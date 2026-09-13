const { WebSocketServer } = require("ws");
const url = require("url");
const { randomUUID } = require("node:crypto");

const { sequelize, Document } = require("./src/models");
const { authenticateSocket, getMembership } = require("./src/auth");
const { touchPresence, removePresence, getPresence } = require("./src/presence");
const { createMessage } = require("./src/messages");
const {
  parseRoomId,
  docRoom,
  chatRoom,
  joinRoom,
  leaveRoom,
  broadcast,
  sendTo,
  clearRooms,
} = require("./src/rooms");

const HEARTBEAT_INTERVAL = 30000;

let wss;
let heartbeat;

function initWebSocket(server) {
  wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const parsedUrl = url.parse(request.url, true);

    if (parsedUrl.pathname !== "/ws") {
      socket.destroy();
      return;
    }

    const user = authenticateSocket(parsedUrl.query.token);
    if (!user) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.user = user;
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (ws) => {
    ws.id = randomUUID();
    ws.rooms = new Set();
    ws.isAlive = true;

    ws.on("pong", () => {
      ws.isAlive = true;
      // Refresh presence for every room this socket is in, so a quiet-but-open
      // tab does not expire out of the member list.
      for (const roomId of ws.rooms) {
        touchPresence(roomId, ws.user).catch((err) =>
          console.error("Presence refresh failed:", err),
        );
      }
    });

    sendTo(ws, { type: "CONNECTED", socketId: ws.id, user: ws.user });

    ws.on("message", (raw) => handleMessage(ws, raw));
    ws.on("close", () => handleClose(ws));
    ws.on("error", (err) => console.error("Socket error:", err.message));
  });

  // One interval for the whole server, not one per connection.
  heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        console.log(
          `[Heartbeat] Terminating dead socket for user ${ws.user?.id || "anonymous"}`,
        );
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL);

  console.log("WebSocket gateway listening on /ws");
  return wss;
}

// Is this user allowed in this room? Documents inherit their workspace's
// membership, so both room kinds resolve to one WorkspaceMember lookup.
async function authorizeRoom(user, roomId) {
  const parsed = parseRoomId(roomId);
  if (!parsed) return { ok: false, code: "BAD_ROOM", message: "Unknown room id" };

  let workspaceId = parsed.id;
  if (parsed.kind === "doc") {
    const doc = await Document.findByPk(parsed.id);
    if (!doc) {
      return { ok: false, code: "NOT_FOUND", message: "Document not found" };
    }
    workspaceId = doc.WorkspaceId;
  }

  const membership = await getMembership(user.id, workspaceId);
  if (!membership) {
    return {
      ok: false,
      code: "FORBIDDEN",
      message: "Not a member of this workspace",
    };
  }

  return { ok: true, workspaceId, role: membership.role };
}

async function handleMessage(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return sendTo(ws, {
      type: "ERROR",
      code: "BAD_JSON",
      message: "Message must be JSON",
    });
  }

  try {
    // Allowlist only. Unknown types are rejected rather than relayed, so a
    // client cannot broadcast arbitrary payloads to a room.
    switch (msg.type) {
      case "JOIN":
        return await onJoin(ws, msg);
      case "LEAVE":
        return await onLeave(ws, msg);
      case "DOCUMENT_UPDATE":
        return await onDocumentUpdate(ws, msg);
      case "CHAT_MESSAGE":
        return await onChatMessage(ws, msg);
      case "TYPING":
        return await onTyping(ws, msg);
      default:
        return sendTo(ws, {
          type: "ERROR",
          code: "UNKNOWN_TYPE",
          message: `Unsupported message type: ${msg.type}`,
        });
    }
  } catch (err) {
    console.error("Error handling message:", err);
    sendTo(ws, {
      type: "ERROR",
      code: "INTERNAL",
      message: "Failed to handle message",
    });
  }
}

async function onJoin(ws, msg) {
  const { roomId } = msg;
  const auth = await authorizeRoom(ws.user, roomId);
  if (!auth.ok) {
    return sendTo(ws, {
      type: "ERROR",
      code: auth.code,
      message: auth.message,
      roomId,
    });
  }

  await joinRoom(roomId, ws);
  await touchPresence(roomId, ws.user);

  const activeUsers = await getPresence(roomId);
  sendTo(ws, { type: "JOINED", roomId, role: auth.role, activeUsers });
  await broadcast(roomId, { type: "PRESENCE_UPDATE", roomId, activeUsers });
}

async function onLeave(ws, msg) {
  const { roomId } = msg;
  if (!ws.rooms.has(roomId)) return;

  await leaveRoom(roomId, ws);
  await removePresence(roomId, ws.user.id);

  sendTo(ws, { type: "LEFT", roomId });
  await broadcast(roomId, {
    type: "PRESENCE_UPDATE",
    roomId,
    activeUsers: await getPresence(roomId),
  });
}

async function onDocumentUpdate(ws, msg) {
  const { documentId, content, expectedVersion } = msg;
  const roomId = docRoom(documentId);

  if (!ws.rooms.has(roomId)) {
    return sendTo(ws, {
      type: "ERROR",
      code: "NOT_JOINED",
      message: `Join ${roomId} before editing`,
    });
  }
  if (typeof content !== "string" || !Number.isInteger(expectedVersion)) {
    return sendTo(ws, {
      type: "ERROR",
      code: "BAD_PAYLOAD",
      message: "content (string) and expectedVersion (int) are required",
    });
  }

  const auth = await authorizeRoom(ws.user, roomId);
  if (!auth.ok || auth.role === "viewer") {
    return sendTo(ws, {
      type: "ERROR",
      code: "FORBIDDEN",
      message: "Editor or owner role required to edit",
    });
  }

  // Optimistic concurrency: the row only moves if nobody else has bumped the
  // version since this client last read it.
  const [updatedRowsCount] = await Document.update(
    { content, version: sequelize.literal('"version" + 1') },
    { where: { id: documentId, version: expectedVersion } },
  );

  const currentDoc = await Document.findByPk(documentId);

  if (updatedRowsCount === 0) {
    // Conflict: tell only the sender, and include the version to retry from.
    return sendTo(ws, {
      type: "VERSION_CONFLICT",
      documentId,
      message:
        "Your update was rejected because another edit was processed first.",
      currentVersion: currentDoc ? currentDoc.version : null,
      currentContent: currentDoc ? currentDoc.content : null,
    });
  }

  sendTo(ws, {
    type: "DOCUMENT_SAVED",
    documentId,
    version: currentDoc.version,
  });

  await broadcast(
    roomId,
    {
      type: "DOCUMENT_UPDATED",
      documentId,
      content: currentDoc.content,
      version: currentDoc.version,
      updatedBy: ws.user.id,
    },
    ws.id,
  );
}

async function onChatMessage(ws, msg) {
  const { workspaceId, content } = msg;
  const roomId = chatRoom(workspaceId);

  if (!ws.rooms.has(roomId)) {
    return sendTo(ws, {
      type: "ERROR",
      code: "NOT_JOINED",
      message: `Join ${roomId} before sending chat`,
    });
  }
  if (typeof content !== "string" || content.trim() === "") {
    return sendTo(ws, {
      type: "ERROR",
      code: "BAD_PAYLOAD",
      message: "content must be a non-empty string",
    });
  }

  const message = await createMessage(workspaceId, ws.user, content.trim());

  // The sender gets the persisted row too, so every client renders the same
  // server-assigned id and timestamp.
  sendTo(ws, { type: "CHAT_MESSAGE", roomId, message });
  await broadcast(roomId, { type: "CHAT_MESSAGE", roomId, message }, ws.id);
}

async function onTyping(ws, msg) {
  const { roomId } = msg;
  if (!ws.rooms.has(roomId)) return;

  await broadcast(
    roomId,
    { type: "TYPING", roomId, user: { id: ws.user.id, name: ws.user.name } },
    ws.id,
  );
}

async function handleClose(ws) {
  const roomIds = [...ws.rooms];
  for (const roomId of roomIds) {
    try {
      await leaveRoom(roomId, ws);
      await removePresence(roomId, ws.user.id);
      await broadcast(roomId, {
        type: "PRESENCE_UPDATE",
        roomId,
        activeUsers: await getPresence(roomId),
      });
    } catch (err) {
      console.error("Error clearing presence on disconnect:", err);
    }
  }
}

// Used by REST writes so a document edited over HTTP still reaches open sockets.
async function broadcastToRoom(roomId, payload) {
  await broadcast(roomId, payload);
}

function broadcastShutdown() {
  if (!wss) return;
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(
        JSON.stringify({
          type: "SERVER_SHUTDOWN",
          message: "Server is shutting down. Please reconnect later.",
        }),
      );
      client.close(1001, "Server is shutting down");
    }
  }
}

function closeWebSocket() {
  return new Promise((resolve) => {
    clearInterval(heartbeat);
    if (!wss) return resolve();

    for (const client of wss.clients) {
      client.terminate();
    }
    clearRooms();
    wss.close(() => resolve());
  });
}

module.exports = {
  initWebSocket,
  closeWebSocket,
  broadcastShutdown,
  broadcastToRoom,
};

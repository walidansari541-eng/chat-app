const {
  subscribeToRoom,
  unsubscribeFromRoom,
  publishToRoom,
} = require("./redisPubSub");

// roomId -> Set<ws> connected to THIS instance. Cross-instance delivery goes
// through Redis pub/sub; this map is only the local leg of the fan-out.
const rooms = new Map();

function parseRoomId(roomId) {
  if (typeof roomId !== "string") return null;
  const [kind, id] = roomId.split(":");
  if ((kind !== "doc" && kind !== "chat") || !id) return null;
  return { kind, id };
}

const docRoom = (documentId) => `doc:${documentId}`;
const chatRoom = (workspaceId) => `chat:${workspaceId}`;

// Deliver to local sockets, skipping the socket that originated the event.
function deliverLocally(roomId, payload, senderSocketId) {
  const clients = rooms.get(roomId);
  if (!clients) return;

  const encoded = JSON.stringify(payload);
  for (const client of clients) {
    if (client.readyState === 1 && client.id !== senderSocketId) {
      client.send(encoded);
    }
  }
}

async function joinRoom(roomId, ws) {
  let clients = rooms.get(roomId);

  if (!clients) {
    clients = new Set();
    rooms.set(roomId, clients);
    // First local member of this room: open the Redis subscription once.
    await subscribeToRoom(roomId, (envelope) => {
      deliverLocally(roomId, envelope.payload, envelope.senderSocketId);
    });
  }

  clients.add(ws);
  ws.rooms.add(roomId);
  return clients.size;
}

async function leaveRoom(roomId, ws) {
  const clients = rooms.get(roomId);
  ws.rooms.delete(roomId);
  if (!clients) return;

  clients.delete(ws);
  if (clients.size === 0) {
    // Last local member left: drop the room and its subscription together, so
    // subscriptions cannot accumulate for the lifetime of the process.
    rooms.delete(roomId);
    await unsubscribeFromRoom(roomId);
  }
}

// Publish to every instance, including this one. Pass senderSocketId to keep
// the originating socket from receiving its own echo.
async function broadcast(roomId, payload, senderSocketId = null) {
  await publishToRoom(roomId, { senderSocketId, payload });
}

// Direct send to a single socket (conflicts, errors) - never goes over Redis.
function sendTo(ws, payload) {
  if (ws.readyState === 1) ws.send(JSON.stringify(payload));
}

function clearRooms() {
  rooms.clear();
}

module.exports = {
  rooms,
  parseRoomId,
  docRoom,
  chatRoom,
  joinRoom,
  leaveRoom,
  broadcast,
  sendTo,
  clearRooms,
};

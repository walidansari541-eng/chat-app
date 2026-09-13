const redisClient = require("./redisClient");
const { Message, User } = require("./models");

const CACHE_TTL = 300;
const HISTORY_LIMIT = 50;

const cacheKey = (workspaceId) => `workspace:${workspaceId}:messages`;

function serialize(message, user) {
  return {
    id: message.id,
    content: message.content,
    createdAt: message.createdAt,
    workspaceId: message.WorkspaceId,
    user: { id: user.id, name: user.name },
  };
}

// Single write path for chat, used by both the WebSocket gateway and the REST
// fallback so persistence and cache invalidation can never drift apart.
async function createMessage(workspaceId, user, content) {
  const message = await Message.create({
    WorkspaceId: workspaceId,
    UserId: user.id,
    content,
  });

  await redisClient.del(cacheKey(workspaceId));
  return serialize(message, user);
}

// Read-through cache: newest HISTORY_LIMIT messages, returned oldest-first.
async function getMessages(workspaceId) {
  const key = cacheKey(workspaceId);
  const cached = await redisClient.get(key);
  if (cached) return JSON.parse(cached);

  const rows = await Message.findAll({
    where: { WorkspaceId: workspaceId },
    include: [{ model: User, attributes: ["id", "name"] }],
    order: [["createdAt", "DESC"]],
    limit: HISTORY_LIMIT,
  });

  const messages = rows
    .reverse()
    .map((row) => serialize(row, row.User || { id: row.UserId, name: null }));

  await redisClient.set(key, JSON.stringify(messages), { EX: CACHE_TTL });
  return messages;
}

module.exports = { createMessage, getMessages, cacheKey, CACHE_TTL };

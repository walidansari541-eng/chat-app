const redisClient = require("./redisClient");

// A user is considered present if they were seen within this window. Sockets
// refresh their entry on every heartbeat pong.
const PRESENCE_TTL_MS = 45000;

const zsetKey = (roomId) => `presence:${roomId}:seen`;
const hashKey = (roomId) => `presence:${roomId}:users`;

// Add or refresh a user in a room. Score is the last-seen timestamp, so
// staleness is a range query rather than a keyspace scan.
async function touchPresence(roomId, user) {
  const now = Date.now();
  await Promise.all([
    redisClient.zAdd(zsetKey(roomId), { score: now, value: user.id }),
    redisClient.hSet(
      hashKey(roomId),
      user.id,
      JSON.stringify({ userId: user.id, name: user.name }),
    ),
  ]);
}

async function removePresence(roomId, userId) {
  await Promise.all([
    redisClient.zRem(zsetKey(roomId), userId),
    redisClient.hDel(hashKey(roomId), userId),
  ]);
}

async function getPresence(roomId) {
  const cutoff = Date.now() - PRESENCE_TTL_MS;

  // Evict anyone whose last heartbeat is older than the window, then read the
  // survivors. O(log n + m), no KEYS scan.
  await redisClient.zRemRangeByScore(zsetKey(roomId), "-inf", cutoff);
  const userIds = await redisClient.zRange(zsetKey(roomId), 0, -1);
  if (userIds.length === 0) return [];

  const stored = await redisClient.hmGet(hashKey(roomId), userIds);
  return userIds.map((userId, i) => {
    try {
      return stored[i] ? JSON.parse(stored[i]) : { userId, name: null };
    } catch {
      return { userId, name: null };
    }
  });
}

module.exports = {
  touchPresence,
  removePresence,
  getPresence,
  PRESENCE_TTL_MS,
};

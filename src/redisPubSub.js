const { createClient } = require("redis");
const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

const pubClient = createClient({ url: redisUrl });
const subClient = pubClient.duplicate();

pubClient.on("error", (err) => console.error("Redis pub error:", err));
subClient.on("error", (err) => console.error("Redis sub error:", err));

const ready = (async () => {
  await pubClient.connect();
  await subClient.connect();
  console.log("Redis Pub/Sub clients connected.");
})();

const channelFor = (roomId) => `room:${roomId}`;

// Rooms are "doc:<uuid>" or "chat:<workspaceUuid>". One channel per room lets
// several server instances fan out to their own local sockets.
async function subscribeToRoom(roomId, onMessage) {
  await ready;
  await subClient.subscribe(channelFor(roomId), (message) => {
    try {
      onMessage(JSON.parse(message));
    } catch (err) {
      console.error("Bad pub/sub payload:", err);
    }
  });
}

async function unsubscribeFromRoom(roomId) {
  await ready;
  await subClient.unsubscribe(channelFor(roomId));
}

async function publishToRoom(roomId, messagePayload) {
  await ready;
  await pubClient.publish(channelFor(roomId), JSON.stringify(messagePayload));
}

async function closePubSub() {
  await Promise.allSettled([pubClient.quit(), subClient.quit()]);
}

module.exports = {
  pubClient,
  subClient,
  subscribeToRoom,
  unsubscribeFromRoom,
  publishToRoom,
  closePubSub,
};

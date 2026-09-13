require("dotenv").config();

const express = require("express");
const {
  initWebSocket,
  closeWebSocket,
  broadcastShutdown,
} = require("./websocket");
const redisClient = require("./src/redisClient");
const { closePubSub } = require("./src/redisPubSub");
const { sequelize } = require("./src/models");
const { correlationIdMiddleware } = require("./src/middleware");

const authRoutes = require("./src/routes/auth");
const workspaceRoutes = require("./src/routes/workspaces");
const documentRoutes = require("./src/routes/documents");

const app = express();
app.use(express.json());
app.use(correlationIdMiddleware);

app.get("/health", async (req, res) => {
  try {
    await sequelize.authenticate();
    res.status(200).json({
      status: "UP",
      database: "OK",
      redis: redisClient.isOpen ? "OK" : "DOWN",
    });
  } catch (err) {
    res.status(500).json({ status: "DOWN", error: err.message });
  }
});

app.use("/api/auth", authRoutes);
app.use("/api/workspaces", workspaceRoutes);
app.use("/api/documents", documentRoutes);

app.use((req, res) => res.status(404).json({ error: "Not found" }));

app.use((err, req, res, next) => {
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "ERROR",
      correlationId: req.correlationId,
      message: err.message,
    }),
  );
  res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT || 3000;

let server;

async function start() {
  // Dev convenience: derive the schema from the models. Not production-safe;
  // a real deployment wants migrations instead.
  await sequelize.sync({ alter: true });
  console.log("PostgreSQL connected & models synced via Sequelize.");

  server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  initWebSocket(server);
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});

let shuttingDown = false;

const shutdown = async () => {
  if (shuttingDown) {
    console.log("Shutdown already in progress. Forcing exit.");
    process.exit(1);
  }
  shuttingDown = true;
  console.log("Shutting down API server gracefully...");

  // Hard deadline so a stuck connection can never hang the process forever.
  const forceExit = setTimeout(() => {
    console.error("Graceful shutdown timed out after 10s. Forcing exit.");
    process.exit(1);
  }, 10000);
  forceExit.unref();

  try {
    // Tell clients why they are being dropped, then terminate the sockets:
    // server.close() waits on them.
    broadcastShutdown();
    await closeWebSocket();

    if (server) {
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        // Idle keep-alive sockets hold server.close() open, so drop them
        // while the close is still pending.
        server.closeIdleConnections?.();
      });
    }

    await sequelize.close();
    await closePubSub();
    if (redisClient.isOpen) await redisClient.quit();

    console.log("Closed HTTP server, WebSocket, DB and Redis connections.");
    clearTimeout(forceExit);
    process.exit(0);
  } catch (error) {
    console.error("Error during shutdown:", error);
    clearTimeout(forceExit);
    process.exit(1);
  }
};


process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

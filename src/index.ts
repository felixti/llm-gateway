import { Hono } from "hono";
import { env } from "./config/env";
import { requestIdMiddleware } from "./middleware/request-id";
import { chatRoutes } from "./routes/chat.routes";
import { messagesRoutes } from "./routes/messages.routes";
import { responsesRoutes } from "./routes/responses.routes";
import { modelsRoutes } from "./routes/models.routes";
import { healthRoutes } from "./routes/health.routes";
import { quotaRoutes } from "./routes/quota.routes";
import { adminRoutes } from "./routes/admin.routes";

// Create Hono app
const app = new Hono();

// Request ID middleware - first in chain
app.use("*", requestIdMiddleware);

// Mount route groups
app.route("/v1/chat/completions", chatRoutes);
app.route("/v1/messages", messagesRoutes);
app.route("/v1/responses", responsesRoutes);
app.route("/v1/models", modelsRoutes);
app.route("/", healthRoutes);
app.route("/quota", quotaRoutes);
app.route("/admin", adminRoutes);

// Graceful shutdown handler
const shutdown = (signal: string) => {
  console.log(`Received ${signal}, starting graceful shutdown (30s drain)...`);
  setTimeout(() => {
    console.log("Shutdown complete");
    process.exit(0);
  }, 30000);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Start server
const port = env.PORT;
console.log(`LLM Gateway starting on port ${port}`);

export default app;

import { EventBus } from "./event-bus.mjs";
import { createApi } from "./api.mjs";
import { startPipeline, stopPipeline } from "./pipeline.mjs";
import { watchApprovals } from "./proposals.mjs";

const PORT = parseInt(process.env.HYDRA_PORT) || 4000;
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

async function main() {
  console.log("[Hydra] Starting orchestrator...");

  // Initialize event bus
  const eventBus = new EventBus(REDIS_URL);
  await eventBus.init();
  console.log("[Hydra] Event bus initialized (Redis Streams ready)");

  // Start the agent pipeline (consumers listening on Redis streams)
  await startPipeline(eventBus);
  console.log("[Hydra] Agent pipeline started (7 agents listening)");

  // Start the proposal approval watcher (polls reports/proposals/approved/)
  watchApprovals(eventBus);
  console.log("[Hydra] Proposal approval watcher started");

  // Create and start API server
  const app = createApi(eventBus);
  const server = app.listen(PORT, () => {
    console.log(`[Hydra] REST API listening on port ${PORT}`);
    console.log(`[Hydra] Health check: http://localhost:${PORT}/health`);
  });

  // Graceful shutdown
  const shutdown = async (signal) => {
    console.log(`\n[Hydra] Received ${signal}, shutting down...`);
    stopPipeline(eventBus);
    server.close();
    await eventBus.close();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[Hydra] Fatal error:", err);
  process.exit(1);
});

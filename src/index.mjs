import { EventBus } from "./event-bus.mjs";
import { createApi } from "./api.mjs";
import { startPipeline, stopPipeline } from "./pipeline.mjs";
import { createTracker, getTracker } from "./task-tracker.mjs";
import { initMetrics } from "./metrics.mjs";
import { watchApprovals } from "./proposals.mjs";
import { sendNotification } from "./notify.mjs";
import { startCleanupSchedule } from "./cleanup.mjs";

const PORT = parseInt(process.env.HYDRA_PORT) || 4000;
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const CYCLE_TTL_MS = parseInt(process.env.HYDRA_CYCLE_TTL_MS) || 90 * 60 * 1000; // 90 minutes

async function main() {
  console.log("[Hydra] Starting orchestrator...");

  // Initialize event bus and task tracker
  const eventBus = new EventBus(REDIS_URL);
  await eventBus.init();
  console.log("[Hydra] Event bus initialized (Redis Streams ready)");

  createTracker(REDIS_URL);
  initMetrics(REDIS_URL);
  console.log("[Hydra] Task tracker + metrics initialized (Redis-backed)");

  // Start the agent pipeline (consumers listening on Redis streams)
  await startPipeline(eventBus);
  console.log("[Hydra] Background consumers started (meta, notifications, dlq)");

  // Start the proposal approval watcher (polls reports/proposals/approved/)
  watchApprovals(eventBus);
  console.log("[Hydra] Proposal approval watcher started");

  // Log control loop mode
  if (process.env.HYDRA_LEGACY_PIPELINE === "1") {
    console.log("[Hydra] LEGACY PIPELINE MODE — set HYDRA_LEGACY_PIPELINE=0 or unset for V2");
  } else {
    console.log("[Hydra] V2 CONTROL LOOP — ground→plan→skeptic→execute→verify→merge");
  }

  // Create and start API server
  const app = createApi(eventBus);
  const server = app.listen(PORT, () => {
    console.log(`[Hydra] REST API listening on port ${PORT}`);
    console.log(`[Hydra] Health check: http://localhost:${PORT}/health`);
  });

  // Report cleanup (archive reports older than 7 days)
  startCleanupSchedule();

  // Cycle watchdog — auto-kill cycles past the TTL, alert on stalls
  setInterval(async () => {
    try {
      const tracker = getTracker();
      const state = await tracker.getCycleState();
      if (state.status !== "running") return;

      const elapsed = Date.now() - new Date(state.startedAt).getTime();
      const elapsedMin = Math.round(elapsed / 60000);

      if (elapsed > CYCLE_TTL_MS) {
        // Auto-kill: timeout all remaining tasks and complete the cycle
        console.log(`[Watchdog] Cycle ${state.cycleId} exceeded TTL (${elapsedMin}min > ${CYCLE_TTL_MS / 60000}min) — auto-killing`);
        const timedOut = await tracker.timeoutStaleTasks(state.cycleId, eventBus);
        await sendNotification({
          type: "cycle:auto_killed",
          payload: {
            cycleId: state.cycleId,
            elapsed: `${elapsedMin}min`,
            ttl: `${CYCLE_TTL_MS / 60000}min`,
            tasksTimedOut: timedOut,
          },
        });
      } else {
        // Warn about in-progress tasks
        const pending = state.tasks.filter((t) => t.status === "in_progress" || t.status === "created");
        if (pending.length > 0 && elapsed > 30 * 60 * 1000) {
          console.log(`[Watchdog] Cycle ${state.cycleId} running ${elapsedMin}min — ${pending.length} tasks still active`);
          await sendNotification({
            type: "cycle:stalled",
            payload: {
              cycleId: state.cycleId,
              elapsed: `${elapsedMin}min`,
              inProgress: pending.length,
              tasks: pending.map((t) => `${t.taskId}: ${t.stage}`),
            },
          });
        }
      }
    } catch (err) {
      console.error("[Watchdog] Error:", err.message);
    }
  }, 15 * 60 * 1000); // Check every 15 minutes
  console.log("[Hydra] Cycle watchdog started (checks every 15min, TTL " + (CYCLE_TTL_MS / 60000) + "min)");

  // Graceful shutdown
  const shutdown = async (signal) => {
    console.log(`\n[Hydra] Received ${signal}, shutting down...`);
    stopPipeline(eventBus);
    server.close();
    await getTracker().close();
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

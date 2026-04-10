import { EventBus, STREAMS } from "./event-bus.mjs";
import { createApi } from "./api.mjs";
import { createTracker, getTracker } from "./task-tracker.mjs";
import { initMetrics } from "./metrics.mjs";
import { watchApprovals, runMetaAnalysis } from "./proposals.mjs";
import { sendNotification } from "./notify.mjs";
import { startCleanupSchedule } from "./cleanup.mjs";
import { autoStart as autoStartScheduler, stop as stopScheduler } from "./scheduler.mjs";
import { startDigest, stopDigest, recordEvent } from "./digest.mjs";

import { createServer } from "node:net";

const PORT = parseInt(process.env.HYDRA_PORT) || 4000;
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const CYCLE_TTL_MS = parseInt(process.env.HYDRA_CYCLE_TTL_MS) || 90 * 60 * 1000; // 90 minutes

// ---------------------------------------------------------------------------
// Background stream consumers (folded from pipeline.mjs)
// ---------------------------------------------------------------------------

const MAX_CONSUMER_RESTARTS = 5;
const BACKOFF_BASE_MS = 5000;

async function startConsumerWithRecovery(name, startFn) {
  let restarts = 0;
  while (true) {
    try {
      await startFn();
      break;
    } catch (err) {
      restarts++;
      console.error(`[Consumer] ${name} crashed (restart ${restarts}/${MAX_CONSUMER_RESTARTS}):`, err.message);
      if (restarts > MAX_CONSUMER_RESTARTS) {
        console.error(`[Consumer] ${name} exceeded max restarts — giving up`);
        await sendNotification({
          type: "consumer:dead",
          payload: { consumer: name, error: err.message, restarts },
        });
        break;
      }
      const delay = BACKOFF_BASE_MS * restarts;
      console.log(`[Consumer] Restarting ${name} in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

function startConsumers(eventBus) {
  // Notification consumer — routes events to the digest system
  startConsumerWithRecovery("notifications", () =>
    eventBus.consume(STREAMS.NOTIFICATIONS, "openclaw", `notify-${process.pid}`, async (event) => {
      recordEvent(event);
    }, { count: 1, blockMs: 5000 }),
  );

  // Meta agent consumer — triggers analysis from measured failures
  startConsumerWithRecovery("meta", () =>
    eventBus.consume(STREAMS.META, "meta", `meta-${process.pid}`, async (event) => {
      if (event.type === "cycle:report" || event.type === "eval:failed") {
        console.log(`[Consumer] meta processing ${event.type}`);
        await runMetaAnalysis(eventBus, event);
      }
    }, { count: 1, blockMs: 10000 }),
  );

  // Dead-letter queue consumer — alert and mark tasks failed
  startConsumerWithRecovery("dlq", () =>
    eventBus.consume(STREAMS.DLQ, "dlq-processor", `dlq-${process.pid}`, async (event) => {
      const { originalStream, originalGroup, originalEvent, error, deliveryCount } = event.payload || {};
      console.error(`[DLQ] Failed event from ${originalStream}/${originalGroup}: ${originalEvent?.type} — ${error} (${deliveryCount} attempts)`);
      await sendNotification({
        type: "dlq:alert",
        payload: { originalStream, originalGroup, eventType: originalEvent?.type, error, deliveryCount },
      });
      const taskId = originalEvent?.payload?.taskId;
      if (taskId) {
        await getTracker().markTaskDone(originalEvent?.payload?.originalTaskId || taskId, "failed", eventBus);
      }
    }, { count: 1, blockMs: 10000 }),
  );

  console.log("[Hydra] Background consumers started (meta, notifications, dlq)");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Guard: abort if another Hydra instance is already running on the same port
  const portFree = await new Promise((resolve) => {
    const tester = createServer();
    tester.once("error", () => resolve(false));
    tester.listen(PORT, () => { tester.close(); resolve(true); });
  });
  if (!portFree) {
    console.error(`[Hydra] ABORT: Port ${PORT} is already in use. Another Hydra instance is running.`);
    console.error(`[Hydra] Use 'systemctl --user restart hydra' to manage the service — do not run 'node src/index.mjs' directly.`);
    process.exit(1);
  }

  console.log("[Hydra] Starting orchestrator...");

  // Startup cleanup: delete stale feature branches in the target project
  const PROJECT_WORKSPACE = process.env.HYDRA_PROJECT_WORKSPACE || "/home/gabe/hydra-betting";
  try {
    const { execFile: ef } = await import("node:child_process");
    const { promisify: p } = await import("node:util");
    const run = p(ef);
    await run("git", ["checkout", "main"], { cwd: PROJECT_WORKSPACE, timeout: 5000 }).catch(() => {});
    const { stdout } = await run("git", ["branch", "--list", "feature/*"], { cwd: PROJECT_WORKSPACE, timeout: 5000 });
    const stale = stdout.trim().split("\n").map(b => b.trim()).filter(Boolean);
    for (const branch of stale) {
      await run("git", ["branch", "-D", branch], { cwd: PROJECT_WORKSPACE, timeout: 5000 }).catch(() => {});
    }
    if (stale.length > 0) console.log(`[Hydra] Startup cleanup: deleted ${stale.length} stale feature branches`);
  } catch {}

  // Initialize event bus and task tracker
  const eventBus = new EventBus(REDIS_URL);
  await eventBus.init();
  console.log("[Hydra] Event bus initialized (Redis Streams ready)");

  createTracker(REDIS_URL);
  initMetrics(REDIS_URL);
  console.log("[Hydra] Task tracker + metrics initialized (Redis-backed)");

  // Recover held tasks from Redis (from previous cycle's dependency holds)
  try {
    const recovered = await getTracker().recoverHeldTasks();
    if (recovered.length > 0) {
      console.log(`[Hydra] Recovered ${recovered.length} held task(s) from Redis`);
    }
  } catch (err) {
    console.error(`[Hydra] Failed to recover held tasks:`, err.message);
  }

  // Start background consumers (notifications, meta, DLQ)
  startConsumers(eventBus);

  // Start digest notifications (4h summaries instead of per-event messages)
  startDigest();

  // Start the proposal approval watcher (polls reports/proposals/approved/)
  watchApprovals(eventBus);
  console.log("[Hydra] Proposal approval watcher started");

  console.log("[Hydra] V2 CONTROL LOOP — ground→plan→skeptic→execute→verify→merge");

  // Create and start API server
  const app = createApi(eventBus);
  const server = app.listen(PORT, () => {
    console.log(`[Hydra] REST API listening on port ${PORT}`);
    console.log(`[Hydra] Health check: http://localhost:${PORT}/health`);
  });

  // Report cleanup (cycle-summaries 2d, reality-reports keep 50)
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
  }, 15 * 60 * 1000);
  console.log("[Hydra] Cycle watchdog started (checks every 15min, TTL " + (CYCLE_TTL_MS / 60000) + "min)");

  // Auto-start scheduler
  const schedulerResult = await autoStartScheduler(eventBus);
  if (schedulerResult) {
    console.log(`[Hydra] Scheduler auto-started (interval: ${schedulerResult.intervalHuman})`);
  }

  // Graceful shutdown
  const shutdown = async (signal) => {
    console.log(`\n[Hydra] Received ${signal}, shutting down...`);
    stopDigest();
    stopScheduler();
    eventBus.stopConsuming();
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

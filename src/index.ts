// Sentry must be imported FIRST
import { Sentry } from "./instrument.ts";

import { EventBus } from "./event-bus.ts";
import { createApi } from "./api.ts";
import { stopKnowledgeIndexer } from "./knowledge-base/knowledge-indexer.ts";
import { autoStart as autoStartScheduler, stop as stopScheduler } from "./scheduler/heartbeat.ts";
import { startDigest, stopDigest } from "./digest.ts";
import { initLearning } from "./learning.ts";
import { cleanWorkQueue } from "./redis/work-queue.ts";
import { getTargetName, getTargetWorkspace } from "./target-config.ts";
import { startConsumers } from "./notification-consumer.ts";
import { slotEventsBridgeConsumer } from "./autopilot/slot-events-bridge.ts";
import { recsEngineConsumer } from "./autopilot/recommendation-engine.ts";
import {
  startPrLifecycleBridge,
  type PrLifecycleBridge,
} from "./autopilot/pr-lifecycle-bridge.ts";

import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { WebSocketServer } from "ws";

const PORT = parseInt(process.env.HYDRA_PORT) || 4000;

// Background stream consumers (notifications, DLQ, slot-events bridge, recs
// engine) plus the alert-routing grammar were extracted into the
// notification-consumer Module (issue #1376). index.ts stays a thin caller of
// startConsumers() and retains only process lifecycle below.

// ---------------------------------------------------------------------------
// Autopilot observability bridges (issue #673) — module-level handles so the
// SIGTERM shutdown sequence can stop them cleanly. Polling bridges, not
// XREADGROUP consumers, so they live outside startConsumersWithRecovery.
//
// The budget-threshold bridge was removed in #703 — it polled the dead
// `hydra:scheduler:daily-spend` key (no live writer) and never emitted an
// event. The live cost guardrail is `src/cost/usage-tracker.ts`.
// ---------------------------------------------------------------------------
let _prLifecycleBridge: PrLifecycleBridge | null = null;

async function startObservabilityBridges(eventBus: EventBus): Promise<void> {
  try {
    // Pass the service-wide Event Bus so publishRaw's WS broadcast reaches the
    // live dashboard clients registered on this bus (ADR-0017 Category B).
    _prLifecycleBridge = await startPrLifecycleBridge({ eventBus });
  } catch (err: any) {
    console.error(`[Hydra] pr-lifecycle-bridge failed to start: ${err?.message || err}`);
  }
}

function stopObservabilityBridges(): void {
  if (_prLifecycleBridge) {
    try { _prLifecycleBridge.stop(); } catch (err: any) {
      console.error(`[Hydra] pr-lifecycle-bridge stop failed: ${err?.message || err}`);
    }
    _prLifecycleBridge = null;
  }
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
  console.log(`[Hydra] Target: ${getTargetName()} (workspace: ${getTargetWorkspace()})`);

  // Startup cleanup: delete stale feature branches in the target project
  const PROJECT_WORKSPACE = getTargetWorkspace();
  try {
    const { execFile: ef } = await import("node:child_process");
    const { promisify: p } = await import("node:util");
    const run = p(ef);
    await run("git", ["checkout", "main"], { cwd: PROJECT_WORKSPACE, timeout: 5000 }).catch(() => { /* intentional: checkout may fail if already on main or dirty state */ });
    const { stdout } = await run("git", ["branch", "--list", "feature/*"], { cwd: PROJECT_WORKSPACE, timeout: 5000 });
    const stale = stdout.trim().split("\n").map(b => b.trim()).filter(Boolean);
    for (const branch of stale) {
      await run("git", ["branch", "-D", branch], { cwd: PROJECT_WORKSPACE, timeout: 5000 }).catch(() => { /* intentional: best-effort stale branch cleanup */ });
    }
    if (stale.length > 0) console.log(`[Hydra] Startup cleanup: deleted ${stale.length} stale feature branches`);
  } catch (err: any) { console.error(`[Hydra] Startup branch cleanup failed: ${err.message}`); }

  // Initialize event bus
  const eventBus = new EventBus();
  await eventBus.init();
  console.log("[Hydra] Event bus initialized (Redis Streams ready)");

  // Initialize learning system (migrates rules, registers OV skills, starts indexer)
  await initLearning();

  // Clean work queue: remove COMPLETED: items and deduplicate
  try {
    await cleanWorkQueue();
  } catch (err: any) {
    console.error(`[Hydra] Work queue cleanup failed: ${err.message}`);
  }

  // Start background consumers (notifications, meta, DLQ)
  startConsumers(eventBus);

  // Issue #673: PR-lifecycle observability bridge. Publishes onto
  // `hydra:autopilot:slot-events` (the same stream the slot-events bridge
  // re-broadcasts over WS) so dashboard tiles like BattleCardRow can react
  // without round-tripping the REST API. (The sibling budget-threshold
  // bridge was removed in #703 — it polled a dead Redis key.)
  await startObservabilityBridges(eventBus);

  // Start digest notifications (4h summaries instead of per-event messages)
  startDigest();

  // Agent streaming was wired through codex-runner's setAgentStreamCallback,
  // both removed in PR-3 (issue #383). Autopilot subagents own execution
  // now and emit their own events via the event bus directly.

  console.log("[Hydra] Scheduler heartbeat — housekeeping only (codex control loop removed PR-3 #383)");

  // Create and start API + WebSocket server
  const app = createApi(eventBus);
  const server = createHttpServer(app);

  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    eventBus.addWsClient(ws);
    ws.send(JSON.stringify({ type: "connected", timestamp: new Date().toISOString() }));
  });

  // Heartbeat — detect dead connections
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  wss.on("connection", (ws) => {
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });
  });

  server.listen(PORT, () => {
    console.log(`[Hydra] REST API + WebSocket listening on port ${PORT}`);
    console.log(`[Hydra] Health check: http://localhost:${PORT}/health`);
    console.log(`[Hydra] WebSocket: ws://localhost:${PORT}`);
  });

  // Stale-Redis-key sweep + stale-inProgress return + done-lane prune now run
  // as housekeeping chores (issue #1876) — driven by the hourly
  // `hydra-housekeeping.timer` POSTing to `/api/maintenance/housekeeping`,
  // not a separate in-process 24h setInterval.

  // Auto-start scheduler
  const schedulerResult = await autoStartScheduler(eventBus);
  if (schedulerResult) {
    console.log(`[Hydra] Scheduler auto-started (interval: ${schedulerResult.intervalHuman})`);
  }

  // Graceful shutdown
  const shutdown = async (signal) => {
    console.log(`\n[Hydra] Received ${signal}, shutting down...`);
    stopDigest();
    // Issue #388: process shutdown is NOT operator-deliberate — systemd will
    // restart the service and autoStart() will resume the scheduler. Writing
    // a deliberate-stop marker here would defeat that.
    await stopScheduler({ reason: "shutdown" });
    stopObservabilityBridges();
    eventBus.stopConsuming();
    // Issue #1221: best-effort unregister THIS process's own slot-events
    // consumer names so a graceful exit never leaves a zombie the next process
    // must reap. Only the `$`-anchored slot-events groups (PEL-loss-tolerant);
    // notifications/DLQ are left registered so their at-least-once PELs survive.
    // Each delConsumer is best-effort and never throws; the stateless startup
    // reapStaleConsumers() sweep is the SIGKILL-safe backstop.
    for (const { stream, group, consumer } of [slotEventsBridgeConsumer(), recsEngineConsumer()]) {
      await eventBus.delConsumer(stream, group, consumer);
    }
    clearInterval(heartbeat);
    // Issue #866: clear the leaked 30s knowledge-indexer Redis poll so it does
    // not survive shutdown. (The 24h cleanup-prune interval was removed in
    // #1876 — its work runs as housekeeping chores now, no in-process timer.)
    stopKnowledgeIndexer();
    for (const ws of wss.clients) ws.close(1001, "server shutting down");
    wss.close();
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

// Sentry must be imported FIRST
import { Sentry } from "./instrument.ts";

import { EventBus } from "./event-bus.ts";
import { createApi } from "./api.ts";
import { stopKnowledgeIndexer } from "./knowledge-base/indexer.ts";
import { autoStart as autoStartScheduler, stop as stopScheduler } from "./scheduler/heartbeat.ts";
import { startDigest, stopDigest } from "./digest.ts";
import { initLearning } from "./learning-lifecycle.ts";
import { cleanWorkQueue } from "./redis/work-queue.ts";
import { getTargetName, getTargetWorkspace } from "./target-config.ts";
import { gitExec } from "./github/git.ts";
import { isGhFailure, isGhOk } from "./github/exec.ts";
import {
  parseWorktreeList,
  classifyOrphanWorktree,
  DEFAULT_WORKTREE_MIN_AGE_SECONDS,
  type WorktreeRow,
} from "./worktree-orphan.ts";
import { statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startConsumers } from "./notification-consumer.ts";
import { slotEventsBridgeConsumer } from "./autopilot/slot-events-bridge.ts";
import { recsEngineConsumer } from "./autopilot/recommendation-consumer.ts";
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
// Startup orphan-worktree prune (issue #2465, recurrence of #2115)
//
// A code-writing dispatch into the target project runs in a `/dev/shm`
// worktree. When that dispatch crashes / exits uncleanly the worktree dir AND
// its `.git/worktrees/<id>` registry entry survive, with the feature branch
// still checked out there. The startup `git branch -D` sweep below then fails
// closed — git refuses to delete a branch a registered worktree still holds —
// so stale feature branches accumulate over every boot.
//
// This pass reclaims the ORPHANED worktree dirs first, so the subsequent
// `git branch -D` loop succeeds. It reuses the SAME liveness classifier the
// hydra-branch-prune skill encodes (scripts/ci/branch-prune.ts) rather than
// hand-rolling an `rm -rf` of a dispatch dir:
//   - never reclaims a worktree held by a live agent PID (lock-file `(pid N)`),
//   - never reclaims one under the 6h age floor (an in-flight dispatch that
//     simply hasn't taken its lock yet looks identical to a crashed orphan),
//   - never touches the main working tree.
// `git worktree remove --force` unregisters the entry AND removes the dir; the
// trailing `git worktree prune` reclaims any registry entry whose dir already
// vanished. Best-effort and never-throwing — a prune fault must never block
// server.listen (it runs inside the same try/catch envelope as the branch
// sweep). Idempotent: a second run no-ops (the dir/entry are already gone).
// ---------------------------------------------------------------------------

/** Live-PID predicate — mirrors scripts/ci/branch-prune-runner.ts::isLivePid. */
function isLivePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM means the process exists but we can't signal it — treat as live.
    return err && err.code === "EPERM";
  }
}

/**
 * Reclaim orphaned `/dev/shm/hydra-worktrees/` worktrees in the target
 * workspace so the stale-branch sweep can delete their feature branches.
 * Returns the count reclaimed (0 on any non-orphan / unreachable state).
 */
async function pruneOrphanedTargetWorktrees(
  workspace: string,
  gitOpts: { cwd: string; timeout: number },
): Promise<number> {
  // Locate the common git dir so we can read each worktree's lock-file body
  // (`<commonDir>/worktrees/<id>/locked`), whose `(pid N)` token feeds the
  // live-agent guard. `git worktree list --porcelain` does not carry the PID.
  const commonDirRes = await gitExec(["rev-parse", "--git-common-dir"], gitOpts);
  if (isGhFailure(commonDirRes)) {
    console.error(`[Hydra] Startup worktree prune: 'git rev-parse --git-common-dir' failed (${commonDirRes.code}) — skipping`);
    return 0;
  }
  let commonDir = commonDirRes.data.stdout.trim();
  if (!commonDir) return 0;
  // A relative `.git` resolves against the workspace cwd.
  if (!commonDir.startsWith("/")) commonDir = join(workspace, commonDir);

  const listed = await gitExec(["worktree", "list", "--porcelain"], gitOpts);
  if (isGhFailure(listed)) {
    console.error(`[Hydra] Startup worktree prune: 'git worktree list' failed (${listed.code}) — skipping`);
    return 0;
  }

  // Read lock-file bodies for each worktree so the classifier's live-PID rail
  // can parse the `(pid N)` token. The worktree id is the basename of its path
  // (git's `.git/worktrees/<id>` convention); the lock lives in the common git
  // dir, never under the (possibly-vanished) worktree dir itself.
  const porcelain = listed.data.stdout;
  const lockBodies = new Map<string, string>();
  for (const wt of parseWorktreeList(porcelain)) {
    const id = wt.path.slice(wt.path.lastIndexOf("/") + 1);
    try {
      lockBodies.set(wt.path, readFileSync(join(commonDir, "worktrees", id, "locked"), "utf-8"));
    } catch { /* intentional: no lock file = unlocked worktree, not an error */ }
  }
  // Parse once with lock bodies (populates lockedByPid), then attach each dir's
  // mtime age — the last gate the age-floor rail checks. A vanished dir leaves
  // ageSeconds null = unknown = conservative skip (git worktree prune reclaims
  // its registry entry instead).
  const withLocks: WorktreeRow[] = parseWorktreeList(porcelain, lockBodies).map((wt) => {
    let ageSeconds: number | null = null;
    try {
      ageSeconds = Math.floor((Date.now() - statSync(wt.path).mtimeMs) / 1000);
    } catch { /* intentional: dir already gone = let `git worktree prune` reclaim the registry entry */ }
    return { ...wt, ageSeconds };
  });

  // The main working tree is the first porcelain stanza; never reclaim it.
  const mainWorktreePath = withLocks.length > 0 ? withLocks[0].path : workspace;

  let reclaimed = 0;
  for (const wt of withLocks) {
    const result = classifyOrphanWorktree(wt, {
      mainWorktreePath,
      // Startup runs on `main`; the orphans hold `feature/*` branches. Pass the
      // real current branch so the never-reap-current-branch rail is honest.
      currentBranch: "main",
      isLivePid,
      minAgeSeconds: DEFAULT_WORKTREE_MIN_AGE_SECONDS,
      // Scope the destructive action to `/dev/shm/hydra-worktrees/` — the dir
      // family the recurrence (#2115 -> #2465) is observed in. A worktree
      // elsewhere is left for the hydra-branch-prune skill's broader sweep.
      scopePrefix: "/dev/shm/hydra-worktrees/",
    });
    if (result.action !== "delete-orphan-worktree") continue;
    const removed = await gitExec(["worktree", "remove", "--force", wt.path], gitOpts);
    if (isGhFailure(removed)) {
      console.error(`[Hydra] Startup worktree prune: 'git worktree remove --force ${wt.path}' skipped (${removed.code})`);
      continue;
    }
    reclaimed++;
    console.log(`[Hydra] Startup worktree prune: reclaimed orphan worktree ${wt.path}${wt.branch ? ` (branch ${wt.branch})` : ""}`);
  }

  // Reclaim any registry entry whose dir already vanished (the orphan dir was
  // removed out-of-band but `.git/worktrees/<id>` lingered) so a stale entry
  // can't keep blocking its branch on a later boot.
  const pruned = await gitExec(["worktree", "prune"], gitOpts);
  if (isGhFailure(pruned)) {
    console.error(`[Hydra] Startup worktree prune: 'git worktree prune' skipped (${pruned.code})`);
  }

  return reclaimed;
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

  // Startup cleanup: delete stale feature branches in the target project.
  // Routes every `git` call through the GitHub CLI Adapter seam
  // (src/github/git.ts::gitExec, issue #1960) — no raw node:child_process here.
  // gitExec never throws; it returns a GhResult, so the prior best-effort
  // `.catch()` swallows become explicit `if (!ok)` skips.
  const PROJECT_WORKSPACE = getTargetWorkspace();
  try {
    const gitOpts = { cwd: PROJECT_WORKSPACE, timeout: 5000 };
    // Best-effort: checkout may fail if already on main or in a dirty state.
    // isGhFailure/isGhOk guards are required: tsconfig runs strict:false, so a
    // plain `if (!result.ok)` does NOT narrow the GhResult union (see the note
    // on these guards in src/github/exec.ts).
    const checkout = await gitExec(["checkout", "main"], gitOpts);
    if (isGhFailure(checkout)) {
      console.error(`[Hydra] Startup cleanup: 'git checkout main' skipped (${checkout.code})`);
    }
    // Issue #2465 (recurrence of #2115): reclaim orphaned /dev/shm worktrees
    // BEFORE the branch sweep — a registered worktree holding a feature branch
    // makes `git branch -D` fail closed, so stale branches accumulate. The
    // prune is best-effort and never-throwing; a fault here must not abort the
    // branch sweep that follows.
    try {
      const reclaimed = await pruneOrphanedTargetWorktrees(PROJECT_WORKSPACE, gitOpts);
      if (reclaimed > 0) console.log(`[Hydra] Startup cleanup: reclaimed ${reclaimed} orphan worktree(s) before stale-branch sweep`);
    } catch (err: any) {
      console.error(`[Hydra] Startup worktree prune failed: ${err.message}`);
    }
    const listed = await gitExec(["branch", "--list", "feature/*"], gitOpts);
    if (isGhOk(listed)) {
      // `git branch` marks the currently checked-out branch with a leading `+`
      // (worktree) or `*` (HEAD); strip it before passing to `git branch -D`,
      // else the delete fails with "branch '+ feature/...' not found".
      const stale = listed.data.stdout.trim().split("\n").map(b => b.trim().replace(/^[+*]\s+/, "")).filter(Boolean);
      for (const branch of stale) {
        // Best-effort per-branch delete; a failure here is non-fatal.
        const deleted = await gitExec(["branch", "-D", branch], gitOpts);
        if (isGhFailure(deleted)) {
          console.error(`[Hydra] Startup cleanup: 'git branch -D ${branch}' skipped (${deleted.code})`);
        }
      }
      if (stale.length > 0) console.log(`[Hydra] Startup cleanup: deleted ${stale.length} stale feature branches`);
    } else {
      console.error(`[Hydra] Startup cleanup: 'git branch --list' failed (${listed.code}) — skipping stale-branch sweep`);
    }
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

  // Reconcile backlog lane indices against the canonical items hash (issue
  // #2056). A transition writes the hash first and the lane zset second, so a
  // crash / Redis restart (the #1990 desync) can leave items unreachable via
  // the sorted-set read paths. This startup sweep re-indexes any hash item
  // missing from its lane zset and removes orphan zset members. Best-effort and
  // never-throwing — a reconciler fault must never block server.listen. The
  // same self-healing function also runs hourly as a housekeeping chore.
  try {
    const { reconcileLaneIndices } = await import("./backlog/index-reconciler.ts");
    const rec = await reconcileLaneIndices();
    if (rec.reindexed > 0 || rec.orphansRemoved > 0 || rec.unLaned > 0) {
      console.log(
        `[Hydra] Lane-index reconcile: re-indexed ${rec.reindexed}, removed ${rec.orphansRemoved} orphan(s), ${rec.unLaned} un-laned (scanned ${rec.scanned})`,
      );
    }
  } catch (err: any) {
    console.error(`[Hydra] Lane-index reconcile failed: ${err.message}`);
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

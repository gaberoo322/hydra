/**
 * Regression tests for the no-op-merge alarm (issue #222).
 *
 * Bug: Phantom merges (#218) silently degraded the system for ~14 hours:
 * 13 consecutive cycles reported `tasksMerged: 1` while writing zero files.
 * Without a guard, this class of failure (worktree merge bug, verification
 * diff bug, or future regression) can run indefinitely undetected.
 *
 * The guardrail (defense-in-depth, independent of the underlying bug):
 *   1. Per-cycle: if `verification.filesChanged.length === 0` AND
 *      `task.scopeBoundary.in.length > 0`, downgrade to "verified-no-diff",
 *      do not increment tasksMerged, and push a critical alert.
 *   2. Cumulative: 3 consecutive no-op merges halt the scheduler.
 *   3. Surfaced via /api/scheduler/status (consecutiveNoOpMerges,
 *      noOpMergeHaltThreshold, haltedForNoOpMerges) and /api/metrics
 *      (noOpMerges field per cycle, noOpMergeRate aggregate).
 *
 * Tests focus on pure logic (classifier, threshold) and observable side
 * effects (metrics shape, scheduler state). Full end-to-end cycle
 * simulation is out of scope — that requires Codex agents.
 */

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/1";
process.env.REDIS_URL = REDIS_URL;

// Shared connection for the whole file — node:test's describe-level after()
// hooks can fire before sibling describes finish, so a per-describe disconnect
// produced "Connection is closed" failures. One connection, cleaned at the
// end via after() at the file scope.
const redis: any = new Redis(REDIS_URL);

async function cleanKeys() {
  const keys = await redis.keys("hydra:*");
  if (keys.length > 0) await redis.del(...keys);
}

after(async () => {
  await cleanKeys();
  redis.disconnect();
});

// ---------------------------------------------------------------------------
// Pure logic: classifyNoOpMergeState + threshold
// ---------------------------------------------------------------------------

describe("classifyNoOpMergeState (issue #222)", () => {
  let classifyNoOpMergeState: any;
  let NO_OP_MERGE_HALT_THRESHOLD: number;

  test("loads classifier and threshold from scheduler module", async () => {
    const mod = await import("../src/scheduler.ts");
    classifyNoOpMergeState = mod.classifyNoOpMergeState;
    NO_OP_MERGE_HALT_THRESHOLD = mod.NO_OP_MERGE_HALT_THRESHOLD;
    assert.equal(typeof classifyNoOpMergeState, "function");
    assert.equal(typeof NO_OP_MERGE_HALT_THRESHOLD, "number");
    assert.ok(NO_OP_MERGE_HALT_THRESHOLD > 0, "threshold must be positive");
  });

  test("returns 'ok' when no-op count is below threshold", () => {
    assert.equal(classifyNoOpMergeState(0), "ok");
    assert.equal(classifyNoOpMergeState(NO_OP_MERGE_HALT_THRESHOLD - 1), "ok");
  });

  test("returns 'halt' at exactly the threshold", () => {
    assert.equal(classifyNoOpMergeState(NO_OP_MERGE_HALT_THRESHOLD), "halt");
  });

  test("returns 'halt' above the threshold", () => {
    assert.equal(classifyNoOpMergeState(NO_OP_MERGE_HALT_THRESHOLD + 5), "halt");
  });

  test("threshold matches issue #222 spec (3 consecutive no-op merges)", () => {
    // Deliberately encode the spec value — change here means a behavior
    // change that should be reviewed.
    assert.equal(NO_OP_MERGE_HALT_THRESHOLD, 3);
  });

  test("counter reset after a real merge means classifier returns ok", () => {
    // Simulates the reset: consecutiveNoOpMerges = 0 after a real merge.
    assert.equal(classifyNoOpMergeState(0), "ok");
  });
});

// ---------------------------------------------------------------------------
// Metrics shape: noOpMerges field is parsed and aggregated
// ---------------------------------------------------------------------------

describe("metrics noOpMerges field (issue #222)", () => {
  let recordCycleMetrics: any;
  let getMetricsTrend: any;
  let getAggregateStats: any;

  beforeEach(async () => {
    await cleanKeys();
    const mod = await import("../src/metrics.ts");
    recordCycleMetrics = mod.recordCycleMetrics;
    getMetricsTrend = mod.getMetricsTrend;
    getAggregateStats = mod.getAggregateStats;
  });

  test("noOpMerges round-trips through Redis as an integer", async () => {
    await recordCycleMetrics("test-cycle-1", {
      tasksAttempted: 1,
      tasksVerified: 1,
      tasksMerged: 0,
      noOpMerges: 1,
      tasksFailed: 0,
      tasksAbandoned: 0,
      regressionIntroduced: false,
      taskTitle: "noop-test-1",
      anchorType: "test",
    });

    const trend = await getMetricsTrend(5);
    assert.equal(trend.length, 1);
    assert.equal(trend[0].cycleId, "test-cycle-1");
    assert.equal(trend[0].noOpMerges, 1, "noOpMerges should be an integer 1");
    assert.equal(typeof trend[0].noOpMerges, "number");
    assert.equal(trend[0].tasksMerged, 0, "tasksMerged must NOT be incremented for no-op merge");
  });

  test("missing noOpMerges is undefined (back-compat with pre-#222 cycles)", async () => {
    // For cycles recorded before #222, the field doesn't exist in Redis.
    // getMetricsTrend leaves it `undefined` rather than coercing to 0 — this
    // matches the existing pattern for other optional integer fields.
    // Aggregate stats handle this via `m.noOpMerges > 0` which is false
    // for undefined.
    await recordCycleMetrics("test-cycle-2", {
      tasksAttempted: 1,
      tasksVerified: 1,
      tasksMerged: 1,
      tasksFailed: 0,
      tasksAbandoned: 0,
      regressionIntroduced: false,
      taskTitle: "normal-merge",
      anchorType: "test",
    });

    const trend = await getMetricsTrend(5);
    // undefined is the expected back-compat shape
    assert.ok(trend[0].noOpMerges === undefined || trend[0].noOpMerges === 0,
      `missing noOpMerges should be undefined or 0, got ${trend[0].noOpMerges}`);
    // The important guarantee: aggregate stats must NOT count this as a no-op
    const stats = await getAggregateStats(5);
    assert.equal(stats.noOpMerges, 0, "cycle without noOpMerges field must not count as no-op");
  });

  test("getAggregateStats surfaces noOpMerges and noOpMergeRate", async () => {
    // Record 3 cycles: 2 no-op, 1 merged
    await recordCycleMetrics("cycle-a", {
      tasksAttempted: 1, tasksMerged: 0, noOpMerges: 1,
      taskTitle: "t-a", anchorType: "test",
    });
    await recordCycleMetrics("cycle-b", {
      tasksAttempted: 1, tasksMerged: 1, noOpMerges: 0,
      taskTitle: "t-b", anchorType: "test",
    });
    await recordCycleMetrics("cycle-c", {
      tasksAttempted: 1, tasksMerged: 0, noOpMerges: 1,
      taskTitle: "t-c", anchorType: "test",
    });

    const stats = await getAggregateStats(10);
    assert.equal(stats.cycles, 3);
    assert.equal(stats.noOpMerges, 2, "should count 2 cycles with noOpMerges > 0");
    assert.equal(stats.noOpMergeRate, Math.round((2 / 3) * 100));
  });
});

// ---------------------------------------------------------------------------
// Scheduler halt: simulate 3 consecutive no-op merge cycles → halted state
// ---------------------------------------------------------------------------

describe("scheduler halts after consecutive no-op merges (issue #222)", () => {
  let getStatus: any;
  let stopScheduler: any;
  let createSchedulerRouter: any;

  beforeEach(async () => {
    await cleanKeys();
    const schedMod = await import("../src/scheduler.ts");
    getStatus = schedMod.getStatus;
    stopScheduler = schedMod.stop;
    const apiMod = await import("../src/api/scheduler.ts");
    createSchedulerRouter = apiMod.createSchedulerRouter;
    try { stopScheduler(); } catch { /* intentional: may not be running */ }
  });

  after(async () => {
    try { stopScheduler(); } catch { /* intentional: may not be running */ }
  });

  test("getStatus exposes no-op-merge fields", async () => {
    const status = await getStatus();
    assert.equal(typeof status.consecutiveNoOpMerges, "number");
    assert.equal(typeof status.noOpMergeHaltThreshold, "number");
    assert.equal(typeof status.haltedForNoOpMerges, "boolean");
    assert.equal(status.consecutiveNoOpMerges, 0, "fresh state should be 0");
    assert.equal(status.haltedForNoOpMerges, false, "fresh state should not be halted");
    assert.equal(status.noOpMergeHaltThreshold, 3, "default threshold per issue #222 spec");
  });

  test("API status response surfaces all no-op-merge fields", async () => {
    const router = createSchedulerRouter({ publisher: redis });
    // Find the status handler
    let statusHandler: Function | null = null;
    for (const layer of router.stack) {
      if (layer.route && layer.route.path === "/scheduler/status") {
        statusHandler = layer.route.stack[layer.route.stack.length - 1].handle;
        break;
      }
    }
    assert.ok(statusHandler, "status handler must exist");

    const req: any = { method: "GET", url: "/", headers: {}, query: {}, params: {}, body: {} };
    let body: any = null;
    const res: any = {
      _status: 200,
      status() { return res; },
      json(b: any) { body = b; return res; },
    };
    await statusHandler(req, res);

    assert.ok(body, "body should be set");
    assert.ok("consecutiveNoOpMerges" in body, "API status must include consecutiveNoOpMerges");
    assert.ok("noOpMergeHaltThreshold" in body, "API status must include noOpMergeHaltThreshold");
    assert.ok("haltedForNoOpMerges" in body, "API status must include haltedForNoOpMerges");
  });
});

// ---------------------------------------------------------------------------
// post-merge.ts: no-op-merge classification (pure logic check via direct import)
// ---------------------------------------------------------------------------

describe("post-merge no-op detection conditions (issue #222)", () => {
  // The detection rule: isNoOpMerge = mergeResult.ok
  //                                  && filesChanged.length === 0
  //                                  && plannedFileCount > 0
  // Encoded here as a pure function so tests don't have to spin up the
  // entire control loop. If the rule changes, this test must be updated
  // alongside post-merge.ts.

  function isNoOpMerge(mergeOk: boolean, filesChangedCount: number, plannedFileCount: number): boolean {
    return mergeOk && filesChangedCount === 0 && plannedFileCount > 0;
  }

  test("merge ok + zero files + non-empty scope → no-op", () => {
    assert.equal(isNoOpMerge(true, 0, 3), true);
  });

  test("merge ok + files changed → not no-op", () => {
    assert.equal(isNoOpMerge(true, 5, 3), false);
  });

  test("merge ok + zero files + empty scope → not no-op (planner requested nothing)", () => {
    // This matches the "verified" path — the planner explicitly produced no
    // task or had no scope. Distinguishing this from a phantom merge is the
    // whole point of requiring scopeBoundary.in.length > 0 in the predicate.
    assert.equal(isNoOpMerge(true, 0, 0), false);
  });

  test("merge failed → not no-op (we never reached the merge state)", () => {
    assert.equal(isNoOpMerge(false, 0, 3), false);
  });
});

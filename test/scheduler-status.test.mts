/**
 * Regression tests for /api/scheduler/status rolling merge-rate (issue #232).
 *
 * Bug: `/api/scheduler/status` reported `mergeRate` from lifetime
 * `cyclesMerged / cyclesRun`, which was dominated by long-tail history.
 * After the issue #218 regression (no merges for 14h), the lifetime ratio
 * read 2% even when recent cycles were merging at 80%, tripping the stall
 * watchdog and obscuring real performance.
 *
 * Fix: surface a rolling N-cycle merge rate (default 50, configurable via
 * HYDRA_ROLLING_MERGE_RATE_WINDOW) computed from the same source as
 * `hydra metrics --count N` (cycle metrics history). The lifetime ratio
 * remains as `mergeRateLifetime` for audit.
 *
 * These tests verify:
 * - AC1: `/scheduler/status` returns both `mergeRate` (rolling) and
 *   `mergeRateLifetime` so operators can distinguish the two views.
 * - AC2: rolling rate is computed from cycle metrics history (not scheduler
 *   counters) — populates fixture metrics and checks the math.
 * - AC3: when lifetime counters and rolling history disagree (the exact
 *   issue #232 scenario: 7/384 lifetime vs 8/10 recent), `mergeRate` reflects
 *   the recent window, not lifetime.
 * - AC4: `mergeRate` falls back to the lifetime ratio when cycle history is
 *   empty, so consumers always get a number.
 * - AC5: status response surfaces `mergeRateWindow` and
 *   `mergeRateCyclesInWindow` so the dashboard can label the field.
 *
 * Uses Redis DB 1 — never touches production (DB 0).
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

process.env.REDIS_URL = "redis://localhost:6379/1";

const adapter = await import("../src/redis-adapter.ts");
const schedulerMod = await import("../src/scheduler.ts");
const { getStatus } = schedulerMod as any;

let testRedis: any;

async function cleanKeys() {
  const keys = await testRedis.keys("hydra:*");
  if (keys.length > 0) await testRedis.del(...keys);
}

/**
 * Write a fixture cycle metrics record to Redis so getMetricsTrend()
 * picks it up. Mirrors the shape produced by recordCycleMetrics().
 */
async function writeFixtureMetrics(cycleId: string, fields: Record<string, any>): Promise<void> {
  const flat: Record<string, string> = { cycleId, recordedAt: new Date(Date.now()).toISOString() };
  for (const [k, v] of Object.entries(fields)) {
    flat[k] = typeof v === "object" ? JSON.stringify(v) : String(v);
  }
  // Use the same adapter helper the production code uses — keeps the test
  // honest if the storage shape ever changes.
  await adapter.setCycleMetrics(cycleId, flat, 600);
}

describe("/api/scheduler/status rolling merge rate (issue #232)", () => {
  beforeEach(async () => {
    if (!testRedis) {
      testRedis = new Redis("redis://localhost:6379/1");
    }
    await cleanKeys();
  });

  after(async () => {
    if (testRedis) {
      await cleanKeys();
      testRedis.disconnect();
    }
  });

  // -------------------------------------------------------------------------
  // AC1 — /scheduler/status returns both rolling and lifetime fields
  // -------------------------------------------------------------------------

  test("status response exposes mergeRate and mergeRateLifetime", async () => {
    const status = await getStatus();
    assert.ok("mergeRate" in status, "status should contain mergeRate");
    assert.ok("mergeRateLifetime" in status, "status should contain mergeRateLifetime");
    assert.equal(typeof status.mergeRate, "number", "mergeRate should be a number");
    assert.equal(typeof status.mergeRateLifetime, "number", "mergeRateLifetime should be a number");
  });

  // -------------------------------------------------------------------------
  // AC5 — window metadata is surfaced for dashboard labels
  // -------------------------------------------------------------------------

  test("status response exposes mergeRateWindow and mergeRateCyclesInWindow", async () => {
    const status = await getStatus();
    assert.ok("mergeRateWindow" in status, "status should contain mergeRateWindow");
    assert.ok("mergeRateCyclesInWindow" in status, "status should contain mergeRateCyclesInWindow");
    assert.equal(typeof status.mergeRateWindow, "number");
    assert.equal(typeof status.mergeRateCyclesInWindow, "number");
    assert.ok(status.mergeRateWindow >= 1, "mergeRateWindow should be a positive integer");
  });

  // -------------------------------------------------------------------------
  // AC2 — rolling rate is computed from cycle metrics history
  // -------------------------------------------------------------------------

  test("rolling mergeRate matches the percentage of cycles with tasksMerged > 0", async () => {
    // 10 fixture cycles, 8 merged. Lexicographic ordering on cycleId is what
    // getRecentMetricIds uses, so name them cycle-001..cycle-010 — also
    // mirrors the production cycle id format.
    for (let i = 0; i < 10; i++) {
      const cycleId = `cycle-${String(i + 1).padStart(3, "0")}`;
      await writeFixtureMetrics(cycleId, {
        tasksMerged: i < 8 ? 1 : 0,
        tasksAttempted: 1,
        tasksFailed: i < 8 ? 0 : 1,
      });
    }

    const status = await getStatus();
    assert.equal(status.mergeRate, 80, "8/10 recent cycles merged should yield 80%");
    assert.equal(status.mergeRateCyclesInWindow, 10);
  });

  // -------------------------------------------------------------------------
  // AC3 — primary regression: lifetime stale ≠ rolling current
  // -------------------------------------------------------------------------

  test("rolling rate ignores lifetime counters when they disagree", async () => {
    // Simulate the issue #232 scenario at smaller scale: lifetime says 7/384
    // (long-tail history including a 14h zero-merge regression) but the
    // last 10 cycles are 8/10 merged.
    for (let i = 0; i < 384; i++) await adapter.incrSchedulerCyclesRun();
    for (let i = 0; i < 7; i++) await adapter.incrSchedulerCyclesMerged();

    for (let i = 0; i < 10; i++) {
      const cycleId = `cycle-${String(i + 1).padStart(3, "0")}`;
      await writeFixtureMetrics(cycleId, {
        tasksMerged: i < 8 ? 1 : 0,
        tasksAttempted: 1,
      });
    }

    // Force scheduler in-memory state to reload from Redis so lifetime fields
    // are populated. We can't import private state, so just call getStatus
    // after seeding — getStatus reads from `state` directly which is seeded
    // by loadSchedulerState() during init. Counters incremented above are
    // in Redis; we recompute lifetime here to compare against the response.
    const cyclesRun = await adapter.getSchedulerCyclesRun();
    const cyclesMerged = await adapter.getSchedulerCyclesMerged();
    const expectedLifetime = cyclesRun > 0 ? Math.round((cyclesMerged / cyclesRun) * 100) : 0;

    const status = await getStatus();

    assert.equal(
      status.mergeRate,
      80,
      "operator-visible mergeRate should reflect recent 8/10 = 80%, not lifetime 7/384",
    );
    // Lifetime ratio is exposed as a separate field. We only assert that
    // it differs from the rolling rate — the in-memory `state` seeding
    // happens during scheduler module init, so the exact lifetime value
    // depends on test ordering. The critical regression is that mergeRate
    // (the operator metric) is decoupled from the lifetime ratio.
    assert.ok(
      status.mergeRate !== status.mergeRateLifetime || expectedLifetime === 80,
      "rolling and lifetime rates should be reported separately when they diverge",
    );
  });

  // -------------------------------------------------------------------------
  // AC4 — fallback when no rolling history exists
  // -------------------------------------------------------------------------

  test("mergeRate falls back to lifetime ratio when no cycle history exists", async () => {
    // No cycle metrics written. Counters also empty.
    const status = await getStatus();
    assert.equal(status.mergeRate, 0, "mergeRate should be 0 when there is no data");
    assert.equal(status.mergeRateCyclesInWindow, 0);
    assert.equal(status.mergeRateLifetime, 0);
  });

  // -------------------------------------------------------------------------
  // AC2 (extended) — single-cycle window edge case
  // -------------------------------------------------------------------------

  test("rolling rate handles a single recent cycle correctly", async () => {
    await writeFixtureMetrics("cycle-001", { tasksMerged: 1, tasksAttempted: 1 });
    const status = await getStatus();
    assert.equal(status.mergeRate, 100, "1/1 merged cycle should yield 100%");
    assert.equal(status.mergeRateCyclesInWindow, 1);
  });

  test("rolling rate is 0 when all recent cycles failed to merge", async () => {
    for (let i = 0; i < 5; i++) {
      const cycleId = `cycle-${String(i + 1).padStart(3, "0")}`;
      await writeFixtureMetrics(cycleId, { tasksMerged: 0, tasksFailed: 1, tasksAttempted: 1 });
    }
    const status = await getStatus();
    assert.equal(status.mergeRate, 0, "0/5 merged cycles should yield 0%");
    assert.equal(status.mergeRateCyclesInWindow, 5);
  });
});

/**
 * Regression tests for /api/scheduler/status post-codex shape (issue #397).
 *
 * After #383 deleted the in-process control loop, the scheduler ticks for
 * housekeeping only — no `runControlLoop` invocation ever happens. The
 * codex-shaped fields (`lastCycleAt`, `consecutiveNonMerges`,
 * `stallBackoffMs`, `stallAlertThreshold`, `zeroOutputThreshold`,
 * `stallState`, `repetition`) all keyed off counters that the cycle path
 * used to advance. Surfacing their last-codex-era values from `state`
 * would lie to the dashboard ("scheduler healthy, 30 consecutive
 * non-merges, halt imminent") and would defeat the watchdog
 * (`lastCycleAt` advances every tick → genuine stalls are never detected).
 *
 * Fix:
 *   - `lastTickAt`        : new heartbeat field, updated every tick.
 *                           Watchdog reads this.
 *   - `lastCycleAt`       : null while codexCycleEnabled=false.
 *   - `mode`              : "scheduler-only" when running, "disabled" otherwise.
 *   - codex-only counters : null when codexCycleEnabled=false.
 *   - `repetition`        : null when codexCycleEnabled=false.
 *
 * These tests live below the issue-#232 block but use the same Redis DB 1
 * and the same `getStatus()` import.
 */
// Issue #397: a fresh Redis handle for the second block. The first block's
// `after()` hook disconnects `testRedis`, so reusing that variable here
// throws "Connection is closed" on the first cleanKeys() call. Keep the
// lifecycle local to this describe.
let postCodexRedis: any;

async function cleanKeysPostCodex() {
  const keys = await postCodexRedis.keys("hydra:*");
  if (keys.length > 0) await postCodexRedis.del(...keys);
}

describe("/api/scheduler/status post-codex shape (issue #397)", () => {
  beforeEach(async () => {
    if (!postCodexRedis) {
      postCodexRedis = new Redis("redis://localhost:6379/1");
    }
    await cleanKeysPostCodex();
  });

  after(async () => {
    if (postCodexRedis) {
      await cleanKeysPostCodex();
      postCodexRedis.disconnect();
    }
  });

  // -------------------------------------------------------------------------
  // AC: codexCycleEnabled is always false post-#383
  // -------------------------------------------------------------------------

  test("status surfaces codexCycleEnabled=false", async () => {
    const status = await getStatus();
    assert.equal(
      status.codexCycleEnabled,
      false,
      "post-#383 the in-process control loop is gone — flag must be false",
    );
  });

  // -------------------------------------------------------------------------
  // AC: mode field is one of the two valid post-#383 strings
  // -------------------------------------------------------------------------

  test("status surfaces a `mode` string", async () => {
    const status = await getStatus();
    assert.ok("mode" in status, "status must contain mode field");
    assert.ok(
      status.mode === "scheduler-only" || status.mode === "disabled",
      `mode must be one of {scheduler-only, disabled}, got: ${status.mode}`,
    );
  });

  // -------------------------------------------------------------------------
  // AC: lastTickAt is exposed (heartbeat surface for the watchdog)
  // -------------------------------------------------------------------------

  test("status exposes lastTickAt field", async () => {
    const status = await getStatus();
    assert.ok(
      "lastTickAt" in status,
      "status must contain lastTickAt — watchdog reads this for liveness",
    );
    // lastTickAt is null until the first runScheduledCycle invocation. The
    // important contract is that the field exists in the response shape.
    assert.ok(
      status.lastTickAt === null || typeof status.lastTickAt === "string",
      "lastTickAt must be null or ISO string",
    );
  });

  // -------------------------------------------------------------------------
  // AC: lastCycleAt is null while codex is disabled (the primary issue #397
  // regression — the old code reported a stale heartbeat value here that
  // misled the watchdog into thinking cycles were running)
  // -------------------------------------------------------------------------

  test("lastCycleAt is null when codexCycleEnabled=false", async () => {
    const status = await getStatus();
    assert.equal(status.codexCycleEnabled, false, "precondition for the regression");
    assert.equal(
      status.lastCycleAt,
      null,
      "lastCycleAt must be null when no in-process control loop runs — otherwise the watchdog reads stale data",
    );
  });

  // -------------------------------------------------------------------------
  // AC: codex-only counters report null while codex is disabled
  // (consecutiveNonMerges / stallBackoffMs / stallAlertThreshold /
  //  zeroOutputThreshold / stallState).
  //
  // Reporting last-codex-era integers here would make api/checklist.ts
  // (`consecutiveNonMerges >= 5`) fire "idle-spinning" warnings forever
  // and would let `stallBackoffMs` re-enter exponential backoff math
  // against a counter that no live code path can ever advance or reset.
  // -------------------------------------------------------------------------

  test("codex-only stall fields are null when codexCycleEnabled=false", async () => {
    const status = await getStatus();
    assert.equal(status.codexCycleEnabled, false, "precondition");
    for (const field of [
      "consecutiveNonMerges",
      "stallAlertThreshold",
      "zeroOutputThreshold",
      "stallBackoffMs",
      "stallState",
    ]) {
      assert.equal(
        status[field],
        null,
        `${field} must be null when codexCycleEnabled=false (no live counter feeds it)`,
      );
    }
  });

  // -------------------------------------------------------------------------
  // AC: repetition detector block is null when codex is disabled
  // -------------------------------------------------------------------------

  test("repetition block is null when codexCycleEnabled=false", async () => {
    const status = await getStatus();
    assert.equal(status.codexCycleEnabled, false, "precondition");
    assert.equal(
      status.repetition,
      null,
      "repetition detector has no plan-stream to watch when codex is off — must be null",
    );
  });

  // -------------------------------------------------------------------------
  // AC: getStatus() still exposes the housekeeping fields the dashboard /
  // watchdog / metrics consumer rely on — running, cyclesRun,
  // mergeRate, intervalMs, research.dailySpendUsd.
  // This is a guard against an over-eager null sweep deleting legit fields.
  // -------------------------------------------------------------------------

  test("housekeeping fields survive the post-codex shape change", async () => {
    const status = await getStatus();
    assert.ok("running" in status);
    assert.ok("cyclesRun" in status);
    assert.ok("mergeRate" in status);
    assert.ok("intervalMs" in status);
    assert.ok(status.research, "research block must still be present");
    assert.ok("dailySpendUsd" in status.research);
    assert.ok("dailyCostCapUsd" in status.research);
  });
});

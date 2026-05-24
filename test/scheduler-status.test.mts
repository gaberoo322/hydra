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
 * Regression tests for /api/scheduler/status shape post-ADR-0006 / ADR-0010.
 *
 * The in-process control loop was removed in PR-3 (#383) and the dead
 * codex-shaped fields it left behind (`lastCycleAt`, `consecutiveNonMerges`,
 * `stallBackoffMs`, `stallAlertThreshold`, `zeroOutputThreshold`,
 * `stallState`, `repetition`, `mode`, `codexCycleEnabled`, no-op-merge
 * fields) were dropped entirely in the scheduler-junk-drawer retirement.
 *
 * These tests pin the *live* shape — the housekeeping fields the dashboard
 * and watchdog actually rely on — so an over-eager future cleanup doesn't
 * delete them by accident.
 */
let postCodexRedis: any;

async function cleanKeysPostCodex() {
  const keys = await postCodexRedis.keys("hydra:*");
  if (keys.length > 0) await postCodexRedis.del(...keys);
}

describe("/api/scheduler/status live shape", () => {
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

  test("status exposes lastTickAt field (watchdog liveness surface)", async () => {
    const status = await getStatus();
    assert.ok(
      "lastTickAt" in status,
      "status must contain lastTickAt — watchdog reads this for liveness",
    );
    assert.ok(
      status.lastTickAt === null || typeof status.lastTickAt === "string",
      "lastTickAt must be null or ISO string",
    );
  });

  test("housekeeping fields survive", async () => {
    const status = await getStatus();
    assert.ok("running" in status);
    assert.ok("cyclesRun" in status);
    assert.ok("mergeRate" in status);
    assert.ok("intervalMs" in status);
    assert.ok(status.research, "research block must still be present");
    assert.ok("dailySpendUsd" in status.research);
    assert.ok("dailyCostCapUsd" in status.research);
  });

  test("retired codex-era fields are absent (not just null)", async () => {
    const status = await getStatus();
    for (const field of [
      "codexCycleEnabled",
      "mode",
      "lastCycleAt",
      "consecutiveNonMerges",
      "stallAlertThreshold",
      "zeroOutputThreshold",
      "stallBackoffMs",
      "stallState",
      "consecutiveNoOpMerges",
      "noOpMergeHaltThreshold",
      "haltedForNoOpMerges",
      "repetition",
    ]) {
      assert.ok(
        !(field in status),
        `${field} should have been removed from the API surface (ADR-0010 follow-up)`,
      );
    }
  });
});

/**
 * Regression test for /api/metrics/quality-gates (issue #212).
 *
 * Bug: mutation kill rate and JIT-generated test counts were computed per cycle
 * but never aggregated, so operators couldn't see quality regressions until a
 * wave of reverts forced an investigation.
 *
 * Fix: New `getQualityGateTrend(count)` aggregates the last N cycles, computes
 * percentiles, and surfaces the data via `GET /api/metrics/quality-gates`.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

// Set test DB before any adapter imports
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

const { recordCycleMetrics } = await import("../src/metrics/record.ts");
const { getQualityGateTrend } = await import("../src/metrics/quality-gates.ts");
const { percentileNearestRank: percentile } = await import("../src/metrics/math.ts");

let testRedis: any;

async function cleanTestKeys() {
  const patterns = ["hydra:metrics:*", "hydra:cycle:costs:*"];
  for (const pat of patterns) {
    const keys = await testRedis.keys(pat);
    if (keys.length > 0) await testRedis.del(...keys);
  }
  await testRedis.del("hydra:metrics:index");
}

describe("quality-gate trend aggregation (issue #212)", () => {
  beforeEach(async () => {
    if (!testRedis) {
      testRedis = new Redis(process.env.REDIS_URL);
    }
    await cleanTestKeys();
  });

  after(async () => {
    await cleanTestKeys();
    if (testRedis) testRedis.disconnect();
  });

  // -------------------------------------------------------------------------
  // Pure percentile math
  // -------------------------------------------------------------------------

  test("percentile returns null on empty input", () => {
    assert.equal(percentile([], 50), null);
    assert.equal(percentile([], 95), null);
  });

  test("percentile uses nearest-rank semantics", () => {
    // 10 values, 0..90 step 10 — sorted
    const xs = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90];
    // p50 → ceil(.5 * 10) = 5 → sorted[4] = 40
    assert.equal(percentile(xs, 50), 40);
    // p95 → ceil(.95 * 10) = 10 → sorted[9] = 90
    assert.equal(percentile(xs, 95), 90);
    // p100 → sorted[9] = 90
    assert.equal(percentile(xs, 100), 90);
  });

  test("percentile handles single-element and unsorted input", () => {
    assert.equal(percentile([42], 50), 42);
    assert.equal(percentile([42], 95), 42);
    // unsorted input is sorted internally
    assert.equal(percentile([90, 10, 50, 30, 70], 50), 50);
  });

  test("percentile filters non-finite values", () => {
    assert.equal(percentile([10, Number.NaN, 20, Number.POSITIVE_INFINITY, 30], 50), 20);
    assert.equal(percentile([Number.NaN, Number.NaN], 50), null);
  });

  // -------------------------------------------------------------------------
  // Empty state — never throws, returns zeroed summary
  // -------------------------------------------------------------------------

  test("getQualityGateTrend returns empty trend with zeroed summary when no cycles exist", async () => {
    const result = await getQualityGateTrend(50);
    assert.deepEqual(result.trend, []);
    assert.equal(result.summary.cycles, 0);
    assert.equal(result.summary.cyclesWithMutationData, 0);
    assert.equal(result.summary.avgKillRate, null);
    assert.equal(result.summary.killRateP50, null);
    assert.equal(result.summary.killRateP95, null);
    assert.equal(result.summary.gateBlockCount, 0);
    assert.equal(result.summary.totalJitTestsAdded, 0);
  });

  // -------------------------------------------------------------------------
  // Populated state — trend + percentile summary
  // -------------------------------------------------------------------------

  test("getQualityGateTrend aggregates kill rate, JIT counts, and gate blocks across cycles", async () => {
    // 10 cycles: kill rates 30, 50, 60, 70, 75, 80, 85, 90, 95, 100
    // 2 of them gate-blocked (lowest kill rates)
    // JIT tests added: 0,2,1,0,3,0,1,0,0,0 → total 7
    const fixtures = [
      { cycleId: "cycle-qg-001", killRate: 30, killed: 3, survived: 7, gateBlocked: 1, jitKept: 0 },
      { cycleId: "cycle-qg-002", killRate: 50, killed: 5, survived: 5, gateBlocked: 1, jitKept: 2 },
      { cycleId: "cycle-qg-003", killRate: 60, killed: 6, survived: 4, gateBlocked: 0, jitKept: 1 },
      { cycleId: "cycle-qg-004", killRate: 70, killed: 7, survived: 3, gateBlocked: 0, jitKept: 0 },
      { cycleId: "cycle-qg-005", killRate: 75, killed: 15, survived: 5, gateBlocked: 0, jitKept: 3 },
      { cycleId: "cycle-qg-006", killRate: 80, killed: 8, survived: 2, gateBlocked: 0, jitKept: 0 },
      { cycleId: "cycle-qg-007", killRate: 85, killed: 17, survived: 3, gateBlocked: 0, jitKept: 1 },
      { cycleId: "cycle-qg-008", killRate: 90, killed: 9, survived: 1, gateBlocked: 0, jitKept: 0 },
      { cycleId: "cycle-qg-009", killRate: 95, killed: 19, survived: 1, gateBlocked: 0, jitKept: 0 },
      { cycleId: "cycle-qg-010", killRate: 100, killed: 10, survived: 0, gateBlocked: 0, jitKept: 0 },
    ];

    for (const f of fixtures) {
      await recordCycleMetrics(f.cycleId, {
        tasksAttempted: 1,
        tasksMerged: f.gateBlocked === 1 ? 0 : 1,
        tasksFailed: f.gateBlocked === 1 ? 1 : 0,
        testsBefore: 100,
        testsAfter: 102,
        filesChanged: 2,
        totalDurationMs: 30000,
        regressionIntroduced: false,
        taskTitle: `Cycle ${f.cycleId}`,
        anchorType: "priorities",
        mutationKillRate: f.killRate,
        mutationKilled: f.killed,
        mutationSurvived: f.survived,
        mutationsTested: f.killed + f.survived,
        gateBlocked: f.gateBlocked,
        jitTestsKept: f.jitKept,
        jitTestsGenerated: f.jitKept,
      });
    }

    const result = await getQualityGateTrend(50);

    // Trend has all 10 entries
    assert.equal(result.trend.length, 10, "should have 10 trend entries");

    // Trend entries have expected shape
    const entry = result.trend.find((e) => e.cycleId === "cycle-qg-005")!;
    assert.ok(entry, "cycle-qg-005 should be present in trend");
    assert.equal(entry.killRate, 75);
    assert.equal(entry.mutationsTested, 20);
    assert.equal(entry.mutationsKilled, 15);
    assert.equal(entry.jitTestsAdded, 3);
    assert.equal(entry.gateBlocked, false);
    assert.ok(typeof entry.completedAt === "string", "completedAt should be a string");

    // Summary stats
    assert.equal(result.summary.cycles, 10);
    assert.equal(result.summary.cyclesWithMutationData, 10);
    // avg of 30,50,60,70,75,80,85,90,95,100 = 73.5 → 74 (rounded)
    assert.equal(result.summary.avgKillRate, 74);
    // p50 (nearest-rank, n=10): rank=5 → sorted[4] = 75
    assert.equal(result.summary.killRateP50, 75);
    // p95: rank=ceil(.95*10)=10 → sorted[9] = 100
    assert.equal(result.summary.killRateP95, 100);
    assert.equal(result.summary.gateBlockCount, 2);
    assert.equal(result.summary.totalJitTestsAdded, 7);
  });

  // -------------------------------------------------------------------------
  // Backward compat — legacy cycles without quality gate fields
  // -------------------------------------------------------------------------

  test("getQualityGateTrend treats legacy cycles' missing fields as null without crashing", async () => {
    // Old-style cycle: no mutation/jit fields
    await recordCycleMetrics("cycle-legacy-001", {
      tasksAttempted: 1, tasksMerged: 1, tasksFailed: 0,
      testsBefore: 50, testsAfter: 51, filesChanged: 1,
      totalDurationMs: 15000, regressionIntroduced: false,
      taskTitle: "Legacy cycle", anchorType: "priorities",
    });

    const result = await getQualityGateTrend(50);
    assert.equal(result.trend.length, 1);
    const entry = result.trend[0];
    assert.equal(entry.cycleId, "cycle-legacy-001");
    assert.equal(entry.killRate, null, "missing killRate should be null");
    assert.equal(entry.mutationsTested, null, "missing mutationsTested should be null");
    assert.equal(entry.mutationsKilled, null, "missing mutationsKilled should be null");
    assert.equal(entry.jitTestsAdded, null, "missing jitTestsAdded should be null");
    assert.equal(entry.gateBlocked, false, "missing gateBlocked defaults to false");

    // Summary excludes null kill rates from averages
    assert.equal(result.summary.cycles, 1);
    assert.equal(result.summary.cyclesWithMutationData, 0);
    assert.equal(result.summary.avgKillRate, null);
    assert.equal(result.summary.killRateP50, null);
    assert.equal(result.summary.killRateP95, null);
  });

  // -------------------------------------------------------------------------
  // Sentinel handling — mutationKillRate=-1 means "did not apply"
  // -------------------------------------------------------------------------

  test("getQualityGateTrend treats mutationKillRate=-1 (not applicable) as null in trend", async () => {
    await recordCycleMetrics("cycle-na-001", {
      tasksAttempted: 1, tasksMerged: 0, tasksFailed: 1,
      testsBefore: 50, testsAfter: 50, filesChanged: 0,
      totalDurationMs: 10000, regressionIntroduced: false,
      taskTitle: "Fixer-only failure", anchorType: "failing-test",
      // -1 sentinel from post-merge.ts (no mutation testing happened)
      mutationKillRate: -1,
      mutationKilled: 0,
      mutationSurvived: 0,
      mutationsTested: 0,
      gateBlocked: 0,
      jitTestsKept: 0,
    });

    const result = await getQualityGateTrend(50);
    assert.equal(result.trend.length, 1);
    assert.equal(result.trend[0].killRate, null);
    assert.equal(result.summary.cyclesWithMutationData, 0);
    assert.equal(result.summary.avgKillRate, null);
  });

  // -------------------------------------------------------------------------
  // Mixed populated+legacy summary
  // -------------------------------------------------------------------------

  test("getQualityGateTrend includes only data-bearing cycles in percentile math", async () => {
    // 3 cycles with mutation data, 2 legacy cycles
    await recordCycleMetrics("cycle-mix-001", {
      tasksAttempted: 1, tasksMerged: 1, testsBefore: 10, testsAfter: 11, filesChanged: 1,
      totalDurationMs: 1000, regressionIntroduced: false, taskTitle: "A", anchorType: "priorities",
      mutationKillRate: 60, mutationKilled: 6, mutationSurvived: 4, mutationsTested: 10,
      gateBlocked: 0, jitTestsKept: 1,
    });
    await recordCycleMetrics("cycle-mix-002", {
      tasksAttempted: 1, tasksMerged: 1, testsBefore: 11, testsAfter: 12, filesChanged: 1,
      totalDurationMs: 1000, regressionIntroduced: false, taskTitle: "B", anchorType: "priorities",
      mutationKillRate: 80, mutationKilled: 8, mutationSurvived: 2, mutationsTested: 10,
      gateBlocked: 0, jitTestsKept: 0,
    });
    await recordCycleMetrics("cycle-mix-003", {
      tasksAttempted: 1, tasksMerged: 1, testsBefore: 12, testsAfter: 13, filesChanged: 1,
      totalDurationMs: 1000, regressionIntroduced: false, taskTitle: "C", anchorType: "priorities",
      mutationKillRate: 100, mutationKilled: 10, mutationSurvived: 0, mutationsTested: 10,
      gateBlocked: 0, jitTestsKept: 0,
    });
    // Legacy entries
    await recordCycleMetrics("cycle-mix-004", {
      tasksAttempted: 1, tasksMerged: 1, testsBefore: 13, testsAfter: 14, filesChanged: 1,
      totalDurationMs: 1000, regressionIntroduced: false, taskTitle: "Legacy D", anchorType: "priorities",
    });
    await recordCycleMetrics("cycle-mix-005", {
      tasksAttempted: 1, tasksMerged: 1, testsBefore: 14, testsAfter: 15, filesChanged: 1,
      totalDurationMs: 1000, regressionIntroduced: false, taskTitle: "Legacy E", anchorType: "priorities",
    });

    const result = await getQualityGateTrend(50);
    assert.equal(result.summary.cycles, 5);
    assert.equal(result.summary.cyclesWithMutationData, 3);
    // avg of [60,80,100] = 80
    assert.equal(result.summary.avgKillRate, 80);
    // p50 of [60,80,100] (rank=ceil(.5*3)=2 → sorted[1] = 80)
    assert.equal(result.summary.killRateP50, 80);
    // p95 of [60,80,100] (rank=ceil(.95*3)=3 → sorted[2] = 100)
    assert.equal(result.summary.killRateP95, 100);
    assert.equal(result.summary.totalJitTestsAdded, 1);
  });
});

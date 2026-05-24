/**
 * Regression test for quality-gate coverage observability (issue #287).
 *
 * Bug: `qualityGateCoverageRate` reported 33% with only 3 of 20 cycles
 * contributing samples — every early-exit path (verification failure, drift,
 * planner no-work, preflight reject, cost-cap) dropped out of the denominator
 * because they never recorded `qualityGateCoverage`. The rate was biased
 * upward toward whichever cycles happened to reach post-merge.
 *
 * Fix: `recordCycleMetrics` now auto-derives `qualityGateCoverage` per cycle:
 *   - mutation OR JIT actually ran            → "true"   (covered)
 *   - verification ran but neither gate ran   → "false"  (not covered)
 *   - verification did not run                → absent   (not applicable)
 *
 * `getAggregateStats` exposes three counters (covered / not-covered /
 * not-applicable) so dashboards can show absolute counts, not just the ratio.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

// Set test DB before any adapter imports
process.env.REDIS_URL = "redis://localhost:6379/1";

const { recordCycleMetrics } = await import("../src/metrics/record.ts");
const { getMetricsTrend } = await import("../src/metrics/trend.ts");
const { getAggregateStats } = await import("../src/metrics/aggregate.ts");
const { deriveQualityGateCoverage } = await import("../src/metrics/quality-gates.ts");

let testRedis: any;

async function cleanTestKeys() {
  const patterns = ["hydra:metrics:*", "hydra:cycle:costs:*"];
  for (const pat of patterns) {
    const keys = await testRedis.keys(pat);
    if (keys.length > 0) await testRedis.del(...keys);
  }
  await testRedis.del("hydra:metrics:index");
}

describe("quality gate coverage observability (issue #287)", () => {
  beforeEach(async () => {
    if (!testRedis) testRedis = new Redis("redis://localhost:6379/1");
    await cleanTestKeys();
  });

  after(async () => {
    await cleanTestKeys();
    if (testRedis) testRedis.disconnect();
  });

  // -------------------------------------------------------------------------
  // Pure-function tests for deriveQualityGateCoverage
  // -------------------------------------------------------------------------

  describe("deriveQualityGateCoverage", () => {
    test("preserves explicit boolean true", () => {
      assert.equal(deriveQualityGateCoverage({ qualityGateCoverage: true }), "true");
    });

    test("preserves explicit boolean false", () => {
      assert.equal(deriveQualityGateCoverage({ qualityGateCoverage: false }), "false");
    });

    test("preserves explicit string 'true'", () => {
      assert.equal(deriveQualityGateCoverage({ qualityGateCoverage: "true" }), "true");
    });

    test("preserves explicit string 'false'", () => {
      assert.equal(deriveQualityGateCoverage({ qualityGateCoverage: "false" }), "false");
    });

    test("returns 'true' when mutation actually ran", () => {
      assert.equal(deriveQualityGateCoverage({
        mutationDecision: "ran",
        verificationDurationMs: 1000,
      }), "true");
      assert.equal(deriveQualityGateCoverage({
        mutationsTested: 5,
        verificationDurationMs: 1000,
      }), "true");
      assert.equal(deriveQualityGateCoverage({
        mutationKillRate: 80,
        verificationDurationMs: 1000,
      }), "true");
    });

    test("returns 'true' when JIT actually ran", () => {
      assert.equal(deriveQualityGateCoverage({
        jitDecision: "ran: 2 tests added",
        verificationDurationMs: 1000,
      }), "true");
      assert.equal(deriveQualityGateCoverage({
        jitTestsKept: 1,
        verificationDurationMs: 1000,
      }), "true");
      assert.equal(deriveQualityGateCoverage({
        jitTestsCaughtBug: 1,
        verificationDurationMs: 1000,
      }), "true");
      assert.equal(deriveQualityGateCoverage({
        jitTestsGenerated: 3,
        verificationDurationMs: 1000,
      }), "true");
    });

    test("returns 'false' when verification ran but neither gate ran", () => {
      // Merged cycle without mutation run (e.g., quick-fix path historically)
      assert.equal(deriveQualityGateCoverage({
        tasksMerged: 1,
        verificationDurationMs: 5000,
      }), "false");
      // Verification failure path — verification ran, neither gate did
      assert.equal(deriveQualityGateCoverage({
        tasksFailed: 1,
        verificationDurationMs: 3000,
      }), "false");
    });

    test("returns undefined when verification did not run (abandoned pre-verification)", () => {
      // Drift-rejected cycle
      assert.equal(deriveQualityGateCoverage({
        tasksAttempted: 1,
        tasksAbandoned: 1,
        verificationDurationMs: 0,
        abandonReason: "Drift: similar to recent work",
      }), undefined);
      // Planner noWork
      assert.equal(deriveQualityGateCoverage({
        tasksAbandoned: 1,
        verificationDurationMs: 0,
        abandonReason: "Planner noWork: codebase-clean",
      }), undefined);
      // Preflight rejection
      assert.equal(deriveQualityGateCoverage({
        tasksAttempted: 1,
        tasksAbandoned: 1,
        verificationDurationMs: 0,
        abandonReason: "Preflight: scope too broad",
      }), undefined);
      // Cost-cap pre-execution
      assert.equal(deriveQualityGateCoverage({
        tasksAttempted: 1,
        tasksAbandoned: 1,
        verificationDurationMs: 0,
        abandonReason: "Cost cap tripped at pre-planner checkpoint",
      }), undefined);
    });

    test("returns undefined for legacy cycles with no useful signal", () => {
      assert.equal(deriveQualityGateCoverage({}), undefined);
      // tasksAttempted alone is not enough — could be drift/preflight reject
      assert.equal(deriveQualityGateCoverage({ tasksAttempted: 1 }), undefined);
    });
  });

  // -------------------------------------------------------------------------
  // Recording: verification-ran cycle without mutation run → false
  // -------------------------------------------------------------------------

  test("merged cycle without mutation run records qualityGateCoverage: false", async () => {
    const cycleId = "cycle-287-merged-no-mutation";

    // Simulate a merged cycle where neither mutation nor JIT ran (e.g., the
    // file count was zero or the language wasn't supported). Verification
    // DID run (we got past it to reach post-merge).
    await recordCycleMetrics(cycleId, {
      tasksAttempted: 1,
      tasksMerged: 1,
      tasksFailed: 0,
      tasksVerified: 1,
      tasksAbandoned: 0,
      testsBefore: 50,
      testsAfter: 50,
      filesChanged: 1,
      totalDurationMs: 30000,
      verificationDurationMs: 5000,
      regressionIntroduced: false,
      taskTitle: "Doc-only cycle",
      anchorType: "priorities",
      // Mutation/JIT did not run
      mutationKillRate: -1,
      mutationKilled: 0,
      mutationSurvived: 0,
      jitTestsGenerated: 0,
      jitTestsKept: 0,
    });

    const trend = await getMetricsTrend(1);
    const m = trend[0];

    assert.equal(m.qualityGateCoverage, false,
      "verification-ran cycle without gate must record explicit false");
  });

  // -------------------------------------------------------------------------
  // Recording: abandoned-pre-verification cycle → absent (not applicable)
  // -------------------------------------------------------------------------

  test("abandoned-pre-verification cycle leaves qualityGateCoverage absent", async () => {
    const cycleId = "cycle-287-drift-abandoned";

    // Drift-rejected cycle — verification never ran.
    await recordCycleMetrics(cycleId, {
      tasksAttempted: 1,
      tasksAbandoned: 1,
      tasksMerged: 0,
      tasksFailed: 0,
      tasksVerified: 0,
      testsBefore: 50,
      testsAfter: 50,
      filesChanged: 0,
      totalDurationMs: 2000,
      verificationDurationMs: 0,
      regressionIntroduced: false,
      taskTitle: "Drift-rejected task",
      anchorType: "priorities",
      abandonReason: "Drift: similar to recent work",
    });

    const trend = await getMetricsTrend(1);
    const m = trend[0];

    assert.equal(m.qualityGateCoverage, undefined,
      "pre-verification abandoned cycle must leave field absent (null / not-applicable)");
  });

  // -------------------------------------------------------------------------
  // Recording: verification-failure cycle → false (gate didn't run, but
  // verification did get past the executor)
  // -------------------------------------------------------------------------

  test("verification-failure cycle records qualityGateCoverage: false", async () => {
    const cycleId = "cycle-287-verification-failed";

    await recordCycleMetrics(cycleId, {
      tasksAttempted: 1,
      tasksFailed: 1,
      tasksMerged: 0,
      tasksVerified: 0,
      tasksAbandoned: 0,
      testsBefore: 50,
      testsAfter: 50,
      filesChanged: 0,
      totalDurationMs: 15000,
      verificationDurationMs: 8000,
      regressionIntroduced: false,
      taskTitle: "Failed verification",
      anchorType: "failing-test",
    });

    const trend = await getMetricsTrend(1);
    const m = trend[0];

    assert.equal(m.qualityGateCoverage, false,
      "verification-failure cycle should record explicit false (verification ran, gate did not)");
  });

  // -------------------------------------------------------------------------
  // Recording: mutation-ran cycle → true (preserved explicit signal)
  // -------------------------------------------------------------------------

  test("mutation-ran cycle records qualityGateCoverage: true", async () => {
    const cycleId = "cycle-287-mutation-ran";

    await recordCycleMetrics(cycleId, {
      tasksAttempted: 1,
      tasksMerged: 1,
      tasksVerified: 1,
      testsBefore: 50,
      testsAfter: 52,
      filesChanged: 2,
      totalDurationMs: 60000,
      verificationDurationMs: 10000,
      regressionIntroduced: false,
      taskTitle: "Real feature change",
      anchorType: "priorities",
      mutationDecision: "ran",
      mutationsTested: 8,
      mutationKilled: 6,
      mutationSurvived: 2,
      mutationKillRate: 75,
      jitTestsGenerated: 2,
      jitTestsKept: 1,
    });

    const trend = await getMetricsTrend(1);
    const m = trend[0];

    assert.equal(m.qualityGateCoverage, true,
      "mutation-ran cycle should record true");
  });

  // -------------------------------------------------------------------------
  // Recording: explicit boolean from caller is preserved
  // -------------------------------------------------------------------------

  test("explicit qualityGateCoverage from caller is preserved", async () => {
    // post-merge.ts already sets the string "true"/"false" explicitly via
    // computeQualityGateCoverage. Verify the derive logic preserves it.
    const cycleIdTrue = "cycle-287-explicit-true";
    const cycleIdFalse = "cycle-287-explicit-false";

    await recordCycleMetrics(cycleIdTrue, {
      tasksMerged: 1,
      tasksVerified: 1,
      verificationDurationMs: 5000,
      taskTitle: "Explicit true",
      anchorType: "priorities",
      qualityGateCoverage: "true",
    });

    await recordCycleMetrics(cycleIdFalse, {
      tasksMerged: 1,
      tasksVerified: 1,
      verificationDurationMs: 5000,
      taskTitle: "Explicit false",
      anchorType: "priorities",
      qualityGateCoverage: "false",
    });

    const trend = await getMetricsTrend(5);
    const t = trend.find((m) => m.cycleId === cycleIdTrue);
    const f = trend.find((m) => m.cycleId === cycleIdFalse);

    assert.equal(t?.qualityGateCoverage, true);
    assert.equal(f?.qualityGateCoverage, false);
  });

  // -------------------------------------------------------------------------
  // Aggregate distinguishes covered / not-covered / not-applicable
  // -------------------------------------------------------------------------

  test("getAggregateStats distinguishes covered / not-covered / not-applicable", async () => {
    // 2 covered, 1 not-covered, 1 not-applicable
    await recordCycleMetrics("agg-1", {
      tasksMerged: 1, tasksVerified: 1, verificationDurationMs: 5000,
      taskTitle: "covered-1", anchorType: "priorities",
      mutationDecision: "ran", mutationsTested: 5, mutationKillRate: 80,
    });
    await recordCycleMetrics("agg-2", {
      tasksMerged: 1, tasksVerified: 1, verificationDurationMs: 5000,
      taskTitle: "covered-2", anchorType: "priorities",
      jitTestsKept: 2, jitDecision: "ran: 2 tests added",
    });
    await recordCycleMetrics("agg-3", {
      tasksFailed: 1, verificationDurationMs: 3000,
      taskTitle: "not-covered", anchorType: "failing-test",
    });
    await recordCycleMetrics("agg-4", {
      tasksAbandoned: 1, verificationDurationMs: 0,
      taskTitle: "not-applicable", anchorType: "priorities",
      abandonReason: "Drift: similar to recent work",
    });

    const stats = await getAggregateStats(20);

    assert.equal(stats.cycles, 4, "should have 4 cycles total");
    assert.equal(stats.qualityGateCoverageCovered, 2, "2 covered");
    assert.equal(stats.qualityGateCoverageNotCovered, 1, "1 not-covered");
    assert.equal(stats.qualityGateCoverageNotApplicable, 1, "1 not-applicable");
    assert.equal(stats.qualityGateCoverageSamples, 3,
      "samples = covered + not-covered (excludes not-applicable)");
    // Rate is over samples (covered / samples) = 2/3 = 67%
    assert.equal(stats.qualityGateCoverageRate, 67,
      "rate should be covered / samples, not covered / cycles");
  });

  // -------------------------------------------------------------------------
  // The original symptom: with explicit recording, samples should not lag
  // wildly behind cycles for "real" workloads (where most cycles run
  // verification).
  // -------------------------------------------------------------------------

  test("samples covers most cycles when verification ran in each", async () => {
    // Simulate 5 verification-ran cycles (some merged, some failed, some
    // with mutation, some without). All should produce samples.
    for (let i = 0; i < 5; i++) {
      await recordCycleMetrics(`sample-cov-${i}`, {
        tasksMerged: i % 2 === 0 ? 1 : 0,
        tasksFailed: i % 2 === 0 ? 0 : 1,
        tasksVerified: i % 2 === 0 ? 1 : 0,
        verificationDurationMs: 5000,
        taskTitle: `cycle ${i}`,
        anchorType: "priorities",
        // Only every-other cycle actually runs mutation
        mutationDecision: i % 2 === 0 ? "ran" : "skipped: no files changed",
        mutationsTested: i % 2 === 0 ? 4 : 0,
      });
    }

    const stats = await getAggregateStats(20);
    assert.equal(stats.cycles, 5, "5 cycles total");
    assert.equal(stats.qualityGateCoverageSamples, 5,
      "all 5 cycles should be in the sample (verification ran for each)");
    assert.equal(stats.qualityGateCoverageNotApplicable, 0,
      "no cycle skipped verification, so none are not-applicable");
  });
});

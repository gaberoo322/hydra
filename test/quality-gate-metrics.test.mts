/**
 * Regression test for quality gate data in metrics API response (issue #181).
 *
 * Bug: Mutation testing results, fixer usage, scope filter actions, JIT test
 * generation results, and reconciliation status were computed during each cycle
 * but never recorded in the metrics Redis hash — so GET /api/metrics never
 * surfaced them.
 *
 * Fix: Thread quality gate fields through post-merge.ts → recordCycleMetrics()
 * and parse them back in getMetricsTrend().
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

// Set test DB before any adapter imports
process.env.REDIS_URL = "redis://localhost:6379/1";

const { recordCycleMetrics, getMetricsTrend } = await import("../src/metrics.ts");

let testRedis: any;

async function cleanTestKeys() {
  const patterns = ["hydra:metrics:*", "hydra:cycle:costs:*"];
  for (const pat of patterns) {
    const keys = await testRedis.keys(pat);
    if (keys.length > 0) await testRedis.del(...keys);
  }
  // Also clean the metrics index
  await testRedis.del("hydra:metrics:index");
}

describe("quality gate metrics (issue #181)", () => {
  beforeEach(async () => {
    if (!testRedis) {
      testRedis = new Redis("redis://localhost:6379/1");
    }
    await cleanTestKeys();
  });

  after(async () => {
    await cleanTestKeys();
    if (testRedis) testRedis.disconnect();
  });

  // -------------------------------------------------------------------------
  // Success path — all quality gate fields recorded and retrievable
  // -------------------------------------------------------------------------

  test("recordCycleMetrics stores quality gate fields on success path", async () => {
    const cycleId = "cycle-qg-success-001";

    await recordCycleMetrics(cycleId, {
      tasksAttempted: 1,
      tasksMerged: 1,
      tasksFailed: 0,
      tasksVerified: 1,
      tasksAbandoned: 0,
      testsBefore: 100,
      testsAfter: 102,
      filesChanged: 3,
      totalDurationMs: 45000,
      regressionIntroduced: false,
      taskTitle: "Add widget feature",
      anchorType: "priorities",
      // Quality gate fields (issue #181)
      mutationKillRate: 85,
      mutationKilled: 17,
      mutationSurvived: 3,
      fixerUsed: 0,
      fixerResolved: 0,
      scopeFilterCleaned: 2,
      jitTestsGenerated: 3,
      jitTestsKept: 2,
      jitTestsCaughtBug: 0,
      reconciliationStatus: "aligned",
    });

    const trend = await getMetricsTrend(1);
    assert.equal(trend.length, 1, "should have 1 cycle in trend");

    const m = trend[0];
    assert.equal(m.mutationKillRate, 85, "mutationKillRate should be 85");
    assert.equal(m.mutationKilled, 17, "mutationKilled should be 17");
    assert.equal(m.mutationSurvived, 3, "mutationSurvived should be 3");
    assert.equal(m.fixerUsed, 0, "fixerUsed should be 0 (not used)");
    assert.equal(m.fixerResolved, 0, "fixerResolved should be 0");
    assert.equal(m.scopeFilterCleaned, 2, "scopeFilterCleaned should be 2");
    assert.equal(m.jitTestsGenerated, 3, "jitTestsGenerated should be 3");
    assert.equal(m.jitTestsKept, 2, "jitTestsKept should be 2");
    assert.equal(m.reconciliationStatus, "aligned", "reconciliationStatus should be 'aligned'");
  });

  // -------------------------------------------------------------------------
  // Failure path — fixer used but didn't resolve
  // -------------------------------------------------------------------------

  test("records fixer usage on failure path", async () => {
    const cycleId = "cycle-qg-failure-001";

    await recordCycleMetrics(cycleId, {
      tasksAttempted: 1,
      tasksMerged: 0,
      tasksFailed: 1,
      tasksVerified: 0,
      tasksAbandoned: 0,
      testsBefore: 100,
      testsAfter: 100,
      filesChanged: 0,
      totalDurationMs: 30000,
      regressionIntroduced: false,
      taskTitle: "Fix broken widget",
      anchorType: "failing-test",
      // Quality gate fields — fixer used but failed
      mutationKillRate: -1,
      mutationKilled: 0,
      mutationSurvived: 0,
      fixerUsed: 1,
      fixerResolved: 0,
      scopeFilterCleaned: 0,
      jitTestsGenerated: 0,
      jitTestsKept: 0,
      jitTestsCaughtBug: 0,
      reconciliationStatus: "skipped",
    });

    const trend = await getMetricsTrend(1);
    assert.equal(trend.length, 1);

    const m = trend[0];
    assert.equal(m.fixerUsed, 1, "fixerUsed should be 1 (fixer was invoked)");
    assert.equal(m.fixerResolved, 0, "fixerResolved should be 0 (fixer did not resolve)");
    assert.equal(m.mutationKillRate, -1, "mutationKillRate should be -1 (not applicable)");
    assert.equal(m.reconciliationStatus, "skipped", "reconciliationStatus should be 'skipped'");
  });

  // -------------------------------------------------------------------------
  // Scope creep path — reconciliation detects scope creep
  // -------------------------------------------------------------------------

  test("records scope creep reconciliation status", async () => {
    const cycleId = "cycle-qg-scopecreep-001";

    await recordCycleMetrics(cycleId, {
      tasksAttempted: 1,
      tasksMerged: 1,
      tasksFailed: 0,
      testsBefore: 50,
      testsAfter: 52,
      filesChanged: 5,
      totalDurationMs: 60000,
      regressionIntroduced: false,
      taskTitle: "Refactor auth module",
      anchorType: "codebase-health",
      // Quality gate fields — scope creep detected
      mutationKillRate: 60,
      mutationKilled: 6,
      mutationSurvived: 4,
      fixerUsed: 1,
      fixerResolved: 1,
      scopeFilterCleaned: 3,
      jitTestsGenerated: 2,
      jitTestsKept: 1,
      jitTestsCaughtBug: 0,
      reconciliationStatus: "scopeCreep",
    });

    const trend = await getMetricsTrend(1);
    const m = trend[0];

    assert.equal(m.fixerUsed, 1, "fixerUsed should be 1");
    assert.equal(m.fixerResolved, 1, "fixerResolved should be 1 (fixer resolved the issue)");
    assert.equal(m.scopeFilterCleaned, 3, "scopeFilterCleaned should be 3");
    assert.equal(m.reconciliationStatus, "scopeCreep", "reconciliationStatus should be 'scopeCreep'");
    assert.equal(m.mutationKillRate, 60, "mutationKillRate should be 60");
    assert.equal(m.mutationSurvived, 4, "mutationSurvived should be 4");
  });

  // -------------------------------------------------------------------------
  // Backward compat — old cycles without quality gate fields still parse
  // -------------------------------------------------------------------------

  test("old cycles without quality gate fields are absent (not zero)", async () => {
    const cycleId = "cycle-qg-compat-001";

    // Simulate old-style metrics (no quality gate fields)
    await recordCycleMetrics(cycleId, {
      tasksAttempted: 1,
      tasksMerged: 1,
      tasksFailed: 0,
      testsBefore: 42,
      testsAfter: 42,
      filesChanged: 1,
      totalDurationMs: 15000,
      regressionIntroduced: false,
      taskTitle: "Legacy cycle",
      anchorType: "priorities",
    });

    const trend = await getMetricsTrend(1);
    const m = trend[0];

    // Quality gate fields should be absent (undefined) when not recorded —
    // consumers can distinguish "not recorded" from "recorded as 0"
    assert.equal(m.mutationKillRate, undefined, "missing mutationKillRate should be undefined");
    assert.equal(m.mutationKilled, undefined, "missing mutationKilled should be undefined");
    assert.equal(m.fixerUsed, undefined, "missing fixerUsed should be undefined");
    assert.equal(m.scopeFilterCleaned, undefined, "missing scopeFilterCleaned should be undefined");
    assert.equal(m.reconciliationStatus, undefined, "missing reconciliationStatus should be undefined");

    // Existing fields should still parse correctly
    assert.equal(m.tasksMerged, 1, "tasksMerged should still parse correctly");
    assert.equal(m.testsBefore, 42, "testsBefore should still parse correctly");
  });

  // -------------------------------------------------------------------------
  // Multiple cycles — trend preserves all fields across entries
  // -------------------------------------------------------------------------

  test("multiple cycles preserve quality gate fields in trend", async () => {
    await recordCycleMetrics("cycle-qg-multi-001", {
      tasksAttempted: 1, tasksMerged: 1, tasksFailed: 0,
      testsBefore: 100, testsAfter: 102, filesChanged: 2,
      totalDurationMs: 20000, regressionIntroduced: false,
      taskTitle: "First task", anchorType: "priorities",
      mutationKillRate: 90, mutationKilled: 9, mutationSurvived: 1,
      fixerUsed: 0, fixerResolved: 0, scopeFilterCleaned: 0,
      reconciliationStatus: "aligned",
    });

    await recordCycleMetrics("cycle-qg-multi-002", {
      tasksAttempted: 1, tasksMerged: 0, tasksFailed: 1,
      testsBefore: 102, testsAfter: 102, filesChanged: 0,
      totalDurationMs: 35000, regressionIntroduced: false,
      taskTitle: "Failed task", anchorType: "failing-test",
      mutationKillRate: -1, mutationKilled: 0, mutationSurvived: 0,
      fixerUsed: 1, fixerResolved: 0, scopeFilterCleaned: 1,
      reconciliationStatus: "skipped",
    });

    const trend = await getMetricsTrend(5);
    assert.equal(trend.length, 2, "should have 2 cycles");

    // Find each cycle (order depends on Redis sorted set score)
    const first = trend.find(m => m.cycleId === "cycle-qg-multi-001");
    const second = trend.find(m => m.cycleId === "cycle-qg-multi-002");
    assert.ok(first, "first cycle should be in trend");
    assert.ok(second, "second cycle should be in trend");

    assert.equal(first.mutationKillRate, 90);
    assert.equal(first.fixerUsed, 0);
    assert.equal(first.reconciliationStatus, "aligned");

    assert.equal(second.mutationKillRate, -1);
    assert.equal(second.fixerUsed, 1);
    assert.equal(second.reconciliationStatus, "skipped");
  });
});

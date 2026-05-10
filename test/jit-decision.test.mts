/**
 * Regression test for JIT decision string (issue #235).
 *
 * Bug: `/api/metrics/quality-gates` showed `jitTestsAdded: 0` for every cycle
 * regardless of whether JIT was correctly skipped (kill rate ≥ 80%) or
 * actually broken — there was no observable signal proving JIT was functional.
 *
 * Fix: Every cycle now records a `jitDecision` string (e.g. "skipped:
 * kill-rate >= 80%", "ran: 3 tests added") on the metrics hash, surfaced
 * via `getQualityGateTrend`. Operators can answer "is JIT working?" from
 * the dashboard without forensic log digs.
 *
 * Coverage:
 *   1. JitTestResult type carries `decision` and helpers (jitSkipReport,
 *      JIT_SKIP_* constants) produce the expected strings.
 *   2. getQualityGateTrend surfaces jitDecision per trend entry, including
 *      both ran-with-tests and skipped cases.
 *   3. Legacy cycles missing jitDecision return null (back-compat).
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

// Set test DB before any adapter imports
process.env.REDIS_URL = "redis://localhost:6379/1";

const {
  jitSkipReport,
  JIT_SKIP_QUICK_FIX,
  JIT_SKIP_NO_DIFF,
  JIT_SKIP_NO_FILES_CHANGED,
  JIT_SKIP_KILL_RATE,
} = await import("../src/jit.ts");
const { recordCycleMetrics, getQualityGateTrend } = await import("../src/metrics.ts");

let testRedis: any;

async function cleanTestKeys() {
  const patterns = ["hydra:metrics:*", "hydra:cycle:costs:*"];
  for (const pat of patterns) {
    const keys = await testRedis.keys(pat);
    if (keys.length > 0) await testRedis.del(...keys);
  }
  await testRedis.del("hydra:metrics:index");
}

describe("JIT decision string (issue #235)", () => {
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
  // Pure helpers — skip-decision constants and report builder
  // -------------------------------------------------------------------------

  test("JIT_SKIP_* constants describe each gate predicate", () => {
    assert.equal(JIT_SKIP_QUICK_FIX, "skipped: quick-fix");
    assert.equal(JIT_SKIP_NO_DIFF, "skipped: no diff");
    assert.equal(JIT_SKIP_NO_FILES_CHANGED, "skipped: no files changed");
    assert.equal(JIT_SKIP_KILL_RATE, "skipped: kill-rate >= 80%");
  });

  test("jitSkipReport returns a zeroed JitTestResult carrying the decision", () => {
    const r = jitSkipReport(JIT_SKIP_QUICK_FIX);
    assert.equal(r.decision, "skipped: quick-fix");
    assert.equal(r.generated, 0);
    assert.equal(r.kept, 0);
    assert.equal(r.discarded, 0);
    assert.equal(r.caughtBug, false);
    assert.equal(r.bugDetails, null);
    assert.deepEqual(r.testFiles, []);
    assert.equal(r.error, null);
  });

  // -------------------------------------------------------------------------
  // Trend integration — kill-rate=70% (ran) and kill-rate=100% (skipped)
  // -------------------------------------------------------------------------

  test("getQualityGateTrend surfaces 'ran: ...' decision when kill rate < 80%", async () => {
    // Synthetic cycle: low kill rate, JIT actually ran and added a test
    await recordCycleMetrics("cycle-jitdec-ran", {
      tasksAttempted: 1, tasksMerged: 1, tasksFailed: 0,
      testsBefore: 100, testsAfter: 101, filesChanged: 2,
      totalDurationMs: 30000, regressionIntroduced: false,
      taskTitle: "Trigger JIT at 70% kill rate", anchorType: "priorities",
      mutationKillRate: 70, mutationKilled: 7, mutationSurvived: 3,
      mutationsTested: 10, gateBlocked: 0,
      jitTestsKept: 1, jitTestsGenerated: 1,
      jitDecision: "ran: 1 test added",
    });

    const result = await getQualityGateTrend(50);
    const entry = result.trend.find((e: any) => e.cycleId === "cycle-jitdec-ran");
    assert.ok(entry, "cycle should be in trend");
    assert.equal(entry!.killRate, 70);
    assert.equal(entry!.jitTestsAdded, 1);
    assert.equal(entry!.jitDecision, "ran: 1 test added");
    assert.ok(
      entry!.jitDecision.startsWith("ran:"),
      "kill-rate < 80% should report a 'ran: ...' decision",
    );
  });

  test("getQualityGateTrend surfaces 'skipped: kill-rate >= 80%' when kill rate is 100%", async () => {
    await recordCycleMetrics("cycle-jitdec-skipped", {
      tasksAttempted: 1, tasksMerged: 1, tasksFailed: 0,
      testsBefore: 100, testsAfter: 100, filesChanged: 1,
      totalDurationMs: 25000, regressionIntroduced: false,
      taskTitle: "Skip JIT at 100% kill rate", anchorType: "priorities",
      mutationKillRate: 100, mutationKilled: 10, mutationSurvived: 0,
      mutationsTested: 10, gateBlocked: 0,
      jitTestsKept: 0, jitTestsGenerated: 0,
      jitDecision: JIT_SKIP_KILL_RATE,
    });

    const result = await getQualityGateTrend(50);
    const entry = result.trend.find((e: any) => e.cycleId === "cycle-jitdec-skipped");
    assert.ok(entry, "cycle should be in trend");
    assert.equal(entry!.killRate, 100);
    assert.equal(entry!.jitTestsAdded, 0);
    assert.equal(entry!.jitDecision, "skipped: kill-rate >= 80%");
    assert.ok(
      entry!.jitDecision.startsWith("skipped:"),
      "kill-rate >= 80% should report a 'skipped: ...' decision",
    );
  });

  test("getQualityGateTrend surfaces quick-fix skip decision", async () => {
    await recordCycleMetrics("cycle-jitdec-quickfix", {
      tasksAttempted: 1, tasksMerged: 1, tasksFailed: 0,
      testsBefore: 100, testsAfter: 100, filesChanged: 1,
      totalDurationMs: 5000, regressionIntroduced: false,
      taskTitle: "quick-fix", anchorType: "priorities",
      complexity: "quick-fix",
      jitTestsKept: 0, jitTestsGenerated: 0,
      jitDecision: JIT_SKIP_QUICK_FIX,
    });

    const result = await getQualityGateTrend(50);
    const entry = result.trend.find((e: any) => e.cycleId === "cycle-jitdec-quickfix");
    assert.ok(entry);
    assert.equal(entry!.jitDecision, "skipped: quick-fix");
  });

  // -------------------------------------------------------------------------
  // Backward compat — legacy cycles without jitDecision
  // -------------------------------------------------------------------------

  test("legacy cycle without jitDecision returns null in trend (no crash)", async () => {
    await recordCycleMetrics("cycle-jitdec-legacy", {
      tasksAttempted: 1, tasksMerged: 1, tasksFailed: 0,
      testsBefore: 100, testsAfter: 100, filesChanged: 1,
      totalDurationMs: 10000, regressionIntroduced: false,
      taskTitle: "Legacy cycle", anchorType: "priorities",
      // no jitDecision field
    });

    const result = await getQualityGateTrend(50);
    const entry = result.trend.find((e: any) => e.cycleId === "cycle-jitdec-legacy");
    assert.ok(entry);
    assert.equal(entry!.jitDecision, null, "missing jitDecision should be null");
  });
});

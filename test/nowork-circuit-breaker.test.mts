/**
 * Regression test for noWork circuit-breaker escalation (issue #137).
 *
 * Bug: When the planner produced noWork=true, the outcome was classified
 * as 'no-work' (skipped) instead of counting toward the abandonment
 * circuit-breaker. The same anchor could produce noWork 3+ consecutive
 * cycles without triggering reframe escalation, wasting frontier model
 * inference and contributing to the 42% empty cycle rate.
 *
 * Fix: noWork outcomes now call reportOutcome with status 'abandoned',
 * which increments the abandonment counter and triggers reframe
 * escalation after MAX_CONSECUTIVE_ABANDONMENTS (3) cycles.
 *
 * Requires Redis running on localhost:6379 (default).
 * Uses Redis DB 1 for tests — never touches production (DB 0).
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

let redis: any;

const REFRAME_QUEUE_KEY = "hydra:anchors:reframe-queue";
const ABANDONMENT_PREFIX = "hydra:anchors:abandonment-count:";

async function cleanKeys() {
  const patterns = [
    "hydra:anchors:*",
    "hydra:backlog:*",
  ];
  for (const pat of patterns) {
    const keys = await redis.keys(pat);
    if (keys.length > 0) await redis.del(...keys);
  }
}

describe("noWork circuit-breaker escalation (issue #137)", () => {
  let anchorSelection: any;

  beforeEach(async () => {
    if (!redis) {
      const redisUrl = process.env.REDIS_URL || "redis://localhost:6379/1";
      process.env.REDIS_URL = redisUrl;
      redis = new Redis(redisUrl);
    }
    await cleanKeys();
    anchorSelection = await import("../src/anchor-selection.ts");
  });

  after(async () => {
    if (redis) {
      await cleanKeys();
      redis.disconnect();
    }
  });

  test("recurring noWork anchor escalates to reframe after MAX_CONSECUTIVE_ABANDONMENTS", async () => {
    const { reportOutcome, _testing } = anchorSelection;
    const { MAX_CONSECUTIVE_ABANDONMENTS, REFRAME_QUEUE } = _testing;

    const anchor = {
      type: "doc",
      reference: "direction/priorities.md",
      whyNow: "Next priority from operator direction document",
    };

    // Simulate MAX_CONSECUTIVE_ABANDONMENTS noWork outcomes for the same anchor.
    // Each noWork calls reportOutcome with status: "abandoned" (issue #137 fix).
    for (let i = 0; i < MAX_CONSECUTIVE_ABANDONMENTS; i++) {
      await reportOutcome(anchor, {
        status: "abandoned",
        reason: `Planner noWork: all priorities addressed (cycle ${i + 1})`,
        task: { title: anchor.reference, taskId: "none" },
      });
    }

    // Verify the anchor was escalated to the reframe queue
    const reframeItems = await redis.lrange(REFRAME_QUEUE, 0, -1);
    assert.ok(
      reframeItems.length >= 1,
      `Expected at least 1 reframe item after ${MAX_CONSECUTIVE_ABANDONMENTS} abandonments, got ${reframeItems.length}`,
    );

    const escalated = JSON.parse(reframeItems[reframeItems.length - 1]);
    assert.equal(escalated.escalationSource, "abandonment-circuit-breaker");
    assert.equal(escalated.totalAttempts, MAX_CONSECUTIVE_ABANDONMENTS);
    assert.ok(
      escalated.lastReason.includes("noWork"),
      `Expected noWork in escalation reason, got: ${escalated.lastReason}`,
    );

    // Verify the abandonment counter was reset (reframe gets one clean shot)
    const key = _testing.anchorKey(anchor.reference);
    const count = await redis.get(key);
    assert.equal(count, null, "Abandonment counter should be reset after reframe escalation");
  });

  test("noWork abandonment counter increments but does not escalate before threshold", async () => {
    const { reportOutcome, _testing } = anchorSelection;
    const { MAX_CONSECUTIVE_ABANDONMENTS } = _testing;

    const anchor = {
      type: "codebase-health",
      reference: "codebase-health: large-file in src/control-loop.ts",
      whyNow: "Codebase health analysis",
    };

    // Simulate one less than the threshold
    for (let i = 0; i < MAX_CONSECUTIVE_ABANDONMENTS - 1; i++) {
      await reportOutcome(anchor, {
        status: "abandoned",
        reason: `Planner noWork: no actionable improvement found (cycle ${i + 1})`,
        task: { title: anchor.reference, taskId: "none" },
      });
    }

    // Reframe queue should be empty — not yet escalated
    const reframeItems = await redis.lrange(REFRAME_QUEUE_KEY, 0, -1);
    assert.equal(reframeItems.length, 0, "Should not escalate before reaching threshold");

    // Counter should be at threshold - 1
    const key = _testing.anchorKey(anchor.reference);
    const count = parseInt(await redis.get(key) || "0");
    assert.equal(count, MAX_CONSECUTIVE_ABANDONMENTS - 1);
  });

  test("successful merge resets the noWork abandonment counter", async () => {
    const { reportOutcome, _testing } = anchorSelection;

    const anchor = {
      type: "user-request",
      reference: "Add login page",
      whyNow: "Queued by operator",
    };

    // Simulate 2 noWork abandonments
    for (let i = 0; i < 2; i++) {
      await reportOutcome(anchor, {
        status: "abandoned",
        reason: "Planner noWork: already addressed",
        task: { title: anchor.reference, taskId: "none" },
      });
    }

    // Counter should be 2
    const key = _testing.anchorKey(anchor.reference);
    let count = parseInt(await redis.get(key) || "0");
    assert.equal(count, 2);

    // Simulate a successful merge — should reset the counter
    await reportOutcome(anchor, { status: "merged" });
    count = parseInt(await redis.get(key) || "0");
    assert.equal(count, 0, "Merge should reset abandonment counter");
  });

  test("handlePlanResult noWork sentinel triggers abandonment path", async () => {
    // This test verifies the pipeline-steps.ts integration:
    // the __noWork sentinel from runPlannerAgent flows through handlePlanResult
    // and calls reportOutcome with status: "abandoned"
    const { handlePlanResult } = await import("../src/pipeline-steps.ts");
    const { _testing } = anchorSelection;
    const { createTracker } = await import("../src/task-tracker.ts");
    createTracker();

    const anchor = {
      type: "doc",
      reference: "direction/priorities.md",
      whyNow: "Priorities doc",
    };

    const ctx = {
      cycleId: "cycle-nowork-test",
      startTime: Date.now(),
      grounding: {
        testReport: { passed: 42, failed: 0, total: 42, duration: 5000 },
        typecheckReport: { errors: 0 },
        groundingDurationMs: 5000,
        gitStatus: { clean: true },
      },
      groundingSummary: "Tests: 42 passed, 0 failed.",
      ovSession: {
        sessionId: "test-session",
        cycleId: "cycle-nowork-test",
        active: false,
        async logPlanner() {},
        async logSkeptic() {},
        async logExecutor() {},
        async logOutcome() {},
        async logVerification() {},
        async markUsed() {},
        async commit() {},
      },
      eventBus: { async publish() {} },
      anchor,
      anchorConfidence: { score: 0.75, reason: "heuristic", tier: "heuristic" as const },
    };

    // Simulate the __noWork sentinel that runPlannerAgent now returns
    const noWorkTask = { __noWork: true, reason: "All priorities addressed" };

    const result = await handlePlanResult(ctx, noWorkTask, ctx.anchorConfidence);

    // Pipeline should stop
    assert.equal(result.continue, false);
    if (!result.continue) {
      assert.ok(
        result.result.reason.includes("noWork"),
        `Expected 'noWork' in reason, got: ${result.result.reason}`,
      );
    }

    // Abandonment counter should have been incremented
    const key = _testing.anchorKey(anchor.reference);
    const count = parseInt(await redis.get(key) || "0");
    assert.ok(count >= 1, `Expected abandonment counter >= 1, got ${count}`);
  });
});

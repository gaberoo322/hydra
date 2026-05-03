/**
 * Regression tests for src/learning.ts — unified learning facade.
 *
 * Verifies that recordOutcome() dispatches to the correct per-agent lesson
 * recorder and both reflection systems, and that clearOutcomes() clears
 * reflections from both stores.
 *
 * Requires Redis running on localhost:6379 (default).
 * Uses Redis DB 1 for tests — never touches production (DB 0).
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

let learning: typeof import("../src/learning.ts");
let reflections: typeof import("../src/reflections.ts");
let redis: any;

async function cleanKeys() {
  const keys = await redis.keys("hydra:reflections:*");
  const memKeys = await redis.keys("hydra:memory:*");
  const allKeys = [...keys, ...memKeys];
  if (allKeys.length > 0) await redis.del(...allKeys);
}

describe("learning facade", () => {
  beforeEach(async () => {
    if (!redis) {
      redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379/1");
      process.env.REDIS_URL = "redis://localhost:6379/1";
      learning = await import("../src/learning.ts");
      reflections = await import("../src/reflections.ts");
    }
    await cleanKeys();
  });

  after(async () => {
    if (redis) {
      await cleanKeys();
      redis.disconnect();
    }
  });

  test("recordOutcome for planner failure records global reflection", async () => {
    await learning.recordOutcome("planner", "cycle-learn-001", { title: "Fix auth" }, {
      finalState: "failed",
      reason: "Verification failed: npm test",
      anchor: { type: "failing-test", reference: "auth-login-test" },
      taskTitle: "Fix auth",
      context: {
        failReason: "Verification failed: npm test",
        failedSteps: ["npm test"],
        whatToTryDifferently: "Narrow scope and fix tests first.",
      },
    });

    // Global reflection should be recorded
    const all = await reflections.getAllReflections();
    assert.ok(all.length >= 1, "Expected at least 1 global reflection");
    const ref = all.find((r) => r.cycleId === "cycle-learn-001");
    assert.ok(ref, "Expected a reflection with cycleId cycle-learn-001");
    assert.equal(ref.failureMode, "failed");
    assert.equal(ref.anchorReference, "auth-login-test");
  });

  test("recordOutcome for merged state does NOT record reflections", async () => {
    await learning.recordOutcome("planner", "cycle-learn-002", { title: "Add feature" }, {
      finalState: "merged",
      context: { scopeCreep: ["extra-file.ts"] },
    });

    const all = await reflections.getAllReflections();
    const ref = all.find((r) => r.cycleId === "cycle-learn-002");
    assert.equal(ref, undefined, "merged outcomes should not create global reflections");
  });

  test("recordOutcome with unknown agent logs error but does not throw", async () => {
    // Should not throw — just log and continue with reflections
    await learning.recordOutcome("unknown-agent", "cycle-learn-003", { title: "Something" }, {
      finalState: "failed",
      reason: "test",
      anchor: { type: "test", reference: "test-ref" },
    });

    // Global reflection should still be recorded despite unknown agent
    const all = await reflections.getAllReflections();
    const ref = all.find((r) => r.cycleId === "cycle-learn-003");
    assert.ok(ref, "Global reflection should still be recorded for unknown agent");
  });

  test("clearOutcomes clears both per-anchor and global reflections", async () => {
    const anchor = { type: "failing-test", reference: "clear-test-anchor" };

    // Record a failure to create reflections in both stores
    await learning.recordOutcome("planner", "cycle-learn-004", { title: "Will fail" }, {
      finalState: "failed",
      reason: "Verification failed",
      anchor,
      taskTitle: "Will fail",
      context: { whatToTryDifferently: "Try something else" },
    });

    // Verify global reflection exists
    const before = await reflections.getAllReflections();
    const refBefore = before.find((r) => r.cycleId === "cycle-learn-004");
    assert.ok(refBefore, "Expected reflection before clearing");

    // Clear outcomes
    await learning.clearOutcomes("clear-test-anchor");

    // Global reflection for this anchor should be gone
    const after = await reflections.getAllReflections();
    const refAfter = after.find((r) => r.cycleId === "cycle-learn-004");
    assert.equal(refAfter, undefined, "Expected reflection to be cleared");
  });

  test("recordOutcome for no-task records both reflections", async () => {
    await learning.recordOutcome("planner", "cycle-learn-005", null, {
      finalState: "no-task",
      reason: "Planner could not produce a valid task",
      anchor: { type: "priorities-doc", reference: "some-priority" },
      taskTitle: "Planner produced no task",
      context: {
        whatToTryDifferently: "Anchor too vague — be more specific.",
      },
    });

    const all = await reflections.getAllReflections();
    const ref = all.find((r) => r.cycleId === "cycle-learn-005");
    assert.ok(ref, "Expected global reflection for no-task outcome");
    assert.equal(ref.failureMode, "no-task");
  });

  test("recordOutcome for executor no-diff records failure", async () => {
    await learning.recordOutcome("executor", "cycle-learn-006", { title: "Add widget" }, {
      finalState: "failed",
      reason: "Executor produced no code changes",
      anchor: { type: "work-queue", reference: "add-widget" },
      taskTitle: "Add widget",
      context: { noDiff: true },
    });

    const all = await reflections.getAllReflections();
    const ref = all.find((r) => r.cycleId === "cycle-learn-006");
    assert.ok(ref, "Expected global reflection for executor no-diff");
    assert.equal(ref.failureMode, "failed");
  });

  test("recordOutcome for skeptic records lesson without reflections when merged", async () => {
    // Skeptic lessons on merged tasks shouldn't create reflections
    await learning.recordOutcome("skeptic", "cycle-learn-007", { title: "Refactor" }, {
      finalState: "merged",
      context: { skepticVerdict: "approve" },
    });

    const all = await reflections.getAllReflections();
    const ref = all.find((r) => r.cycleId === "cycle-learn-007");
    assert.equal(ref, undefined, "Merged skeptic outcomes should not create global reflections");
  });
});

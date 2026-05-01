/**
 * Regression tests for src/reflections.ts — Reflexion-style post-mortem buffer.
 *
 * Requires Redis running on localhost:6379 (default).
 * Uses Redis DB 1 for tests — never touches production (DB 0).
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

const BUFFER_KEY = "hydra:reflections:buffer";

let reflections;
let redis: any;

async function cleanReflectionKeys() {
  const keys = await redis.keys("hydra:reflections:*");
  if (keys.length > 0) await redis.del(...keys);
}

describe("reflections buffer", () => {
  beforeEach(async () => {
    if (!redis) {
      // Use Redis DB 1 for tests — production uses DB 0
      redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379/1");
      process.env.REDIS_URL = "redis://localhost:6379/1";
      reflections = await import("../src/reflections.ts");
    }
    await cleanReflectionKeys();
  });

  after(async () => {
    if (redis) {
      await cleanReflectionKeys();
      redis.disconnect();
    }
    if (reflections?.closeReflectionsRedis) {
      reflections.closeReflectionsRedis();
    }
  });

  test("recordReflection stores a reflection in the buffer", async () => {
    await reflections.recordReflection({
      cycleId: "cycle-test-001",
      anchorType: "failing-test",
      anchorReference: "auth login test",
      failureMode: "verification-failed",
      whatFailed: "Login flow broke after refactor",
      whyItFailed: "Missing import in auth module",
      whatToTryDifferently: "Check all imports before committing",
    });

    const all = await reflections.getAllReflections();
    assert.equal(all.length, 1);
    assert.equal(all[0].cycleId, "cycle-test-001");
    assert.equal(all[0].anchorType, "failing-test");
    assert.equal(all[0].anchorReference, "auth login test");
    assert.equal(all[0].failureMode, "verification-failed");
    assert.ok(all[0].timestamp);
  });

  test("buffer is capped at 20 entries", async () => {
    // Insert 25 reflections
    for (let i = 0; i < 25; i++) {
      await reflections.recordReflection({
        cycleId: `cycle-test-${i.toString().padStart(3, "0")}`,
        anchorType: "prior-failure",
        anchorReference: `task-${i}`,
        failureMode: "no-diff",
        whatFailed: `Task ${i} failed`,
        whyItFailed: "no code changes",
        whatToTryDifferently: "be more specific",
      });
    }

    const all = await reflections.getAllReflections();
    assert.equal(all.length, 20);
    // Most recent should be first (reversed order)
    assert.equal(all[0].cycleId, "cycle-test-024");
    // Oldest kept should be index 5 (25 - 20 = 5)
    assert.equal(all[19].cycleId, "cycle-test-005");
  });

  test("loadRelevantReflections filters by anchor reference", async () => {
    await reflections.recordReflection({
      cycleId: "cycle-a", anchorType: "failing-test", anchorReference: "auth flow",
      failureMode: "verification-failed", whatFailed: "auth broke",
      whyItFailed: "missing import", whatToTryDifferently: "check imports",
    });
    await reflections.recordReflection({
      cycleId: "cycle-b", anchorType: "research", anchorReference: "payments integration",
      failureMode: "no-diff", whatFailed: "payments unchanged",
      whyItFailed: "no code written", whatToTryDifferently: "narrow scope",
    });
    await reflections.recordReflection({
      cycleId: "cycle-c", anchorType: "failing-test", anchorReference: "auth flow",
      failureMode: "no-task", whatFailed: "planner failed",
      whyItFailed: "vague anchor", whatToTryDifferently: "reword anchor",
    });

    const relevant = await reflections.loadRelevantReflections(
      { type: "failing-test", reference: "auth flow" },
    );
    // Should match both auth flow entries + the type match
    assert.ok(relevant.length >= 2);
    // Most recent first
    assert.equal(relevant[0].cycleId, "cycle-c");
  });

  test("loadRelevantReflections respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      await reflections.recordReflection({
        cycleId: `cycle-${i}`, anchorType: "failing-test", anchorReference: "same-anchor",
        failureMode: "verification-failed", whatFailed: `attempt ${i}`,
        whyItFailed: "still broken", whatToTryDifferently: "try again",
      });
    }

    const limited = await reflections.loadRelevantReflections(
      { type: "failing-test", reference: "same-anchor" },
      2,
    );
    assert.equal(limited.length, 2);
  });

  test("clearReflectionsForAnchor removes matching entries", async () => {
    await reflections.recordReflection({
      cycleId: "cycle-1", anchorType: "research", anchorReference: "payments",
      failureMode: "no-diff", whatFailed: "payments",
      whyItFailed: "reason", whatToTryDifferently: "advice",
    });
    await reflections.recordReflection({
      cycleId: "cycle-2", anchorType: "failing-test", anchorReference: "auth",
      failureMode: "verification-failed", whatFailed: "auth",
      whyItFailed: "reason", whatToTryDifferently: "advice",
    });
    await reflections.recordReflection({
      cycleId: "cycle-3", anchorType: "research", anchorReference: "payments",
      failureMode: "no-task", whatFailed: "payments",
      whyItFailed: "reason", whatToTryDifferently: "advice",
    });

    const removed = await reflections.clearReflectionsForAnchor("payments");
    assert.equal(removed, 2);

    const remaining = await reflections.getAllReflections();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].anchorReference, "auth");
  });

  test("getAllReflections returns empty array when buffer is empty", async () => {
    const all = await reflections.getAllReflections();
    assert.deepEqual(all, []);
  });

  test("formatReflectionsForPrompt produces ## Recent Failures section", () => {
    const formatted = reflections.formatReflectionsForPrompt([
      {
        cycleId: "cycle-test-001",
        anchorType: "failing-test",
        anchorReference: "auth test",
        failureMode: "verification-failed",
        whatFailed: "Login flow broke",
        whyItFailed: "Missing import",
        whatToTryDifferently: "Check imports first",
        timestamp: "2026-04-30T12:00:00Z",
      },
    ]);

    assert.ok(formatted.includes("## Recent Failures"));
    assert.ok(formatted.includes("cycle-test-001"));
    assert.ok(formatted.includes("Login flow broke"));
    assert.ok(formatted.includes("Missing import"));
    assert.ok(formatted.includes("Check imports first"));
  });

  test("formatReflectionsForPrompt returns empty string for no reflections", () => {
    const formatted = reflections.formatReflectionsForPrompt([]);
    assert.equal(formatted, "");
  });

  test("clearReflectionsForAnchor returns 0 when no matches", async () => {
    await reflections.recordReflection({
      cycleId: "cycle-1", anchorType: "research", anchorReference: "unrelated",
      failureMode: "no-diff", whatFailed: "something",
      whyItFailed: "reason", whatToTryDifferently: "advice",
    });

    const removed = await reflections.clearReflectionsForAnchor("nonexistent");
    assert.equal(removed, 0);

    const all = await reflections.getAllReflections();
    assert.equal(all.length, 1);
  });
});

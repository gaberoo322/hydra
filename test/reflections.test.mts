/**
 * Regression tests for learning.ts — Reflexion-style post-mortem buffer.
 *
 * Requires Redis running on localhost:6379 (default).
 * Uses Redis DB 1 for tests — never touches production (DB 0).
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

process.env.REDIS_URL = "redis://localhost:6379/1";

let reflections: typeof import("../src/reflections/reflections.ts");
let redis: any;
let redisAvailable = false;

async function cleanReflectionKeys() {
  const keys = await redis.keys("hydra:reflections:*");
  if (keys.length > 0) await redis.del(...keys);
}

/** Call at top of each test — skips the test if Redis is unreachable. */
function requireRedis(t: any) {
  if (!redisAvailable) {
    t.skip("Redis unavailable");
  }
}

describe("reflections buffer", () => {
  beforeEach(async () => {
    if (!redis) {
      // Use Redis DB 1 for tests — production uses DB 0
      redis = new Redis(process.env.REDIS_URL!);
      try {
        await redis.ping();
        redisAvailable = true;
      } catch (err) {
        console.error("Redis unavailable at localhost:6379/1, skipping reflections tests");
        return;
      }
      reflections = await import("../src/reflections/reflections.ts");
    }
    if (!redisAvailable) return;
    await cleanReflectionKeys();
  });

  after(async () => {
    if (redis) {
      if (redisAvailable) await cleanReflectionKeys();
      redis.disconnect();
    }
    if (reflections?.closeReflectionsRedis) {
      reflections.closeReflectionsRedis();
    }
    const { closeRedisConnections } = await import("../src/redis/connection.ts");
    closeRedisConnections();
  });

  test("recordReflection stores a reflection in the buffer", async (t) => {
    requireRedis(t);
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

  test("buffer is capped at 20 entries", async (t) => {
    requireRedis(t);
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

  test("loadRelevantReflections filters by anchor reference", async (t) => {
    requireRedis(t);
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

  test("loadRelevantReflections respects limit", async (t) => {
    requireRedis(t);
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

  test("clearReflectionsForAnchor removes matching entries", async (t) => {
    requireRedis(t);
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

  test("getAllReflections returns empty array when buffer is empty", async (t) => {
    requireRedis(t);
    const all = await reflections.getAllReflections();
    assert.deepEqual(all, []);
  });

  test("formatReflectionsForPrompt produces ## Recent Failures section", (t) => {
    requireRedis(t);
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

  test("formatReflectionsForPrompt returns empty string for no reflections", (t) => {
    requireRedis(t);
    const formatted = reflections.formatReflectionsForPrompt([]);
    assert.equal(formatted, "");
  });

  test("consolidateReflections flushes buffer into per-anchor store and clears buffer", async (t) => {
    requireRedis(t);
    await reflections.recordReflection({
      cycleId: "cyc-consol-1", anchorType: "prior-failure", anchorReference: "issue-9001",
      failureMode: "verification-failed", whatFailed: "tsc broke",
      whyItFailed: "missing import", whatToTryDifferently: "add the import first",
    });
    await reflections.recordReflection({
      cycleId: "cyc-consol-2", anchorType: "prior-failure", anchorReference: "issue-9002",
      failureMode: "no-diff", whatFailed: "no changes",
      whyItFailed: "task already done", whatToTryDifferently: "verify before re-dispatch",
    });

    const summary = await reflections.consolidateReflections();
    assert.equal(summary.scanned, 2);
    assert.equal(summary.consolidated, 2);
    assert.equal(summary.skipped, 0);

    // Buffer is now empty (the success-criteria invariant: LLEN → 0).
    const bufLen = await redis.llen("hydra:reflections:buffer");
    assert.equal(bufLen, 0);

    // Per-anchor store has the migrated narrative, readable by the planner path.
    const block = await reflections.loadAnchorReflections("issue-9001");
    assert.equal(block.count, 1);
    assert.ok(block.content.includes("missing import"));
    assert.ok(block.content.includes("add the import first"));

    const block2 = await reflections.loadAnchorReflections("issue-9002");
    assert.equal(block2.count, 1);
  });

  test("consolidateReflections is idempotent on cycleId across re-runs", async (t) => {
    requireRedis(t);
    await reflections.recordReflection({
      cycleId: "cyc-idem-1", anchorType: "prior-failure", anchorReference: "issue-9100",
      failureMode: "verification-failed", whatFailed: "broke",
      whyItFailed: "reason", whatToTryDifferently: "advice",
    });

    await reflections.consolidateReflections();

    // Re-record the SAME cycleId, then re-consolidate — must not duplicate.
    await reflections.recordReflection({
      cycleId: "cyc-idem-1", anchorType: "prior-failure", anchorReference: "issue-9100",
      failureMode: "verification-failed", whatFailed: "broke",
      whyItFailed: "reason", whatToTryDifferently: "advice",
    });
    const summary = await reflections.consolidateReflections();
    assert.equal(summary.scanned, 1);
    assert.equal(summary.consolidated, 0);
    assert.equal(summary.skipped, 1);

    const block = await reflections.loadAnchorReflections("issue-9100");
    assert.equal(block.count, 1, "duplicate cycleId must not produce a second per-anchor row");
  });

  test("consolidateReflections is a clean no-op on an empty buffer", async (t) => {
    requireRedis(t);
    const summary = await reflections.consolidateReflections();
    assert.deepEqual(summary, { scanned: 0, consolidated: 0, skipped: 0 });
  });

  test("consolidateReflections drains malformed and anchorless entries", async (t) => {
    requireRedis(t);
    // Directly seed the buffer: one malformed, one anchorless, one valid.
    await redis.rpush("hydra:reflections:buffer", "{not json");
    await redis.rpush("hydra:reflections:buffer", JSON.stringify({ cycleId: "c", failureMode: "x", whatFailed: "y", whyItFailed: "z", whatToTryDifferently: "w", anchorType: "t", timestamp: "2026-06-08T00:00:00Z" }));
    await reflections.recordReflection({
      cycleId: "cyc-valid", anchorType: "prior-failure", anchorReference: "issue-9200",
      failureMode: "no-diff", whatFailed: "nope",
      whyItFailed: "reason", whatToTryDifferently: "advice",
    });

    const summary = await reflections.consolidateReflections();
    assert.equal(summary.scanned, 3);
    assert.equal(summary.consolidated, 1);
    assert.equal(summary.skipped, 2);

    // All three drained — the unconsolidatable ones don't leak.
    const bufLen = await redis.llen("hydra:reflections:buffer");
    assert.equal(bufLen, 0);
  });

  test("clearReflectionsForAnchor returns 0 when no matches", async (t) => {
    requireRedis(t);
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

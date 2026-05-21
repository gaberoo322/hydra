/**
 * Regression tests for reflection effectiveness tracking (issue #150).
 *
 * Tests:
 *   - Outcome recording when anchor has existing reflections
 *   - Effectiveness calculation from multiple outcomes
 *   - Selective clearing: high-effectiveness reflections preserved, low cleared
 *
 * Requires Redis running on localhost:6379 (default).
 * Uses Redis DB 1 for tests — never touches production (DB 0).
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

// Set REDIS_URL before any import of learning.ts so the singleton picks up DB 1
process.env.REDIS_URL = "redis://localhost:6379/1";

// Cross-cutting orchestration (recordOutcome / clearOutcomes) lives in the
// barrel; reflection-cluster queries (getReflectionEffectiveness) live in the
// reflections module. Both are needed by this test.
let learning: typeof import("../src/learning.ts");
let reflections: typeof import("../src/reflections/reflections.ts");
let redis: any;
let redisAvailable = false;

const OUTCOMES_KEY = "hydra:learning:reflection:outcomes";

async function cleanKeys() {
  const reflKeys = await redis.keys("hydra:reflections:*");
  const outcomeExists = await redis.exists(OUTCOMES_KEY);
  const toDelete = [...reflKeys];
  if (outcomeExists) toDelete.push(OUTCOMES_KEY);
  if (toDelete.length > 0) await redis.del(...toDelete);
}

function requireRedis(t: any) {
  if (!redisAvailable) t.skip("Redis unavailable");
}

describe("reflection effectiveness (issue #150)", () => {
  beforeEach(async () => {
    if (!redis) {
      redis = new Redis(process.env.REDIS_URL!);
      try {
        await redis.ping();
        redisAvailable = true;
      } catch {
        console.error("Redis unavailable at localhost:6379/1, skipping tests");
        return;
      }
      learning = await import("../src/learning.ts");
      reflections = await import("../src/reflections/reflections.ts");
    }
    if (!redisAvailable) return;
    await cleanKeys();
  });

  after(async () => {
    if (redis) {
      if (redisAvailable) await cleanKeys();
      redis.disconnect();
    }
    const { closeRedisConnections } = await import("../src/redis-adapter.ts");
    closeRedisConnections();
  });

  test("AC1: recordOutcome records reflection outcome when anchor has existing reflections", async (t) => {
    requireRedis(t);

    const anchorRef = "flaky auth test";

    // First: record a failure reflection for this anchor (creates per-anchor entry)
    await learning.recordOutcome({
      agents: [],
      cycleId: "cycle-001",
      task: { title: "fix auth" },
      finalState: "failed",
      anchorRef,
      anchorType: "failing-test",
      reflection: {
        failureMode: "verification-failed",
        whatFailed: "auth test",
        whyItFailed: "missing import",
        whatToTryDifferently: "check imports",
      },
    });

    // Outcomes sorted set should be empty — no pre-existing reflections on first attempt
    const outcomesBefore = await redis.zrange(OUTCOMES_KEY, 0, -1);
    assert.equal(outcomesBefore.length, 0, "no outcome on first attempt (no prior reflections)");

    // Second: retry the same anchor — now it has existing reflections
    await learning.recordOutcome({
      agents: [],
      cycleId: "cycle-002",
      task: { title: "fix auth retry" },
      finalState: "merged",
      anchorRef,
      anchorType: "failing-test",
    });

    // Now the outcomes sorted set should have an entry
    const outcomesAfter = await redis.zrange(OUTCOMES_KEY, 0, -1);
    assert.equal(outcomesAfter.length, 1, "should record outcome on retry with existing reflections");

    const outcome = JSON.parse(outcomesAfter[0]);
    assert.equal(outcome.anchorRef, anchorRef);
    assert.equal(outcome.hadReflections, true);
    assert.equal(outcome.outcome, "merged");
    assert.equal(outcome.cycleId, "cycle-002");
    assert.ok(outcome.timestamp);
  });

  test("AC2: getReflectionEffectiveness computes per-anchor success rates", async (t) => {
    requireRedis(t);

    const anchorRef = "payments module";

    // Manually push outcomes to simulate multiple retries
    const outcomes = [
      { anchorRef, hadReflections: true, outcome: "merged", cycleId: "c1", timestamp: new Date().toISOString() },
      { anchorRef, hadReflections: true, outcome: "failed", cycleId: "c2", timestamp: new Date().toISOString() },
      { anchorRef, hadReflections: true, outcome: "merged", cycleId: "c3", timestamp: new Date().toISOString() },
      { anchorRef: "other-anchor", hadReflections: true, outcome: "failed", cycleId: "c4", timestamp: new Date().toISOString() },
    ];

    for (let i = 0; i < outcomes.length; i++) {
      await redis.zadd(OUTCOMES_KEY, Date.now() + i, JSON.stringify(outcomes[i]));
    }

    const result = await reflections.getReflectionEffectiveness();
    assert.ok(result.anchors.length === 2, "should have 2 anchors");

    const payments = result.anchors.find(a => a.ref === "payments module");
    assert.ok(payments, "should find payments anchor");
    assert.equal(payments!.totalRetries, 3);
    assert.equal(payments!.successes, 2);
    assert.equal(payments!.failures, 1);
    assert.ok(Math.abs(payments!.successRate - 2 / 3) < 0.01, "success rate should be ~66.7%");

    const other = result.anchors.find(a => a.ref === "other-anchor");
    assert.ok(other, "should find other anchor");
    assert.equal(other!.totalRetries, 1);
    assert.equal(other!.successes, 0);
    assert.equal(other!.failures, 1);
    assert.equal(other!.successRate, 0);
  });

  test("AC3: clearOutcomes extends TTL for effective reflections instead of deleting", async (t) => {
    requireRedis(t);

    const anchorRef = "effective-anchor";
    const key = "hydra:reflections:" + anchorRef;

    // Create a per-anchor reflection entry
    await redis.rpush(key, JSON.stringify({ cycleId: "c1", anchorRef, outcome: "failed" }));
    await redis.expire(key, 7 * 86400); // 7 day TTL

    // Record outcomes showing >50% success rate
    const goodOutcomes = [
      { anchorRef, hadReflections: true, outcome: "merged", cycleId: "c2", timestamp: new Date().toISOString() },
      { anchorRef, hadReflections: true, outcome: "merged", cycleId: "c3", timestamp: new Date().toISOString() },
      { anchorRef, hadReflections: true, outcome: "failed", cycleId: "c4", timestamp: new Date().toISOString() },
    ];
    for (let i = 0; i < goodOutcomes.length; i++) {
      await redis.zadd(OUTCOMES_KEY, Date.now() + i, JSON.stringify(goodOutcomes[i]));
    }

    // clearOutcomes should extend TTL instead of deleting
    await learning.clearOutcomes(anchorRef);

    // Key should still exist
    const exists = await redis.exists(key);
    assert.equal(exists, 1, "effective reflection key should still exist");

    // TTL should be extended (close to 30 days = 2592000 seconds)
    const ttl = await redis.ttl(key);
    assert.ok(ttl > 7 * 86400, `TTL should be extended beyond 7 days, got ${ttl}`);
    assert.ok(ttl <= 30 * 86400, `TTL should not exceed 30 days, got ${ttl}`);
  });

  test("AC3: clearOutcomes deletes reflections with low effectiveness", async (t) => {
    requireRedis(t);

    const anchorRef = "ineffective-anchor";
    const key = "hydra:reflections:" + anchorRef;

    // Create a per-anchor reflection entry
    await redis.rpush(key, JSON.stringify({ cycleId: "c1", anchorRef, outcome: "failed" }));
    await redis.expire(key, 7 * 86400);

    // Record outcomes showing <=50% success rate
    const badOutcomes = [
      { anchorRef, hadReflections: true, outcome: "failed", cycleId: "c2", timestamp: new Date().toISOString() },
      { anchorRef, hadReflections: true, outcome: "failed", cycleId: "c3", timestamp: new Date().toISOString() },
      { anchorRef, hadReflections: true, outcome: "merged", cycleId: "c4", timestamp: new Date().toISOString() },
    ];
    for (let i = 0; i < badOutcomes.length; i++) {
      await redis.zadd(OUTCOMES_KEY, Date.now() + i, JSON.stringify(badOutcomes[i]));
    }

    // clearOutcomes should delete (<=50% success rate = 1/3 = 33%)
    await learning.clearOutcomes(anchorRef);

    const exists = await redis.exists(key);
    assert.equal(exists, 0, "ineffective reflection key should be deleted");
  });

  test("AC2: getReflectionEffectiveness returns empty anchors when no outcomes", async (t) => {
    requireRedis(t);

    const result = await reflections.getReflectionEffectiveness();
    assert.deepEqual(result.anchors, []);
    // Issue #193: response now also includes an injection summary block.
    // Don't assert exact values — depends on what cycle metrics happen to
    // be in Redis from other tests sharing DB 1.
    assert.ok(result.injection, "response includes injection stats");
    assert.equal(typeof result.injection.totalCycles, "number");
    assert.equal(typeof result.injection.cyclesWithReflections, "number");
    assert.equal(typeof result.injection.injectionRate, "number");
  });
});

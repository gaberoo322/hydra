/**
 * Regression tests for reflection effectiveness aggregation (issue #150).
 *
 * Exercises `getReflectionEffectiveness()` directly — the per-anchor
 * success-rate aggregation that backs `/api/reflections/effectiveness`.
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
    const { closeRedisConnections } = await import("../src/redis/connection.ts");
    closeRedisConnections();
  });

  test("getReflectionEffectiveness computes per-anchor success rates", async (t) => {
    requireRedis(t);

    const anchorRef = "payments module";

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

  test("getReflectionEffectiveness returns empty anchors when no outcomes", async (t) => {
    requireRedis(t);

    const result = await reflections.getReflectionEffectiveness();
    assert.deepEqual(result.anchors, []);
    // Issue #193: response also includes an injection summary block.
    // Don't assert exact values — depends on what cycle metrics happen to
    // be in Redis from other tests sharing DB 1.
    assert.ok(result.injection, "response includes injection stats");
    assert.equal(typeof result.injection.totalCycles, "number");
    assert.equal(typeof result.injection.cyclesWithReflections, "number");
    assert.equal(typeof result.injection.injectionRate, "number");
  });
});

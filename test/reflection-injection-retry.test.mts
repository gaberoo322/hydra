/**
 * Regression tests for episodic reflection telemetry on retries (issue #193).
 *
 * Original context: prior-failure anchors are quick-fix anchors. The fix loaded
 * reflections for them so a retry saw the prior-failure context instead of
 * re-proposing a plan that already failed. The in-process assembly path
 * (`buildPlannerContext`) that those reflections fed was retired (issue #1128)
 * along with the codex control loop; the LIVE injection path is now
 * `GET /api/reflections`, which the dispatch skills fetch at planning time.
 *
 * What remains here is the still-live `getReflectionEffectiveness` injection-stats
 * shape (issue #193). The `reflectionTelemetry` itemCount-summation helper was
 * removed as dead once its last production consumer went (issue #1414), so its
 * unit-level tests went with it.
 *
 * Requires Redis running on localhost:6379 (uses DB 1).
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

process.env.REDIS_URL = "redis://localhost:6379/1";

let redis: any;
let redisAvailable = false;

function requireRedis(t: any) {
  if (!redisAvailable) t.skip("Redis unavailable");
}

async function cleanReflections() {
  const keys = await redis.keys("hydra:reflections:*");
  if (keys.length > 0) await redis.del(...keys);
  const outcomes = "hydra:learning:reflection:outcomes";
  await redis.del(outcomes);
}

describe("reflection injection on retry (issue #193)", () => {
  beforeEach(async () => {
    if (!redis) {
      redis = new Redis(process.env.REDIS_URL!);
      try {
        await redis.ping();
        redisAvailable = true;
      } catch (err) {
        console.error("Redis unavailable, skipping reflection-injection tests");
        return;
      }
    }
    if (!redisAvailable) return;
    await cleanReflections();
  });

  after(async () => {
    if (redis) {
      if (redisAvailable) await cleanReflections();
      redis.disconnect();
    }
    const { closeRedisConnections } = await import("../src/redis/connection.ts");
    closeRedisConnections();
  });

  test("getReflectionEffectiveness returns injection stats (issue #193)", async (t) => {
    requireRedis(t);
    const learning = await import("../src/reflections/reflections.ts");

    const result = await learning.getReflectionEffectiveness();

    // Shape contract
    assert.ok(Array.isArray(result.anchors), "anchors must be an array");
    assert.ok(typeof result.injection === "object", "injection summary must be present");
    assert.equal(typeof result.injection.totalCycles, "number");
    assert.equal(typeof result.injection.cyclesWithReflections, "number");
    assert.equal(typeof result.injection.injectionRate, "number");
    assert.ok(result.injection.injectionRate >= 0 && result.injection.injectionRate <= 1,
      "injection rate must be a fraction");
  });
});

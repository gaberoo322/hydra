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
 * What remains here is the still-live telemetry contract: `reflectionTelemetry`
 * (the per-anchor/global itemCount summation behind `task.__reflectionsInjected`)
 * and `getReflectionEffectiveness` (the injection-stats shape, issue #193).
 *
 * Requires Redis running on localhost:6379 (uses DB 1).
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";
import type { LearningContext, LearningContextBlock } from "../src/learning.ts";

process.env.REDIS_URL = "redis://localhost:6379/1";

/** Build a minimal LearningContext from a list of blocks (issue #804). */
function ctxOf(blocks: Partial<LearningContextBlock>[]): LearningContext {
  const full = blocks.map((b) => ({
    source: b.source!,
    status: b.status ?? "hit",
    content: b.content ?? "",
    itemCount: b.itemCount ?? 0,
    error: b.error,
  })) as LearningContextBlock[];
  return {
    blocks: full,
    toPrompt: () => full.filter((b) => b.status === "hit" && b.content.length > 0).map((b) => b.content).join("\n\n"),
  };
}

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

  test("reflectionTelemetry sums per-anchor and global block itemCounts (issue #804)", async () => {
    const { reflectionTelemetry } = await import("../src/learning.ts");

    assert.deepEqual(reflectionTelemetry(ctxOf([])), { count: 0, sources: [] }, "no blocks → 0");

    const priorOnly = reflectionTelemetry(ctxOf([
      { source: "per-anchor-reflections", status: "hit", content: "## PRIOR ATTEMPTS (3…)", itemCount: 3 },
    ]));
    assert.equal(priorOnly.count, 3, "per-anchor itemCount is the count — no header regex");

    const recentOnly = reflectionTelemetry(ctxOf([
      { source: "global-reflections", status: "hit", content: "## Recent Failures …", itemCount: 2 },
    ]));
    assert.equal(recentOnly.count, 2, "global itemCount is the count");

    const both = reflectionTelemetry(ctxOf([
      { source: "per-anchor-reflections", status: "hit", content: "prior", itemCount: 3 },
      { source: "global-reflections", status: "hit", content: "recent", itemCount: 2 },
    ]));
    assert.equal(both.count, 5, "both blocks sum");
    assert.deepEqual(both.sources, ["per-anchor", "global"]);
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

describe("planner result tags reflection telemetry (issue #193)", () => {
  test("reflectionTelemetry feeds task.__reflectionsInjected metric path", async () => {
    // Unit-level check that the helper used by context-builder produces the
    // value that becomes task.__reflectionsInjected — now off structured
    // blocks (issue #804), not a markdown re-parse.
    const { reflectionTelemetry } = await import("../src/learning.ts");

    // Simulate what loadAnchorReflections reports (one reflection, count=1).
    const { count } = reflectionTelemetry(ctxOf([
      { source: "per-anchor-reflections", status: "hit", content: "## PRIOR ATTEMPTS (1…)", itemCount: 1 },
    ]));
    assert.equal(count, 1, "one per-anchor reflection → count is 1");

    // This is what task.__reflectionsInjected will be set to
    const hadReflections = count > 0;
    assert.equal(hadReflections, true, "boolean derivation works for metric");
  });
});

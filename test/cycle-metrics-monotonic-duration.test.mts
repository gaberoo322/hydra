/**
 * Monotonic-max duration write contract for recordCycleMetrics (issue #2364).
 *
 * A cycleId receives TWO cycle-record writes: the reap-time `completed` write
 * (which computes a wall-clock span from the slot's `started_epoch`) and the
 * post-merge `merged`/auto-merge follow-up write (which the autopilot fires with
 * its own duration). Because `recordCycleMetrics` is an additive HSET, the later
 * write would blindly overwrite the earlier — so a follow-up carrying `0` (the
 * truthful "unknown" sentinel, or a qa_orch relay cycle whose reap never wrote a
 * duration) could CLOBBER a real non-zero span, and a non-zero follow-up could
 * never UPGRADE a 0 first write. Both directions surfaced as `totalDurationMs=0`
 * on merged cycles despite the instrumentation path working end-to-end.
 *
 * `recordCycleMetrics` now treats the duration fields as monotonic-max: never
 * let a 0 overwrite a stored non-zero, and let any non-zero upgrade a stored
 * 0/absent. These tests pin that order-independence against real Redis.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

const { recordCycleMetrics } = await import("../src/metrics/record.ts");
const { getCycleMetrics } = await import("../src/redis/cycle-metrics.ts");

let testRedis: any;

async function cleanTestKeys() {
  const keys = await testRedis.keys("hydra:metrics:*");
  if (keys.length > 0) await testRedis.del(...keys);
  await testRedis.del("hydra:metrics:index");
}

describe("recordCycleMetrics monotonic duration (issue #2364)", () => {
  beforeEach(async () => {
    if (!testRedis) testRedis = new Redis(process.env.REDIS_URL);
    await cleanTestKeys();
  });

  after(async () => {
    await cleanTestKeys();
    if (testRedis) testRedis.disconnect();
  });

  test("a later 0 NEVER clobbers a stored non-zero duration", async () => {
    const cycleId = "cycle-2364-no-clobber";
    // First write: reap recorded a real wall-clock span.
    await recordCycleMetrics(cycleId, { totalDurationMs: 619721, tasksMerged: 1 });
    // Second write: a follow-up with duration 0 (no start stamp / qa relay).
    await recordCycleMetrics(cycleId, { totalDurationMs: 0, prNumber: "2363" });

    const m = await getCycleMetrics(cycleId);
    assert.equal(m.totalDurationMs, "619721", "the real span survives the 0 follow-up");
    assert.equal(m.prNumber, "2363", "the follow-up still enriched non-duration fields");
  });

  test("a later non-zero UPGRADES a stored 0 duration (the dev_orch repair)", async () => {
    const cycleId = "cycle-2364-upgrade";
    // First write: reap had no usable start stamp → truthful 0.
    await recordCycleMetrics(cycleId, { totalDurationMs: 0, tasksMerged: 1 });
    // Second write: the post-merge follow-up carries the real span.
    await recordCycleMetrics(cycleId, { totalDurationMs: 458000, prNumber: "2364" });

    const m = await getCycleMetrics(cycleId);
    assert.equal(m.totalDurationMs, "458000", "the 0 first write is upgraded to the real span");
  });

  test("two positive spans keep the larger (non-regressing) value", async () => {
    const cycleId = "cycle-2364-max";
    await recordCycleMetrics(cycleId, { totalDurationMs: 100000 });
    await recordCycleMetrics(cycleId, { totalDurationMs: 80000 });
    const m = await getCycleMetrics(cycleId);
    assert.equal(m.totalDurationMs, "100000", "the longer measured span wins");

    await recordCycleMetrics(cycleId, { totalDurationMs: 250000 });
    const m2 = await getCycleMetrics(cycleId);
    assert.equal(m2.totalDurationMs, "250000", "a longer later span still upgrades");
  });

  test("the monotonic guard applies to every duration field, not just totalDurationMs", async () => {
    const cycleId = "cycle-2364-all-fields";
    await recordCycleMetrics(cycleId, {
      totalDurationMs: 500000,
      groundingDurationMs: 12000,
      verificationDurationMs: 30000,
      planningDurationMs: 8000,
      executionDurationMs: 40000,
    });
    // A follow-up that zeroes every duration field must not regress any of them.
    await recordCycleMetrics(cycleId, {
      totalDurationMs: 0,
      groundingDurationMs: 0,
      verificationDurationMs: 0,
      planningDurationMs: 0,
      executionDurationMs: 0,
    });
    const m = await getCycleMetrics(cycleId);
    assert.equal(m.totalDurationMs, "500000");
    assert.equal(m.groundingDurationMs, "12000");
    assert.equal(m.verificationDurationMs, "30000");
    assert.equal(m.planningDurationMs, "8000");
    assert.equal(m.executionDurationMs, "40000");
  });

  test("a first write with a real duration persists it unchanged (no spurious read)", async () => {
    const cycleId = "cycle-2364-first";
    await recordCycleMetrics(cycleId, { totalDurationMs: 77777 });
    const m = await getCycleMetrics(cycleId);
    assert.equal(m.totalDurationMs, "77777");
  });

  test("a write with NO duration field leaves an existing stored duration untouched", async () => {
    const cycleId = "cycle-2364-no-duration-field";
    await recordCycleMetrics(cycleId, { totalDurationMs: 333000 });
    // Pure enrichment with no duration field — must not touch the stored span.
    await recordCycleMetrics(cycleId, { filesChanged: 5, prNumber: "2364" });
    const m = await getCycleMetrics(cycleId);
    assert.equal(m.totalDurationMs, "333000");
    assert.equal(m.filesChanged, "5");
  });
});

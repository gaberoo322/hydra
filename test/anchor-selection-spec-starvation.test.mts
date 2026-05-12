/**
 * Regression tests for spec-starvation instrumentation + capacity floor
 * (issue #301).
 *
 * Bug: 12 active specs sat at 0/N task progress for an extended period
 * because anchor priority 3 (kanban) and priority 2 (stuckness-driven
 * research) shadowed priority 4 (specs). The anchor distribution over a
 * 20-cycle window had zero "spec" selections.
 *
 * Fix: spec-starvation module (src/anchor-selection/spec-starvation.ts)
 *   - records *why* the spec tier was passed each cycle
 *   - maintains a "cycles since spec last served" gauge
 *   - exposes a capacity-floor predicate the selector uses to pre-empt
 *     kanban every Nth cycle
 *
 * These tests pin the pure predicate, the counter wiring, the API stats
 * shape, and the env-var override surface.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";
import { redisKeys } from "../src/redis-keys.ts";

let redis: any;

async function cleanKeys() {
  const keys = await redis.keys("hydra:*");
  if (keys.length > 0) await redis.del(...keys);
}

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379/1";
process.env.REDIS_URL = redisUrl;
redis = new Redis(redisUrl);

after(async () => {
  if (redis) {
    await cleanKeys();
    redis.disconnect();
  }
});

describe("shouldForceSpecPriority — pure predicate (issue #301)", () => {
  test("returns false when no spec task is available", async () => {
    const { shouldForceSpecPriority } = await import("../src/anchor-selection/spec-starvation.ts");
    assert.equal(shouldForceSpecPriority(0, false, 3), false);
    assert.equal(shouldForceSpecPriority(5, false, 3), false);
    // Even a huge gauge can't force a spec that doesn't exist.
    assert.equal(shouldForceSpecPriority(99, false, 3), false);
  });

  test("returns false until floorN cycles have passed", async () => {
    const { shouldForceSpecPriority } = await import("../src/anchor-selection/spec-starvation.ts");
    assert.equal(shouldForceSpecPriority(0, true, 3), false);
    assert.equal(shouldForceSpecPriority(1, true, 3), false);
    assert.equal(shouldForceSpecPriority(2, true, 3), false);
  });

  test("returns true once cyclesSinceServed >= floorN", async () => {
    const { shouldForceSpecPriority } = await import("../src/anchor-selection/spec-starvation.ts");
    assert.equal(shouldForceSpecPriority(3, true, 3), true);
    assert.equal(shouldForceSpecPriority(10, true, 3), true);
  });

  test("returns false for non-positive or non-finite floorN", async () => {
    const { shouldForceSpecPriority } = await import("../src/anchor-selection/spec-starvation.ts");
    assert.equal(shouldForceSpecPriority(100, true, 0), false);
    assert.equal(shouldForceSpecPriority(100, true, -1), false);
    assert.equal(shouldForceSpecPriority(100, true, NaN), false);
  });
});

describe("getSpecCapacityFloorN — env override (issue #301)", () => {
  test("default is 3 when env var is absent", async () => {
    const { getSpecCapacityFloorN, DEFAULT_SPEC_CAPACITY_FLOOR_N } = await import(
      "../src/anchor-selection/spec-starvation.ts"
    );
    assert.equal(DEFAULT_SPEC_CAPACITY_FLOOR_N, 3);
    assert.equal(getSpecCapacityFloorN({}), 3);
  });

  test("honours numeric env var", async () => {
    const { getSpecCapacityFloorN } = await import("../src/anchor-selection/spec-starvation.ts");
    assert.equal(getSpecCapacityFloorN({ HYDRA_SPEC_CAPACITY_FLOOR_N: "5" }), 5);
    assert.equal(getSpecCapacityFloorN({ HYDRA_SPEC_CAPACITY_FLOOR_N: "10" }), 10);
  });

  test("falls back to default on garbage values", async () => {
    const { getSpecCapacityFloorN } = await import("../src/anchor-selection/spec-starvation.ts");
    assert.equal(getSpecCapacityFloorN({ HYDRA_SPEC_CAPACITY_FLOOR_N: "" }), 3);
    assert.equal(getSpecCapacityFloorN({ HYDRA_SPEC_CAPACITY_FLOOR_N: "abc" }), 3);
    assert.equal(getSpecCapacityFloorN({ HYDRA_SPEC_CAPACITY_FLOOR_N: "0" }), 3);
    assert.equal(getSpecCapacityFloorN({ HYDRA_SPEC_CAPACITY_FLOOR_N: "-4" }), 3);
  });
});

describe("recordSpecPassedReason / recordSpecServed (issue #301)", () => {
  beforeEach(async () => {
    await cleanKeys();
  });

  test("recordSpecPassedReason increments per-reason hash counter", async () => {
    const { recordSpecPassedReason } = await import("../src/anchor-selection/spec-starvation.ts");
    await recordSpecPassedReason("kanban_won");
    await recordSpecPassedReason("kanban_won");
    await recordSpecPassedReason("wip_full");
    const reasons = await redis.hgetall(redisKeys.specsPassedReasons());
    assert.equal(reasons.kanban_won, "2");
    assert.equal(reasons.wip_full, "1");
  });

  test("recordSpecPassedReason advances cycles-since-served gauge", async () => {
    const { recordSpecPassedReason, getCyclesSinceSpecServed } = await import(
      "../src/anchor-selection/spec-starvation.ts"
    );
    await recordSpecPassedReason("kanban_won");
    await recordSpecPassedReason("kanban_won");
    assert.equal(await getCyclesSinceSpecServed(), 2);
    await recordSpecPassedReason("stuckness_won");
    assert.equal(await getCyclesSinceSpecServed(), 3);
  });

  test("force_floor does NOT advance the cycles-since-served gauge", async () => {
    // force_floor is the *output* of the floor firing — it co-occurs with
    // recordSpecServed() which resets the gauge. Allowing it to advance the
    // gauge would double-count and break the predicate's cadence.
    const { recordSpecPassedReason, recordSpecServed, getCyclesSinceSpecServed } = await import(
      "../src/anchor-selection/spec-starvation.ts"
    );
    await recordSpecPassedReason("kanban_won");
    await recordSpecPassedReason("kanban_won");
    await recordSpecPassedReason("kanban_won");
    assert.equal(await getCyclesSinceSpecServed(), 3);
    // Floor fires this cycle:
    await recordSpecServed();
    await recordSpecPassedReason("force_floor");
    assert.equal(await getCyclesSinceSpecServed(), 0);
    // The bookkeeping counter is still incremented though.
    const reasons = await redis.hgetall(redisKeys.specsPassedReasons());
    assert.equal(reasons.force_floor, "1");
  });

  test("recordSpecServed resets the gauge and stamps lastServedAt", async () => {
    const { recordSpecPassedReason, recordSpecServed, getCyclesSinceSpecServed } = await import(
      "../src/anchor-selection/spec-starvation.ts"
    );
    await recordSpecPassedReason("kanban_won");
    await recordSpecPassedReason("kanban_won");
    assert.equal(await getCyclesSinceSpecServed(), 2);
    const before = new Date().toISOString();
    await recordSpecServed();
    assert.equal(await getCyclesSinceSpecServed(), 0);
    const lastServed = await redis.get(redisKeys.specsLastServedAt());
    assert.ok(lastServed, "lastServedAt should be set");
    assert.ok(lastServed >= before, `lastServedAt ${lastServed} must be >= ${before}`);
  });
});

describe("getSpecStarvationStats — API surface (issue #301)", () => {
  beforeEach(async () => {
    await cleanKeys();
  });

  test("returns zeroed shape on empty Redis", async () => {
    const { getSpecStarvationStats } = await import("../src/anchor-selection/spec-starvation.ts");
    const stats = await getSpecStarvationStats();
    assert.equal(stats.cyclesSinceServed, 0);
    assert.equal(stats.lastServedAt, null);
    assert.deepEqual(stats.reasons, {});
    assert.equal(stats.floorN, 3);
  });

  test("returns populated counters and gauge", async () => {
    const { recordSpecPassedReason, getSpecStarvationStats } = await import(
      "../src/anchor-selection/spec-starvation.ts"
    );
    await recordSpecPassedReason("kanban_won");
    await recordSpecPassedReason("kanban_won");
    await recordSpecPassedReason("no_active_spec");
    const stats = await getSpecStarvationStats();
    assert.equal(stats.cyclesSinceServed, 3);
    assert.equal(stats.reasons.kanban_won, 2);
    assert.equal(stats.reasons.no_active_spec, 1);
    assert.equal(stats.floorN, 3);
  });
});

describe("capacity-floor cadence simulation (issue #301)", () => {
  // High-level proof: given a steady-state of "kanban always wins and a
  // spec task always exists", the floor fires exactly once every floorN
  // cycles. This is the regression we want — the historical 20-cycle
  // window had zero spec wins; this loop guarantees floor(20/3)=6.

  beforeEach(async () => {
    await cleanKeys();
  });

  test("over 20 cycles with floorN=3, the floor fires every 4 cycles", async () => {
    const {
      shouldForceSpecPriority,
      recordSpecPassedReason,
      recordSpecServed,
      getCyclesSinceSpecServed,
    } = await import("../src/anchor-selection/spec-starvation.ts");

    let forcedCount = 0;
    const floorN = 3;
    const forceCycles: number[] = [];
    for (let i = 0; i < 20; i++) {
      const gauge = await getCyclesSinceSpecServed();
      // hasSpecTask always true in this simulation — the bug scenario.
      if (shouldForceSpecPriority(gauge, true, floorN)) {
        forcedCount += 1;
        forceCycles.push(i);
        await recordSpecServed();
        await recordSpecPassedReason("force_floor");
      } else {
        await recordSpecPassedReason("kanban_won");
      }
    }
    // Cadence math: floorN=3 means "fire when gauge >= 3". After a force we
    // reset gauge to 0, then kanban_won fires 3 cycles in a row pushing the
    // gauge to 3, then the 4th cycle in the period forces. Period = 4
    // cycles. Over 20 cycles, with the first force at index 3, we get
    // forces at {3,7,11,15,19} — exactly 5. This is the AC: ">=1/N task
    // progress within 48h", and at 5/20 = 25% spec selection rate we
    // comfortably make 1 spec task progress per operating day.
    assert.equal(forcedCount, 5);
    assert.deepEqual(forceCycles, [3, 7, 11, 15, 19]);
  });

  test("with no spec task available, the floor NEVER fires (no busy-wait)", async () => {
    const {
      shouldForceSpecPriority,
      recordSpecPassedReason,
      getCyclesSinceSpecServed,
    } = await import("../src/anchor-selection/spec-starvation.ts");

    let forcedCount = 0;
    for (let i = 0; i < 20; i++) {
      const gauge = await getCyclesSinceSpecServed();
      if (shouldForceSpecPriority(gauge, false, 3)) {
        forcedCount += 1;
      } else {
        await recordSpecPassedReason("no_active_spec");
      }
    }
    assert.equal(forcedCount, 0);
  });
});

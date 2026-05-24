/**
 * Regression tests for reframe-starvation instrumentation + capacity floor
 * (issue #377).
 *
 * Bug: the reframe lane (priority 9 in CLAUDE.md) was being indefinitely
 * shadowed by higher-priority tiers. In a 50-cycle window with 17 abandoned
 * cycles, reframe served only 2 — roughly one walk per 25 cycles against
 * a queue that often had ~10 candidates. The REFRAME_INTERLEAVE_INTERVAL
 * constant existed but no consumer enforced it.
 *
 * Fix: reframe-starvation module (src/anchor-selection/reframe.ts)
 *   - records *why* the reframe tier was passed each cycle
 *   - maintains a "cycles since reframe last served" gauge
 *   - exposes a capacity-floor predicate the dispatcher uses to pre-empt
 *     kanban every Nth cycle
 *
 * These tests pin the pure predicate, the counter wiring, the API stats
 * shape, the env-var override surface, and the helper that recognises the
 * default-cadence constant.
 *
 * Requires Redis running on localhost:6379. Uses DB 1 — production lives
 * on DB 0.
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

describe("shouldForceReframePriority — pure predicate (issue #377)", () => {
  test("returns false when no reframe candidate is available", async () => {
    const { shouldForceReframePriority } = await import(
      "../src/anchor-selection/reframe.ts"
    );
    assert.equal(shouldForceReframePriority(0, false, 5), false);
    assert.equal(shouldForceReframePriority(5, false, 5), false);
    assert.equal(shouldForceReframePriority(99, false, 5), false);
  });

  test("returns false until floorN cycles have passed", async () => {
    const { shouldForceReframePriority } = await import(
      "../src/anchor-selection/reframe.ts"
    );
    assert.equal(shouldForceReframePriority(0, true, 5), false);
    assert.equal(shouldForceReframePriority(1, true, 5), false);
    assert.equal(shouldForceReframePriority(4, true, 5), false);
  });

  test("returns true once cyclesSinceServed >= floorN", async () => {
    const { shouldForceReframePriority } = await import(
      "../src/anchor-selection/reframe.ts"
    );
    assert.equal(shouldForceReframePriority(5, true, 5), true);
    assert.equal(shouldForceReframePriority(50, true, 5), true);
  });

  test("returns false for non-positive or non-finite floorN", async () => {
    const { shouldForceReframePriority } = await import(
      "../src/anchor-selection/reframe.ts"
    );
    assert.equal(shouldForceReframePriority(100, true, 0), false);
    assert.equal(shouldForceReframePriority(100, true, -1), false);
    assert.equal(shouldForceReframePriority(100, true, NaN), false);
  });
});

describe("getReframeFloorN — env override (issue #377)", () => {
  test("default is 5 when env var is absent", async () => {
    const { getReframeFloorN, DEFAULT_REFRAME_FLOOR_N } = await import(
      "../src/anchor-selection/reframe.ts"
    );
    assert.equal(DEFAULT_REFRAME_FLOOR_N, 5);
    assert.equal(getReframeFloorN({}), 5);
  });

  test("honours numeric env var", async () => {
    const { getReframeFloorN } = await import(
      "../src/anchor-selection/reframe.ts"
    );
    assert.equal(getReframeFloorN({ HYDRA_REFRAME_FLOOR_N: "7" }), 7);
    assert.equal(getReframeFloorN({ HYDRA_REFRAME_FLOOR_N: "10" }), 10);
  });

  test("falls back to default on garbage values", async () => {
    const { getReframeFloorN } = await import(
      "../src/anchor-selection/reframe.ts"
    );
    assert.equal(getReframeFloorN({ HYDRA_REFRAME_FLOOR_N: "" }), 5);
    assert.equal(getReframeFloorN({ HYDRA_REFRAME_FLOOR_N: "abc" }), 5);
    assert.equal(getReframeFloorN({ HYDRA_REFRAME_FLOOR_N: "0" }), 5);
    assert.equal(getReframeFloorN({ HYDRA_REFRAME_FLOOR_N: "-4" }), 5);
  });
});

describe("recordReframePassedReason / recordReframeServed (issue #377)", () => {
  beforeEach(async () => {
    await cleanKeys();
  });

  test("recordReframePassedReason increments the per-reason hash and the gauge", async () => {
    const { recordReframePassedReason, getCyclesSinceReframeServed } = await import(
      "../src/anchor-selection/reframe.ts"
    );

    await recordReframePassedReason("kanban_won");
    await recordReframePassedReason("kanban_won");
    await recordReframePassedReason("spec_won");

    const reasonsHash = await redis.hgetall(redisKeys.anchorReframePassedReasons());
    assert.equal(parseInt(reasonsHash.kanban_won), 2);
    assert.equal(parseInt(reasonsHash.spec_won), 1);

    const gauge = await getCyclesSinceReframeServed();
    assert.equal(gauge, 3, "gauge should advance 1 per recorded pass-over");
  });

  test("force_floor records the reason hash but does NOT advance the gauge", async () => {
    const { recordReframePassedReason, getCyclesSinceReframeServed } = await import(
      "../src/anchor-selection/reframe.ts"
    );

    await recordReframePassedReason("force_floor");
    await recordReframePassedReason("force_floor");

    const reasonsHash = await redis.hgetall(redisKeys.anchorReframePassedReasons());
    assert.equal(parseInt(reasonsHash.force_floor), 2);

    const gauge = await getCyclesSinceReframeServed();
    assert.equal(gauge, 0, "force_floor must not advance the starvation gauge");
  });

  test("recordReframeServed resets the gauge and stamps lastServedAt", async () => {
    const {
      recordReframePassedReason,
      recordReframeServed,
      getCyclesSinceReframeServed,
    } = await import("../src/anchor-selection/reframe.ts");

    await recordReframePassedReason("kanban_won");
    await recordReframePassedReason("spec_won");
    assert.equal(await getCyclesSinceReframeServed(), 2);

    await recordReframeServed();

    assert.equal(
      await getCyclesSinceReframeServed(),
      0,
      "gauge must reset on serve",
    );
    const lastServed = await redis.get(redisKeys.anchorReframeLastServedAt());
    assert.ok(lastServed, "lastServedAt should be populated");
    // ISO-8601 sanity check
    assert.match(lastServed, /^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("getReframeStarvationStats — API surface (issue #377)", () => {
  beforeEach(async () => {
    await cleanKeys();
  });

  test("returns zero-state when nothing recorded yet", async () => {
    const { getReframeStarvationStats } = await import(
      "../src/anchor-selection/reframe.ts"
    );
    const stats = await getReframeStarvationStats();
    assert.deepEqual(stats, {
      cyclesSinceServed: 0,
      lastServedAt: null,
      reasons: {},
      floorN: 5,
    });
  });

  test("includes recorded reasons, gauge, and floorN", async () => {
    const {
      recordReframePassedReason,
      recordReframeServed,
      getReframeStarvationStats,
    } = await import("../src/anchor-selection/reframe.ts");

    await recordReframePassedReason("kanban_won");
    await recordReframePassedReason("spec_won");
    await recordReframePassedReason("kanban_won");
    await recordReframeServed();
    // After serve: gauge reset, reasons hash preserved (monotonic counters).
    await recordReframePassedReason("kanban_won");

    const stats = await getReframeStarvationStats();
    assert.equal(stats.cyclesSinceServed, 1);
    assert.ok(stats.lastServedAt);
    assert.deepEqual(stats.reasons, { kanban_won: 3, spec_won: 1 });
    assert.equal(stats.floorN, 5);
  });
});

describe("REFRAME_INTERLEAVE_INTERVAL parity (issue #377)", () => {
  test("DEFAULT_REFRAME_FLOOR_N matches the legacy interleave constant", async () => {
    const { DEFAULT_REFRAME_FLOOR_N } = await import(
      "../src/anchor-selection/reframe.ts"
    );
    const { _testing } = await import("../src/anchor-selection.ts");
    assert.equal(
      DEFAULT_REFRAME_FLOOR_N,
      _testing.REFRAME_INTERLEAVE_INTERVAL,
      "The new floor cadence must equal the historical interleave interval (5).",
    );
  });
});

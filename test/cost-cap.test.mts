/**
 * Regression tests for the per-cycle cost cap circuit breaker (issue #209).
 *
 * Bug: There was no per-cycle spending cap on the build loop. Recent
 * metrics showed abandoned cycles consuming up to $56 each before
 * hitting their gate (Preflight, Auto-decompose, Planner noWork). With
 * 31 abandoned cycles in the last 50, this was the dominant cost-leak
 * class — a single bad cycle cost ~3x the median cycle.
 *
 * Fix: New `HYDRA_PER_CYCLE_COST_CAP_USD` env (default $25) aborts a
 * build cycle once accumulated agent cost crosses the threshold. The
 * cycle records `Cost cap exceeded: ...` as `abandonReason` so it
 * appears as a category in `/api/metrics/abandonment`.
 *
 * Requires Redis running on localhost:6379 (default).
 * Uses Redis DB 1 for tests — never touches production (DB 0).
 */

import { test, describe, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

// Force test DB before adapter imports
process.env.REDIS_URL = "redis://localhost:6379/1";

// Lazy module imports (after env override)
const {
  getPerCycleCostCapUsd,
  getCycleCostUsd,
  checkCostCap,
  COST_CAP_REASON_PREFIX,
} = await import("../src/cost/cap.ts");

let testRedis: any;

async function cleanKeys() {
  const patterns = [
    "hydra:cycle:*",
    "hydra:metrics:*",
    "hydra:anchors:*",
    "hydra:reflections:*",
  ];
  for (const pat of patterns) {
    const keys = await testRedis.keys(pat);
    if (keys.length > 0) await testRedis.del(...keys);
  }
}

describe("per-cycle cost cap circuit breaker (issue #209)", () => {
  // Snapshot env so individual tests can mutate without leaking to siblings
  let savedCap: string | undefined;

  beforeEach(async () => {
    if (!testRedis) testRedis = new Redis("redis://localhost:6379/1");
    savedCap = process.env.HYDRA_PER_CYCLE_COST_CAP_USD;
    delete process.env.HYDRA_PER_CYCLE_COST_CAP_USD;
    await cleanKeys();
  });

  afterEach(() => {
    if (savedCap === undefined) {
      delete process.env.HYDRA_PER_CYCLE_COST_CAP_USD;
    } else {
      process.env.HYDRA_PER_CYCLE_COST_CAP_USD = savedCap;
    }
  });

  after(async () => {
    if (testRedis) {
      await cleanKeys();
      testRedis.disconnect();
    }
  });

  // -----------------------------------------------------------------
  // getPerCycleCostCapUsd — env parsing and default
  // -----------------------------------------------------------------

  describe("getPerCycleCostCapUsd", () => {
    test("returns default $25 when env unset", () => {
      delete process.env.HYDRA_PER_CYCLE_COST_CAP_USD;
      assert.equal(getPerCycleCostCapUsd(), 25);
    });

    test("parses numeric env value", () => {
      process.env.HYDRA_PER_CYCLE_COST_CAP_USD = "10";
      assert.equal(getPerCycleCostCapUsd(), 10);
      process.env.HYDRA_PER_CYCLE_COST_CAP_USD = "0.5";
      assert.equal(getPerCycleCostCapUsd(), 0.5);
    });

    test("returns Infinity for 'Infinity' value", () => {
      process.env.HYDRA_PER_CYCLE_COST_CAP_USD = "Infinity";
      assert.equal(getPerCycleCostCapUsd(), Infinity);
      process.env.HYDRA_PER_CYCLE_COST_CAP_USD = "infinity";
      assert.equal(getPerCycleCostCapUsd(), Infinity);
    });

    test("returns Infinity for non-finite or non-positive values (off)", () => {
      process.env.HYDRA_PER_CYCLE_COST_CAP_USD = "0";
      assert.equal(getPerCycleCostCapUsd(), Infinity);
      process.env.HYDRA_PER_CYCLE_COST_CAP_USD = "-5";
      assert.equal(getPerCycleCostCapUsd(), Infinity);
      process.env.HYDRA_PER_CYCLE_COST_CAP_USD = "not-a-number";
      assert.equal(getPerCycleCostCapUsd(), Infinity);
    });

    test("treats empty string as default", () => {
      process.env.HYDRA_PER_CYCLE_COST_CAP_USD = "";
      assert.equal(getPerCycleCostCapUsd(), 25);
    });
  });

  // -----------------------------------------------------------------
  // getCycleCostUsd — Redis read of accumulated microdollars
  // -----------------------------------------------------------------

  describe("getCycleCostUsd", () => {
    test("returns 0 for cycle with no recorded spend", async () => {
      const cost = await getCycleCostUsd("cycle-cc-empty");
      assert.equal(cost, 0);
    });

    test("converts microdollars to dollars", async () => {
      // Manually seed the costs hash that task-tracker normally writes
      await testRedis.hset(
        "hydra:cycle:cycle-cc-seed:costs",
        "costMicrodollars",
        12_500_000, // $12.50
      );
      const cost = await getCycleCostUsd("cycle-cc-seed");
      assert.equal(cost, 12.5);
    });

    test("handles negative or invalid values defensively", async () => {
      await testRedis.hset(
        "hydra:cycle:cycle-cc-bad:costs",
        "costMicrodollars",
        "-100",
      );
      const cost = await getCycleCostUsd("cycle-cc-bad");
      assert.equal(cost, 0);
    });
  });

  // -----------------------------------------------------------------
  // checkCostCap — pure status query
  // -----------------------------------------------------------------

  describe("checkCostCap", () => {
    test("not exceeded under cap", async () => {
      process.env.HYDRA_PER_CYCLE_COST_CAP_USD = "25";
      await testRedis.hset(
        "hydra:cycle:cycle-cc-under:costs",
        "costMicrodollars",
        10_000_000, // $10
      );
      const status = await checkCostCap("cycle-cc-under");
      assert.equal(status.exceeded, false);
      assert.equal(status.costUsd, 10);
      assert.equal(status.capUsd, 25);
    });

    test("exceeded when cost meets cap exactly", async () => {
      process.env.HYDRA_PER_CYCLE_COST_CAP_USD = "5";
      await testRedis.hset(
        "hydra:cycle:cycle-cc-eq:costs",
        "costMicrodollars",
        5_000_000, // $5
      );
      const status = await checkCostCap("cycle-cc-eq");
      assert.equal(status.exceeded, true);
      assert.match(status.reason, new RegExp(`^${COST_CAP_REASON_PREFIX}: \\$5\\.00`));
    });

    test("exceeded when cost is above cap", async () => {
      process.env.HYDRA_PER_CYCLE_COST_CAP_USD = "10";
      await testRedis.hset(
        "hydra:cycle:cycle-cc-over:costs",
        "costMicrodollars",
        56_000_000, // $56 — the worst observed cycle
      );
      const status = await checkCostCap("cycle-cc-over");
      assert.equal(status.exceeded, true);
      assert.equal(status.costUsd, 56);
    });

    test("never exceeded when cap is Infinity", async () => {
      process.env.HYDRA_PER_CYCLE_COST_CAP_USD = "Infinity";
      await testRedis.hset(
        "hydra:cycle:cycle-cc-inf:costs",
        "costMicrodollars",
        100_000_000, // $100
      );
      const status = await checkCostCap("cycle-cc-inf");
      assert.equal(status.exceeded, false);
      assert.equal(status.capUsd, Infinity);
    });
  });

});

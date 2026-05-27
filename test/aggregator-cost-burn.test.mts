/**
 * Regression tests for the cost-burn aggregator (issue #618).
 *
 * Covers:
 *   - pure helpers: tokensToUsdPerMillion, computeSpark, computeHeadroomPct
 *   - happy path: full deps stubbed
 *   - bucket boundary: 5h and 24h windows producing different per-hour rates
 *   - empty state: zero tokens, zero budget
 *   - sub-source failure isolation
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  getCostBurn,
  tokensToUsdPerMillion,
  computeSpark,
  computeHeadroomPct,
} from "../src/aggregators/cost-burn.ts";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("tokensToUsdPerMillion — pure helper", () => {
  test("computes USD from tokens at a given USD-per-million rate", () => {
    assert.equal(tokensToUsdPerMillion(1_000_000, 5), 5);
    assert.equal(tokensToUsdPerMillion(500_000, 10), 5);
    assert.equal(tokensToUsdPerMillion(100_000, 20), 2);
  });

  test("returns 0 for zero / negative inputs", () => {
    assert.equal(tokensToUsdPerMillion(0, 5), 0);
    assert.equal(tokensToUsdPerMillion(-1, 5), 0);
    assert.equal(tokensToUsdPerMillion(1_000_000, 0), 0);
    assert.equal(tokensToUsdPerMillion(1_000_000, -1), 0);
  });

  test("rounds to 4 decimal places", () => {
    // 1 token at $1/M = $0.000001 → rounds to 0.
    assert.equal(tokensToUsdPerMillion(1, 1), 0);
    // 100 tokens at $1/M = $0.0001 — exactly the resolution boundary.
    assert.equal(tokensToUsdPerMillion(100, 1), 0.0001);
  });
});

describe("computeSpark — pure helper", () => {
  test("returns [5h-hourly-rate, 24h-hourly-rate]", () => {
    // 5h window: 5M tokens at $10/M → $50 over 5h → $10/h.
    // 24h window: 24M tokens at $10/M → $240 over 24h → $10/h.
    const spark = computeSpark({
      tokensLast5hTotal: 5_000_000,
      tokensLast24hTotal: 24_000_000,
      tokenUsdRate: 10,
    });
    assert.deepEqual(spark, [10, 10]);
  });

  test("emits [0, 0] when rate is 0", () => {
    const spark = computeSpark({
      tokensLast5hTotal: 5_000_000,
      tokensLast24hTotal: 24_000_000,
      tokenUsdRate: 0,
    });
    assert.deepEqual(spark, [0, 0]);
  });

  test("emits [0, 0] when both bucket totals are 0", () => {
    const spark = computeSpark({
      tokensLast5hTotal: 0,
      tokensLast24hTotal: 0,
      tokenUsdRate: 10,
    });
    assert.deepEqual(spark, [0, 0]);
  });

  test("captures a rising burn rate: 5h-rate > 24h-rate", () => {
    // Recent spike: 10M tokens in 5h ($20/h) vs 12M over 24h ($5/h).
    const spark = computeSpark({
      tokensLast5hTotal: 10_000_000,
      tokensLast24hTotal: 12_000_000,
      tokenUsdRate: 10,
    });
    assert.equal(spark[0], 20);
    assert.equal(spark[1], 5);
  });
});

describe("computeHeadroomPct — pure helper", () => {
  test("100 when budget is 0 or unset", () => {
    assert.equal(computeHeadroomPct(5, 0), 100);
    assert.equal(computeHeadroomPct(5, -1), 100);
  });

  test("100 when daySpent is 0 or negative", () => {
    assert.equal(computeHeadroomPct(0, 50), 100);
    assert.equal(computeHeadroomPct(-1, 50), 100);
  });

  test("clamps at 0 when overspent", () => {
    assert.equal(computeHeadroomPct(100, 50), 0);
    assert.equal(computeHeadroomPct(60, 50), 0);
  });

  test("computes (1 - spent/budget) * 100 inside the band", () => {
    // $10 of $50 → 80% headroom remaining.
    assert.equal(computeHeadroomPct(10, 50), 80);
    // $25 of $50 → 50% headroom remaining.
    assert.equal(computeHeadroomPct(25, 50), 50);
  });
});

// ---------------------------------------------------------------------------
// getCostBurn — integration via deps
// ---------------------------------------------------------------------------

describe("getCostBurn — happy path", () => {
  test("returns a complete CostBurn shape", async () => {
    const burn = await getCostBurn({
      readDaySpentUsd: async () => 12.5,
      readUsage: async () => ({
        tokensLast5h: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 5_000_000 },
        tokensLast24h: 24_000_000,
      }),
      getTokenUsdRate: () => 10,
      readDailyBudgetUsd: () => 100,
    });
    assert.equal(burn.daySpent, 12.5);
    assert.equal(burn.dailyBudget, 100);
    assert.deepEqual(burn.lastHourSpark, [10, 10]);
    assert.equal(burn.headroomPct, 87.5);
  });
});

describe("getCostBurn — bucket boundary", () => {
  test("5h-only burn produces non-zero 5h spark and zero 24h spark", async () => {
    const burn = await getCostBurn({
      readDaySpentUsd: async () => 0,
      readUsage: async () => ({
        tokensLast5h: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 5_000_000 },
        tokensLast24h: 0,
      }),
      getTokenUsdRate: () => 10,
      readDailyBudgetUsd: () => 0,
    });
    assert.equal(burn.lastHourSpark.length, 2);
    assert.ok(burn.lastHourSpark[0] > 0);
    assert.equal(burn.lastHourSpark[1], 0);
  });
});

describe("getCostBurn — empty state", () => {
  test("zero tokens + zero budget yields [0,0] spark and 100% headroom", async () => {
    const burn = await getCostBurn({
      readDaySpentUsd: async () => 0,
      readUsage: async () => ({
        tokensLast5h: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 },
        tokensLast24h: 0,
      }),
      getTokenUsdRate: () => 10,
      readDailyBudgetUsd: () => 0,
    });
    assert.equal(burn.daySpent, 0);
    assert.equal(burn.dailyBudget, 0);
    assert.deepEqual(burn.lastHourSpark, [0, 0]);
    assert.equal(burn.headroomPct, 100);
  });
});

describe("getCostBurn — sub-source failure isolation", () => {
  test("daySpent reader throws → daySpent degrades to 0 but spark still computes", async () => {
    const burn = await getCostBurn({
      readDaySpentUsd: async () => {
        throw new Error("surrogate down");
      },
      readUsage: async () => ({
        tokensLast5h: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 5_000_000 },
        tokensLast24h: 24_000_000,
      }),
      getTokenUsdRate: () => 10,
      readDailyBudgetUsd: () => 50,
    });
    assert.equal(burn.daySpent, 0);
    assert.deepEqual(burn.lastHourSpark, [10, 10]);
    assert.equal(burn.headroomPct, 100);
  });

  test("usage reader throws → spark degrades to [0,0] but daySpent still ships", async () => {
    const burn = await getCostBurn({
      readDaySpentUsd: async () => 25,
      readUsage: async () => {
        throw new Error("usage tracker failed");
      },
      getTokenUsdRate: () => 10,
      readDailyBudgetUsd: () => 100,
    });
    assert.equal(burn.daySpent, 25);
    assert.deepEqual(burn.lastHourSpark, [0, 0]);
    assert.equal(burn.headroomPct, 75);
  });
});

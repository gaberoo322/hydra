/**
 * Regression tests for the cost-burn aggregator (issue #618).
 *
 * The USD dollar-budget fields (daySpent / dailyBudget / headroomPct) and
 * the computeHeadroomPct helper were retired in #885 — under the Claude Code
 * subscription a USD attribution is a fiction (see CONTEXT.md Quota Weight),
 * so those tests pinned a structurally-$0 / 100%-headroom path and were
 * deleted. The aggregator now ships only the token-derived burn-rate spark.
 *
 * Covers:
 *   - pure helpers: tokensToUsdPerMillion, computeSpark
 *   - happy path: full deps stubbed
 *   - bucket boundary: 5h and 24h windows producing different per-hour rates
 *   - empty state: zero tokens
 *   - sub-source failure isolation
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  getCostBurn,
  tokensToUsdPerMillion,
  computeSpark,
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

// ---------------------------------------------------------------------------
// getCostBurn — integration via deps
// ---------------------------------------------------------------------------

describe("getCostBurn — happy path", () => {
  test("returns a complete CostBurn shape (spark only)", async () => {
    const burn = await getCostBurn({
      readUsage: async () => ({
        tokensLast5h: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 5_000_000 },
        tokensLast24h: 24_000_000,
      }),
      getTokenUsdRate: () => 10,
    });
    assert.deepEqual(Object.keys(burn), ["lastHourSpark"]);
    assert.deepEqual(burn.lastHourSpark, [10, 10]);
  });
});

describe("getCostBurn — bucket boundary", () => {
  test("5h-only burn produces non-zero 5h spark and zero 24h spark", async () => {
    const burn = await getCostBurn({
      readUsage: async () => ({
        tokensLast5h: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 5_000_000 },
        tokensLast24h: 0,
      }),
      getTokenUsdRate: () => 10,
    });
    assert.equal(burn.lastHourSpark.length, 2);
    assert.ok(burn.lastHourSpark[0] > 0);
    assert.equal(burn.lastHourSpark[1], 0);
  });
});

describe("getCostBurn — empty state", () => {
  test("zero tokens yields [0,0] spark", async () => {
    const burn = await getCostBurn({
      readUsage: async () => ({
        tokensLast5h: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 },
        tokensLast24h: 0,
      }),
      getTokenUsdRate: () => 10,
    });
    assert.deepEqual(burn.lastHourSpark, [0, 0]);
  });
});

describe("getCostBurn — sub-source failure isolation", () => {
  test("usage reader throws → spark degrades to [0,0]", async () => {
    const burn = await getCostBurn({
      readUsage: async () => {
        throw new Error("usage tracker failed");
      },
      getTokenUsdRate: () => 10,
    });
    assert.deepEqual(burn.lastHourSpark, [0, 0]);
  });
});

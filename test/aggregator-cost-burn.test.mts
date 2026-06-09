/**
 * Regression tests for the cost-burn aggregator (issue #618).
 *
 * The USD dollar-budget fields (daySpent / dailyBudget / headroomPct) were
 * retired in #885, and the structurally-$0 token-to-USD display interface
 * (getTokenUsdRate / tokensToUsdPerMillion / HYDRA_TOKEN_USD_RATE) was
 * honest-deleted in #1413 — under the Claude Code subscription a USD
 * attribution is a fiction (see CONTEXT.md Quota Weight). The aggregator now
 * ships only the token-denominated burn-rate pair the Subscription Usage
 * Tracker actually measures.
 *
 * Covers:
 *   - pure helpers: tokensPerHour, computeBurnRates
 *   - happy path: full deps stubbed
 *   - bucket boundary: 5h and 24h windows producing different per-hour rates
 *   - empty state: zero tokens
 *   - sub-source failure isolation
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  getCostBurn,
  tokensPerHour,
  computeBurnRates,
} from "../src/aggregators/cost-burn.ts";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("tokensPerHour — pure helper", () => {
  test("averages a window total down to a per-hour rate", () => {
    assert.equal(tokensPerHour(5_000_000, 5), 1_000_000);
    assert.equal(tokensPerHour(24_000_000, 24), 1_000_000);
    assert.equal(tokensPerHour(100, 4), 25);
  });

  test("returns 0 for zero / negative inputs", () => {
    assert.equal(tokensPerHour(0, 5), 0);
    assert.equal(tokensPerHour(-1, 5), 0);
    assert.equal(tokensPerHour(1_000_000, 0), 0);
    assert.equal(tokensPerHour(1_000_000, -1), 0);
  });

  test("rounds to the nearest whole token", () => {
    // 10 tokens over 3h = 3.33… → rounds to 3.
    assert.equal(tokensPerHour(10, 3), 3);
  });
});

describe("computeBurnRates — pure helper", () => {
  test("returns { tokensPerHour5h, tokensPerHour24h }", () => {
    // 5h window: 5M tokens → 1M/h. 24h window: 24M tokens → 1M/h.
    const burn = computeBurnRates({
      tokensLast5hTotal: 5_000_000,
      tokensLast24hTotal: 24_000_000,
    });
    assert.deepEqual(burn, { tokensPerHour5h: 1_000_000, tokensPerHour24h: 1_000_000 });
  });

  test("emits zeros when both bucket totals are 0", () => {
    const burn = computeBurnRates({
      tokensLast5hTotal: 0,
      tokensLast24hTotal: 0,
    });
    assert.deepEqual(burn, { tokensPerHour5h: 0, tokensPerHour24h: 0 });
  });

  test("captures a rising burn rate: 5h-rate > 24h-rate", () => {
    // Recent spike: 10M tokens in 5h (2M/h) vs 12M over 24h (0.5M/h).
    const burn = computeBurnRates({
      tokensLast5hTotal: 10_000_000,
      tokensLast24hTotal: 12_000_000,
    });
    assert.equal(burn.tokensPerHour5h, 2_000_000);
    assert.equal(burn.tokensPerHour24h, 500_000);
  });
});

// ---------------------------------------------------------------------------
// getCostBurn — integration via deps
// ---------------------------------------------------------------------------

describe("getCostBurn — happy path", () => {
  test("returns a complete CostBurn shape (token rates only)", async () => {
    const burn = await getCostBurn({
      readUsage: async () => ({
        tokensLast5h: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 5_000_000 },
        tokensLast24h: 24_000_000,
      }),
    });
    assert.deepEqual(Object.keys(burn).sort(), ["tokensPerHour24h", "tokensPerHour5h"]);
    assert.equal(burn.tokensPerHour5h, 1_000_000);
    assert.equal(burn.tokensPerHour24h, 1_000_000);
  });
});

describe("getCostBurn — bucket boundary", () => {
  test("5h-only burn produces non-zero 5h rate and zero 24h rate", async () => {
    const burn = await getCostBurn({
      readUsage: async () => ({
        tokensLast5h: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 5_000_000 },
        tokensLast24h: 0,
      }),
    });
    assert.ok(burn.tokensPerHour5h > 0);
    assert.equal(burn.tokensPerHour24h, 0);
  });
});

describe("getCostBurn — empty state", () => {
  test("zero tokens yields zero rates", async () => {
    const burn = await getCostBurn({
      readUsage: async () => ({
        tokensLast5h: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 },
        tokensLast24h: 0,
      }),
    });
    assert.deepEqual(burn, { tokensPerHour5h: 0, tokensPerHour24h: 0 });
  });
});

describe("getCostBurn — sub-source failure isolation", () => {
  test("usage reader throws → rates degrade to 0", async () => {
    const burn = await getCostBurn({
      readUsage: async () => {
        throw new Error("usage tracker failed");
      },
    });
    assert.deepEqual(burn, { tokensPerHour5h: 0, tokensPerHour24h: 0 });
  });
});

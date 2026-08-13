/**
 * Regression tests for `weightedTokens` — the per-token-category weighted UNIT
 * (issue #3825).
 *
 * Pre-#3825 the fold hardcoded input / output / cacheCreation at weight 1.0 and
 * exposed only `cacheRead`, so every ranking surface ranked consumers by RAW
 * cache-read volume (85% of volume, ~25% of real burn) while the dominant cost
 * driver — cache writes — was invisible. This file pins the four-category fix:
 *
 *   - each of the four categories contributes at its OWN configured weight
 *     (isolation test per category) — AC5 / ask #1
 *   - the fold is NOT an identity under the default list-price config — AC5
 *   - the documented volume/cost inversion holds: cache-read-dominant volume
 *     shrinks under list-price weights, cache-write grows
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { weightedTokens } from "../src/cost/token-math.ts";
import type { TokenBreakdown, CategoryWeights } from "../src/cost/token-math.ts";
// The list-price DEFAULTS live in the env-reader leaf (issue #3825); import them
// so the "default config" assertions track the source of truth, not a literal.
import {
  DEFAULT_BURN_WEIGHT_INPUT,
  DEFAULT_BURN_WEIGHT_OUTPUT,
  DEFAULT_BURN_WEIGHT_CACHE_READ,
  DEFAULT_BURN_WEIGHT_CACHE_CREATION,
} from "../src/cost/config.ts";

function breakdown(
  input = 0,
  output = 0,
  cacheRead = 0,
  cacheCreation = 0,
): TokenBreakdown {
  return { input, output, cacheRead, cacheCreation, total: input + output + cacheRead + cacheCreation };
}

describe("weightedTokens (issue #3825)", () => {
  test("each of the four categories contributes at its own configured weight", () => {
    // A non-trivial weight per category, none equal, so a leak between axes
    // (e.g. cacheCreation silently pinned at 1.0) changes the result.
    const w: CategoryWeights = { input: 3, output: 5, cacheRead: 0.1, cacheCreation: 1.25 };

    // Isolate each category: only ONE axis non-zero → the fold must equal that
    // axis's weight × its token count, proving the weight actually binds.
    assert.equal(weightedTokens(breakdown(100), w), 300, "input axis"); // 3 * 100
    assert.equal(weightedTokens(breakdown(0, 100), w), 500, "output axis"); // 5 * 100
    assert.equal(weightedTokens(breakdown(0, 0, 100), w), 10, "cacheRead axis"); // 0.1 * 100
    assert.equal(weightedTokens(breakdown(0, 0, 0, 100), w), 125, "cacheCreation axis"); // 1.25 * 100
  });

  test("all-1.0 weights reduce to .total (the identity baseline)", () => {
    const identity: CategoryWeights = { input: 1, output: 1, cacheRead: 1, cacheCreation: 1 };
    const b = breakdown(100, 200, 300, 400);
    assert.equal(weightedTokens(b, identity), b.total);
  });

  test("is NOT an identity under the DEFAULT list-price config (criterion 5)", () => {
    // The pre-#3825 default config was identity for 3 of 4 axes; the new default
    // list-price config is NOT, which is the whole point.
    const defaults: CategoryWeights = {
      input: DEFAULT_BURN_WEIGHT_INPUT, // 1.0
      output: DEFAULT_BURN_WEIGHT_OUTPUT, // 5.0
      cacheRead: DEFAULT_BURN_WEIGHT_CACHE_READ, // 0.1
      cacheCreation: DEFAULT_BURN_WEIGHT_CACHE_CREATION, // 1.25
    };
    const b = breakdown(100, 100, 100, 100);
    assert.notEqual(weightedTokens(b, defaults), b.total);
    // 1*100 + 5*100 + 0.1*100 + 1.25*100 = 735
    assert.equal(weightedTokens(b, defaults), 735);
  });

  test("the volume/cost inversion the issue describes: cache-read volume shrinks, cache-write grows", () => {
    // A realistic cache-read-dominant mix: cacheRead is ~70% of VOLUME but the
    // cheapest category; cacheCreation (cache-write) is ~12% of volume but a
    // top cost driver. Ranking by raw tokens puts cacheRead on top; weighting
    // inverts it.
    const defaults: CategoryWeights = {
      input: DEFAULT_BURN_WEIGHT_INPUT,
      output: DEFAULT_BURN_WEIGHT_OUTPUT,
      cacheRead: DEFAULT_BURN_WEIGHT_CACHE_READ,
      cacheCreation: DEFAULT_BURN_WEIGHT_CACHE_CREATION,
    };
    const b = breakdown(10_000, 5_000, 60_000, 10_000); // total 85,000
    // 1*10000 + 5*5000 + 0.1*60000 + 1.25*10000 = 53500
    assert.equal(weightedTokens(b, defaults), 53_500);
    // Raw cache-read share of volume ≈ 70.6%; its share of the WEIGHTED total:
    const cacheReadWeightedShare = (DEFAULT_BURN_WEIGHT_CACHE_READ * 60_000) / 53_500;
    assert.ok(cacheReadWeightedShare < 0.15, "cache-read shrinks from ~70% of volume to ~11% of burn");
    // Cache-write share of volume ≈ 11.8%; of the WEIGHTED total:
    const cacheWriteWeightedShare = (DEFAULT_BURN_WEIGHT_CACHE_CREATION * 10_000) / 53_500;
    assert.ok(cacheWriteWeightedShare > 0.2, "cache-write grows from ~12% of volume to ~23% of burn");
  });
});

/**
 * Regression tests for the ranked-report burn-weight config readers (issue #3825).
 *
 * These readers (`getBurnWeight*` / `getBurnFamily*` + their `*Weights`
 * composers) live in their OWN `HYDRA_USAGE_BURN_WEIGHT_*` /
 * `HYDRA_USAGE_BURN_FAMILY_*` namespace, DISTINCT from the identity-by-default
 * live-fold readers, and default to LIST-PRICE ratios so the report's
 * calibration never leaks into the live gate. This file pins:
 *
 *   - the list-price DEFAULTS (category: input 1 / output 5 / cacheRead 0.1 /
 *     cacheCreation 1.25; family: opus 5 / sonnet 3 / haiku 1, calibrated from
 *     per-MTok input price)
 *   - env-var override per reader
 *   - the fail-loud fallback for a non-positive / non-finite value
 *   - the two composers delegate to the per-axis readers
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  getBurnWeightInput,
  getBurnWeightOutput,
  getBurnWeightCacheRead,
  getBurnWeightCacheCreation,
  getBurnCategoryWeights,
  getBurnFamilyWeightOpus,
  getBurnFamilyWeightSonnet,
  getBurnFamilyWeightHaiku,
  getBurnFamilyWeights,
  DEFAULT_BURN_WEIGHT_INPUT,
  DEFAULT_BURN_WEIGHT_OUTPUT,
  DEFAULT_BURN_WEIGHT_CACHE_READ,
  DEFAULT_BURN_WEIGHT_CACHE_CREATION,
  DEFAULT_BURN_FAMILY_OPUS,
  DEFAULT_BURN_FAMILY_SONNET,
  DEFAULT_BURN_FAMILY_HAIKU,
} from "../src/cost/config.ts";

const BURN_ENV_KEYS = [
  "HYDRA_USAGE_BURN_WEIGHT_INPUT",
  "HYDRA_USAGE_BURN_WEIGHT_OUTPUT",
  "HYDRA_USAGE_BURN_WEIGHT_CACHE_READ",
  "HYDRA_USAGE_BURN_WEIGHT_CACHE_CREATION",
  "HYDRA_USAGE_BURN_FAMILY_OPUS",
  "HYDRA_USAGE_BURN_FAMILY_SONNET",
  "HYDRA_USAGE_BURN_FAMILY_HAIKU",
];

function snapshot() {
  const prev: Record<string, string | undefined> = {};
  for (const k of BURN_ENV_KEYS) prev[k] = process.env[k];
  return () => {
    for (const k of BURN_ENV_KEYS) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  };
}

describe("ranked-report burn-weight config readers (issue #3825)", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = snapshot();
    for (const k of BURN_ENV_KEYS) delete process.env[k];
  });
  afterEach(() => restore());

  test("category readers default to the list-price ratios", () => {
    assert.equal(getBurnWeightInput(), DEFAULT_BURN_WEIGHT_INPUT);
    assert.equal(getBurnWeightOutput(), DEFAULT_BURN_WEIGHT_OUTPUT);
    assert.equal(getBurnWeightCacheRead(), DEFAULT_BURN_WEIGHT_CACHE_READ);
    assert.equal(getBurnWeightCacheCreation(), DEFAULT_BURN_WEIGHT_CACHE_CREATION);
    // The literal list-price ratios the issue names, pinned against the defaults:
    assert.equal(DEFAULT_BURN_WEIGHT_INPUT, 1.0);
    assert.equal(DEFAULT_BURN_WEIGHT_OUTPUT, 5.0);
    assert.equal(DEFAULT_BURN_WEIGHT_CACHE_READ, 0.1);
    assert.equal(DEFAULT_BURN_WEIGHT_CACHE_CREATION, 1.25);
  });

  test("family readers default to per-MTok-input-price calibration (opus 5 / sonnet 3 / haiku 1)", () => {
    assert.equal(getBurnFamilyWeightOpus(), DEFAULT_BURN_FAMILY_OPUS);
    assert.equal(getBurnFamilyWeightSonnet(), DEFAULT_BURN_FAMILY_SONNET);
    assert.equal(getBurnFamilyWeightHaiku(), DEFAULT_BURN_FAMILY_HAIKU);
    assert.equal(DEFAULT_BURN_FAMILY_OPUS, 5);
    assert.equal(DEFAULT_BURN_FAMILY_SONNET, 3);
    assert.equal(DEFAULT_BURN_FAMILY_HAIKU, 1);
  });

  test("each category reader honours its env var override", () => {
    process.env.HYDRA_USAGE_BURN_WEIGHT_INPUT = "2.7";
    process.env.HYDRA_USAGE_BURN_WEIGHT_OUTPUT = "6";
    process.env.HYDRA_USAGE_BURN_WEIGHT_CACHE_READ = "0.25";
    process.env.HYDRA_USAGE_BURN_WEIGHT_CACHE_CREATION = "2";
    assert.equal(getBurnWeightInput(), 2.7);
    assert.equal(getBurnWeightOutput(), 6);
    assert.equal(getBurnWeightCacheRead(), 0.25);
    assert.equal(getBurnWeightCacheCreation(), 2);
  });

  test("non-positive / non-finite values fall back to the default (fail-loud)", () => {
    // Each invalid shape is logged + falls back rather than silently dropping a
    // category. `0`, `-1`, and `abc` all return the default.
    for (const bad of ["0", "-1", "abc", "NaN", "Infinity"]) {
      process.env.HYDRA_USAGE_BURN_WEIGHT_INPUT = bad;
      assert.equal(getBurnWeightInput(), DEFAULT_BURN_WEIGHT_INPUT, `input fallback for ${bad}`);
    }
    process.env.HYDRA_USAGE_BURN_FAMILY_OPUS = "-5";
    assert.equal(getBurnFamilyWeightOpus(), DEFAULT_BURN_FAMILY_OPUS);
  });

  test("getBurnCategoryWeights composes the four category readers", () => {
    process.env.HYDRA_USAGE_BURN_WEIGHT_OUTPUT = "9";
    const w = getBurnCategoryWeights();
    assert.equal(w.input, DEFAULT_BURN_WEIGHT_INPUT);
    assert.equal(w.output, 9); // overridden
    assert.equal(w.cacheRead, DEFAULT_BURN_WEIGHT_CACHE_READ);
    assert.equal(w.cacheCreation, DEFAULT_BURN_WEIGHT_CACHE_CREATION);
  });

  test("getBurnFamilyWeights composes the three family readers", () => {
    process.env.HYDRA_USAGE_BURN_FAMILY_OPUS = "8";
    const w = getBurnFamilyWeights();
    assert.equal(w.opus, 8); // overridden
    assert.equal(w.sonnet, DEFAULT_BURN_FAMILY_SONNET);
    assert.equal(w.haiku, DEFAULT_BURN_FAMILY_HAIKU);
  });
});

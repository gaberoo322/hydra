/**
 * Regression tests for the z-score pure-math leaf (`src/metrics/math.ts`,
 * issue #2883).
 *
 * These boundary tests originally lived in
 * `test/aggregator-anomaly-detector.test.mts` alongside the anomaly-detector
 * aggregator's own tests, but `meanStd`/`zScore`/`classifyZ` are a
 * general-purpose relocated leaf consumed by other aggregators
 * (`autonomy-rate.ts`, `builder-health.ts`, `outcome-attribution/estimator.ts`
 * via `meanStd`/`zScore`) — split out here (issue #4356) so their coverage
 * survives the anomaly-detector aggregator's removal instead of being deleted
 * alongside it.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { classifyZ, meanStd, zScore } from "../src/metrics/math.ts";

// ---------------------------------------------------------------------------
// meanStd
// ---------------------------------------------------------------------------

describe("meanStd — pure math", () => {
  test("returns zeros on empty input", () => {
    assert.deepEqual(meanStd([]), { mean: 0, std: 0 });
  });
  test("constant series has zero std", () => {
    const { mean, std } = meanStd([5, 5, 5, 5]);
    assert.equal(mean, 5);
    assert.equal(std, 0);
  });
  test("computes population std (not sample std)", () => {
    // Population std of [1,2,3,4,5] = sqrt(2) ≈ 1.4142
    const { mean, std } = meanStd([1, 2, 3, 4, 5]);
    assert.equal(mean, 3);
    assert.ok(Math.abs(std - Math.sqrt(2)) < 1e-9, `got std=${std}`);
  });
  test("drops non-finite values silently", () => {
    const { mean, std } = meanStd([1, NaN, 3, Infinity, 5]);
    assert.equal(mean, 3);
    // {1,3,5} → mean=3, std=sqrt(8/3)
    assert.ok(Math.abs(std - Math.sqrt(8 / 3)) < 1e-9, `got std=${std}`);
  });
});

// ---------------------------------------------------------------------------
// zScore
// ---------------------------------------------------------------------------

describe("zScore — pure math", () => {
  test("standard z = (x - mean) / std", () => {
    assert.equal(zScore(10, 5, 2.5), 2);
  });
  test("zero std → zero z (NOT Infinity)", () => {
    assert.equal(zScore(7, 5, 0), 0);
  });
  test("non-finite inputs → zero (defensive)", () => {
    assert.equal(zScore(NaN, 0, 1), 0);
    assert.equal(zScore(0, Infinity, 1), 0);
    assert.equal(zScore(0, 0, NaN), 0);
  });
});

// ---------------------------------------------------------------------------
// classifyZ — boundary tests
// ---------------------------------------------------------------------------

describe("classifyZ — boundary tests", () => {
  const T = 2.0;

  test("z just under threshold → null (1.99 < 2.0)", () => {
    assert.equal(classifyZ(1.99, T), null);
    assert.equal(classifyZ(-1.99, T), null);
  });

  test("z exactly at threshold → anomaly (>=2.0 high; <=-2.0 low)", () => {
    assert.equal(classifyZ(2.0, T), "high");
    assert.equal(classifyZ(-2.0, T), "low");
  });

  test("z just over threshold → anomaly direction", () => {
    assert.equal(classifyZ(2.01, T), "high");
    assert.equal(classifyZ(-2.01, T), "low");
  });

  test("zero z → null", () => {
    assert.equal(classifyZ(0, T), null);
  });

  test("non-finite inputs → null", () => {
    assert.equal(classifyZ(NaN, T), null);
    assert.equal(classifyZ(Infinity, T), null);
    assert.equal(classifyZ(1, NaN), null);
  });

  test("negative threshold rejected → null", () => {
    assert.equal(classifyZ(5, -1), null);
  });

  test("threshold of 0 → any non-zero z is anomalous", () => {
    assert.equal(classifyZ(0.0001, 0), "high");
    assert.equal(classifyZ(-0.0001, 0), "low");
    // z=0 with threshold=0 still returns null since 0 < 0 is false and 0 >= 0 hits — actually 0 >= 0 is true so "high"
    assert.equal(classifyZ(0, 0), "high");
  });

  test("custom higher threshold (3σ) is stricter", () => {
    assert.equal(classifyZ(2.5, 3), null);
    assert.equal(classifyZ(3.0, 3), "high");
  });
});

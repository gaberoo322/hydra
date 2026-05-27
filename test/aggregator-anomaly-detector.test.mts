/**
 * Regression tests for the anomaly-detector aggregator (issue #620, PRD #615).
 *
 * Boundary tests on the z-score threshold are explicitly required by the
 * issue. The math is pure — no Redis or subprocess is involved in any of
 * these tests; the integration shape is exercised via the `readSeries`
 * dependency injection.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  getAnomalies,
  meanStd,
  zScore,
  classifyZ,
  type SeriesInput,
} from "../src/aggregators/anomaly-detector.ts";

const NOW = new Date("2026-05-26T12:00:00.000Z");

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
// classifyZ — REQUIRED boundary tests
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

// ---------------------------------------------------------------------------
// getAnomalies — integration shape via injected readSeries
// ---------------------------------------------------------------------------

describe("getAnomalies — happy path", () => {
  test("detects a high anomaly when latest is far above baseline", async () => {
    // Baseline mean 5, std ≈ 0; injected sample = 100. Latest is evaluated
    // against everything-but-itself, so we need a baseline with non-zero std.
    const samples: SeriesInput["samples"] = [
      { at: "2026-05-20T00:00:00Z", value: 5 },
      { at: "2026-05-21T00:00:00Z", value: 6 },
      { at: "2026-05-22T00:00:00Z", value: 4 },
      { at: "2026-05-23T00:00:00Z", value: 5 },
      { at: "2026-05-24T00:00:00Z", value: 6 },
      { at: "2026-05-25T00:00:00Z", value: 5 },
      { at: "2026-05-26T00:00:00Z", value: 100 }, // latest — way out
    ];
    const readSeries = async (): Promise<SeriesInput[]> => [
      { metric: "cost-per-hour", subKey: null, samples },
    ];
    const result = await getAnomalies({ now: NOW, readSeries });
    assert.equal(result.anomalies.length, 1);
    const a = result.anomalies[0];
    assert.equal(a.metric, "cost-per-hour");
    assert.equal(a.direction, "high");
    assert.ok(a.zScore > 2, `expected z > 2, got ${a.zScore}`);
  });

  test("no anomaly when latest sample matches the baseline", async () => {
    const samples: SeriesInput["samples"] = Array.from({ length: 8 }, (_, i) => ({
      at: `2026-05-${20 + i}T00:00:00Z`,
      value: 5,
    }));
    const readSeries = async (): Promise<SeriesInput[]> => [
      { metric: "abandonment-rate", subKey: null, samples },
    ];
    const result = await getAnomalies({ now: NOW, readSeries });
    assert.deepEqual(result.anomalies, []);
  });

  test("custom threshold (1.0) catches more anomalies than default", async () => {
    // Baseline: 6 samples with mean 10 and stdev = sqrt(70/6) ≈ 3.42.
    // Latest = 15 → z ≈ 1.46. Strict (2σ): no anomaly. Loose (1σ): one.
    const samples: SeriesInput["samples"] = [
      { at: "2026-05-20T00:00:00Z", value: 5 },
      { at: "2026-05-21T00:00:00Z", value: 15 },
      { at: "2026-05-22T00:00:00Z", value: 7 },
      { at: "2026-05-23T00:00:00Z", value: 13 },
      { at: "2026-05-24T00:00:00Z", value: 8 },
      { at: "2026-05-25T00:00:00Z", value: 12 },
      { at: "2026-05-26T00:00:00Z", value: 15 },
    ];
    const readSeries = async (): Promise<SeriesInput[]> => [
      { metric: "cost-per-hour", subKey: null, samples },
    ];
    const strict = await getAnomalies({ now: NOW, readSeries, zThreshold: 2 });
    const loose = await getAnomalies({ now: NOW, readSeries, zThreshold: 1 });
    assert.equal(strict.anomalies.length, 0);
    assert.equal(loose.anomalies.length, 1);
  });

  test("low anomalies are flagged in the negative direction", async () => {
    const samples: SeriesInput["samples"] = [
      { at: "2026-05-20T00:00:00Z", value: 50 },
      { at: "2026-05-21T00:00:00Z", value: 51 },
      { at: "2026-05-22T00:00:00Z", value: 49 },
      { at: "2026-05-23T00:00:00Z", value: 50 },
      { at: "2026-05-24T00:00:00Z", value: 51 },
      { at: "2026-05-25T00:00:00Z", value: 49 },
      { at: "2026-05-26T00:00:00Z", value: 1 }, // way under
    ];
    const readSeries = async (): Promise<SeriesInput[]> => [
      { metric: "abandonment-rate", subKey: null, samples },
    ];
    const result = await getAnomalies({ now: NOW, readSeries });
    assert.equal(result.anomalies.length, 1);
    assert.equal(result.anomalies[0].direction, "low");
    assert.ok(result.anomalies[0].zScore < -2);
  });

  test("multiple series → multiple anomalies, sorted by |z| desc", async () => {
    // Tight baseline (jitter ±0.05) so even modest outliers produce big z.
    const tight = (base: number, last: number) =>
      [...Array(6)]
        .map((_, i) => ({
          at: `2026-05-${20 + i}T00:00:00Z`,
          value: base + ((i % 2) - 0.5) * 0.1,
        }))
        .concat([{ at: "2026-05-26T00:00:00Z", value: last }]);

    const readSeries = async (): Promise<SeriesInput[]> => [
      { metric: "cost-per-hour", subKey: null, samples: tight(10, 25) },
      // Failure-rate series: baseline around 0.1, latest 0.9 — also far above.
      { metric: "dispatch-class-failure-rate", subKey: "dev_orch", samples: tight(0.1, 0.9) },
    ];
    const result = await getAnomalies({ now: NOW, readSeries });
    assert.equal(result.anomalies.length, 2);
    // First entry should have the larger |z|.
    assert.ok(
      Math.abs(result.anomalies[0].zScore) >= Math.abs(result.anomalies[1].zScore),
    );
  });

  test("series with fewer than 2 samples is ignored", async () => {
    const readSeries = async (): Promise<SeriesInput[]> => [
      { metric: "cost-per-hour", subKey: null, samples: [{ at: "x", value: 1 }] },
    ];
    const result = await getAnomalies({ now: NOW, readSeries });
    assert.deepEqual(result.anomalies, []);
  });

  test("reader throw → empty anomalies", async () => {
    const readSeries = async (): Promise<SeriesInput[]> => {
      throw new Error("boom");
    };
    const result = await getAnomalies({ now: NOW, readSeries });
    assert.deepEqual(result.anomalies, []);
  });

  test("threshold echo + baselineWindowDays echo in response", async () => {
    const readSeries = async (): Promise<SeriesInput[]> => [];
    const result = await getAnomalies({
      now: NOW,
      readSeries,
      zThreshold: 2.5,
      baselineWindowDays: 21,
    });
    assert.equal(result.threshold, 2.5);
    assert.equal(result.baselineWindowDays, 21);
  });
});

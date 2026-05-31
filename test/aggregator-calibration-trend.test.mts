/**
 * Regression tests for the calibration-trend aggregator (issue #619).
 *
 * Pure helpers (`tierAccuracyForRecord`, `costAccuracyForRecord`,
 * `bucketByDay`) are tested directly. Integration uses a stub record
 * reader so no Redis is required.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  getCalibrationTrend,
  tierAccuracyForRecord,
  costAccuracyForRecord,
  bucketByDay,
  type CalibrationRecord,
} from "../src/aggregators/calibration-trend.ts";

const NOW = new Date("2026-05-26T12:00:00.000Z");

// ---------------------------------------------------------------------------
// Pure helpers — tierAccuracyForRecord
// ---------------------------------------------------------------------------

describe("tierAccuracyForRecord — pure helper", () => {
  test("returns null when tier is not a number", () => {
    assert.equal(
      tierAccuracyForRecord({ cycleId: "c1", actualOutcome: "merged" }),
      null,
    );
  });

  test("returns null when actualOutcome is no-task", () => {
    assert.equal(
      tierAccuracyForRecord({ cycleId: "c1", tier: 2, actualOutcome: "no-task" }),
      null,
    );
  });

  test("low tier + merged → correct (1)", () => {
    assert.equal(
      tierAccuracyForRecord({ cycleId: "c1", tier: 1, actualOutcome: "merged" }),
      1,
    );
    assert.equal(
      tierAccuracyForRecord({ cycleId: "c1", tier: 2, actualOutcome: "merged" }),
      1,
    );
  });

  test("auto-merge tier + failed → incorrect (0)", () => {
    // tier 1 is an auto-merge tier; predicted-merge but failed → wrong.
    assert.equal(
      tierAccuracyForRecord({ cycleId: "c1", tier: 1, actualOutcome: "failed" }),
      0,
    );
  });

  test("boundary: tier 2 is an auto-merge tier", () => {
    assert.equal(
      tierAccuracyForRecord({ cycleId: "c1", tier: 2, actualOutcome: "failed" }),
      0,
    );
  });

  // ADR-0019: tier 3 is an AUTO-MERGE tier (matches the current tier
  // table: T3 auto-merges unless scope-justification). The pre-ADR-0015
  // calibration model treated tier 3 as "review/high" — that was the
  // stale numbering. isAutoMergeTier({1,2,3}) realigns it.
  test("boundary: tier 3 is an auto-merge tier — merged → correct (1)", () => {
    assert.equal(
      tierAccuracyForRecord({ cycleId: "c1", tier: 3, actualOutcome: "merged" }),
      1,
    );
  });

  test("boundary: tier 3 (auto-merge) + failed → incorrect (0)", () => {
    assert.equal(
      tierAccuracyForRecord({ cycleId: "c1", tier: 3, actualOutcome: "failed" }),
      0,
    );
  });

  // Regression (ADR-0019 / issue #799): Tier 0 (Verifier Core /
  // operator-only) is NOT an auto-merge tier — the calibration mismodel
  // was `tier <= 2`, which scored Tier 0 as predicted-auto-merge.
  // `isAutoMergeTier(0) === false` now drives `predictedAutoMerge`, so a
  // Tier-0 PR is no longer modelled as auto-merge.
  //
  // With the (unchanged) `predictedAutoMerge === actualMerged` scoring:
  //   tier 0 + merged   → predicted no-auto-merge but it merged → 0
  //   tier 0 + failed   → predicted no-auto-merge, did not merge → 1
  // The defect was the OLD code scoring tier-0+merged as 1 by treating
  // Tier 0 as auto-merge; the fix removes that false credit.
  test("regression: tier 0 + merged scores 0 (Tier 0 is not auto-merge; the merge was operator-driven)", () => {
    assert.equal(
      tierAccuracyForRecord({ cycleId: "c1", tier: 0, actualOutcome: "merged" }),
      0,
    );
  });

  test("regression: tier 0 + failed scores 1 (predicted non-auto-merge, did not merge → correct)", () => {
    assert.equal(
      tierAccuracyForRecord({ cycleId: "c1", tier: 0, actualOutcome: "failed" }),
      1,
    );
  });
});

// ---------------------------------------------------------------------------
// Pure helpers — costAccuracyForRecord
// ---------------------------------------------------------------------------

describe("costAccuracyForRecord — pure helper", () => {
  test("returns null when score is missing", () => {
    assert.equal(
      costAccuracyForRecord({ cycleId: "c1", actualOutcome: "merged" }),
      null,
    );
  });

  test("returns null when outcome is no-task", () => {
    assert.equal(
      costAccuracyForRecord({
        cycleId: "c1",
        predictedScore: 0.8,
        actualOutcome: "no-task",
      }),
      null,
    );
  });

  test("high score + merged → correct", () => {
    assert.equal(
      costAccuracyForRecord({
        cycleId: "c1",
        predictedScore: 0.9,
        actualOutcome: "merged",
      }),
      1,
    );
  });

  test("low score + failed → correct", () => {
    assert.equal(
      costAccuracyForRecord({
        cycleId: "c1",
        predictedScore: 0.2,
        actualOutcome: "failed",
      }),
      1,
    );
  });

  test("boundary: score == 0.5 → predicted merge", () => {
    assert.equal(
      costAccuracyForRecord({
        cycleId: "c1",
        predictedScore: 0.5,
        actualOutcome: "merged",
      }),
      1,
    );
  });

  test("boundary: score just below 0.5 → predicted not-merge", () => {
    assert.equal(
      costAccuracyForRecord({
        cycleId: "c1",
        predictedScore: 0.49,
        actualOutcome: "merged",
      }),
      0,
    );
  });
});

// ---------------------------------------------------------------------------
// Pure helpers — bucketByDay
// ---------------------------------------------------------------------------

describe("bucketByDay — pure helper", () => {
  test("empty input → []", () => {
    assert.deepEqual(bucketByDay([], tierAccuracyForRecord), []);
  });

  test("buckets two records on the same day into one point with averaged accuracy", () => {
    const recs: CalibrationRecord[] = [
      { cycleId: "c1", tier: 1, actualOutcome: "merged", recordedAt: "2026-05-26T01:00:00Z" },
      { cycleId: "c2", tier: 1, actualOutcome: "failed", recordedAt: "2026-05-26T11:00:00Z" },
    ];
    const out = bucketByDay(recs, tierAccuracyForRecord);
    assert.equal(out.length, 1);
    assert.equal(out[0].v, 0.5); // one correct, one incorrect → 50% accuracy
  });

  test("days with no scorable records are omitted", () => {
    const recs: CalibrationRecord[] = [
      // unscorable — no tier
      { cycleId: "c1", actualOutcome: "merged", recordedAt: "2026-05-25T01:00:00Z" },
      { cycleId: "c2", tier: 1, actualOutcome: "merged", recordedAt: "2026-05-26T11:00:00Z" },
    ];
    const out = bucketByDay(recs, tierAccuracyForRecord);
    assert.equal(out.length, 1);
    assert.equal(out[0].v, 1);
  });

  test("sorts oldest → newest", () => {
    const recs: CalibrationRecord[] = [
      { cycleId: "c1", tier: 1, actualOutcome: "merged", recordedAt: "2026-05-26T01:00:00Z" },
      { cycleId: "c2", tier: 1, actualOutcome: "merged", recordedAt: "2026-05-24T01:00:00Z" },
      { cycleId: "c3", tier: 1, actualOutcome: "merged", recordedAt: "2026-05-25T01:00:00Z" },
    ];
    const out = bucketByDay(recs, tierAccuracyForRecord);
    assert.deepEqual(
      out.map((p) => p.t),
      [
        "2026-05-24T00:00:00.000Z",
        "2026-05-25T00:00:00.000Z",
        "2026-05-26T00:00:00.000Z",
      ],
    );
  });
});

// ---------------------------------------------------------------------------
// Integration shape
// ---------------------------------------------------------------------------

describe("getCalibrationTrend — happy path", () => {
  test("merges tier+cost series in one response", async () => {
    const records: CalibrationRecord[] = [
      {
        cycleId: "c1",
        tier: 1,
        predictedScore: 0.8,
        actualOutcome: "merged",
        recordedAt: "2026-05-26T01:00:00Z",
      },
      {
        // Tier 0 (Verifier Core / operator-only) — NOT an auto-merge tier.
        // A non-merged outcome confirms the non-auto-merge prediction. (ADR-0019)
        cycleId: "c2",
        tier: 0,
        predictedScore: 0.2,
        actualOutcome: "failed",
        recordedAt: "2026-05-26T05:00:00Z",
      },
    ];
    const response = await getCalibrationTrend(7, {
      now: NOW,
      readCalibrationRecords: async () => records,
    });
    assert.equal(response.windowDays, 7);
    assert.equal(response.tierAccuracy.sampleSize, 2);
    assert.equal(response.tierAccuracy.points.length, 1);
    assert.equal(response.tierAccuracy.points[0].v, 1); // both correct
    assert.equal(response.costAccuracy.sampleSize, 2);
    assert.equal(response.costAccuracy.points[0].v, 1);
  });
});

describe("getCalibrationTrend — empty state", () => {
  test("no records → both series empty, sampleSize 0", async () => {
    const response = await getCalibrationTrend(7, {
      now: NOW,
      readCalibrationRecords: async () => [],
    });
    assert.deepEqual(response.tierAccuracy.points, []);
    assert.equal(response.tierAccuracy.sampleSize, 0);
    assert.deepEqual(response.costAccuracy.points, []);
    assert.equal(response.costAccuracy.sampleSize, 0);
  });
});

describe("getCalibrationTrend — failure isolation", () => {
  test("reader throws → both series empty, never throws", async () => {
    const response = await getCalibrationTrend(7, {
      now: NOW,
      readCalibrationRecords: async () => {
        throw new Error("redis down");
      },
    });
    assert.deepEqual(response.tierAccuracy.points, []);
    assert.deepEqual(response.costAccuracy.points, []);
  });
});

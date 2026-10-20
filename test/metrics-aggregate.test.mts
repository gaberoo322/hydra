/**
 * Regression tests for `computeRollingMergeRateFromTrend` — the shared pure
 * rolling-merge-rate helper extracted in issue #2169.
 *
 * Before #2169, the `fraction of cycles with tasksMerged>0, as a rounded
 * percentage` arithmetic was duplicated in two places:
 *   - `scheduler/heartbeat.ts::computeRollingMergeRate` (the
 *     `/api/scheduler/status` rolling merge-rate), and
 *   - `metrics/aggregate.ts::projectAggregateStats` (the `/metrics` mergedRate).
 * The arithmetic now lives in exactly one pure function; both sites delegate.
 *
 * Locked behaviors (the design-concept invariants for #2169):
 *   - Empty trend → null (NOT 0): "no data" is distinct from "0% merged", so
 *     the heartbeat false-stall guard (issue #232) is preserved.
 *   - All-failed (no tasksMerged>0) → 0.
 *   - Single merged cycle → 100.
 *   - Mixed → Math.round((merged/total)*100), no Math.floor / toFixed drift.
 *   - Null-safe predicate: null / undefined / absent `tasksMerged` entries
 *     count as not-merged ((m?.tasksMerged ?? 0) > 0), never throw.
 *   - Pure: no Redis, no Express — synthetic trend arrays only.
 *
 * Authored as a NEW top-level `describe` with no shared-Redis lifecycle, so it
 * cannot piggyback on a sibling suite's `after()` teardown (CLAUDE.md authoring
 * rule).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { computeRollingMergeRateFromTrend, computeEmptyRateFromTrend } from "../src/metrics/stats-projection.ts";

describe("computeRollingMergeRateFromTrend (issue #2169)", () => {
  test("empty trend returns null (no data, not 0%)", () => {
    assert.strictEqual(computeRollingMergeRateFromTrend([]), null);
  });

  test("all-failed trend (no tasksMerged>0) returns 0", () => {
    const trend = [
      { tasksMerged: 0, tasksFailed: 1 },
      { tasksMerged: 0, tasksFailed: 2 },
      { tasksMerged: 0 },
    ];
    assert.strictEqual(computeRollingMergeRateFromTrend(trend), 0);
  });

  test("single merged cycle returns 100", () => {
    assert.strictEqual(
      computeRollingMergeRateFromTrend([{ tasksMerged: 1 }]),
      100,
    );
  });

  test("mixed trend rounds (merged/total)*100", () => {
    // 1 of 3 merged → 33.33.. → Math.round → 33
    const oneOfThree = [
      { tasksMerged: 2 },
      { tasksMerged: 0 },
      { tasksMerged: 0 },
    ];
    assert.strictEqual(computeRollingMergeRateFromTrend(oneOfThree), 33);

    // 2 of 3 merged → 66.66.. → Math.round → 67 (proves no Math.floor drift)
    const twoOfThree = [
      { tasksMerged: 1 },
      { tasksMerged: 3 },
      { tasksMerged: 0 },
    ];
    assert.strictEqual(computeRollingMergeRateFromTrend(twoOfThree), 67);

    // exact half: 1 of 2 merged → 50
    const half = [{ tasksMerged: 5 }, { tasksMerged: 0 }];
    assert.strictEqual(computeRollingMergeRateFromTrend(half), 50);
  });

  test("null / undefined / absent tasksMerged entries count as not-merged (null-safe predicate)", () => {
    const trend = [
      { tasksMerged: 1 }, // merged
      { tasksMerged: null }, // null → 0 → not merged
      { tasksMerged: undefined }, // undefined → 0 → not merged
      {}, // absent → 0 → not merged
    ];
    // 1 of 4 merged → 25, and no throw on null/undefined/absent.
    assert.strictEqual(computeRollingMergeRateFromTrend(trend), 25);
  });

  test("all-merged trend returns 100", () => {
    const trend = [{ tasksMerged: 1 }, { tasksMerged: 4 }, { tasksMerged: 2 }];
    assert.strictEqual(computeRollingMergeRateFromTrend(trend), 100);
  });
});

describe("computeEmptyRateFromTrend (issue #2818)", () => {
  // An "empty" cycle = tasksAttempted>0 AND all three outcome counters 0 (the
  // read-side mirror of the write-path `unaccounted` bucket, #1919).
  const empty = { tasksAttempted: 1, tasksMerged: 0, tasksFailed: 0, tasksAbandoned: 0 };
  const merged = { tasksAttempted: 1, tasksMerged: 1, tasksFailed: 0, tasksAbandoned: 0 };
  const failed = { tasksAttempted: 1, tasksMerged: 0, tasksFailed: 1, tasksAbandoned: 0 };
  const abandoned = { tasksAttempted: 1, tasksMerged: 0, tasksFailed: 0, tasksAbandoned: 1 };

  test("empty trend returns null (no data, not 0%)", () => {
    assert.strictEqual(computeEmptyRateFromTrend([]), null);
  });

  test("no empty cycles returns 0", () => {
    assert.strictEqual(computeEmptyRateFromTrend([merged, failed, abandoned]), 0);
  });

  test("all-empty trend returns 100", () => {
    assert.strictEqual(computeEmptyRateFromTrend([empty, empty, empty]), 100);
  });

  test("single empty cycle returns 100", () => {
    assert.strictEqual(computeEmptyRateFromTrend([empty]), 100);
  });

  test("mixed trend rounds (empty/total)*100", () => {
    // 1 empty of 3 → 33
    assert.strictEqual(computeEmptyRateFromTrend([empty, merged, failed]), 33);
    // 2 empty of 3 → 67
    assert.strictEqual(computeEmptyRateFromTrend([empty, empty, merged]), 67);
    // 1 empty of 2 → 50
    assert.strictEqual(computeEmptyRateFromTrend([empty, merged]), 50);
  });

  test("a merged cycle is NOT empty even with tasksAttempted>0", () => {
    assert.strictEqual(computeEmptyRateFromTrend([merged]), 0);
  });

  test("a failed cycle is NOT empty", () => {
    assert.strictEqual(computeEmptyRateFromTrend([failed]), 0);
  });

  test("an abandoned cycle is NOT empty", () => {
    assert.strictEqual(computeEmptyRateFromTrend([abandoned]), 0);
  });

  test("tasksAttempted==0 is NOT empty (no work attempted, not an empty outcome)", () => {
    const noAttempt = { tasksAttempted: 0, tasksMerged: 0, tasksFailed: 0, tasksAbandoned: 0 };
    assert.strictEqual(computeEmptyRateFromTrend([noAttempt]), 0);
  });

  test("null-safe: missing counter fields default to 0 (an empty cycle)", () => {
    // Only tasksAttempted present, all outcome fields absent → treated as 0 → empty.
    assert.strictEqual(computeEmptyRateFromTrend([{ tasksAttempted: 1 }]), 100);
    // Entirely absent tasksAttempted → not empty (0 attempted).
    assert.strictEqual(computeEmptyRateFromTrend([{}]), 0);
  });
});

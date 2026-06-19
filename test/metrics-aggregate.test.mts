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

import { computeRollingMergeRateFromTrend } from "../src/metrics/aggregate.ts";

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

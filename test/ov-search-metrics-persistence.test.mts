/**
 * Regression tests for the OV search-quality metrics persistence seam (#1440).
 *
 * Covers the PURE helpers only — no Redis, no OV — so the suite runs in CI
 * without infrastructure:
 *   - `utcHourKey` / `utcDayKey` bucket-key math
 *   - `rollupWindow` aggregation + derived rates (never NaN)
 *   - `computeFlushDelta` monotonic-delta extraction from ov-search.ts
 *
 * The Redis I/O functions (recordOvSearchDelta, getOvSearchWindow,
 * recordKnowledgeContextAvailability, getKnowledgeContextAvailability) are
 * thin pipelined HINCRBY/HGETALL wrappers verified by hand against the same
 * shape as the proven scope-violations seam; their key math + folding is what's
 * unit-tested here via the pure helpers they delegate to.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  utcHourKey,
  utcDayKey,
  rollupWindow,
  type OvSearchWindowBucket,
} from "../src/redis/ov-search-metrics.ts";
import {
  computeFlushDelta,
  type OvSearchMetrics,
} from "../src/knowledge-base/ov-search.ts";

describe("utcHourKey / utcDayKey — pure helpers", () => {
  test("utcHourKey formats UTC YYYY-MM-DDTHH", () => {
    assert.equal(utcHourKey(new Date("2026-06-09T14:37:21Z")), "2026-06-09T14");
    assert.equal(utcHourKey(new Date("2026-01-05T00:00:00Z")), "2026-01-05T00");
    assert.equal(utcHourKey(new Date("2026-12-31T23:59:59Z")), "2026-12-31T23");
  });

  test("utcDayKey formats UTC YYYY-MM-DD", () => {
    assert.equal(utcDayKey(new Date("2026-06-09T14:37:21Z")), "2026-06-09");
    assert.equal(utcDayKey(new Date("2026-05-30T23:59:59Z")), "2026-05-30");
  });

  test("hour key is UTC, not local — boundary near midnight", () => {
    // A time that would be a different day/hour in a negative-offset locale.
    assert.equal(utcHourKey(new Date("2026-06-09T00:30:00Z")), "2026-06-09T00");
    assert.equal(utcDayKey(new Date("2026-06-09T00:30:00Z")), "2026-06-09");
  });
});

describe("rollupWindow — aggregation + derived rates", () => {
  const bucket = (over: Partial<OvSearchWindowBucket> = {}): OvSearchWindowBucket => ({
    hour: "2026-06-09T14",
    totalSearches: 0,
    zeroResultCount: 0,
    totalResults: 0,
    totalLatencyMs: 0,
    fallbackAttempts: 0,
    fallbackSuccesses: 0,
    errors: 0,
    ...over,
  });

  test("empty window yields all-zero rollup with zero (not NaN) rates", () => {
    const r = rollupWindow([], 24);
    assert.equal(r.windowHours, 24);
    assert.equal(r.totalSearches, 0);
    assert.equal(r.zeroResultRate, 0);
    assert.equal(r.fallbackSuccessRate, 0);
    assert.equal(r.avgResultsPerQuery, 0);
    assert.equal(r.avgLatencyMs, 0);
    assert.ok(!Number.isNaN(r.zeroResultRate));
    assert.ok(!Number.isNaN(r.avgLatencyMs));
  });

  test("sums counters across buckets", () => {
    const r = rollupWindow(
      [
        bucket({ totalSearches: 10, zeroResultCount: 2, totalResults: 40, totalLatencyMs: 1000 }),
        bucket({ totalSearches: 5, zeroResultCount: 3, totalResults: 5, totalLatencyMs: 500 }),
      ],
      24,
    );
    assert.equal(r.totalSearches, 15);
    assert.equal(r.zeroResultCount, 5);
    assert.equal(r.totalResults, 45);
  });

  test("derives zeroResultRate / fallbackSuccessRate / avgs", () => {
    const r = rollupWindow(
      [
        bucket({
          totalSearches: 10,
          zeroResultCount: 4,
          totalResults: 20,
          totalLatencyMs: 1500,
          fallbackAttempts: 4,
          fallbackSuccesses: 1,
        }),
      ],
      1,
    );
    assert.equal(r.zeroResultRate, 0.4); // 4/10
    assert.equal(r.fallbackSuccessRate, 0.25); // 1/4
    assert.equal(r.avgResultsPerQuery, 2); // 20/10
    assert.equal(r.avgLatencyMs, 150); // 1500/10
  });

  test("fallbackSuccessRate is 0 (not NaN) when no fallbacks attempted", () => {
    const r = rollupWindow([bucket({ totalSearches: 3, totalResults: 9, totalLatencyMs: 300 })], 1);
    assert.equal(r.fallbackAttempts, 0);
    assert.equal(r.fallbackSuccessRate, 0);
    assert.ok(!Number.isNaN(r.fallbackSuccessRate));
  });

  test("preserves the bucket list for trend rendering", () => {
    const buckets = [bucket({ hour: "2026-06-09T14" }), bucket({ hour: "2026-06-09T13" })];
    const r = rollupWindow(buckets, 2);
    assert.equal(r.buckets.length, 2);
    assert.equal(r.buckets[0].hour, "2026-06-09T14");
  });
});

describe("computeFlushDelta — monotonic delta extraction", () => {
  const m = (over: Partial<OvSearchMetrics> = {}): OvSearchMetrics => ({
    totalSearches: 0,
    zeroResultCount: 0,
    totalResults: 0,
    totalLatencyMs: 0,
    fallbackAttempts: 0,
    fallbackSuccesses: 0,
    errors: 0,
    ...over,
  });

  test("emits only positive per-field deltas", () => {
    const live = m({ totalSearches: 10, zeroResultCount: 3, totalResults: 25, totalLatencyMs: 800 });
    const snapshot = m({ totalSearches: 6, zeroResultCount: 1, totalResults: 20, totalLatencyMs: 500 });
    const delta = computeFlushDelta(live, snapshot);
    assert.equal(delta.totalSearches, 4);
    assert.equal(delta.zeroResultCount, 2);
    assert.equal(delta.totalResults, 5);
    assert.equal(delta.totalLatencyMs, 300);
  });

  test("equal live + snapshot yields an empty delta (no-op flush)", () => {
    const same = m({ totalSearches: 7, totalResults: 21 });
    const delta = computeFlushDelta(same, { ...same });
    assert.deepEqual(delta, {});
  });

  test("omits fields whose delta is zero", () => {
    const live = m({ totalSearches: 5, errors: 0 });
    const snapshot = m({ totalSearches: 5, errors: 0 });
    const delta = computeFlushDelta(live, snapshot);
    assert.ok(!("totalSearches" in delta));
    assert.ok(!("errors" in delta));
  });

  test("never emits negative deltas (post-reset re-baseline guard)", () => {
    // After resetOvSearchMetrics the snapshot is re-baselined to the live zero
    // state, but model a stale snapshot that is ahead of live anyway.
    const live = m({ totalSearches: 2 });
    const snapshot = m({ totalSearches: 9 });
    const delta = computeFlushDelta(live, snapshot);
    assert.deepEqual(delta, {});
  });
});

/**
 * Regression tests for the shared trend-series grammar (issue #956).
 *
 * Before #956 the four mechanics below were copy-pasted across ~7 trend
 * aggregators: a byte-identical `dayBucketKey` (calibration + lessons), a
 * `utcDate` / `iso8601DateOnly` twin (builder-health + backlog-flow), the
 * `now - windowDays * 24h` window arithmetic (four aggregators), the `{ t, v }`
 * point shape (re-declared four ways), and the historical-plus-current
 * clamp-and-sort fold (quota + outcome-trends, near-identical). This is the
 * one test surface that pins that grammar now that the aggregators import it.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  windowStart,
  dayBucketKey,
  dayKey,
  sortByTimeAsc,
  bucketByDay,
  mean,
  count,
  mergeWindowedPoints,
  type TrendPoint,
} from "../src/aggregators/trend-series.ts";

const NOW = new Date("2026-05-26T12:00:00.000Z");

// ---------------------------------------------------------------------------
// windowStart
// ---------------------------------------------------------------------------

describe("windowStart", () => {
  test("subtracts windowDays days from now", () => {
    const start = windowStart(NOW, 7);
    assert.equal(start.toISOString(), "2026-05-19T12:00:00.000Z");
  });

  test("windowDays 0 → now", () => {
    assert.equal(windowStart(NOW, 0).getTime(), NOW.getTime());
  });
});

// ---------------------------------------------------------------------------
// dayBucketKey / dayKey
// ---------------------------------------------------------------------------

describe("dayBucketKey", () => {
  test("collapses to start-of-UTC-day ISO", () => {
    assert.equal(
      dayBucketKey(new Date("2026-05-26T23:59:59.999Z")),
      "2026-05-26T00:00:00.000Z",
    );
  });

  test("zero-pads month and day", () => {
    assert.equal(
      dayBucketKey(new Date("2026-01-05T10:00:00Z")),
      "2026-01-05T00:00:00.000Z",
    );
  });
});

describe("dayKey", () => {
  test("date-only form of dayBucketKey", () => {
    assert.equal(dayKey(new Date("2026-05-26T23:00:00Z")), "2026-05-26");
  });

  test("agrees with the legacy toISOString().split('T')[0] form", () => {
    const d = new Date("2026-02-09T18:30:00Z");
    assert.equal(dayKey(d), d.toISOString().split("T")[0]);
  });
});

// ---------------------------------------------------------------------------
// sortByTimeAsc
// ---------------------------------------------------------------------------

describe("sortByTimeAsc", () => {
  test("sorts oldest → newest in place", () => {
    const pts: TrendPoint[] = [
      { t: "2026-05-26T00:00:00.000Z", v: 1 },
      { t: "2026-05-24T00:00:00.000Z", v: 2 },
      { t: "2026-05-25T00:00:00.000Z", v: 3 },
    ];
    const out = sortByTimeAsc(pts);
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
// bucketByDay + folds
// ---------------------------------------------------------------------------

interface Rec {
  ts: string;
  s: number | null;
}

const recOpts = {
  tsOf: (r: Rec) => r.ts,
  score: (r: Rec) => r.s,
};

describe("bucketByDay", () => {
  test("empty input → []", () => {
    assert.deepEqual(bucketByDay([], { ...recOpts, combine: mean }), []);
  });

  test("mean fold averages a day's scorable records into one point", () => {
    const recs: Rec[] = [
      { ts: "2026-05-26T01:00:00Z", s: 1 },
      { ts: "2026-05-26T11:00:00Z", s: 0 },
    ];
    const out = bucketByDay(recs, { ...recOpts, combine: mean });
    assert.equal(out.length, 1);
    assert.equal(out[0].t, "2026-05-26T00:00:00.000Z");
    assert.equal(out[0].v, 0.5);
  });

  test("count fold tallies a day's records", () => {
    const recs: Rec[] = [
      { ts: "2026-05-25T05:00:00Z", s: 1 },
      { ts: "2026-05-25T22:00:00Z", s: 1 },
      { ts: "2026-05-26T01:00:00Z", s: 1 },
    ];
    const out = bucketByDay(recs, { ...recOpts, combine: count });
    assert.equal(out.length, 2);
    assert.equal(out[0].v, 2);
    assert.equal(out[1].v, 1);
  });

  test("skips records scored null and unparseable timestamps", () => {
    const recs: Rec[] = [
      { ts: "2026-05-26T01:00:00Z", s: null }, // unscorable
      { ts: "not-a-date", s: 1 }, // bad ts
      { ts: "2026-05-26T05:00:00Z", s: 1 },
    ];
    const out = bucketByDay(recs, { ...recOpts, combine: mean });
    assert.equal(out.length, 1);
    assert.equal(out[0].v, 1);
  });

  test("output sorted oldest → newest", () => {
    const recs: Rec[] = [
      { ts: "2026-05-26T01:00:00Z", s: 1 },
      { ts: "2026-05-24T01:00:00Z", s: 1 },
      { ts: "2026-05-25T01:00:00Z", s: 1 },
    ];
    const out = bucketByDay(recs, { ...recOpts, combine: mean });
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

describe("mean / count folds", () => {
  test("mean of empty → 0", () => assert.equal(mean([]), 0));
  test("mean averages", () => assert.equal(mean([1, 0, 1, 0]), 0.5));
  test("count counts", () => assert.equal(count([9, 9, 9]), 3));
});

// ---------------------------------------------------------------------------
// mergeWindowedPoints
// ---------------------------------------------------------------------------

describe("mergeWindowedPoints", () => {
  const start = windowStart(NOW, 7); // 2026-05-19T12:00:00Z

  test("keeps in-window historical, appends current at-now, sorts", () => {
    const historical: TrendPoint[] = [
      { t: "2026-05-20T00:00:00Z", v: 10 },
      { t: "2026-05-22T00:00:00Z", v: 20 },
    ];
    const current: TrendPoint = { t: NOW.toISOString(), v: 30 };
    const out = mergeWindowedPoints(historical, current, start, NOW);
    assert.deepEqual(
      out.map((p) => p.v),
      [10, 20, 30],
    );
  });

  test("drops out-of-window historical points", () => {
    const historical: TrendPoint[] = [
      { t: "2026-05-10T00:00:00Z", v: 1 }, // before start
      { t: "2026-05-20T00:00:00Z", v: 2 }, // inside
    ];
    const out = mergeWindowedPoints(historical, null, start, NOW);
    assert.deepEqual(
      out.map((p) => p.v),
      [2],
    );
  });

  test("does not duplicate current when a historical point shares its ts", () => {
    const ts = NOW.toISOString();
    const historical: TrendPoint[] = [{ t: ts, v: 5 }];
    const current: TrendPoint = { t: ts, v: 99 };
    const out = mergeWindowedPoints(historical, current, start, NOW);
    assert.equal(out.length, 1);
    assert.equal(out[0].v, 5); // historical wins; current not re-appended
  });

  test("null current with no historical → []", () => {
    assert.deepEqual(mergeWindowedPoints([], null, start, NOW), []);
  });

  test("current outside the window is dropped", () => {
    const future = new Date(NOW.getTime() + 60 * 60 * 1000);
    const current: TrendPoint = { t: future.toISOString(), v: 7 };
    assert.deepEqual(mergeWindowedPoints([], current, start, NOW), []);
  });

  test("skips non-finite historical values", () => {
    const historical: TrendPoint[] = [
      { t: "2026-05-20T00:00:00Z", v: Number.NaN },
      { t: "2026-05-21T00:00:00Z", v: 4 },
    ];
    const out = mergeWindowedPoints(historical, null, start, NOW);
    assert.deepEqual(
      out.map((p) => p.v),
      [4],
    );
  });
});

/**
 * Trend-series grammar for the dashboard's rolling-window aggregators
 * (issue #956).
 *
 * Every "is the system getting better over a rolling window?" aggregator on
 * the Outcomes / Explore pages speaks the same small grammar:
 *
 *   1. **Window arithmetic** — `windowStart = now - windowDays * 24h`.
 *   2. **UTC day-bucket key** — collapse a timestamp to its start-of-UTC-day
 *      ISO string (`YYYY-MM-DDT00:00:00.000Z`) so a 7-day window yields at
 *      most 7 points regardless of how many cycles ran each day.
 *   3. **The `{ t, v }` point shape** — an ISO timestamp `t` paired with a
 *      numeric reading `v`, the canonical sparkline datum.
 *   4. **The clamp-and-sort fold** — drop points outside the window, then
 *      sort oldest → newest so the sparkline reads left-to-right.
 *
 * Before #956 that grammar was good but its *implementation* was copy-pasted.
 * Two aggregators (`calibration-trend.ts`, `lessons-trend.ts`) carried a
 * byte-identical private `dayBucketKey`; `builder-health.ts` carried a
 * `utcDate` twin and `backlog-flow.ts` an `iso8601DateOnly` twin. The window
 * arithmetic `new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000)` was
 * re-typed in four aggregators. The `{ t, v }` shape was independently
 * re-declared as `TimeSeries.points`, `QuotaPoint`, `TrendPoint`, and inline
 * `{ t: string; v: number }[]`. And the "filter historical to window, append
 * the current reading at-now if not already covered, sort oldest → newest"
 * fold was duplicated almost line-for-line between
 * `subscription-quota-trend.ts::computeQuotaPoints` and
 * `outcome-trends.ts::bucketPoints`.
 *
 * This Module is the single home for that grammar, in the same shape #916
 * (`settle.ts`) and #940 (`feedback-file.ts`) concentrated their respective
 * mechanics. Each aggregator now supplies only its per-day value projection
 * and calls the Module; the grammar has one referent and one test surface
 * (`test/aggregator-trend-series.test.mts`).
 *
 * The aggregators keep their public `bucketByDay` / `promotionsByDay` /
 * `computeQuotaPoints` / `bucketPoints` exports (the dashboard + tests import
 * them) — those are now thin projections over this Module, preserving wire
 * shape and call sites.
 */

// ---------------------------------------------------------------------------
// The canonical point shape
// ---------------------------------------------------------------------------

/**
 * One sparkline datum: an ISO timestamp paired with a numeric reading. The
 * one shape every trend aggregator emits — `TimeSeries.points`, `QuotaPoint`,
 * and the per-aggregator `TrendPoint` are all this.
 */
export interface TrendPoint {
  /** ISO timestamp of the reading. */
  t: string;
  /** Reading value at `t`. */
  v: number;
}

// ---------------------------------------------------------------------------
// Grammar mechanic 1 — window arithmetic
// ---------------------------------------------------------------------------

/** Milliseconds in one day. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Start of a rolling window: `now` minus `windowDays` days. The arithmetic
 * the trend aggregators all opened with.
 */
export function windowStart(now: Date, windowDays: number): Date {
  return new Date(now.getTime() - windowDays * MS_PER_DAY);
}

// ---------------------------------------------------------------------------
// Grammar mechanic 2 — UTC day-bucket key
// ---------------------------------------------------------------------------

/**
 * Collapse a `Date` to the ISO timestamp of its start-of-UTC-day:
 * `YYYY-MM-DDT00:00:00.000Z`. The byte-identical `dayBucketKey` that lived
 * privately in `calibration-trend.ts` and `lessons-trend.ts`.
 */
export function dayBucketKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}T00:00:00.000Z`;
}

/**
 * The date-only (`YYYY-MM-DD`) form of {@link dayBucketKey}. The
 * `utcDate` / `iso8601DateOnly` twins from `builder-health.ts` and
 * `backlog-flow.ts`. Derived from the same UTC fields so the two forms can
 * never drift.
 */
export function dayKey(d: Date): string {
  return dayBucketKey(d).slice(0, 10);
}

// ---------------------------------------------------------------------------
// Grammar mechanic 4 — sort + window clamp folds
// ---------------------------------------------------------------------------

/** Sort `{ t, v }` points oldest → newest, in place, returning the array. */
export function sortByTimeAsc(points: TrendPoint[]): TrendPoint[] {
  points.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  return points;
}

/**
 * Bucket records by UTC day, folding each day's scorable readings into one
 * point via `combine`. Records whose `score` returns `null` are skipped;
 * days with no scorable record are omitted. Output is sorted oldest → newest.
 *
 * `tsOf` extracts the record's timestamp string; a record whose timestamp
 * doesn't parse is skipped. This is the generalisation of
 * `calibration-trend.ts::bucketByDay` (mean fold) and
 * `lessons-trend.ts::promotionsByDay` (count fold) — each supplies a
 * different `score` + `combine`.
 */
export function bucketByDay<R>(
  records: readonly R[],
  opts: {
    tsOf: (rec: R) => string;
    score: (rec: R) => number | null;
    combine: (values: number[]) => number;
  },
): TrendPoint[] {
  if (!Array.isArray(records) || records.length === 0) return [];
  const byDay = new Map<string, number[]>();
  for (const rec of records) {
    const s = opts.score(rec);
    if (s === null) continue;
    const ts = opts.tsOf(rec);
    const ms = Date.parse(typeof ts === "string" ? ts : "");
    if (!Number.isFinite(ms)) continue;
    const day = dayBucketKey(new Date(ms));
    const bucket = byDay.get(day) ?? [];
    bucket.push(s);
    byDay.set(day, bucket);
  }
  const out: TrendPoint[] = [];
  for (const [t, values] of byDay.entries()) {
    out.push({ t, v: opts.combine(values) });
  }
  return sortByTimeAsc(out);
}

/** Mean of a non-empty numeric list (the calibration accuracy fold). */
export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/** Count of a list (the promotion-per-day fold). */
export function count(values: number[]): number {
  return values.length;
}

/**
 * The historical-plus-current clamp-and-sort fold shared by
 * `subscription-quota-trend.ts::computeQuotaPoints` and
 * `outcome-trends.ts::bucketPoints`:
 *
 *   1. keep historical points whose `t` parses and falls inside the window;
 *   2. append the current reading at its timestamp (defaulting to `now`) when
 *      it is inside the window AND not already represented at that exact `t`;
 *   3. sort oldest → newest.
 *
 * `current` is `null` when there is no current reading. The window bounds are
 * inclusive on both ends, matching both prior implementations.
 */
export function mergeWindowedPoints(
  historical: readonly TrendPoint[],
  current: TrendPoint | null,
  windowStartDate: Date,
  now: Date,
): TrendPoint[] {
  const startMs = windowStartDate.getTime();
  const endMs = now.getTime();
  const out: TrendPoint[] = [];

  if (Array.isArray(historical)) {
    for (const p of historical) {
      if (!p || typeof p.t !== "string") continue;
      if (typeof p.v !== "number" || !Number.isFinite(p.v)) continue;
      const ms = Date.parse(p.t);
      if (!Number.isFinite(ms)) continue;
      if (ms < startMs || ms > endMs) continue;
      out.push({ t: p.t, v: p.v });
    }
  }

  if (current && typeof current.v === "number" && Number.isFinite(current.v)) {
    const ts =
      typeof current.t === "string" && current.t ? current.t : now.toISOString();
    const ms = Date.parse(ts);
    if (Number.isFinite(ms) && ms >= startMs && ms <= endMs) {
      if (!out.some((p) => p.t === ts)) {
        out.push({ t: ts, v: current.v });
      }
    }
  }

  return sortByTimeAsc(out);
}

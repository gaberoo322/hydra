/**
 * Subscription-quota-trend aggregator (issue #619, PRD #615 slice 4).
 *
 * Two correlated time series for the Outcomes page's "are we pacing the
 * subscription budget?" view:
 *
 *   - `percentBurned` — what % of the weekly quota the orchestrator has
 *     consumed at each point in the window.
 *   - `headroom`      — remaining quota (100 - percentBurned), the same
 *     number from the inverse angle.
 *
 * Both series read from the Subscription Usage Tracker
 * (`src/cost/usage-tracker.ts`, PR A/B series). The tracker today only
 * exposes a single rolling snapshot — there's no persisted per-day
 * history yet. The aggregator includes a `readHistoricalSnapshots` seam
 * so when history-storage lands, the trend extends seamlessly. Until
 * then both series are a single point at `now`.
 *
 * # Design contract
 *
 * - **Pure helpers exported.** `computeQuotaPoints` is tested directly.
 * - **Never throws.** Tracker failure returns both series as `[]`.
 * - **Uncalibrated → calibrated=false.** When the quota env vars aren't
 *   set, the tracker reports 0%. We pass `calibrated: false` so the
 *   dashboard can render "uncalibrated" instead of "0% used".
 */

import {
  getUsage,
  type UsageSnapshot,
} from "../cost/usage-tracker.ts";
import {
  windowStart as trendWindowStart,
  mergeWindowedPoints,
  type TrendPoint,
} from "./trend-series.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Alias of the shared trend-series point shape (issue #956). */
export type QuotaPoint = TrendPoint;

export interface QuotaTrendResponse {
  windowDays: number;
  generatedAt: string;
  percentBurned: { points: QuotaPoint[] };
  headroom: { points: QuotaPoint[] };
  /** True only when the operator has calibrated the weekly quota env. */
  calibrated: boolean;
}

export interface QuotaTrendDeps {
  now?: Date;
  /** Override the current snapshot reader — defaults to `getUsage()`. */
  readCurrentSnapshot?: () => Promise<UsageSnapshot>;
  /**
   * Seam for a future history-storage backend. Returns ordered usage
   * snapshots inside the window (oldest → newest). Default is `[]`,
   * which produces a single-point trend (the current snapshot). When
   * snapshot persistence lands, plug it in here without touching the
   * aggregator shape.
   */
  readHistoricalSnapshots?: (
    windowStart: Date,
    now: Date,
  ) => Promise<HistoricalSnapshot[]>;
}

/** Minimal shape needed to plot a historical point. */
export interface HistoricalSnapshot {
  t: string;
  percentLast7d: number;
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export async function getQuotaTrend(
  windowDays: number,
  deps: QuotaTrendDeps = {},
): Promise<QuotaTrendResponse> {
  const now = deps.now ?? new Date();
  const windowStart = trendWindowStart(now, windowDays);

  const reader = deps.readCurrentSnapshot ?? (() => getUsage());
  const history = deps.readHistoricalSnapshots ?? (async () => []);

  const [snapshotResult, historicalResult] = await Promise.allSettled([
    reader(),
    history(windowStart, now),
  ]);

  let snapshot: UsageSnapshot | null = null;
  if (snapshotResult.status === "fulfilled") {
    snapshot = snapshotResult.value;
  } else {
    console.error(
      `[subscription-quota-trend] current snapshot failed: ${snapshotResult.reason?.message || snapshotResult.reason}`,
    );
  }
  const historical =
    historicalResult.status === "fulfilled" ? historicalResult.value : [];
  if (historicalResult.status === "rejected") {
    console.error(
      `[subscription-quota-trend] historical fetch failed: ${historicalResult.reason?.message || historicalResult.reason}`,
    );
  }

  const points = computeQuotaPoints(historical, snapshot, windowStart, now);
  const percentBurned = points.map((p) => ({ t: p.t, v: p.v }));
  const headroom = points.map((p) => ({
    t: p.t,
    v: clamp01(100 - p.v),
  }));

  return {
    windowDays,
    generatedAt: now.toISOString(),
    percentBurned: { points: percentBurned },
    headroom: { points: headroom },
    calibrated: snapshot?.calibrated === true,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Pure helper — exported for tests. Combines historical snapshots with the
 * current snapshot, drops out-of-window points, and returns the result
 * sorted oldest → newest.
 *
 * - Filters historical points to those whose `t` is inside the window.
 * - Appends the current snapshot at `now` if not already represented.
 * - Returns `[]` when there are no in-window points AND no current
 *   snapshot (the dashboard renders an "uncalibrated / no data" state).
 */
export function computeQuotaPoints(
  historical: HistoricalSnapshot[],
  current: UsageSnapshot | null,
  windowStart: Date,
  now: Date,
): QuotaPoint[] {
  // Project both sources into the canonical `{ t, v }` shape, then defer the
  // window-clamp + at-now append + oldest→newest sort to the shared fold.
  const historicalPoints: TrendPoint[] = Array.isArray(historical)
    ? historical
        .filter(
          (h): h is HistoricalSnapshot =>
            !!h &&
            typeof h.t === "string" &&
            typeof h.percentLast7d === "number" &&
            Number.isFinite(h.percentLast7d),
        )
        .map((h) => ({ t: h.t, v: h.percentLast7d }))
    : [];

  const currentPoint: TrendPoint | null =
    current && typeof current.percentLast7d === "number"
      ? {
          t:
            typeof current.generatedAt === "string"
              ? current.generatedAt
              : now.toISOString(),
          v: current.percentLast7d,
        }
      : null;

  return mergeWindowedPoints(historicalPoints, currentPoint, windowStart, now);
}

function clamp01(n: number): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

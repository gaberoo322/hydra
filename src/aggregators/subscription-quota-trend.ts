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
 * (`src/cost/usage-tracker.ts`, PR A/B series). The tracker exposes a single
 * rolling snapshot and the orchestrator persists no per-day history, so both
 * series are a single current point at `now` — an honest current reading,
 * not a rolling trend. (The former `readHistoricalSnapshots` future-seam +
 * `HistoricalSnapshot` type were retired in #2877: no live writer existed —
 * the usage-weekly-snapshot store is per-ISO-week raw-token data, the wrong
 * shape/granularity for this per-day `percentLast7d` series.)
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

  const [snapshotResult] = await Promise.allSettled([reader()]);

  let snapshot: UsageSnapshot | null = null;
  if (snapshotResult.status === "fulfilled") {
    snapshot = snapshotResult.value;
  } else {
    console.error(
      `[subscription-quota-trend] current snapshot failed: ${snapshotResult.reason?.message || snapshotResult.reason}`,
    );
  }

  const points = computeQuotaPoints(snapshot, windowStart, now);
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
 * Pure helper — exported for tests. Projects the current usage snapshot into
 * a single windowed `{ t, v }` point: `[point]` when the snapshot is present
 * and inside the window, `[]` otherwise (the dashboard renders an
 * "uncalibrated / no data" state). The orchestrator persists no per-day
 * snapshot history (the `readHistoricalSnapshots` future-seam was retired in
 * #2877), so the output is always at most one point.
 */
export function computeQuotaPoints(
  current: UsageSnapshot | null,
  windowStart: Date,
  now: Date,
): QuotaPoint[] {
  // Project the current snapshot into the canonical `{ t, v }` shape, then
  // defer the window-clamp + at-now default + sort to the shared fold with
  // an empty historical list (the grammar reuse invariant, #956/#2877).
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

  return mergeWindowedPoints([], currentPoint, windowStart, now);
}

function clamp01(n: number): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

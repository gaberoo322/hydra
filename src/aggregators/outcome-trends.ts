/**
 * Outcome-trends aggregator (issue #619, PRD #615 slice 4).
 *
 * Returns a 7-day trend per declared Target Outcome — the "did the system
 * get better this week?" surface for the Outcomes page.
 *
 * # Data path
 *
 * 1. `loadOutcomes()` reads `config/direction/outcomes.yaml` — the canonical
 *    list of declared outcomes (baseline, target, direction).
 * 2. For each outcome, `getOutcomeValue()` produces a single current
 *    reading from its source adapter (`file` — the only implemented source
 *    since #933). The orchestrator does NOT persist a per-day history of
 *    outcome evaluations, so each outcome renders as a single current point
 *    with `baseline` shown alongside — an honest "current reading", not a
 *    rolling trend. (The former `readHistoricalPoints` future-seam was
 *    retired in #2877: it had no live writer and none was on the roadmap.)
 * 3. `deltaPct` is computed against `baseline` so the dashboard can render
 *    "+12% from baseline" with the right sign per outcome `direction`.
 *
 * # Design contract
 *
 * - **Pure helpers exported.** `computeDeltaPct` and `bucketPoints` are
 *   tested directly. The aggregator wires them up against the real
 *   outcomes loader (overridable for tests).
 * - **Never throws.** A failed sub-fetch returns the outcome with empty
 *   `points` + `null` delta so the dashboard can still render the card.
 * - **Single declared outcome is the common case.** Today only
 *   `orchestrator-self-improvement-share` is declared. The aggregator
 *   must render gracefully with N=1 AND N>1.
 */

import {
  loadOutcomes,
  getOutcomeValue,
  type Outcome,
  type OutcomeReading,
} from "../outcomes.ts";
import {
  windowStart as trendWindowStart,
  mergeWindowedPoints,
  type TrendPoint,
} from "./trend-series.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Re-export of the shared trend-series point shape (issue #956). */
export type { TrendPoint };

interface OutcomeTrend {
  name: string;
  direction: "up" | "down";
  /**
   * The current reading, projected as a single windowed point (or `[]` when
   * the reading is absent / outside the window). The orchestrator persists
   * no per-day history, so this is always at most one point — an honest
   * current reading, not a rolling window (#2877).
   */
  points: TrendPoint[];
  baseline: number;
  target: number;
  /**
   * % change from baseline → latest point, signed so the dashboard can
   * always treat positive as "moved toward target". Null when there are
   * no points in the window (the outcome is uncalibrated or unreachable).
   */
  deltaPct: number | null;
}

export interface OutcomeTrendsResponse {
  windowDays: number;
  generatedAt: string;
  outcomes: OutcomeTrend[];
}

export interface OutcomeTrendsDeps {
  now?: Date;
  /** Override the outcomes loader — defaults to `loadOutcomes()`. */
  loadOutcomes?: () => Promise<Outcome[]>;
  /** Override the per-outcome value reader — defaults to `getOutcomeValue`. */
  readCurrentValue?: (outcome: Outcome) => Promise<OutcomeReading | null>;
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export async function getOutcomeTrends(
  windowDays: number,
  deps: OutcomeTrendsDeps = {},
): Promise<OutcomeTrendsResponse> {
  const now = deps.now ?? new Date();
  const windowStart = trendWindowStart(now, windowDays);

  const loader = deps.loadOutcomes ?? defaultLoadOutcomes;
  const reader = deps.readCurrentValue ?? getOutcomeValue;

  let outcomes: Outcome[] = [];
  try {
    outcomes = await loader();
  } catch (err: any) {
    console.error(`[outcome-trends] loader failed: ${err?.message || err}`);
    return { windowDays, generatedAt: now.toISOString(), outcomes: [] };
  }

  const results = await Promise.allSettled(
    outcomes.map((o) => buildTrend(o, windowStart, now, reader)),
  );

  const trends: OutcomeTrend[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled") {
      trends.push(r.value);
    } else {
      console.error(
        `[outcome-trends] outcome ${outcomes[i]?.name} failed: ${r.reason?.message || r.reason}`,
      );
      // Emit a placeholder so the dashboard still renders the card.
      const o = outcomes[i];
      trends.push({
        name: o.name,
        direction: o.direction,
        points: [],
        baseline: o.baseline,
        target: o.target,
        deltaPct: null,
      });
    }
  }

  return { windowDays, generatedAt: now.toISOString(), outcomes: trends };
}

async function defaultLoadOutcomes(): Promise<Outcome[]> {
  const result = await loadOutcomes();
  if (result.ok === false) {
    console.error(
      `[outcome-trends] loadOutcomes returned errors: ${result.errors.join("; ")}`,
    );
    return [];
  }
  return result.outcomes;
}

async function buildTrend(
  outcome: Outcome,
  windowStart: Date,
  now: Date,
  readCurrentValue: (o: Outcome) => Promise<OutcomeReading | null>,
): Promise<OutcomeTrend> {
  const current = await readCurrentValue(outcome);

  const points = bucketPoints(current, windowStart, now);
  const deltaPct = computeDeltaPct(points, outcome.baseline);

  return {
    name: outcome.name,
    direction: outcome.direction,
    points,
    baseline: outcome.baseline,
    target: outcome.target,
    deltaPct,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Pure helper — exported for tests. Projects the current reading into a
 * single windowed `{ t, v }` point: `[point]` when the reading is present
 * and inside the window, `[]` otherwise. The orchestrator persists no
 * per-day history (the `readHistoricalPoints` future-seam was retired in
 * #2877), so the output is always at most one point.
 */
export function bucketPoints(
  current: OutcomeReading | null,
  windowStart: Date,
  now: Date,
): TrendPoint[] {
  // Project the current reading into the canonical `{ t, v }` shape, then
  // defer the window-clamp + at-now default + sort to the shared fold with
  // an empty historical list (the grammar reuse invariant, #956/#2877).
  const currentPoint: TrendPoint | null =
    current && typeof current.value === "number"
      ? {
          t: typeof current.ts === "string" ? current.ts : now.toISOString(),
          v: current.value,
        }
      : null;
  return mergeWindowedPoints([], currentPoint, windowStart, now);
}

/**
 * Pure helper — exported for tests. Computes the % change from `baseline`
 * to the latest point's value. Returns null when there are no points or
 * when the baseline is 0 (would divide by zero).
 */
export function computeDeltaPct(
  points: TrendPoint[],
  baseline: number,
): number | null {
  if (!Array.isArray(points) || points.length === 0) return null;
  if (typeof baseline !== "number" || !Number.isFinite(baseline) || baseline === 0) {
    return null;
  }
  const latest = points[points.length - 1];
  const v = latest?.v;
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return ((v - baseline) / Math.abs(baseline)) * 100;
}

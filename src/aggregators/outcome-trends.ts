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
 *    since #933). The
 *    orchestrator does NOT yet persist a per-day history of outcome
 *    evaluations — when history-storage lands, the `readHistoricalPoints`
 *    dep on this aggregator is the seam to plug it into. Until then the
 *    trend renders as a single point with `baseline` shown alongside.
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

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TrendPoint {
  /** ISO timestamp of the reading. */
  t: string;
  /** Reading value at `t`. */
  v: number;
}

export interface OutcomeTrend {
  name: string;
  direction: "up" | "down";
  /**
   * One point per available evaluation inside the window. Today the
   * orchestrator only persists the latest reading, so this is typically a
   * single point. The seam (`readHistoricalPoints` dep) is ready for a
   * future PR that adds rolling-window persistence.
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
  /**
   * Seam for a future history-storage backend. Returns an ordered list of
   * `TrendPoint`s inside the window (oldest → newest). Defaults to `[]`
   * — combined with the current reading from `readCurrentValue` so the
   * dashboard still has at least one point. When history storage lands,
   * pass it here; nothing in the aggregator shape changes.
   */
  readHistoricalPoints?: (
    outcome: Outcome,
    windowStart: Date,
    now: Date,
  ) => Promise<TrendPoint[]>;
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export async function getOutcomeTrends(
  windowDays: number,
  deps: OutcomeTrendsDeps = {},
): Promise<OutcomeTrendsResponse> {
  const now = deps.now ?? new Date();
  const windowStart = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const loader = deps.loadOutcomes ?? defaultLoadOutcomes;
  const reader = deps.readCurrentValue ?? getOutcomeValue;
  const history = deps.readHistoricalPoints ?? (async () => []);

  let outcomes: Outcome[] = [];
  try {
    outcomes = await loader();
  } catch (err: any) {
    console.error(`[outcome-trends] loader failed: ${err?.message || err}`);
    return { windowDays, generatedAt: now.toISOString(), outcomes: [] };
  }

  const results = await Promise.allSettled(
    outcomes.map((o) => buildTrend(o, windowStart, now, reader, history)),
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
  readHistoricalPoints: (
    o: Outcome,
    s: Date,
    n: Date,
  ) => Promise<TrendPoint[]>,
): Promise<OutcomeTrend> {
  const [historical, current] = await Promise.all([
    readHistoricalPoints(outcome, windowStart, now),
    readCurrentValue(outcome),
  ]);

  const points = bucketPoints(historical, current, windowStart, now);
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
 * Pure helper — exported for tests. Combines a list of historical points
 * with the optional current reading, drops points outside the window, and
 * returns the result sorted oldest → newest. Current reading is appended
 * at `now` if not already covered by a historical point at the same ts.
 */
export function bucketPoints(
  historical: TrendPoint[],
  current: OutcomeReading | null,
  windowStart: Date,
  now: Date,
): TrendPoint[] {
  const startMs = windowStart.getTime();
  const endMs = now.getTime();
  const out: TrendPoint[] = [];
  if (Array.isArray(historical)) {
    for (const p of historical) {
      if (!p || typeof p.v !== "number" || typeof p.t !== "string") continue;
      const ms = Date.parse(p.t);
      if (!Number.isFinite(ms)) continue;
      if (ms < startMs || ms > endMs) continue;
      out.push({ t: p.t, v: p.v });
    }
  }
  if (current && typeof current.value === "number") {
    const ts = typeof current.ts === "string" ? current.ts : now.toISOString();
    const ms = Date.parse(ts);
    if (Number.isFinite(ms) && ms >= startMs && ms <= endMs) {
      // Append unless an identical-ts entry already exists.
      if (!out.some((p) => p.t === ts)) {
        out.push({ t: ts, v: current.value });
      }
    }
  }
  out.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  return out;
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

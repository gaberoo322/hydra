/**
 * Builder-Health Stagnation Panel — pure per-realm projection (issue #3288,
 * epic #3285, ADR-0028).
 *
 * The bridge between the pure single-signal detector
 * (`builder-health-stagnation.ts::computeStagnation`, #3287) and the
 * Builder-Health Scorecard (`builder-health.ts`, #732). #3287 answers "has ONE
 * numeric series stagnated?"; this Module turns the cycle-metrics trend into
 * the several per-signal, per-realm series that detector consumes and folds
 * the verdicts into the `stagnation` block the scorecard exposes on
 * `GET /api/builder-health`.
 *
 * # Attribution by construction (ADR-0028 Decision 2)
 *
 * - **Dispatched-work-only.** The cycle-metrics stream this reads is written
 *   only for autopilot dispatches — human/external PRs never enter it — so the
 *   external-PR-volume confound is excluded *by construction*, not by a filter
 *   applied here. The one thing to enforce is the realm split.
 * - **Per realm, never blended.** Signals are computed against the orchestrator
 *   realm's cycle stream. The target realm has no cycle-metrics stream on this
 *   substrate (target builds run in a separate repo and are not instrumented
 *   here yet — ADR-0028 Consequences), so its per-signal blocks are `null`
 *   (dark), never a fabricated or blended number.
 * - **Relative-to-self, no composite.** Each signal's verdict is
 *   `computeStagnation` against its OWN trailing baseline; there is no
 *   composite/blended index (ADR-0028 Decision 1).
 *
 * # Signals with an honest per-cycle series
 *
 * Only signals that have a real per-cycle reading on the cycle-metrics hash are
 * trended for stagnation. Autonomy rate and time-to-merge are GitHub-join
 * *aggregates* with no per-cycle realm series, so they are deliberately absent
 * from the stagnation panel (they remain in the scorecard's own slots).
 *
 *   - **cycleYield** — per-cycle merge indicator (`tasksMerged > 0 ? 1 : 0`);
 *     a FALLING yield is worse, so `direction: "down"`.
 *   - **reworkRate** — per-cycle regression indicator
 *     (`regressionIntroduced ? 1 : 0`); a RISING rework rate is worse, so
 *     `direction: "up"`.
 *   - **mutationKillRate** — per-cycle mutation-kill-rate value; a FALLING kill
 *     rate is worse, so `direction: "down"`.
 *
 * # Window context (ADR-0028 Decision 2 — exposed, not adjusted out)
 *
 * Tier/backlog composition is not controlled for (no cheap substrate control);
 * instead the window's cleanup-vs-feature mix and anchor-type distribution are
 * exposed alongside the panel as honest context. A shifting mix is a *reader's*
 * caveat, never silently adjusted into the numbers.
 *
 * # Design contract (mirrors builder-health.ts)
 *
 * - **Pure + never throws.** `computeStagnationPanel(trend, opts?)` reads only
 *   its already-fetched trend rows and returns a plain object. No Redis, no
 *   clock, no I/O. A malformed row degrades to a skipped/coerced value.
 */

import {
  computeStagnation,
  type StagnationResult,
  type StagnationDirection,
} from "./builder-health-stagnation.ts";

/** One trend row as returned by `metrics/trend.ts::getMetricsTrend` (parsed). */
export type TrendRow = Record<string, any>;

/** The four builder-health signals that carry a per-cycle series here. */
export type StagnationSignalName = "cycleYield" | "reworkRate" | "mutationKillRate";

/** The two dispatch realms. Only `orch` has a cycle-metrics stream today. */
export type Realm = "orch" | "target";

/**
 * A per-realm stagnation block: the detector verdict for each realm, or `null`
 * when that realm has no instrumented series (dark, never fabricated).
 */
export interface RealmStagnation {
  orch: StagnationResult | null;
  target: StagnationResult | null;
}

/** Window context exposed alongside the panel (ADR-0028 Decision 2). */
interface StagnationWindowContext {
  /** Number of cycles the panel was computed over (orch realm). */
  cycles: number;
  /** Cleanup-vs-feature merged-cycle split (fix:feature framing, #732). */
  mix: { cleanup: number; feature: number };
  /** Anchor-type distribution over the window (tier-mix proxy). */
  anchorTypes: Record<string, number>;
}

/** The full stagnation panel exposed on the scorecard. */
export interface StagnationPanel {
  /** Per-signal, per-realm detector verdicts. */
  signals: Record<StagnationSignalName, RealmStagnation>;
  /** Honest window context (not adjusted out of the signals). */
  windowContext: StagnationWindowContext;
}

/** Detector knobs per signal (direction is fixed by ADR-0028 Decision 1). */
interface SignalSpec {
  direction: StagnationDirection;
  /** Per-cycle numeric reading for this signal, or `null` to skip the row. */
  project: (row: TrendRow) => number | null;
}

/**
 * The three trended signals and their fixed worse-directions (ADR-0028
 * Decision 1). Projections are null-safe — a missing/garbage field yields a
 * skipped row, never a fabricated 0.
 */
const SIGNAL_SPECS: Record<StagnationSignalName, SignalSpec> = {
  cycleYield: {
    direction: "down",
    // A cycle that merged reads 1, a cycle that did not reads 0. Only cycles
    // that actually attempted work contribute (an idle/no-op cycle is not a
    // yield sample).
    project: (row) => {
      if (!isRow(row)) return null;
      const attempted = num(row.tasksAttempted);
      if (attempted === null || attempted <= 0) return null;
      const merged = num(row.tasksMerged);
      return merged !== null && merged > 0 ? 1 : 0;
    },
  },
  reworkRate: {
    direction: "up",
    // A regression-introducing cycle reads 1, else 0 — mirrors
    // stats-projection.ts::projectAggregateStats regressionRate numerator. A
    // non-object row is skipped (null), never coerced to a spurious 0 sample.
    project: (row) => (isRow(row) ? (row.regressionIntroduced === true ? 1 : 0) : null),
  },
  mutationKillRate: {
    direction: "down",
    // The per-cycle mutation-kill-rate value; a cycle with no mutation run has
    // no reading (skip, never a fabricated 0 that would poison the baseline).
    project: (row) => (isRow(row) ? num(row.mutationKillRate) : null),
  },
};

/**
 * Tunables for the panel (all default from ADR-0028 / #3287). Exposed so the
 * scorecard/tests can pin them; production uses the defaults.
 */
export interface StagnationPanelOptions {
  /** Band excursion per signal, in the signal's own units. */
  band?: Partial<Record<StagnationSignalName, number>>;
  /** Consecutive worse cycles required to flip to `breach`. Default 3. */
  sustain?: number;
  /** Minimum series length before a baseline is trusted (cold-start). Default 10. */
  minBaselineCycles?: number;
  /** Trailing rolling-mean window feeding the baseline. Default 50. */
  baselineWindow?: number;
}

const DEFAULT_SUSTAIN = 3;
const DEFAULT_MIN_BASELINE = 10;
const DEFAULT_BASELINE_WINDOW = 50;

// Per-signal default bands. Yield/rework are 0..1 indicators (a 15pp excursion
// from the trailing mean is a meaningful move); mutation-kill-rate is a 0..100
// percentage (a 15-point excursion).
const DEFAULT_BANDS: Record<StagnationSignalName, number> = {
  cycleYield: 0.15,
  reworkRate: 0.15,
  mutationKillRate: 15,
};

/**
 * Fold the cycle-metrics trend into the per-signal, per-realm stagnation panel.
 * Pure, never throws.
 *
 * @param trend Cycle-metrics rows, NEWEST-FIRST (as `getMetricsTrend` returns).
 *              Only the orchestrator realm has such a stream; the target realm
 *              is dark by construction.
 * @param opts  Detector knobs (bands / sustain / minBaseline / baselineWindow).
 */
export function computeStagnationPanel(
  trend: readonly TrendRow[],
  opts: StagnationPanelOptions = {},
): StagnationPanel {
  const rows = Array.isArray(trend) ? trend : [];
  const sustain = opts.sustain ?? DEFAULT_SUSTAIN;
  const minBaselineCycles = opts.minBaselineCycles ?? DEFAULT_MIN_BASELINE;
  const baselineWindow = opts.baselineWindow ?? DEFAULT_BASELINE_WINDOW;

  const signals = {} as Record<StagnationSignalName, RealmStagnation>;
  for (const name of Object.keys(SIGNAL_SPECS) as StagnationSignalName[]) {
    const spec = SIGNAL_SPECS[name];
    const band = opts.band?.[name] ?? DEFAULT_BANDS[name];
    // Oldest-first series of the honest per-cycle readings for the orch realm.
    // `getMetricsTrend` returns newest-first, so reverse; drop skipped rows.
    const series: number[] = [];
    for (let i = rows.length - 1; i >= 0; i--) {
      const v = spec.project(rows[i]);
      if (v !== null) series.push(v);
    }
    const orch = computeStagnation(series, {
      direction: spec.direction,
      band,
      sustain,
      minBaselineCycles,
      baselineWindow,
    });
    // Target realm has no cycle stream on this substrate → dark, never blended.
    signals[name] = { orch, target: null };
  }

  return { signals, windowContext: computeWindowContext(rows) };
}

/**
 * The honest window context (ADR-0028 Decision 2): cleanup-vs-feature merged
 * mix and anchor-type distribution over the orchestrator cycle window. Pure.
 */
function computeWindowContext(rows: readonly TrendRow[]): StagnationWindowContext {
  let cleanup = 0;
  let feature = 0;
  const anchorTypes: Record<string, number> = {};
  for (const row of rows) {
    if (!isRow(row)) continue;
    const at = typeof row.anchorType === "string" && row.anchorType ? row.anchorType : "unknown";
    anchorTypes[at] = (anchorTypes[at] ?? 0) + 1;
    // Only merged cycles contribute to the fix:feature mix (mirrors
    // aggregate.ts::getFixFeatureRatio).
    const merged = num(row.tasksMerged);
    if (merged !== null && merged > 0) {
      if (at === "prior-failure" || at === "failing-test") cleanup++;
      else feature++;
    }
  }
  return { cycles: rows.length, mix: { cleanup, feature }, anchorTypes };
}

/** True for a non-null object row (guards against null/undefined/garbage rows). */
function isRow(row: unknown): row is TrendRow {
  return typeof row === "object" && row !== null;
}

/** Coerce a field to a finite number, or `null` (fail-safe — never throws). */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Autopilot health-signals — shared core (issue #2866 — extracted from the
 * combined `autopilot/run-health.ts` heuristic bag).
 *
 * This leaf owns everything the four per-heuristic evaluators share: the
 * `StuckSignal` domain types, the tunable threshold bag, the reader-facing run
 * shapes, the defensive coercion helpers, and the two shared pure helpers
 * (`rankSignals`, `oldestRunStartEpochS`). Each heuristic leaf
 * (`stalled-dispatch.ts`, `unproductive-loop.ts`, `idle-streak.ts`,
 * `issue-pr-churn.ts`) imports the pieces it needs from here.
 *
 * The coordinator (`autopilot/run-health.ts`) re-exports this module's public
 * surface unchanged, so the five existing importers
 * (`aggregators/autopilot-health.ts`, `autopilot/retro-bundle.ts`,
 * `autopilot/status.ts`, `schemas/now-page.ts`, and the `test/*.mts` files)
 * require ZERO import-path edits — this is a behaviour-preserving refactor.
 *
 * # Design contract
 *
 * - **Pure.** No Redis, clock, or subprocess dependency — every function here
 *   reads only its arguments.
 * - **Never throws.** Coercion helpers degrade defensively; they cannot throw
 *   on malformed input.
 */

// ---------------------------------------------------------------------------
// StuckSignal domain types (issue #2838 — relocated from schemas/now-page.ts;
// #2866 — re-homed to this shared leaf, still re-exported through run-health.ts)
// ---------------------------------------------------------------------------

/**
 * The four stuck-signal heuristic types this analysis core computes:
 *   - `stalled-dispatch`   — a live dispatch running past a threshold with no
 *                            fresh tool-call / turn activity.
 *   - `unproductive-loop`  — a class dispatched repeatedly across the history
 *                            window with zero merges or a high failed count.
 *   - `idle-streak`        — consecutive no-op turns / runs terminating idle.
 *   - `issue-pr-churn`     — the same issue or PR re-dispatched repeatedly
 *                            without resolving.
 *
 * This is the canonical domain owner of the stuck-signal shape: the run-health
 * analysis core produces and ranks every `StuckSignal`, so the type lives here
 * (re-exported through `run-health.ts`). The HTTP wire schema in
 * `schemas/now-page.ts` (`StuckSignalSchema`) validates this shape and imports
 * the types FROM the run-health surface — the correct domain → schema direction.
 */
export type StuckSignalType =
  | "stalled-dispatch"
  | "unproductive-loop"
  | "idle-streak"
  | "issue-pr-churn";

/** Severity ranking a heuristic assigns to a stuck signal. */
export type StuckSignalSeverity = "info" | "warn" | "critical";

/**
 * One ranked stuck signal. `evidence` is an open key/value bag carrying the
 * class, counts, and issue/PR refs the operator needs to act on the signal —
 * an `unknown`-valued record so a heuristic can attach extra evidence (a
 * count, a class label, an array of refs) without a schema change.
 */
export interface StuckSignal {
  type: StuckSignalType;
  severity: StuckSignalSeverity;
  summary: string;
  evidence: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tunable thresholds
// ---------------------------------------------------------------------------

export interface AutopilotHealthThresholds {
  /**
   * Age (seconds) of the live run's heartbeat past which an open dispatch is
   * treated as stalled. `warn` at this threshold; `critical` at 2x.
   */
  stalledDispatchAgeS: number;
  /**
   * Minimum number of dispatches a class must accumulate across the window
   * before a zero-merge / high-failure verdict is interesting.
   */
  unproductiveMinDispatches: number;
  /**
   * Failed-count ratio (failed / dispatches) at or above which a class is
   * flagged `critical` rather than `warn`.
   */
  unproductiveCriticalFailRatio: number;
  /** Consecutive idle/no-op runs that constitute an idle streak (warn). */
  idleStreakMin: number;
  /** Idle-streak length at or above which the signal escalates to critical. */
  idleStreakCritical: number;
  /** Times an issue/PR ref may recur across runs before it counts as churn. */
  churnMinRecurrences: number;
  /** Recurrence count at or above which churn escalates to critical. */
  churnCriticalRecurrences: number;
  /**
   * Extra look-back seconds subtracted from the oldest run's `started_epoch`
   * when computing the real-merge cross-check window (issue #2369).
   *
   * The incident: 14 runs were clustered in an afternoon burst; every master
   * merge from that morning landed ~38 min BEFORE the oldest run started, so
   * `readWindowMergeCount(oldestRunStart)` returned 0 even though 5 PRs had
   * merged. By extending the merge-count window backward by this buffer we
   * capture merges that landed before the run cluster began — the actual
   * delivery cadence is wider than a single burst's span.
   *
   * Default 14 400 s (4 h): enough to span a typical morning-merge-then-
   * afternoon-run cadence without widening so far that stale merges from an
   * earlier productive day suppress a genuinely idle window.
   */
  mergeWindowLookbackS: number;
}

export const DEFAULT_HEALTH_THRESHOLDS: AutopilotHealthThresholds = {
  stalledDispatchAgeS: 900, // 15 min — well past a healthy turn cadence
  unproductiveMinDispatches: 3,
  unproductiveCriticalFailRatio: 0.75,
  idleStreakMin: 3,
  idleStreakCritical: 5,
  churnMinRecurrences: 3,
  churnCriticalRecurrences: 5,
  mergeWindowLookbackS: 14_400, // 4 h — spans the typical morning-merge→afternoon-run gap
};

// ---------------------------------------------------------------------------
// Reader-facing shapes (a thin subset of the runs.ts projections we consume)
// ---------------------------------------------------------------------------

/** Run digest subset (from `listRuns`). Extra fields are tolerated. */
export interface RunDigest {
  run_id?: unknown;
  status?: unknown;
  term_reason?: unknown;
  dispatches?: unknown;
  merged_count?: unknown;
  failed_count?: unknown;
  /**
   * Epoch *seconds* the run started (from `projectRunDigest`). Used to derive
   * the wall-clock span the window covers so the real-merge cross-check
   * (`readWindowMergeCount`) can count master merges over the same interval.
   */
  started_epoch?: unknown;
}

/** Live-run view subset (from `getCurrentRun().view`). */
export interface LiveRunView {
  run_id?: unknown;
  status?: unknown;
  age_s?: unknown;
  turns?: unknown; // Array<turn record> when present
}

// ---------------------------------------------------------------------------
// Coercion helpers — shared by every heuristic leaf
// ---------------------------------------------------------------------------

export function toNum(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim().length > 0) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

export function toStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// ---------------------------------------------------------------------------
// Ranking — exported for tests
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<StuckSignalSeverity, number> = {
  critical: 0,
  warn: 1,
  info: 2,
};

/**
 * Pure helper — exported for tests. Sort signals by severity
 * (critical → warn → info), breaking ties by type so the order is stable.
 */
export function rankSignals(signals: StuckSignal[]): StuckSignal[] {
  return [...signals].sort((a, b) => {
    const sa = SEVERITY_RANK[a.severity] ?? 99;
    const sb = SEVERITY_RANK[b.severity] ?? 99;
    if (sa !== sb) return sa - sb;
    return a.type.localeCompare(b.type);
  });
}

/**
 * Pure helper — exported for tests. Returns the smallest positive
 * `started_epoch` (epoch seconds) across the run-history window, i.e. when the
 * oldest run began — the wall-clock start of the span the window covers. The
 * real-merge cross-check counts master merges since this point. Returns null
 * when no run carries a usable timestamp (the cross-check is then skipped and
 * the heuristic falls back to the per-run `merged_count` boundary alone).
 */
export function oldestRunStartEpochS(history: RunDigest[]): number | null {
  let oldest: number | null = null;
  for (const run of history) {
    const s = toNum(run.started_epoch);
    if (s <= 0) continue;
    if (oldest === null || s < oldest) oldest = s;
  }
  return oldest;
}

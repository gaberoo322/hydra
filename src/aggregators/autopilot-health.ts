/**
 * Autopilot-health aggregator (issue #890, now-console-3, PRD #887).
 *
 * Computes a ranked list of **stuck signals** over two data sources:
 *
 *   1. The live autopilot run (`getCurrentRun()`) — its projected view + the
 *      latest turn timeline. Drives the `stalled-dispatch` heuristic: a live
 *      run whose most-recent turn carries an open dispatch and whose
 *      heartbeat age has crossed a threshold (no fresh tool-call / turn
 *      activity) is wedged.
 *   2. The recent run-history window (`listRuns(historyWindow)`) — run
 *      digests carrying `merged_count` / `failed_count` / `dispatches` /
 *      `term_reason`. Drives the three cross-run heuristics:
 *        - `unproductive-loop` — a class dispatched repeatedly with zero
 *          merges or a high cumulative failed count.
 *        - `idle-streak` — a streak of runs terminating idle or producing no
 *          dispatch at all.
 *        - `issue-pr-churn` — the same issue/PR ref re-dispatched repeatedly
 *          across runs without ever landing a merge.
 *
 * # Design contract — same as stuck-items.ts / active-dispatches.ts
 *
 * - **Pure heuristic core.** Each heuristic is a pure function over already-
 *   read data, exported so tests pin the boundary without stubbing Redis.
 * - **Never throws.** Each sub-source is wrapped via `Promise.allSettled`; a
 *   failed read logs and contributes an empty signal list — the rest still
 *   ship. The public entrypoint cannot throw.
 * - **Readers injectable.** The two run readers live in `deps` so tests run
 *   without Redis or subprocesses. Production callers pass nothing and the
 *   defaults thin-wrap `src/autopilot/runs.ts` (read-only consumption — this
 *   aggregator never mutates run state).
 * - **Ranked output.** Signals are sorted by severity (critical → warn →
 *   info), then by type for a deterministic order.
 */

import type { StuckSignal, StuckSignalSeverity } from "../schemas/now-page.ts";

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
}

export const DEFAULT_HEALTH_THRESHOLDS: AutopilotHealthThresholds = {
  stalledDispatchAgeS: 900, // 15 min — well past a healthy turn cadence
  unproductiveMinDispatches: 3,
  unproductiveCriticalFailRatio: 0.75,
  idleStreakMin: 3,
  idleStreakCritical: 5,
  churnMinRecurrences: 3,
  churnCriticalRecurrences: 5,
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
}

/** Live-run view subset (from `getCurrentRun().view`). */
export interface LiveRunView {
  run_id?: unknown;
  status?: unknown;
  age_s?: unknown;
  turns?: unknown; // Array<turn record> when present
}

export interface AutopilotHealthDeps {
  /** Wall-clock anchor — defaults to `new Date()`. Only used for `generatedAt`. */
  now?: Date;
  /** Override default thresholds. */
  thresholds?: Partial<AutopilotHealthThresholds>;
  /**
   * Reader for the live autopilot run view (the `view` payload of
   * `getCurrentRun()`, which carries `turns`). Returns `null` when no run
   * exists. Defaults to a thin call into `autopilot/runs.getCurrentRun()`.
   */
  readLiveRun?: () => Promise<LiveRunView | null>;
  /**
   * Reader for the recent run-history digests, newest-first. Defaults to a
   * thin call into `autopilot/runs.listRuns(limit)`.
   */
  readRecentRuns?: (limit: number) => Promise<RunDigest[]>;
  /** How many recent runs the cross-run heuristics scan. Defaults to 14. */
  historyWindow?: number;
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export async function getAutopilotHealth(
  deps: AutopilotHealthDeps = {},
): Promise<StuckSignal[]> {
  const thresholds: AutopilotHealthThresholds = {
    ...DEFAULT_HEALTH_THRESHOLDS,
    ...(deps.thresholds ?? {}),
  };
  const historyWindow = deps.historyWindow ?? 14;
  const readLiveRun = deps.readLiveRun ?? defaultReadLiveRun;
  const readRecentRuns = deps.readRecentRuns ?? defaultReadRecentRuns;

  const [liveResult, historyResult] = await Promise.allSettled([
    readLiveRun(),
    readRecentRuns(historyWindow),
  ]);

  const live = settledOrNull(liveResult, "autopilot-health/live-run");
  const history = settledOrEmpty(historyResult, "autopilot-health/run-history");

  const signals: StuckSignal[] = [
    ...detectStalledDispatch(live, thresholds),
    ...detectUnproductiveLoops(history, thresholds),
    ...detectIdleStreak(history, thresholds),
    ...detectIssuePrChurn(history, thresholds),
  ];

  return rankSignals(signals);
}

function settledOrEmpty<T>(result: PromiseSettledResult<T[]>, label: string): T[] {
  if (result.status === "fulfilled") return Array.isArray(result.value) ? result.value : [];
  console.error(
    `[autopilot-health] sub-source failed (${label}): ${result.reason?.message || result.reason}`,
  );
  return [];
}

function settledOrNull<T>(result: PromiseSettledResult<T>, label: string): T | null {
  if (result.status === "fulfilled") return result.value ?? null;
  console.error(
    `[autopilot-health] sub-source failed (${label}): ${result.reason?.message || result.reason}`,
  );
  return null;
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

// ---------------------------------------------------------------------------
// Coercion helpers
// ---------------------------------------------------------------------------

function toNum(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim().length > 0) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function toStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// ---------------------------------------------------------------------------
// Heuristic 1: stalled live dispatch — pure, exported for tests
// ---------------------------------------------------------------------------

/**
 * A live run is stalled when it is still `running`, its most-recent turn
 * carries at least one open dispatch action, and the run's heartbeat age has
 * crossed the threshold (no fresh turn / tool-call activity). `warn` at the
 * threshold, `critical` at 2x. Returns `[]` for any run that is not live,
 * has no open dispatch in its latest turn, or is within the cadence window.
 */
export function detectStalledDispatch(
  live: LiveRunView | null,
  thresholds: AutopilotHealthThresholds,
): StuckSignal[] {
  if (!live) return [];
  if (toStr(live.status) !== "running") return [];

  const ageS = toNum(live.age_s);
  if (ageS < thresholds.stalledDispatchAgeS) return [];

  const turns = Array.isArray(live.turns) ? (live.turns as unknown[]) : [];
  if (turns.length === 0) return [];

  // `getCurrentRun` returns turns newest-first (descending turn_n). The first
  // entry is the most-recent turn; an open dispatch there with no newer turn
  // is the stall signature.
  const latest = turns[0];
  const dispatchCount = countOpenDispatchActions(latest);
  if (dispatchCount === 0) return [];

  const runId = toStr(live.run_id) || "current";
  const severity: StuckSignalSeverity =
    ageS >= thresholds.stalledDispatchAgeS * 2 ? "critical" : "warn";

  return [
    {
      type: "stalled-dispatch",
      severity,
      summary: `Live run ${runId} has an open dispatch with no new activity for ~${Math.floor(
        ageS / 60,
      )}m (heartbeat age ${ageS}s).`,
      evidence: {
        runId,
        ageSeconds: ageS,
        openDispatches: dispatchCount,
        thresholdSeconds: thresholds.stalledDispatchAgeS,
      },
    },
  ];
}

/**
 * Count dispatch actions in a turn record that have no resolved outcome
 * (still pending / in-flight). A turn carries `actions: [{type, outcome?}]`
 * (see `fetchTurnsWithJoins`); a dispatch with `outcome: null` is open.
 */
function countOpenDispatchActions(turn: unknown): number {
  if (!turn || typeof turn !== "object") return 0;
  const actions = (turn as { actions?: unknown }).actions;
  if (!Array.isArray(actions)) return 0;
  let n = 0;
  for (const a of actions) {
    if (!a || typeof a !== "object") continue;
    const action = a as { type?: unknown; outcome?: unknown };
    if (action.type !== "dispatch") continue;
    // outcome null/undefined → still pending. A resolved (merged/failed)
    // outcome means the dispatch is no longer in-flight.
    if (action.outcome === null || action.outcome === undefined) n += 1;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Heuristic 2: unproductive class loops — pure, exported for tests
//
// The run digest doesn't carry a per-run class label, but it does carry the
// aggregate dispatch/merged/failed counts per run. We treat the run-history
// window itself as the "loop": across the window, if total dispatches are
// non-trivial yet zero merged AND a meaningful share failed, the autopilot is
// burning capacity without landing work.
// ---------------------------------------------------------------------------

export function detectUnproductiveLoops(
  history: RunDigest[],
  thresholds: AutopilotHealthThresholds,
): StuckSignal[] {
  let dispatches = 0;
  let merged = 0;
  let failed = 0;
  let runsWithDispatch = 0;
  for (const run of history) {
    const d = toNum(run.dispatches);
    dispatches += d;
    merged += toNum(run.merged_count);
    failed += toNum(run.failed_count);
    if (d > 0) runsWithDispatch += 1;
  }

  if (dispatches < thresholds.unproductiveMinDispatches) return [];
  // Productive if anything merged — only flag a fully-unproductive window.
  if (merged > 0) return [];

  const failRatio = dispatches > 0 ? failed / dispatches : 0;
  const severity: StuckSignalSeverity =
    failRatio >= thresholds.unproductiveCriticalFailRatio ? "critical" : "warn";

  return [
    {
      type: "unproductive-loop",
      severity,
      summary: `Across the last ${history.length} runs, ${dispatches} dispatch(es) landed 0 merges (${failed} failed) — autopilot is looping without progress.`,
      evidence: {
        windowRuns: history.length,
        runsWithDispatch,
        dispatches,
        merged,
        failed,
        failRatio: Number(failRatio.toFixed(3)),
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Heuristic 3: idle streak — pure, exported for tests
//
// A run is "idle/no-op" when it terminated with term_reason "idle" OR
// produced zero dispatches. We count the leading streak of such runs from the
// newest end of the window (history is newest-first).
// ---------------------------------------------------------------------------

export function detectIdleStreak(
  history: RunDigest[],
  thresholds: AutopilotHealthThresholds,
): StuckSignal[] {
  let streak = 0;
  for (const run of history) {
    const idle =
      toStr(run.term_reason) === "idle" || toNum(run.dispatches) === 0;
    if (!idle) break;
    streak += 1;
  }

  if (streak < thresholds.idleStreakMin) return [];

  const severity: StuckSignalSeverity =
    streak >= thresholds.idleStreakCritical ? "critical" : "warn";

  return [
    {
      type: "idle-streak",
      severity,
      summary: `The last ${streak} consecutive autopilot run(s) were idle / produced no dispatch.`,
      evidence: {
        streak,
        windowRuns: history.length,
        thresholdRuns: thresholds.idleStreakMin,
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Heuristic 4: issue/PR churn — pure, exported for tests
//
// A run digest may carry an issue/PR ref the run worked (issue_ref / pr_ref /
// anchor). When the same ref recurs across runs in the window without any
// merged outcome on those runs, it is churning. The reader tolerates either
// naming; refs are extracted defensively.
// ---------------------------------------------------------------------------

export function detectIssuePrChurn(
  history: RunDigest[],
  thresholds: AutopilotHealthThresholds,
): StuckSignal[] {
  // ref → { count, merged }
  const byRef = new Map<string, { count: number; merged: number }>();
  for (const run of history) {
    const refs = extractRefs(run);
    const mergedHere = toNum(run.merged_count);
    for (const ref of refs) {
      const prev = byRef.get(ref) ?? { count: 0, merged: 0 };
      prev.count += 1;
      prev.merged += mergedHere;
      byRef.set(ref, prev);
    }
  }

  const out: StuckSignal[] = [];
  for (const [ref, agg] of byRef) {
    if (agg.count < thresholds.churnMinRecurrences) continue;
    // If something merged on a run carrying this ref, it isn't pure churn.
    if (agg.merged > 0) continue;
    const severity: StuckSignalSeverity =
      agg.count >= thresholds.churnCriticalRecurrences ? "critical" : "warn";
    out.push({
      type: "issue-pr-churn",
      severity,
      summary: `${ref} was re-dispatched across ${agg.count} runs without resolving.`,
      evidence: {
        ref,
        recurrences: agg.count,
        windowRuns: history.length,
      },
    });
  }
  // Most-churned first within this heuristic; the top-level rank re-sorts by
  // severity but keeps this relative order for ties.
  out.sort((a, b) => toNum(b.evidence.recurrences) - toNum(a.evidence.recurrences));
  return out;
}

/**
 * Extract the issue/PR ref(s) a run digest worked. Tolerates several field
 * names (`issue_ref`, `issueRef`, `pr_ref`, `prRef`, `anchor`,
 * `anchor_reference`) since the digest shape is read-only here and we don't
 * want to couple to one exact key. Returns a de-duplicated list.
 */
function extractRefs(run: RunDigest): string[] {
  const candidate = run as Record<string, unknown>;
  const keys = [
    "issue_ref",
    "issueRef",
    "pr_ref",
    "prRef",
    "anchor",
    "anchor_reference",
    "anchorReference",
  ];
  const out = new Set<string>();
  for (const key of keys) {
    const v = candidate[key];
    if (typeof v === "string" && v.trim().length > 0) out.add(v.trim());
  }
  return Array.from(out);
}

// ---------------------------------------------------------------------------
// Default wiring — thin read-only consumption of autopilot/runs.ts
// ---------------------------------------------------------------------------

async function defaultReadLiveRun(): Promise<LiveRunView | null> {
  const { getCurrentRun } = await import("../autopilot/runs.ts");
  const result = await getCurrentRun();
  if (!result.ok) return null;
  return result.view as LiveRunView;
}

async function defaultReadRecentRuns(limit: number): Promise<RunDigest[]> {
  const { listRuns } = await import("../autopilot/runs.ts");
  const result = await listRuns(limit);
  if (!result.ok) return [];
  return result.runs as RunDigest[];
}

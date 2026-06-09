/**
 * Autopilot run-health heuristics (issue #1378 — extracted from
 * `aggregators/autopilot-health.ts`).
 *
 * This module owns the **pure analysis core** of the autopilot-health
 * aggregator: the four stuck-signal heuristics, their threshold types, and the
 * supporting pure helpers (ranking, ref extraction, epoch derivation). Inputs
 * are already-fetched run data — there is NO Redis, clock, or subprocess
 * dependency here, so every function is testable without instantiating the
 * aggregator's `deps` bag.
 *
 * The aggregator (`aggregators/autopilot-health.ts`) is the thin caller: it
 * fans out the two run reads (`getCurrentRun`, `listRuns`) plus the two
 * cross-checks (window-merge count, OS-heartbeat age) and delegates heuristic
 * evaluation here. `autopilot/retro-bundle.ts` consumes the aggregator's
 * public entrypoint, but may import these pure heuristics directly.
 *
 * # Design contract
 *
 * - **Pure heuristic core.** Each heuristic is a pure function over already-
 *   read data, exported so tests pin the boundary without stubbing Redis.
 * - **Never throws.** These functions only read their arguments and coerce
 *   defensively; they cannot throw on malformed input.
 * - **Ranked output.** `rankSignals` sorts by severity (critical → warn →
 *   info), then by type for a deterministic order.
 */

import type { StuckSignal, StuckSignalSeverity } from "../schemas/now-page.ts";
import { isOsHeartbeatStale } from "./os-heartbeat.ts";

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

// ---------------------------------------------------------------------------
// Heuristic 1: stalled live dispatch — pure, exported for tests
// ---------------------------------------------------------------------------

/**
 * A live run is stalled when it is still `running`, its most-recent turn
 * carries at least one open dispatch action, the run's per-turn heartbeat age
 * has crossed the threshold (no fresh turn / tool-call activity), AND the
 * continuously-written OS heartbeat is ALSO stale (#1091). `warn` at the
 * threshold, `critical` at 2x. Returns `[]` for any run that is not live,
 * has no open dispatch in its latest turn, is within the cadence window, or
 * whose OS heartbeat is fresh (loop alive mid-long-turn).
 *
 * `osHbAgeS` is the OS-heartbeat age in seconds, or `null` when unreadable;
 * `null` fails open (treated as stale) so a genuinely hung run whose
 * heartbeat file vanished is still flagged. Omitting it (legacy 2-arg call)
 * also fails open — the cross-check then degrades to the per-turn-only
 * behaviour rather than silently suppressing the signal.
 */
export function detectStalledDispatch(
  live: LiveRunView | null,
  thresholds: AutopilotHealthThresholds,
  osHbAgeS: number | null = null,
): StuckSignal[] {
  if (!live) return [];
  if (toStr(live.status) !== "running") return [];

  const ageS = toNum(live.age_s);
  if (ageS < thresholds.stalledDispatchAgeS) return [];

  // #1091: a fresh OS heartbeat means the control loop is alive even though
  // the per-turn heartbeat lags during a long turn — not a stall.
  if (!isOsHeartbeatStale(osHbAgeS, thresholds.stalledDispatchAgeS)) return [];

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
        osHeartbeatAgeSeconds: osHbAgeS, // null = OS heartbeat unreadable (failed open to stale)
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
// non-trivial yet NOTHING landed, the autopilot may be burning capacity
// without delivering.
//
// CRITICAL (issue #924): per-run `merged_count` is NOT a delivery proxy. CI is
// the async merge gate, so a dispatch opens a PR that merges minutes-to-hours
// later — almost always after the dispatching run has ended (and short-lived
// runs terminate before CI even resolves, leaving every outcome `pending`).
// So per-run `merged_count` is structurally ~0 regardless of real delivery,
// which made this heuristic cry wolf whenever runs are short-lived. We now
// cross-check `realMergesInWindow` — actual master merges over the same span —
// and suppress the signal entirely when real merges landed. The heuristic only
// fires for the genuine case: dispatches accumulating with zero real merges
// ANYWHERE (per-run AND out-of-band).
// ---------------------------------------------------------------------------

export function detectUnproductiveLoops(
  history: RunDigest[],
  thresholds: AutopilotHealthThresholds,
  realMergesInWindow = 0,
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
  // Productive if anything landed per-run OR out-of-band (real master merges in
  // the window). Only flag a window with zero delivery on EITHER axis.
  const realMerges = Math.max(0, Math.floor(realMergesInWindow));
  if (merged > 0 || realMerges > 0) return [];

  const failRatio = dispatches > 0 ? failed / dispatches : 0;
  const severity: StuckSignalSeverity =
    failRatio >= thresholds.unproductiveCriticalFailRatio ? "critical" : "warn";

  return [
    {
      type: "unproductive-loop",
      severity,
      summary: `Across the last ${history.length} runs, ${dispatches} dispatch(es) landed 0 merges (${failed} failed, 0 real master merges in the window) — autopilot is looping without progress.`,
      evidence: {
        windowRuns: history.length,
        runsWithDispatch,
        dispatches,
        merged,
        realMergesInWindow: realMerges,
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

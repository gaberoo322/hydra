/**
 * Scheduler status projection (extracted from `heartbeat.ts`, issue #2974).
 *
 * The single place that assembles the `getStatus()` response shape from an
 * in-memory `SchedulerStateSnapshot` plus pre-computed rolling rates. Pure
 * projection logic with only advisory Redis reads (autopilot-pause,
 * reconciler-health) that fail safe — no timer lifecycle, no mutable state.
 *
 * Extracted from the 924-line `heartbeat.ts` so the projection concern is an
 * independently navigable, testable module (issue #2935 first made
 * `buildSchedulerStatus` a free function; #2974 lifts it + its types into a
 * sibling file). `heartbeat.ts` re-exports `SchedulerStatus`,
 * `StatusProjectionDeps`, `SchedulerStateSnapshot`, and `buildSchedulerStatus`
 * so every existing import path stays zero-diff.
 */

import { getAutopilotPaused } from "../redis/autopilot-pause.ts";
import { getReconcilerHealth } from "../redis/reconciler.ts";
import type { ReconcilerHealthRecord } from "../redis/reconciler.ts";
import { getIndexerErrorStats } from "../knowledge-base/indexer-stats.ts";

// ---------------------------------------------------------------------------
// Duration formatter — used by buildSchedulerStatus (below) and by the
// controller's start() result in heartbeat.ts (re-exported from here).
// ---------------------------------------------------------------------------

export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3600_000).toFixed(1)}h`;
}

// ---------------------------------------------------------------------------
// SchedulerStatus — the named return type of getStatus() (issue #2935)
//
// Before this type existed, every caller read `getStatus()` without
// compile-time enforcement of which fields are present. A field rename (e.g.
// `cyclesMerged` → `mergeCount`) was silently a runtime gap across all five
// call sites. The `SchedulerStatus` interface makes the contract explicit so
// a rename is a compile error at every call site, not a silent miss.
// ---------------------------------------------------------------------------

/**
 * The named return type of `getStatus()` / `buildSchedulerStatus()`.
 *
 * Export this type from the module so callers (src/api/scheduler.ts,
 * src/api/now-page.ts, src/autopilot/status.ts, src/api/recommendations.ts,
 * src/health/fan-out.ts) can reference the exact shape without re-deriving it
 * from an untyped `Record<string, any>` return. A field rename in this
 * interface is a compile error at all five call sites (issue #2935 AC1).
 */
export interface SchedulerStatus {
  // --- Advisory cross-subsystem reads (issue #988, #2057) ---
  /** Merge→done reconciler last-run health. null when no run recorded yet. */
  reconciler: ReconcilerHealthRecord | null;
  /** Autopilot-pause state. {paused:false} by default; {paused:true, since} when paused. */
  autopilotPause: { paused: boolean; since?: number };

  // --- Lifecycle counters (sourced from HeartbeatState) ---
  running: boolean;
  /** Why the scheduler is stopped. null when running or when start() was the last action. */
  stopReason: "deliberate" | "circuit-breaker" | "error-cap" | null;
  deliberateStoppedAt: string | null;
  intervalMs: number;
  intervalHuman: string | null;
  cyclesRun: number;
  cyclesMerged: number;
  cyclesFailed: number;
  /** Cycles whose status was in neither MERGED_STATUSES nor FAILED_STATUSES (issue #1919). */
  cyclesUnaccounted: number;

  // --- Rolling merge rate (issue #232) ---
  mergeRate: number;
  mergeRateWindow: number;
  mergeRateCyclesInWindow: number;

  // --- Rolling empty-cycle rate (issue #2818) ---
  emptyRate: number | null;
  emptyRateWindow: number;
  emptyRateCyclesInWindow: number;

  // --- Lifetime ratio (audit/debug only — do not drive alerts) ---
  mergeRateLifetime: number;

  // --- Indexer observability (issue #2658) ---
  indexerErrors: number;
  indexerRetries: number;

  // --- Heartbeat liveness (issue #397) ---
  lastTickAt: string | null;
  lastError: string | null;
  startedAt: string | null;
  consecutiveErrors: number;
}

/**
 * The advisory cross-subsystem readers consumed only by the status-projection
 * path (not the timer lifecycle). Separated from `HeartbeatControllerDeps` as
 * a named interface so `buildSchedulerStatus` can be called without
 * constructing a full `HeartbeatController` — tests exercise the projection
 * logic directly (issue #2935 AC2).
 *
 * These deps have no effect on `start()` / `stop()` / `runScheduledCycle()` —
 * they are status-projection concerns sharing the constructor historically
 * only because `getStatus()` was a class method.
 */
export interface StatusProjectionDeps {
  getAutopilotPaused?: () => Promise<{ paused: boolean; since?: number }>;
  getReconcilerHealth?: () => Promise<ReconcilerHealthRecord | null>;
}

/**
 * The in-memory state fields that `buildSchedulerStatus` reads from
 * `HeartbeatState`. Declared as a separate interface so the free function can
 * accept a plain struct in tests — no full `HeartbeatController` required.
 */
export interface SchedulerStateSnapshot {
  running: boolean;
  stopReason: "deliberate" | "circuit-breaker" | "error-cap" | null;
  deliberateStoppedAt: string | null;
  intervalMs: number;
  cyclesRun: number;
  cyclesMerged: number;
  cyclesFailed: number;
  cyclesUnaccounted: number;
  lastTickAt: string | null;
  lastError: string | null;
  startedAt: string | null;
  consecutiveErrors: number;
}

/**
 * Compose the `SchedulerStatus` projection from the in-memory state snapshot
 * and pre-computed rate data, plus the advisory cross-subsystem readers.
 *
 * This is the single place that assembles the `getStatus()` response shape.
 * Extracting it as a free function (issue #2935):
 *
 * - Makes the contract compiler-enforced: the return type is `SchedulerStatus`,
 *   so a field rename at the declaration site is a compile error at all 5
 *   call sites that destructure or assign the result.
 * - Lets a test exercise the projection without constructing a full
 *   `HeartbeatController` with all 13 deps — inject a plain `SchedulerStateSnapshot`
 *   and deterministic rate stubs, and the test covers the field-assembly
 *   logic with no Redis and no timer fixture.
 * - Separates the advisory cross-subsystem reads (autopilotPause, reconciler)
 *   from the timer-lifecycle concerns structurally: they live in
 *   `StatusProjectionDeps`, not `HeartbeatControllerDeps`.
 *
 * Production callers: `HeartbeatController.getStatus()` is the only caller.
 * The module-level `getStatus` delegator returns `Promise<SchedulerStatus>`.
 *
 * @param state - In-memory lifecycle counters from `HeartbeatState`.
 * @param rates - Pre-computed rolling rates (merge + empty).
 * @param deps  - Advisory readers. Defaults to the real Redis-backed readers.
 */
export async function buildSchedulerStatus(
  state: SchedulerStateSnapshot,
  rates: {
    rolling: { mergeRate: number | null; cyclesInWindow: number };
    emptyRolling: { emptyRate: number | null; cyclesInWindow: number };
    mergeRateWindow: number;
    emptyRateWindow: number;
  },
  deps: StatusProjectionDeps = {},
): Promise<SchedulerStatus> {
  const resolveAutopilotPaused = deps.getAutopilotPaused ?? getAutopilotPaused;
  const resolveReconcilerHealth = deps.getReconcilerHealth ?? getReconcilerHealth;

  const lifetimeMergeRate = state.cyclesRun > 0
    ? Math.round((state.cyclesMerged / state.cyclesRun) * 100)
    : 0;
  const mergeRate = rates.rolling.mergeRate ?? lifetimeMergeRate;

  // Advisory reads — fail safe (log, never propagate to callers).
  let autopilotPause: { paused: boolean; since?: number } = { paused: false };
  try {
    autopilotPause = await resolveAutopilotPaused();
  } catch (err: any) {
    console.error(`[Heartbeat] getStatus autopilot-pause read failed: ${err?.message ?? err}`);
  }

  let reconciler: ReconcilerHealthRecord | null = null;
  try {
    reconciler = await resolveReconcilerHealth();
  } catch (err: any) {
    console.error(`[Heartbeat] getStatus reconciler-health read failed: ${err?.message ?? err}`);
  }

  const { indexerErrors, indexerRetries } = getIndexerErrorStats();

  return {
    reconciler,
    running: state.running,
    autopilotPause,
    stopReason: state.stopReason,
    deliberateStoppedAt: state.deliberateStoppedAt,
    intervalMs: state.intervalMs,
    intervalHuman: state.intervalMs ? formatDuration(state.intervalMs) : null,
    cyclesRun: state.cyclesRun,
    cyclesMerged: state.cyclesMerged,
    cyclesFailed: state.cyclesFailed,
    cyclesUnaccounted: state.cyclesUnaccounted,
    mergeRate,
    mergeRateWindow: rates.mergeRateWindow,
    mergeRateCyclesInWindow: rates.rolling.cyclesInWindow,
    emptyRate: rates.emptyRolling.emptyRate,
    emptyRateWindow: rates.emptyRateWindow,
    emptyRateCyclesInWindow: rates.emptyRolling.cyclesInWindow,
    mergeRateLifetime: lifetimeMergeRate,
    indexerErrors,
    indexerRetries,
    lastTickAt: state.lastTickAt,
    lastError: state.lastError,
    startedAt: state.startedAt,
    consecutiveErrors: state.consecutiveErrors,
  };
}

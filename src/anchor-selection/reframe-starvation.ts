// ---------------------------------------------------------------------------
// Reframe-starvation instrumentation + capacity floor (issue #377)
// ---------------------------------------------------------------------------
//
// Background
//   The reframe lane (priority 9 in CLAUDE.md) is supposed to absorb tasks
//   that have been abandoned or have failed repeatedly so the planner gets a
//   fresh diagnostic prompt instead of looping forever. In the 50-cycle
//   window measured for issue #377 it served only 2 cycles against 17
//   abandonments + 2 failures — call it ~4%, when ~38% of cycles produced
//   candidates eligible for reframing.
//
//   The cause is symmetric to issue #301 for specs: the reframe tier sits
//   below the kanban queued lane, the work queue, failing-tests, and active
//   specs in the priority chain. Whenever any higher-priority lane has
//   something to serve, reframe is shadowed indefinitely. The
//   `REFRAME_INTERLEAVE_INTERVAL` constant has been declared since 2025 but
//   never had a consumer.
//
// What this module does (mirrors spec-starvation.ts deliberately)
//   1. Records the *reason* the reframe tier was passed over each cycle:
//        kanban_won           — kanban claim returned an item
//        no_reframe_candidate — reframe queue is empty
//        wip_full             — WIP limit reached, reframe tier skipped
//        spec_won             — specs floor (or non-floor selection) won
//                                (legacy enum value — specs retired in #513)
//        failing_tests_won    — grounding had failing tests
//        work_queue_won       — work-queue tier served an item
//        prior_failure_won    — prior-failure tier served an item
//        regression_hunt_won  — regression-hunt tier served
//        codebase_health_won  — codebase-health tier served
//        priorities_doc_won   — fell back to priorities doc
//        drift_duplicate      — head item was a drift duplicate (popped, dropped)
//        corrupt_item         — head item was corrupt JSON (popped, dropped)
//        force_floor          — bookkeeping marker for "we forced reframe this
//                                cycle" (not a starvation reason — recorded
//                                for symmetry with spec-starvation)
//   2. Maintains a "cycles since reframe last served" gauge.
//   3. Exposes a pure predicate `shouldForceReframePriority()` so the
//      capacity-floor dispatcher can pre-empt kanban once the floor cadence
//      has elapsed AND the reframe queue actually has work.
//
// The capacity-floor cadence is operator-tunable via env var; default = 5
// cycles (matching the unused-since-2025 `REFRAME_INTERLEAVE_INTERVAL`
// constant). Rationale: with the same kind of 20-cycle window used for
// specs (#301) the reframe tier won 0..2 times; floor(20 / 5) = 4 guarantees
// a meaningful walk-rate without crowding out the kanban lane.
//
// NOT WIP-gated. A reframe item represents a task that already passed
// through abandonment / repeat-failure — bypassing the WIP cap matches the
// "fixes proceed even when full" semantics in select.ts where failing-test
// and prior-failure tiers also bypass WIP.

import {
  hashIncrBy,
  hashGetAll,
  incrKey,
  delKey,
  setString,
  getString,
} from "../redis-adapter.ts";
import { redisKeys } from "../redis-keys.ts";

export type ReframePassedReason =
  | "kanban_won"
  | "no_reframe_candidate"
  | "wip_full"
  | "spec_won"
  | "failing_tests_won"
  | "work_queue_won"
  | "prior_failure_won"
  | "regression_hunt_won"
  | "codebase_health_won"
  | "priorities_doc_won"
  | "drift_duplicate"
  | "corrupt_item"
  | "force_floor";

/** Default capacity-floor cadence. Every Nth eligible cycle, force the
 *  reframe tier ahead of kanban. Tunable via HYDRA_REFRAME_FLOOR_N.
 *  Matches the existing REFRAME_INTERLEAVE_INTERVAL constant. */
export const DEFAULT_REFRAME_FLOOR_N = 5;

/** Read the configured floor cadence with safe bounds. Negative/zero/NaN ⇒
 *  default. >100 is treated as "effectively disabled" but still numeric so
 *  the counter logic stays well-defined. */
export function getReframeFloorN(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.HYDRA_REFRAME_FLOOR_N;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_REFRAME_FLOOR_N;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_REFRAME_FLOOR_N;
  return n;
}

/**
 * Pure predicate: should the next cycle pre-empt kanban with the reframe tier?
 *
 * Returns true iff a reframe candidate is available AND cyclesSinceServed >=
 * floorN. `cyclesSinceServed` is the value *before* this cycle records its
 * outcome, so floorN=5 means: cycles 1..4 record kanban_won (or whatever
 * other reason); cycle 5 forces reframe.
 */
export function shouldForceReframePriority(
  cyclesSinceServed: number,
  hasReframeCandidate: boolean,
  floorN: number = DEFAULT_REFRAME_FLOOR_N,
): boolean {
  if (!hasReframeCandidate) return false;
  if (!Number.isFinite(floorN) || floorN <= 0) return false;
  return cyclesSinceServed >= floorN;
}

/**
 * Record that the reframe tier was passed over this cycle, with the reason.
 * Increments the per-reason counter AND the cycles-since-served gauge.
 *
 * Fail-soft: any Redis error is logged but does not throw. Instrumentation
 * is best-effort; never block anchor selection on a metrics write.
 */
export async function recordReframePassedReason(reason: ReframePassedReason): Promise<void> {
  try {
    await hashIncrBy(redisKeys.anchorReframePassedReasons(), reason, 1);
    // The "force_floor" path is recorded for parity but does NOT advance the
    // cycles-since-served gauge — that's reset by recordReframeServed().
    if (reason !== "force_floor") {
      await incrKey(redisKeys.anchorReframeCyclesSinceServed());
    }
  } catch (err: any) {
    console.error(`[ReframeStarvation] recordReframePassedReason(${reason}) failed: ${err.message}`);
  }
}

/**
 * Record that a reframe task was actually selected as the anchor this cycle.
 * Resets the cycles-since-served gauge and stamps the last-served timestamp.
 */
export async function recordReframeServed(): Promise<void> {
  try {
    await delKey(redisKeys.anchorReframeCyclesSinceServed());
    await setString(redisKeys.anchorReframeLastServedAt(), new Date().toISOString());
  } catch (err: any) {
    console.error(`[ReframeStarvation] recordReframeServed failed: ${err.message}`);
  }
}

/**
 * Read the current "cycles since reframe last served" gauge. Returns 0 when
 * the key is absent (i.e. just-reset or never-recorded).
 */
export async function getCyclesSinceReframeServed(): Promise<number> {
  try {
    const raw = await getString(redisKeys.anchorReframeCyclesSinceServed());
    if (raw === null || raw === undefined) return 0;
    const n = parseInt(String(raw), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch (err: any) {
    console.error(`[ReframeStarvation] getCyclesSinceReframeServed failed: ${err.message}`);
    return 0;
  }
}

export interface ReframeStarvationStats {
  cyclesSinceServed: number;
  lastServedAt: string | null;
  reasons: Record<string, number>;
  floorN: number;
}

/**
 * Aggregate read for the API surface. Surfaces:
 *   - cyclesSinceServed: the live gauge
 *   - lastServedAt: ISO timestamp or null
 *   - reasons: per-reason counter dict
 *   - floorN: the configured capacity-floor cadence
 */
export async function getReframeStarvationStats(): Promise<ReframeStarvationStats> {
  const [cyclesSinceServed, lastServedAt, reasonsHash] = await Promise.all([
    getCyclesSinceReframeServed(),
    getString(redisKeys.anchorReframeLastServedAt()).catch(() => null),
    hashGetAll(redisKeys.anchorReframePassedReasons()).catch(() => ({})),
  ]);
  const reasons: Record<string, number> = {};
  for (const [k, v] of Object.entries(reasonsHash || {})) {
    const n = parseInt(String(v), 10);
    reasons[k] = Number.isFinite(n) ? n : 0;
  }
  return {
    cyclesSinceServed,
    lastServedAt: lastServedAt || null,
    reasons,
    floorN: getReframeFloorN(),
  };
}

/**
 * Test-only: wipe all starvation counters. Used by regression tests to
 * isolate behaviour between cases.
 */
export async function _resetReframeStarvationForTests(): Promise<void> {
  await delKey(redisKeys.anchorReframePassedReasons());
  await delKey(redisKeys.anchorReframeCyclesSinceServed());
  await delKey(redisKeys.anchorReframeLastServedAt());
}

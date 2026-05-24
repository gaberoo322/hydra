// ---------------------------------------------------------------------------
// Reframe Queue — failed-task retry lane (issues #57, #233, #288, #377)
// ---------------------------------------------------------------------------
//
// One module for the Reframe Queue's full lifecycle:
//
//   - Maintenance: prune stale (>7d) and overflow (>cap) items.
//   - Selection: pop the head item, drift-filter it, return as anchor.
//   - Fairness: track cycles-since-served + the reason every passed-over
//     cycle picked something else, so a capacity floor can pre-empt
//     kanban once the realised share dips below the configured cadence.
//
// Background (combined from the three predecessor files):
//
//   1. The reframe lane sits below kanban / work queue / failing-tests in
//      the priority chain. Whenever any higher-priority lane has work,
//      reframe is shadowed indefinitely — in the 50-cycle window measured
//      for #377 it served only 2 cycles against 17 abandonments + 2
//      failures (~4% realised, ~38% available). The starvation
//      instrumentation here is how `capacity-floors.ts` detects that and
//      forces reframe ahead of kanban once cyclesSinceServed >= floorN.
//
//   2. The pop path drift-filters via `drift-filter.ts` so a near-duplicate
//      of recent merged work doesn't immediately re-fail.
//
//   3. NOT WIP-gated. A reframe item represents a task that already passed
//      through abandonment / repeat-failure — bypassing the WIP cap matches
//      the "fixes proceed even when full" semantics in select.ts.

import {
  delKey,
  listLen,
  listLPop,
  listRange,
  listRPush,
} from "../redis-adapter.ts";
import {
  incrAnchorReframePassedReason,
  getAnchorReframePassedReasons,
  incrAnchorReframeCyclesSinceServed,
  resetAnchorReframeCyclesSinceServed,
  getAnchorReframeCyclesSinceServed,
  setAnchorReframeLastServedAt,
  getAnchorReframeLastServedAt,
  _resetAnchorReframeState,
} from "../redis/work-queue.ts";
import {
  REFRAME_QUEUE,
  REFRAME_QUEUE_CAP,
  REFRAME_QUEUE_MAX_AGE_MS,
} from "./constants.ts";
import { isAnchorDriftDuplicate } from "./drift-filter.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReframeAnchor {
  type: "reframe";
  reference: string;
  whyNow: string;
  context: any;
}

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

export interface ReframeStarvationStats {
  cyclesSinceServed: number;
  lastServedAt: string | null;
  reasons: Record<string, number>;
  floorN: number;
}

// ---------------------------------------------------------------------------
// Capacity-floor cadence configuration
// ---------------------------------------------------------------------------

/** Default capacity-floor cadence. Every Nth eligible cycle, force the
 *  reframe tier ahead of kanban. Tunable via HYDRA_REFRAME_FLOOR_N. */
export const DEFAULT_REFRAME_FLOOR_N = 5;

/** Read the configured floor cadence with safe bounds. Negative/zero/NaN ⇒
 *  default. */
export function getReframeFloorN(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.HYDRA_REFRAME_FLOOR_N;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_REFRAME_FLOOR_N;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_REFRAME_FLOOR_N;
  return n;
}

/**
 * Pure predicate: should the next cycle pre-empt kanban with the reframe
 * tier? Returns true iff a reframe candidate is available AND
 * cyclesSinceServed >= floorN.
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

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

/**
 * Prune stale items (older than 7 days) from the reframe queue and enforce
 * a hard cap of REFRAME_QUEUE_CAP. Oldest items beyond the cap are dropped
 * with a log entry. Called from selectAnchor() before consuming a reframe
 * item. Returns { pruned, dropped }.
 */
export async function pruneReframeQueue(): Promise<{ pruned: number; dropped: number }> {
  let pruned = 0;
  let dropped = 0;

  try {
    const all = await listRange(REFRAME_QUEUE, 0, -1);
    if (all.length === 0) return { pruned, dropped };

    const now = Date.now();
    const kept: string[] = [];

    // Pass 1: filter out items older than 7 days
    for (const raw of all) {
      try {
        const item = JSON.parse(raw);
        const escalatedAt = item.escalatedAt ? new Date(item.escalatedAt).getTime() : 0;
        if (escalatedAt > 0 && now - escalatedAt > REFRAME_QUEUE_MAX_AGE_MS) {
          pruned++;
          console.log(`[ControlLoop] Reframe queue: pruned stale item "${item.originalTitle || item.originalTaskId}" (age: ${Math.round((now - escalatedAt) / 86400000)}d)`);
          continue;
        }
      } catch (err: any) {
        // Corrupt item — drop it
        pruned++;
        console.error(`[ControlLoop] Reframe queue: dropped corrupt item: ${err.message}`);
        continue;
      }
      kept.push(raw);
    }

    // Pass 2: enforce hard cap — drop oldest items beyond cap
    if (kept.length > REFRAME_QUEUE_CAP) {
      const overflow = kept.length - REFRAME_QUEUE_CAP;
      for (let i = 0; i < overflow; i++) {
        try {
          const item = JSON.parse(kept[i]);
          console.log(`[ControlLoop] Reframe queue: dropped overflow item "${item.originalTitle || item.originalTaskId}" (queue: ${kept.length}/${REFRAME_QUEUE_CAP})`);
        } catch {
          console.log(`[ControlLoop] Reframe queue: dropped overflow item (unparseable)`);
        }
        dropped++;
      }
      kept.splice(0, overflow);
    }

    // Only rewrite the list if something changed
    if (pruned > 0 || dropped > 0) {
      await delKey(REFRAME_QUEUE);
      if (kept.length > 0) {
        await listRPush(REFRAME_QUEUE, ...kept);
      }
    }
  } catch (err: any) {
    console.error(`[ControlLoop] Reframe queue pruning failed: ${err.message}`);
  }

  return { pruned, dropped };
}

/** Current length of the reframe queue. */
export async function getReframeQueueLen(): Promise<number> {
  return listLen(REFRAME_QUEUE);
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Non-destructive readiness check used by the capacity-floor dispatcher
 * (#377). Runs queue maintenance (pruning is idempotent) and then reports
 * whether the queue has any items the consumer might try to pop.
 *
 * Drift-filtering happens at consume time, not here — a head item that
 * later turns out to be a drift duplicate is still "a candidate" for
 * floor-readiness purposes; the dispatcher's buildAnchor() handles the
 * fall-through if it can't actually produce an anchor.
 */
export async function hasReframeCandidate(): Promise<boolean> {
  try {
    await pruneReframeQueue();
  } catch (err: any) {
    console.error(`[ControlLoop] hasReframeCandidate prune failed: ${err.message}`);
  }
  try {
    const len = await listLen(REFRAME_QUEUE);
    return len > 0;
  } catch (err: any) {
    console.error(`[ControlLoop] hasReframeCandidate len failed: ${err.message}`);
    return false;
  }
}

export async function selectReframeAnchor(): Promise<ReframeAnchor | null> {
  // Prune stale (>7d) and overflow (>20) items before consuming (#57).
  try {
    const { pruned, dropped } = await pruneReframeQueue();
    if (pruned > 0 || dropped > 0) {
      console.log(`[ControlLoop] Reframe queue maintenance: pruned=${pruned}, dropped=${dropped}`);
    }
  } catch (err: any) {
    console.error(`[ControlLoop] Reframe queue maintenance failed: ${err.message}`);
  }

  const reframeItems = await listRange(REFRAME_QUEUE, 0, 0);
  if (reframeItems.length === 0) return null;

  try {
    const item = JSON.parse(reframeItems[0]);
    await listLPop(REFRAME_QUEUE);
    const candidate: ReframeAnchor = {
      type: "reframe",
      reference: item.originalTitle,
      whyNow: `Task "${item.originalTitle}" failed ${item.totalAttempts} times. Needs diagnosis and a new approach.`,
      context: item,
    };
    // Drift pre-filter (#233) — already popped, just drop & continue if a
    // near-duplicate of recent merged work.
    const driftResult = await isAnchorDriftDuplicate(candidate);
    if (driftResult.drift) {
      return null;
    }
    return candidate;
  } catch (err: any) {
    console.error(`[ControlLoop] Corrupt reframe item: ${err.message}`);
    await listLPop(REFRAME_QUEUE);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Starvation instrumentation
// ---------------------------------------------------------------------------

/**
 * Record that the reframe tier was passed over this cycle, with the reason.
 * Increments the per-reason counter AND the cycles-since-served gauge.
 *
 * Fail-soft: any Redis error is logged but does not throw. Instrumentation
 * is best-effort; never block anchor selection on a metrics write.
 */
export async function recordReframePassedReason(reason: ReframePassedReason): Promise<void> {
  try {
    await incrAnchorReframePassedReason(reason);
    // The "force_floor" path is recorded for parity but does NOT advance the
    // cycles-since-served gauge — that's reset by recordReframeServed().
    if (reason !== "force_floor") {
      await incrAnchorReframeCyclesSinceServed();
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
    await resetAnchorReframeCyclesSinceServed();
    await setAnchorReframeLastServedAt(new Date().toISOString());
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
    const raw = await getAnchorReframeCyclesSinceServed();
    if (raw === null || raw === undefined) return 0;
    const n = parseInt(String(raw), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch (err: any) {
    console.error(`[ReframeStarvation] getCyclesSinceReframeServed failed: ${err.message}`);
    return 0;
  }
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
    getAnchorReframeLastServedAt().catch(() => null),
    getAnchorReframePassedReasons().catch(() => ({})),
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
  await _resetAnchorReframeState();
}

// ---------------------------------------------------------------------------
// Spec-starvation instrumentation + capacity floor (issue #301)
// ---------------------------------------------------------------------------
//
// Background
//   The active-specs tier (priority 4 in CLAUDE.md) was being indefinitely
//   shadowed by the kanban queued lane (priority 3) and the stuckness-driven
//   research tier (priority 2). 12 active specs sat at 0/N tasks complete
//   while the system was happily pulling kanban work. The CLAUDE.md priority
//   chart claimed specs were #4 but in practice they were #∞.
//
// What this module does
//   1. Records the *reason* the spec tier is being passed over each cycle:
//        kanban_won       — kanban claim returned an item
//        no_active_spec   — no active spec has unchecked tasks
//        wip_full         — WIP limit reached, spec tier skipped
//        stuckness_won    — stuckness-driven research short-circuited
//        force_floor      — bookkeeping marker for "we forced a spec this cycle"
//                            (not a starvation reason — recorded for symmetry)
//   2. Maintains a "cycles since spec last served" gauge.
//   3. Exposes a pure predicate `shouldForceSpecPriority()` so the selector
//      can pre-empt kanban once the floor cadence has elapsed AND a spec task
//      is actually available.
//
// The capacity-floor cadence is operator-tunable via env var; default = 3
// cycles. Rationale: in the historical 20-cycle window the spec tier won 0
// times; the floor guarantees floor((window) / N) >= 1 spec selection per
// window, which is the minimum needed to satisfy the issue #301 acceptance
// criterion ">=1/N task progress within 48h".
//
// NOT WIP-gated. Specs already bypass WIP — they represent committed
// multi-cycle plans, not new pulls.

import {
  hashIncrBy,
  hashGetAll,
  incrKey,
  delKey,
  setString,
  getString,
} from "../redis-adapter.ts";
import { redisKeys } from "../redis-keys.ts";

export type SpecPassedReason =
  | "kanban_won"
  | "no_active_spec"
  | "wip_full"
  | "stuckness_won"
  | "all_tasks_blocked"
  | "force_floor";

/** Default capacity-floor cadence. Every Nth eligible cycle, force the spec
 *  tier ahead of kanban. Tunable via HYDRA_SPEC_CAPACITY_FLOOR_N. */
export const DEFAULT_SPEC_CAPACITY_FLOOR_N = 3;

/** Read the configured floor cadence with safe bounds. Negative/zero/NaN ⇒
 *  default. >100 is treated as "effectively disabled" but still numeric so
 *  the counter logic stays well-defined. */
export function getSpecCapacityFloorN(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.HYDRA_SPEC_CAPACITY_FLOOR_N;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_SPEC_CAPACITY_FLOOR_N;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SPEC_CAPACITY_FLOOR_N;
  return n;
}

/**
 * Pure predicate: should the next cycle pre-empt kanban with the spec tier?
 *
 * Returns true iff a spec task is available AND cyclesSinceServed >= floorN.
 * `cyclesSinceServed` is the value *before* this cycle records its outcome,
 * so floorN=3 means: cycles 1,2 record kanban_won; cycle 3 forces spec.
 */
export function shouldForceSpecPriority(
  cyclesSinceServed: number,
  hasSpecTask: boolean,
  floorN: number = DEFAULT_SPEC_CAPACITY_FLOOR_N,
): boolean {
  if (!hasSpecTask) return false;
  if (!Number.isFinite(floorN) || floorN <= 0) return false;
  return cyclesSinceServed >= floorN;
}

/**
 * Record that the spec tier was passed over this cycle, with the reason.
 * Increments the per-reason counter AND the cycles-since-served gauge.
 *
 * Fail-soft: any Redis error is logged but does not throw. Instrumentation
 * is best-effort; never block anchor selection on a metrics write.
 */
export async function recordSpecPassedReason(reason: SpecPassedReason): Promise<void> {
  try {
    await hashIncrBy(redisKeys.specsPassedReasons(), reason, 1);
    // The "force_floor" path is recorded for parity but does NOT advance the
    // cycles-since-served gauge — that's reset by recordSpecServed().
    if (reason !== "force_floor") {
      await incrKey(redisKeys.specsCyclesSinceServed());
    }
  } catch (err: any) {
    console.error(`[SpecStarvation] recordSpecPassedReason(${reason}) failed: ${err.message}`);
  }
}

/**
 * Record that a spec task was actually selected as the anchor this cycle.
 * Resets the cycles-since-served gauge and stamps the last-served timestamp.
 */
export async function recordSpecServed(): Promise<void> {
  try {
    await delKey(redisKeys.specsCyclesSinceServed());
    await setString(redisKeys.specsLastServedAt(), new Date().toISOString());
  } catch (err: any) {
    console.error(`[SpecStarvation] recordSpecServed failed: ${err.message}`);
  }
}

/**
 * Read the current "cycles since spec last served" gauge. Returns 0 when
 * the key is absent (i.e. just-reset or never-recorded).
 */
export async function getCyclesSinceSpecServed(): Promise<number> {
  try {
    const raw = await getString(redisKeys.specsCyclesSinceServed());
    if (raw === null || raw === undefined) return 0;
    const n = parseInt(String(raw), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch (err: any) {
    console.error(`[SpecStarvation] getCyclesSinceSpecServed failed: ${err.message}`);
    return 0;
  }
}

export interface SpecStarvationStats {
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
export async function getSpecStarvationStats(): Promise<SpecStarvationStats> {
  const [cyclesSinceServed, lastServedAt, reasonsHash] = await Promise.all([
    getCyclesSinceSpecServed(),
    getString(redisKeys.specsLastServedAt()).catch(() => null),
    hashGetAll(redisKeys.specsPassedReasons()).catch(() => ({})),
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
    floorN: getSpecCapacityFloorN(),
  };
}

/**
 * Test-only: wipe all starvation counters. Used by regression tests to
 * isolate behaviour between cases.
 */
export async function _resetSpecStarvationForTests(): Promise<void> {
  await delKey(redisKeys.specsPassedReasons());
  await delKey(redisKeys.specsCyclesSinceServed());
  await delKey(redisKeys.specsLastServedAt());
}

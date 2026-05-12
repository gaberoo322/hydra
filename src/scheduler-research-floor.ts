// ---------------------------------------------------------------------------
// Research capacity floor (issue #327)
// ---------------------------------------------------------------------------
//
// Background
//   The scheduler has a `buildRatioMax` ceiling (default 3) that caps research
//   from above — once 24h research cycles exceed 3x the 24h build count, new
//   research is suppressed. But there was no symmetric floor protecting research
//   from being out-competed by an always-full build lane.
//
//   In production the 20-cycle anchor distribution went to {user-request: 19,
//   research: 1} with researchCount24h=1 / buildCount24h=125 (ratio 0.008 vs
//   max 3.0). The research lane only fired when the 2h minimum interval
//   expired AND the queue was nearly empty AND no higher-priority work was
//   available. Architecture review 2026-05-11 flagged it as starvation.
//
//   This is structurally the sibling of #245 (25% self-improvement capacity
//   floor) and #308 (spec capacity-floor pre-emption). The pattern is well
//   established: track a "cycles since last served" gauge and, when the
//   natural rate falls below a configured minimum, force a serve regardless
//   of the always-full competing lane.
//
// What this module does
//   1. Exposes `shouldForceResearchFloor()` — a pure predicate that the
//      scheduler's `maybeRunResearch()` consults *after* the existing queue
//      and ratio-cap checks. If the predicate returns true, the scheduler
//      runs research even though the suppression checks would normally skip.
//   2. Tracks how often the floor fires (`recordResearchFloorTriggered`)
//      vs natural fires, surfaced via `getResearchFloorStats()`.
//   3. Maintains a "twice-empty research" suppression window so a floor-forced
//      research cycle that returns no new opportunities twice in a row disables
//      the floor for 24h (prevents pathological forced empty cycles).
//
// Safety
//   - The floor NEVER bypasses the daily research cost cap (DAILY_COST_CAP_USD).
//   - The floor NEVER bypasses the minimum-interval throttle (`atomicClaimResearch`).
//     The intent is to override queue-depth and ratio-cap suppression only.
//   - Operator-explicit anchors (`opts.anchor`) sidestep the scheduler entirely
//     and reach `runControlLoop` directly, so the floor never competes with them.
//
// Defaults
//   - HYDRA_RESEARCH_BUILD_RATIO_MIN = 0.05  (1 research per 20 builds)
//   - HYDRA_RESEARCH_FLOOR_WINDOW    = 20    (build cycles to look back over)
//   - HYDRA_RESEARCH_FLOOR_EMPTY_SUPPRESS_MS = 24h
//
// Acceptance criteria mapping (issue #327)
//   - [x] `buildRatioMin` config + default 1/20 ........ `getResearchBuildRatioMin`
//   - [x] Force research when last-20 builds + 0 research + minInterval elapsed
//                                                       `shouldForceResearchFloor`
//   - [x] Surfaced on /api/scheduler/status ............. wiring in scheduler.ts
//   - [x] Log "research floor fired: <reason>" .......... wiring in scheduler.ts
//   - [x] Per-cycle telemetry `researchFloorTriggered` .. wiring in scheduler.ts
//   - [x] Forced research-empty-twice → 24h suppression . `markResearchFloorEmpty`
//   - [x] Never overrides daily cost cap ................ wiring in scheduler.ts
//   - [x] Doc the new priority interaction in CLAUDE.md . separate edit
// ---------------------------------------------------------------------------

import {
  hashIncrBy,
  hashGetAll,
  setString,
  getString,
  delKey,
} from "./redis-adapter.ts";
import { redisKeys } from "./redis-keys.ts";

/** Default minimum research:build ratio over the rolling 24h window.
 *  0.05 == 1 research per 20 builds. */
export const DEFAULT_RESEARCH_BUILD_RATIO_MIN = 1 / 20;

/** Default "build cycles to look back over" for the floor decision. The
 *  predicate fires when `buildCount24h >= floorWindow && researchCount24h == 0`,
 *  i.e. at least `floorWindow` builds have happened in 24h with zero research. */
export const DEFAULT_RESEARCH_FLOOR_WINDOW = 20;

/** Suppression window after the forced research cycle returns no new
 *  opportunities twice in a row. Default 24h. */
export const DEFAULT_RESEARCH_FLOOR_EMPTY_SUPPRESS_MS = 24 * 60 * 60 * 1000;

/** How many consecutive "no opportunities" results trigger the suppression. */
export const RESEARCH_FLOOR_EMPTY_STREAK_THRESHOLD = 2;

/** Read the configured floor ratio with safe bounds. Negative/zero/NaN/>1 ⇒
 *  default. The semantics are "minimum acceptable ratio" — values outside
 *  (0, 1] don't make sense (research would have to exceed builds to satisfy
 *  ratio > 1, which the ratioMax ceiling already disallows). */
export function getResearchBuildRatioMin(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.HYDRA_RESEARCH_BUILD_RATIO_MIN;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_RESEARCH_BUILD_RATIO_MIN;
  const n = parseFloat(String(raw));
  if (!Number.isFinite(n) || n <= 0 || n > 1) return DEFAULT_RESEARCH_BUILD_RATIO_MIN;
  return n;
}

/** Read the configured floor build-count window. Negative/zero/NaN ⇒ default. */
export function getResearchFloorWindow(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.HYDRA_RESEARCH_FLOOR_WINDOW;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_RESEARCH_FLOOR_WINDOW;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RESEARCH_FLOOR_WINDOW;
  return n;
}

/** Read the configured "empty research" suppression window in ms. */
export function getResearchFloorEmptySuppressMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.HYDRA_RESEARCH_FLOOR_EMPTY_SUPPRESS_MS;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_RESEARCH_FLOOR_EMPTY_SUPPRESS_MS;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RESEARCH_FLOOR_EMPTY_SUPPRESS_MS;
  return n;
}

export type FloorDecision = {
  shouldFire: boolean;
  reason: string;
};

/**
 * Pure predicate: should the next scheduler tick force a research cycle to
 * satisfy the capacity floor?
 *
 * Fires when ALL of:
 *   - At least `floorWindow` builds have happened in the rolling 24h window
 *   - The realised research:build ratio is BELOW the minimum
 *   - The "empty research" suppression window is not active
 *
 * The minimum-interval throttle and the daily cost cap are checked separately
 * by the caller; this predicate is concerned only with the ratio policy.
 *
 * The reason string is structured for log + telemetry: callers log it verbatim
 * as `[Scheduler] research floor fired: <reason>` per acceptance criterion.
 */
export function shouldForceResearchFloor(args: {
  researchCount24h: number;
  buildCount24h: number;
  ratioMin?: number;
  floorWindow?: number;
  suppressedUntilMs?: number | null;
  nowMs?: number;
}): FloorDecision {
  const ratioMin = args.ratioMin ?? DEFAULT_RESEARCH_BUILD_RATIO_MIN;
  const floorWindow = args.floorWindow ?? DEFAULT_RESEARCH_FLOOR_WINDOW;
  const nowMs = args.nowMs ?? Date.now();
  const suppressedUntilMs = args.suppressedUntilMs ?? 0;

  if (suppressedUntilMs && nowMs < suppressedUntilMs) {
    const remainingMs = suppressedUntilMs - nowMs;
    return {
      shouldFire: false,
      reason: `research floor suppressed for ${Math.round(remainingMs / 60_000)}min — prior forced cycles returned no new opportunities`,
    };
  }

  if (args.buildCount24h < floorWindow) {
    return {
      shouldFire: false,
      reason: `not enough builds yet (${args.buildCount24h} < ${floorWindow})`,
    };
  }

  // Compare realised ratio against the configured minimum. We treat
  // buildCount24h > 0 (guaranteed by the previous check) so the divide is safe.
  const ratio = args.researchCount24h / args.buildCount24h;
  if (ratio >= ratioMin) {
    return {
      shouldFire: false,
      reason: `natural ratio ${ratio.toFixed(3)} >= floor ${ratioMin.toFixed(3)}`,
    };
  }

  return {
    shouldFire: true,
    reason: `ratio ${ratio.toFixed(3)} < floor ${ratioMin.toFixed(3)} over ${args.buildCount24h} builds / ${args.researchCount24h} research in 24h`,
  };
}

// ---------------------------------------------------------------------------
// Redis-backed counters / state
// ---------------------------------------------------------------------------

/** Increment the "this floor fire returned no new opportunities" counter and
 *  return the new streak length. If the streak reaches the threshold, the
 *  caller should set a suppression window via `setResearchFloorSuppressedUntilMs`. */
export async function incrResearchFloorEmptyStreak(): Promise<number> {
  try {
    const key = redisKeys.researchFloorEmptyStreak();
    const cur = await getString(key);
    const next = (cur ? parseInt(cur, 10) : 0) + 1;
    // No TTL — the counter is reset explicitly by a successful (non-empty)
    // forced research cycle, or implicitly when the suppression expires.
    await setString(key, String(next));
    return next;
  } catch (err: any) {
    console.error(`[ResearchFloor] incrResearchFloorEmptyStreak failed: ${err.message}`);
    return 0;
  }
}

/** Reset the empty-streak counter (called when a forced research cycle does
 *  queue new opportunities). */
export async function resetResearchFloorEmptyStreak(): Promise<void> {
  try {
    await delKey(redisKeys.researchFloorEmptyStreak());
  } catch (err: any) {
    console.error(`[ResearchFloor] resetResearchFloorEmptyStreak failed: ${err.message}`);
  }
}

/** Read the current empty-streak length. */
export async function getResearchFloorEmptyStreak(): Promise<number> {
  try {
    const raw = await getString(redisKeys.researchFloorEmptyStreak());
    if (!raw) return 0;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch (err: any) {
    console.error(`[ResearchFloor] getResearchFloorEmptyStreak failed: ${err.message}`);
    return 0;
  }
}

/** Set the suppression deadline (epoch ms). */
export async function setResearchFloorSuppressedUntilMs(deadlineMs: number): Promise<void> {
  try {
    await setString(redisKeys.researchFloorSuppressedUntil(), String(deadlineMs));
  } catch (err: any) {
    console.error(`[ResearchFloor] setResearchFloorSuppressedUntilMs failed: ${err.message}`);
  }
}

/** Read the suppression deadline (epoch ms) or null when unset / expired. */
export async function getResearchFloorSuppressedUntilMs(): Promise<number | null> {
  try {
    const raw = await getString(redisKeys.researchFloorSuppressedUntil());
    if (!raw) return null;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return null;
    if (n < Date.now()) {
      // Expired — clean up so /status doesn't surface stale values.
      try { await delKey(redisKeys.researchFloorSuppressedUntil()); }
      catch { /* intentional: best-effort cleanup */ }
      return null;
    }
    return n;
  } catch (err: any) {
    console.error(`[ResearchFloor] getResearchFloorSuppressedUntilMs failed: ${err.message}`);
    return null;
  }
}

/** Bump per-reason counters when the floor fires (or is suppressed). */
export async function recordResearchFloorTriggered(): Promise<void> {
  try {
    await hashIncrBy(redisKeys.researchFloorStats(), "triggered", 1);
    await setString(redisKeys.researchFloorLastTriggeredAt(), new Date().toISOString());
  } catch (err: any) {
    console.error(`[ResearchFloor] recordResearchFloorTriggered failed: ${err.message}`);
  }
}

export interface ResearchFloorStats {
  triggered: number;
  lastTriggeredAt: string | null;
  emptyStreak: number;
  suppressedUntilMs: number | null;
  ratioMin: number;
  floorWindow: number;
}

/** Aggregate read for the API surface. */
export async function getResearchFloorStats(): Promise<ResearchFloorStats> {
  const [hash, lastTriggeredAt, emptyStreak, suppressedUntilMs] = await Promise.all([
    hashGetAll(redisKeys.researchFloorStats()).catch(() => ({})),
    getString(redisKeys.researchFloorLastTriggeredAt()).catch(() => null),
    getResearchFloorEmptyStreak(),
    getResearchFloorSuppressedUntilMs(),
  ]);
  const hashMap = (hash || {}) as Record<string, string>;
  const triggeredRaw = hashMap.triggered;
  const triggered = triggeredRaw ? parseInt(String(triggeredRaw), 10) : 0;
  return {
    triggered: Number.isFinite(triggered) ? triggered : 0,
    lastTriggeredAt: lastTriggeredAt || null,
    emptyStreak,
    suppressedUntilMs,
    ratioMin: getResearchBuildRatioMin(),
    floorWindow: getResearchFloorWindow(),
  };
}

/** Test-only: wipe all floor state. */
export async function _resetResearchFloorForTests(): Promise<void> {
  await delKey(redisKeys.researchFloorStats());
  await delKey(redisKeys.researchFloorLastTriggeredAt());
  await delKey(redisKeys.researchFloorEmptyStreak());
  await delKey(redisKeys.researchFloorSuppressedUntil());
}

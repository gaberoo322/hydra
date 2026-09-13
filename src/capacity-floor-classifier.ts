/**
 * Pure (zero-Redis) classifier + aggregation for the capacity floor (issue #2211).
 *
 * Split out of `capacity-floor.ts` so the deterministic, synchronous half — the
 * cycle-side classifier, the share aggregation, the shared constants and the
 * value/result types — carries NO Redis dependency. The Redis-backed
 * sliding-window history (writers + readers) stays in `capacity-floor.ts`,
 * which re-exports this module's symbols for back-compat.
 *
 * Background (ADR-0003 / Vision-vector-2): 25% of orchestrator capacity is
 * committed to self-improvement regardless of target state. This module owns
 * the math; `capacity-floor.ts` owns the persistence.
 *
 * Importing this module pulls in only `tier-classifier.ts` (itself Redis-free),
 * so a constants-only or pure-logic caller (e.g. `digest-format.ts`, the
 * `classifySide`/`computeShare` unit tests) no longer drags the
 * `redis/bounded-list.ts` module-level initialization into its import graph.
 */

import { classifyChange } from "./tier-classifier.ts";

// ---------------------------------------------------------------------------
// Constants & types
// ---------------------------------------------------------------------------

/** Default sliding window for share calculations. */
export const DEFAULT_WINDOW_CYCLES = 20;

/** Vision-vector-2 floor: minimum orchestrator-side share. */
export const ORCHESTRATOR_FLOOR = 0.25;

export type CycleSide = "orchestrator" | "target" | "idle";

/**
 * Canonical tri-state floor verdict (#4298). `'unmeasured'` when the
 * non-idle window is empty (windowCount === 0) — Vector 6: "Green cycles ≠
 * working orchestrator"; an empty window must never render as met.
 */
export type CapacityFloorStatus = "met" | "breached" | "unmeasured";

export interface CycleSideEntry {
  cycleId: string;
  side: CycleSide;
  /** Optional commit SHA for traceability. */
  commitSha?: string;
  /** Optional file list for audit. May be omitted to save space. */
  filesChanged?: string[];
  /** ISO timestamp written. */
  recordedAt: string;
  /** Optional source hint (e.g. "post-merge", "hydra-dev"). */
  source?: string;
}

export interface CapacitySnapshot {
  orchestrator: { share: number; count: number; window: number; floor: number };
  target: { share: number; count: number };
  idle: { count: number };
  /** Canonical tri-state floor verdict (#4298). */
  floorStatus: CapacityFloorStatus;
  /** Boolean projection of floorStatus — null when the window is unmeasured. */
  floorMet: boolean | null;
  /** Reverse chronological recent entries (newest first). */
  recent: CycleSideEntry[];
}

export interface ShareResult {
  /** Orchestrator-side count / non-idle count. 0 if denominator is 0. */
  share: number;
  orchestratorCount: number;
  targetCount: number;
  idleCount: number;
  /** Non-idle denominator (orchestrator + target). */
  windowCount: number;
  /** Configured floor. */
  floor: number;
  /**
   * Canonical tri-state verdict (#4298): 'met' iff windowCount > 0 AND
   * share >= floor; 'breached' iff windowCount > 0 AND share < floor;
   * 'unmeasured' iff windowCount === 0.
   */
  floorStatus: CapacityFloorStatus;
  /** Boolean projection of floorStatus: true / false / null. Never computed independently. */
  floorMet: boolean | null;
}

// ---------------------------------------------------------------------------
// Pure classifier
// ---------------------------------------------------------------------------

/**
 * Classify a cycle's side from its file list.
 *
 *   - Empty/missing file list → "idle" (cycle did no merge).
 *   - Otherwise consult tier-classifier on each file and tally how many are
 *     orchestrator-shaped (Tier 1 / Tier 2). Files left at Tier 3 by the
 *     default rule are ambiguous (any `src/` file qualifies) and are
 *     counted as "ambiguous", not as orchestrator votes.
 *   - If there is at least one *strong* orchestrator vote AND no strong
 *     target vote, the result is "orchestrator".
 *   - If `opts.workspaceHint === "target"` and we don't have strong
 *     orchestrator evidence, the result is "target".
 *   - Tiebreak rule for mixed-repo merges (rare): majority of strong votes
 *     wins. If still tied, fall back to the hint, then "target".
 *
 * Callers should prefer the explicit `recordCycleSide` / `recordOrchestrator-
 * SideMerge` writers — the classifier is the fallback when the side wasn't
 * stamped at write time.
 */
export function classifySide(
  filesChanged: string[] | null | undefined,
  opts: { workspaceHint?: "target" | "orchestrator" } = {},
): CycleSide {
  const files = (filesChanged || []).filter(f => typeof f === "string" && f.length > 0);
  if (files.length === 0) return "idle";

  // Strong orchestrator signal: tier-classifier matched a T1 or T2 path
  // (deliberate, narrow lists). T3 is the *default*, so it isn't a signal of
  // anything. T4 (Verifier Core) is not counted as an orchestrator vote — it
  // is the deepest tier, not an orchestrator-shaped self-improvement path.
  const classified = classifyChange(files);
  const orchestratorVotes = (classified.perFile || []).filter(f => f.tier === 1 || f.tier === 2).length;
  const ambiguousVotes = (classified.perFile || []).filter(f => f.tier === 3).length;

  if (opts.workspaceHint === "orchestrator") return "orchestrator";

  if (orchestratorVotes > 0 && orchestratorVotes >= ambiguousVotes) {
    return "orchestrator";
  }

  // No strong orchestrator evidence — defer to workspace hint, default to target.
  // (Cycles run against the target workspace; an unannotated cycle with
  // files in `src/` is almost certainly target-side code.)
  return opts.workspaceHint || "target";
}

// ---------------------------------------------------------------------------
// Pure aggregation
// ---------------------------------------------------------------------------

/**
 * Pure helper for tests: compute the share given an explicit history list.
 */
export function computeShare(history: CycleSideEntry[], floor = ORCHESTRATOR_FLOOR): ShareResult {
  let orchestratorCount = 0;
  let targetCount = 0;
  let idleCount = 0;
  for (const e of history) {
    if (e.side === "orchestrator") orchestratorCount++;
    else if (e.side === "target") targetCount++;
    else idleCount++;
  }
  const windowCount = orchestratorCount + targetCount; // idle excluded
  const share = windowCount > 0 ? orchestratorCount / windowCount : 0;
  // Vector 6 (#4298): an empty window is UNMEASURED, not met. A vacuous
  // `floorMet: true` here rendered a false green on the builder-health dial
  // exactly when the orchestrator was dormant — the condition the dial
  // exists to detect. `floorMet` is the boolean projection of floorStatus,
  // never computed independently.
  const floorStatus: CapacityFloorStatus =
    windowCount === 0 ? "unmeasured" : share >= floor ? "met" : "breached";
  return {
    share,
    orchestratorCount,
    targetCount,
    idleCount,
    windowCount,
    floor,
    floorStatus,
    floorMet: floorStatus === "unmeasured" ? null : floorStatus === "met",
  };
}

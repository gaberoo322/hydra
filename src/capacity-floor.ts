/**
 * Capacity-floor enforcement for orchestrator self-improvement (issue #245).
 *
 * ADR-0003 / Vision-vector-2 commits 25% of orchestrator capacity to
 * self-improvement regardless of target state. Without enforcement, target
 * work crowds out builder investment — the explicit failure mode the ADR
 * exists to prevent.
 *
 * This module provides:
 *
 *   - A pure classifier (`classifySide`) that labels a cycle as
 *     "orchestrator" | "target" | "idle" given its merged-file list.
 *   - A Redis-backed sliding-window history (`recordCycleSide`,
 *     `recordOrchestratorSideMerge`) so we have a single source of truth.
 *   - A consumer (`getSelfImprovementShare`) that returns the share of
 *     orchestrator-side merges in the last N non-idle cycles.
 *   - A snapshot (`getCapacitySnapshot`) used by the API route and digest.
 *
 * Soft preference, NOT hard block: `/hydra-doctor` / critical incidents
 * still run. The share recovers naturally on subsequent cycles. Hard
 * enforcement turns a one-off doctor need into a deadlock.
 *
 * The classifier consults the tier-classifier (#243) when files clearly
 * match orchestrator-shaped paths (e.g. `config/agents/`, `.claude/skills/`,
 * `src/anchor-selection.ts`). Target cycles whose files merely live under
 * `src/` would *also* match Tier-3 by default, so the source-of-truth
 * remains the recorder: post-merge stamps target cycles explicitly; the
 * orchestrator-side merge recorder stamps orchestrator entries explicitly.
 * The classifier is the fallback (and what the tests exercise).
 */

import { boundedJsonList } from "./redis/bounded-list.ts";
import { classifyChange } from "./tier-classifier.ts";

// ---------------------------------------------------------------------------
// Constants & types
// ---------------------------------------------------------------------------

/** Default sliding window for share calculations. */
export const DEFAULT_WINDOW_CYCLES = 20;

/** Vision-vector-2 floor: minimum orchestrator-side share. */
export const ORCHESTRATOR_FLOOR = 0.25;

/** Hard cap on history list length. Keep small — this is a soft signal. */
const HISTORY_MAX_LEN = 200;

/** Redis key for the rolling history list. */
const HISTORY_KEY = "hydra:capacity:history";

/**
 * The rolling cycle-side history, backed by the shared bounded-JSON-list
 * primitive (ADR-0017 Category C). Newest-first, trimmed to HISTORY_MAX_LEN,
 * tolerant of corrupt entries on read. The cycleId/side validity filter stays
 * at the `getCycleHistory` call site (domain validation, not list mechanics).
 */
const history = boundedJsonList<CycleSideEntry>(HISTORY_KEY, HISTORY_MAX_LEN);

export type CycleSide = "orchestrator" | "target" | "idle";

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
  /** Whether the floor is met. */
  floorMet: boolean;
  /** Reverse chronological recent entries (newest first). */
  recent: CycleSideEntry[];
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
// History writers
// ---------------------------------------------------------------------------

/**
 * Record a cycle's side in the rolling history. Best-effort — failures
 * never propagate (this is observability, not critical-path).
 */
export async function recordCycleSide(
  cycleId: string,
  side: CycleSide,
  opts: { commitSha?: string; filesChanged?: string[]; source?: string } = {},
): Promise<void> {
  try {
    const entry: CycleSideEntry = {
      cycleId,
      side,
      commitSha: opts.commitSha,
      filesChanged: opts.filesChanged,
      recordedAt: new Date().toISOString(),
      source: opts.source,
    };
    await history.push(entry);
  } catch (err: any) {
    console.error(`[capacity-floor] recordCycleSide failed (non-fatal): ${err.message}`);
  }
}

/**
 * Convenience writer for orchestrator-side PR merges (e.g. `hydra-dev`
 * landing a PR against the orchestrator repo). Same shape as
 * `recordCycleSide`, but the side is fixed.
 */
export async function recordOrchestratorSideMerge(
  cycleId: string,
  opts: { commitSha?: string; filesChanged?: string[]; source?: string } = {},
): Promise<void> {
  await recordCycleSide(cycleId, "orchestrator", { ...opts, source: opts.source || "orchestrator-merge" });
}

// ---------------------------------------------------------------------------
// History reader
// ---------------------------------------------------------------------------

/**
 * Read the most recent N history entries. Returned newest-first.
 *
 * Tolerates corrupt JSON entries by skipping them.
 */
export async function getCycleHistory(limit: number = DEFAULT_WINDOW_CYCLES): Promise<CycleSideEntry[]> {
  try {
    // boundedJsonList.read() does the tolerant JSON.parse (skipping corrupt
    // entries); the cycleId/side validity filter below is domain validation
    // that stays at the call site (ADR-0017 — mechanics vs. domain split).
    const parsed = await history.read(Math.max(limit, 1));
    return parsed.filter(
      (e): e is CycleSideEntry =>
        !!e && typeof e.cycleId === "string" && typeof e.side === "string",
    );
  } catch (err: any) {
    console.error(`[capacity-floor] getCycleHistory failed (non-fatal): ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Pure aggregation
// ---------------------------------------------------------------------------

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
  /** True iff windowCount > 0 AND share >= floor. */
  floorMet: boolean;
}

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
  return {
    share,
    orchestratorCount,
    targetCount,
    idleCount,
    windowCount,
    floor,
    // If there's no signal yet (empty window) we DO NOT report a floor breach
    // — we have no opinion, so floorMet reports true for an empty window.
    floorMet: windowCount > 0 ? share >= floor : true,
  };
}

/**
 * Read the recent history from Redis and compute the orchestrator share.
 */
export async function getSelfImprovementShare(
  windowCycles: number = DEFAULT_WINDOW_CYCLES,
): Promise<ShareResult> {
  const history = await getCycleHistory(windowCycles);
  return computeShare(history);
}

/**
 * Snapshot used by the API route and digest section. Single read.
 */
export async function getCapacitySnapshot(
  windowCycles: number = DEFAULT_WINDOW_CYCLES,
): Promise<CapacitySnapshot> {
  const history = await getCycleHistory(windowCycles);
  const result = computeShare(history);
  const denom = result.windowCount + result.idleCount;
  return {
    orchestrator: {
      share: result.share,
      count: result.orchestratorCount,
      window: result.windowCount,
      floor: result.floor,
    },
    target: {
      share: denom > 0 ? result.targetCount / result.windowCount : 0,
      count: result.targetCount,
    },
    idle: { count: result.idleCount },
    floorMet: result.floorMet,
    recent: history,
  };
}

// ---------------------------------------------------------------------------
// Test seam
// ---------------------------------------------------------------------------

/**
 * Test-only: clear the history list. Production callers should not use this.
 */
export async function _resetCapacityHistory(): Promise<void> {
  await history.clear();
}

/**
 * Capacity-floor enforcement for orchestrator self-improvement (issue #245).
 *
 * ADR-0003 / Vision-vector-2 commits 25% of orchestrator capacity to
 * self-improvement regardless of target state. Without enforcement, target
 * work crowds out builder investment — the explicit failure mode the ADR
 * exists to prevent.
 *
 * This module owns the **Redis-backed sliding-window cycle-side history**: the
 * writers (`recordCycleSide`, `recordOrchestratorSideMerge`), the private
 * reader (`getCycleHistory`), and the two snapshot consumers
 * (`getSelfImprovementShare`, `getCapacitySnapshot`).
 *
 * The **pure half** — the `classifySide` classifier, the `computeShare`
 * aggregation, the shared constants (`DEFAULT_WINDOW_CYCLES`,
 * `ORCHESTRATOR_FLOOR`) and the value/result types — lives in the zero-Redis
 * sibling `capacity-floor-classifier.ts` (issue #2211). It is re-exported here
 * so existing importers of `capacity-floor.ts` keep working unchanged; a
 * constants-only or pure-logic caller should import directly from
 * `capacity-floor-classifier.ts` to avoid this module's Redis dependency graph.
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
import {
  DEFAULT_WINDOW_CYCLES,
  ORCHESTRATOR_FLOOR,
  computeShare,
  type CapacitySnapshot,
  type CycleSide,
  type CycleSideEntry,
  type ShareResult,
} from "./capacity-floor-classifier.ts";

// Re-export the pure surface so existing `capacity-floor.ts` importers (the
// Redis-backed callers) keep their import sites unchanged. New pure-only
// callers should import from `capacity-floor-classifier.ts` directly.
export {
  classifySide,
  DEFAULT_WINDOW_CYCLES,
  ORCHESTRATOR_FLOOR,
} from "./capacity-floor-classifier.ts";
export type {
  CapacitySnapshot,
  CycleSide,
  ShareResult,
} from "./capacity-floor-classifier.ts";

// ---------------------------------------------------------------------------
// Redis history mechanics
// ---------------------------------------------------------------------------

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
async function getCycleHistory(limit: number = DEFAULT_WINDOW_CYCLES): Promise<CycleSideEntry[]> {
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
// Redis-backed consumers
// ---------------------------------------------------------------------------

/**
 * Read the recent history from Redis and compute the orchestrator share.
 */
export async function getSelfImprovementShare(
  windowCycles: number = DEFAULT_WINDOW_CYCLES,
): Promise<ShareResult> {
  const recent = await getCycleHistory(windowCycles);
  return computeShare(recent);
}

/**
 * Snapshot used by the API route and digest section. Single read.
 */
export async function getCapacitySnapshot(
  windowCycles: number = DEFAULT_WINDOW_CYCLES,
): Promise<CapacitySnapshot> {
  const recent = await getCycleHistory(windowCycles);
  const result = computeShare(recent);
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
    recent,
  };
}

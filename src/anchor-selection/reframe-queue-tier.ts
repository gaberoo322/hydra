// ---------------------------------------------------------------------------
// Reframe-queue tier — tasks that failed repeatedly need a fresh approach
// ---------------------------------------------------------------------------
//
// Prunes stale (>7d) and overflow (>20) items before consuming (issue #57),
// pops the head item, and drift-filters it. Returns null when the queue is
// empty, the head item is corrupt, or it's a drift duplicate.

import { listRange, listLPop, listLen } from "../redis-adapter.ts";
import { REFRAME_QUEUE } from "./constants.ts";
import { isAnchorDriftDuplicate } from "./drift-filter.ts";
import { pruneReframeQueue } from "./reframe-queue.ts";

export interface ReframeAnchor {
  type: "reframe";
  reference: string;
  whyNow: string;
  context: any;
}

/**
 * Non-destructive readiness check used by the capacity-floor dispatcher
 * (issue #377). Runs queue maintenance (pruning is idempotent) and then
 * reports whether the queue has any items the consumer might try to pop.
 *
 * Drift-filtering happens at consume time, not here — a head item that
 * later turns out to be a drift duplicate is still "a candidate" for
 * floor-readiness purposes; the dispatcher's buildAnchor() will handle the
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
  // Prune stale (>7d) and overflow (>20) items before consuming (issue #57).
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
    // Drift pre-filter (issue #233) — already popped, just drop & continue
    // if a near-duplicate of recent merged work.
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

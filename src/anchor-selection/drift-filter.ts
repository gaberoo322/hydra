// ---------------------------------------------------------------------------
// Drift pre-filter — reject near-duplicate anchors BEFORE the planner runs
// ---------------------------------------------------------------------------
//
// Issue #233. The same string-similarity check used by detectDrift after
// planning; moving it earlier saves the ~$1-2 frontier-model planner call
// (~40% of abandons were drift). See computeTitleSimilarity in metrics.ts.

import { findRecentDriftMatch } from "../metrics.ts";
import {
  DRIFT_PREFILTER_LOOKBACK,
  DRIFT_PREFILTER_THRESHOLD,
  DRIFT_PREFILTER_TYPES,
} from "./constants.ts";

// Per-process counter — surfaced via _testing for metric wiring & tests.
let driftPreFilteredCount = 0;

/**
 * Returns true and logs if `anchor.reference` is more than 70% similar to a
 * recent cycle's task title. Mutates the per-process counter so callers can
 * surface savings via /metrics. Pure for `failing-test`/`typecheck` callers
 * (returns false without scanning).
 *
 * Errors during the scan are swallowed — drift filtering must never break
 * anchor selection. Returns false in that case so the candidate proceeds.
 */
export async function isAnchorDriftDuplicate(anchor: any): Promise<{
  drift: boolean;
  match?: { cycleId: string; taskTitle: string; similarity: number };
}> {
  if (!anchor?.reference || !DRIFT_PREFILTER_TYPES.has(anchor.type)) {
    return { drift: false };
  }
  try {
    const match = await findRecentDriftMatch(
      anchor.reference,
      DRIFT_PREFILTER_LOOKBACK,
      DRIFT_PREFILTER_THRESHOLD,
    );
    if (!match) return { drift: false };
    driftPreFilteredCount++;
    console.log(
      `[AnchorSelection] drift-pre-filter: rejecting [${anchor.type}] "${anchor.reference}" — ${Math.round(match.similarity * 100)}% similar to "${match.taskTitle}" from ${match.cycleId} (planner skipped, est ~$1-2 saved)`,
    );
    return { drift: true, match };
  } catch (err: any) {
    console.error(`[AnchorSelection] drift pre-filter scan failed: ${err.message}`);
    return { drift: false };
  }
}

/**
 * Read and reset the per-process drift pre-filter counter. Called by the
 * control loop after each cycle so metrics can record cycle-scoped savings.
 */
export function consumeDriftPreFilteredCount(): number {
  const n = driftPreFilteredCount;
  driftPreFilteredCount = 0;
  return n;
}

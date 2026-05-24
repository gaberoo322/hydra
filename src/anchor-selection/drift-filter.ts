// ---------------------------------------------------------------------------
// Drift pre-filter — reject near-duplicate anchors BEFORE the planner runs
// ---------------------------------------------------------------------------
//
// Issue #233. Rejecting a near-duplicate anchor before the planner runs saves
// the ~$1-2 frontier-model planner call (~40% of abandons were drift).
//
// This module owns the full drift-detection lifecycle:
//   - `computeTitleSimilarity` — pure Jaccard-like token-overlap score
//   - `findRecentDriftMatch`   — scan recent cycles for the first match above threshold
//   - `isAnchorDriftDuplicate` — the pre-filter the selector calls

import { getRecentMetricIds, getCycleMetrics } from "../redis/cycle-metrics.ts";
import {
  DRIFT_PREFILTER_LOOKBACK,
  DRIFT_PREFILTER_THRESHOLD,
  DRIFT_PREFILTER_TYPES,
} from "./constants.ts";

// Per-process counter — surfaced via _testing for metric wiring & tests.
let driftPreFilteredCount = 0;

/**
 * Compute title similarity using word-overlap (Jaccard-like, max-denominator).
 *
 * Pure function. Tokenisation: lowercase, split on whitespace, drop tokens of
 * length <= 3 (filter stop-words like "the", "and", "for"). Returns 0 when
 * either side has no remaining tokens — keeps callers from comparing
 * degenerate titles.
 *
 * Score range: [0, 1]. 1.0 = identical token sets, 0 = disjoint.
 */
export function computeTitleSimilarity(a: string, b: string): number {
  if (typeof a !== "string" || typeof b !== "string") return 0;
  const aWords = new Set(a.toLowerCase().split(/\s+/).filter((w) => w.length > 3));
  const bWords = new Set(b.toLowerCase().split(/\s+/).filter((w) => w.length > 3));
  if (aWords.size === 0 || bWords.size === 0) return 0;
  const intersection = [...aWords].filter((w) => bWords.has(w));
  return intersection.length / Math.max(aWords.size, bWords.size);
}

/**
 * Scan recent cycles and return the first one whose taskTitle is more than
 * `threshold` similar to `reference`. Returns the matching descriptor
 * (cycleId, taskTitle, similarity) or null.
 *
 * @param reference  Candidate anchor reference (typically the queue/doc title)
 * @param lookback   Number of recent cycles to scan (default 50)
 * @param threshold  Similarity above which we consider the anchor a duplicate (default 0.7)
 */
export async function findRecentDriftMatch(
  reference: string,
  lookback = 50,
  threshold = 0.7,
): Promise<{ cycleId: string; taskTitle: string; similarity: number } | null> {
  if (!reference || typeof reference !== "string") return null;
  const cycleIds = await getRecentMetricIds(lookback);
  for (const cycleId of cycleIds) {
    const raw = await getCycleMetrics(cycleId);
    if (!raw.taskTitle) continue;
    const similarity = computeTitleSimilarity(reference, raw.taskTitle);
    if (similarity > threshold) {
      return { cycleId, taskTitle: raw.taskTitle, similarity };
    }
  }
  return null;
}

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

/**
 * Health-signal heuristic 2: unproductive class loops (issue #2866 — extracted
 * from the combined `autopilot/run-health.ts` heuristic bag).
 *
 * The run digest doesn't carry a per-run class label, but it does carry the
 * aggregate dispatch/merged/failed counts per run. We treat the run-history
 * window itself as the "loop": across the window, if total dispatches are
 * non-trivial yet NOTHING landed, the autopilot may be burning capacity
 * without delivering. This leaf owns that heuristic; it evolves with the
 * real-merge cross-check policy independently of the other three evaluators.
 *
 * CRITICAL (issue #924): per-run `merged_count` is NOT a delivery proxy. CI is
 * the async merge gate, so a dispatch opens a PR that merges minutes-to-hours
 * later — almost always after the dispatching run has ended (and short-lived
 * runs terminate before CI even resolves, leaving every outcome `pending`).
 * So per-run `merged_count` is structurally ~0 regardless of real delivery,
 * which made this heuristic cry wolf whenever runs are short-lived. We now
 * cross-check `realMergesInWindow` — actual master merges over the same span —
 * and suppress the signal entirely when real merges landed. The heuristic only
 * fires for the genuine case: dispatches accumulating with zero real merges
 * ANYWHERE (per-run AND out-of-band).
 */

import {
  type AutopilotHealthThresholds,
  type RunDigest,
  type StuckSignal,
  type StuckSignalSeverity,
  toNum,
} from "./common.ts";

export function detectUnproductiveLoops(
  history: RunDigest[],
  thresholds: AutopilotHealthThresholds,
  realMergesInWindow = 0,
): StuckSignal[] {
  let dispatches = 0;
  let merged = 0;
  let failed = 0;
  let runsWithDispatch = 0;
  for (const run of history) {
    const d = toNum(run.dispatches);
    dispatches += d;
    merged += toNum(run.merged_count);
    failed += toNum(run.failed_count);
    if (d > 0) runsWithDispatch += 1;
  }

  if (dispatches < thresholds.unproductiveMinDispatches) return [];
  // Productive if anything landed per-run OR out-of-band (real master merges in
  // the window). Only flag a window with zero delivery on EITHER axis.
  const realMerges = Math.max(0, Math.floor(realMergesInWindow));
  if (merged > 0 || realMerges > 0) return [];

  const failRatio = dispatches > 0 ? failed / dispatches : 0;
  const severity: StuckSignalSeverity =
    failRatio >= thresholds.unproductiveCriticalFailRatio ? "critical" : "warn";

  return [
    {
      type: "unproductive-loop",
      severity,
      summary: `Across the last ${history.length} runs, ${dispatches} dispatch(es) landed 0 merges (${failed} failed, 0 real master merges in the window) — autopilot is looping without progress.`,
      evidence: {
        windowRuns: history.length,
        runsWithDispatch,
        dispatches,
        merged,
        realMergesInWindow: realMerges,
        failed,
        failRatio: Number(failRatio.toFixed(3)),
      },
    },
  ];
}

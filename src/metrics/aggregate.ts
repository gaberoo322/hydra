/**
 * Cycle-metrics trend-rollup coordinators consumed by /metrics, /summary, and
 * planner-facing accomplishments — rolling merge-rate, aggregate stats,
 * cumulative accomplishments, anchor distribution, fix:feature ratio.
 *
 * All seven zero-I/O pure projections (`computeRollingMergeRateFromTrend`,
 * `computeEmptyRateFromTrend`, `projectTokensPerMergedPR`, `projectAggregateStats`,
 * `projectCostByOutcome`, `projectCumulativeAccomplishments`,
 * `projectAnchorDistribution`, plus the `CycleOutcome` / `CostByOutcomeResult` /
 * `CYCLE_OUTCOME_ORDER` cost-by-outcome surface and the `AnchorDistributionResult`
 * shape) were relocated to the `./stats-projection.ts` pure leaf (issue #3212) so
 * the arithmetic is testable without a Redis fixture and a caller that needs only
 * the projection (e.g. `scheduler/rolling-rates.ts`, `api/metrics.ts`) imports the
 * leaf without this module's `getMetricsTrend` dependency. This module keeps ONLY
 * the async Redis-touching wrappers that fetch the trend and delegate to those
 * pure functions. It does NOT re-export the pure symbols (no back-compat shim,
 * issue #3212 invariant 2) — callers of a pure projection import it from
 * `./stats-projection.ts` directly.
 *
 * Per-class cost attribution (the `CostClass` / `skillToCostClass` /
 * `projectCostByClass` / `getCostByClass` surface) was relocated to the Cost
 * module at `src/cost/cost-attribution.ts` (issue #2219) so the Cost domain's
 * knowledge concentrates under `src/cost/`; import those symbols from
 * `../cost/index.ts`.
 */

import { getMetricsTrend } from "./trend.ts";
import {
  projectAggregateStats,
  projectCostByOutcome,
  projectCumulativeAccomplishments,
} from "./stats-projection.ts";

/**
 * Get the token cost broken down by cycle outcome over a recent trend window.
 *
 * Thin wrapper: fetch the trend (the `count` knob), then delegate the split to
 * the pure `projectCostByOutcome`. No new Redis write path — a derived read over
 * the `tokenCost` + outcome fields the trend already joins (issue #3024).
 */
export async function getCostByOutcome(count = 200) {
  const trend = await getMetricsTrend(count);
  return projectCostByOutcome(trend);
}

/**
 * Compute aggregate stats from metrics trend.
 *
 * Thin wrapper: fetch the rolling trend window from Redis (the `count` knob),
 * then delegate the arithmetic to the pure `projectAggregateStats`.
 */
export async function getAggregateStats(count = 20) {
  const trend = await getMetricsTrend(count);
  return projectAggregateStats(trend);
}

/**
 * Get a cumulative summary of what's been accomplished across recent cycles.
 * Used by the planner to avoid re-proposing completed work.
 *
 * Thin wrapper: fetch the trend (the `count` knob), then delegate to the pure
 * `projectCumulativeAccomplishments`.
 */
export async function getCumulativeAccomplishments(count = 15) {
  const trend = await getMetricsTrend(count);
  return projectCumulativeAccomplishments(trend);
}

/**
 * A single still-unclassified cycle's attribution metadata (issue #3403).
 *
 * Exposed by {@link getUnclassifiedAnchors} so the residue that survives the
 * classifier (`src/autopilot/anchor-type.ts` — after skill-name, slot, and
 * unambiguous-prefix inference) is ATTRIBUTABLE rather than an opaque bucket
 * count. The discovery playbook's >10%-unclassified architectural-review trigger
 * needs the offending cycleIds to root-cause the gap; before this the /metrics
 * distribution only reported HOW MANY were unclassified, never WHICH.
 */
export interface UnclassifiedAnchorRecord {
  /** The cycleId that could not be decoded to a lane. */
  cycleId: string;
  /** The merged-PR number, when the record was a merge-status enrichment. */
  prNumber?: string;
  /** The anchor reference (issue ref), when the writer forwarded one. */
  anchorReference?: string;
  /** The human task title, when the writer forwarded one. */
  taskTitle?: string;
}

/**
 * The unclassified-anchor instrumentation projection (issue #3403).
 *
 * Surfaces the metadata of every cycle in the recent window whose anchorType is
 * the `unclassified` sentinel — the root-cause capture the #3403 proposed
 * solution (#3) calls for. Most residual unclassified cycles are the
 * holdback-merge-watch merged-status enrichment write (they carry a `prNumber`
 * but no forwarded anchorType, and their cycleId is a bare UUID / harness branch
 * name with no decodable dispatch slot — the known #2800 upstream forward gap).
 * Emitting the cycleId + prNumber makes each a "documented exception" the
 * operator can map back to its PR, satisfying the issue's success criterion that
 * every unclassified cycle map to a named type OR a documented exception.
 *
 * Thin wrapper: fetch the trend (the `count` knob), then filter/shape the
 * sentinel rows — mirrors the other `getX` aggregators in this module.
 */
export async function getUnclassifiedAnchors(
  count = 50,
): Promise<{ windowCycles: number; unclassified: UnclassifiedAnchorRecord[]; rate: number }> {
  const trend = await getMetricsTrend(count);
  const unclassified: UnclassifiedAnchorRecord[] = [];
  for (const m of trend) {
    if ((m.anchorType && String(m.anchorType).trim()) !== "unclassified") continue;
    const record: UnclassifiedAnchorRecord = { cycleId: String(m.cycleId) };
    if (m.prNumber !== undefined && m.prNumber !== null && String(m.prNumber).length > 0) {
      record.prNumber = String(m.prNumber);
    }
    if (m.anchorReference) record.anchorReference = String(m.anchorReference);
    if (m.taskTitle) record.taskTitle = String(m.taskTitle);
    unclassified.push(record);
  }
  const windowCycles = trend.length;
  const rate = windowCycles > 0
    ? +((unclassified.length / windowCycles) * 100).toFixed(1)
    : 0;
  return { windowCycles, unclassified, rate };
}

/**
 * Compute fix:feature ratio from recent cycles.
 * Fixes = prior-failure or failing-test anchors. Features = everything else that merged.
 */
export async function getFixFeatureRatio(count = 20) {
  const trend = await getMetricsTrend(count);
  let fixes = 0, features = 0;
  for (const m of trend) {
    if (m.tasksMerged > 0) {
      if (m.anchorType === "prior-failure" || m.anchorType === "failing-test") {
        fixes++;
      } else {
        features++;
      }
    }
  }
  return { fixes, features, ratio: features > 0 ? +(fixes / features).toFixed(1) : 0, total: trend.length };
}

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

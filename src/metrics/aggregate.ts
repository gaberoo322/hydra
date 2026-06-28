/**
 * Cycle-metrics trend-rollup aggregations consumed by /metrics, /summary, and
 * planner-facing accomplishments — rolling merge-rate, aggregate stats,
 * cumulative accomplishments, anchor distribution, fix:feature ratio. Pure
 * compositions over getMetricsTrend() — no Redis access of their own.
 *
 * Per-class cost attribution (the `CostClass` / `skillToCostClass` /
 * `projectCostByClass` / `getCostByClass` surface) was relocated to the Cost
 * module at `src/cost/cost-attribution.ts` (issue #2219) so the Cost domain's
 * knowledge concentrates under `src/cost/`; import those symbols from
 * `../cost/index.ts`.
 */

import { getMetricsTrend } from "./trend.ts";

/**
 * Pure projection: the rolling merge-rate of a metrics-trend window, as a
 * rounded percentage (`Math.round((mergedCount / total) * 100)`).
 *
 * A cycle counts as "merged" when its persisted `tasksMerged` field is > 0.
 * The predicate is null-safe (`(m?.tasksMerged ?? 0) > 0`) — identical to the
 * bare `m.tasksMerged > 0` on real data (`undefined > 0 === false`) and
 * strictly safer on null/undefined entries.
 *
 * Returns `null` on an empty trend (not `0`): callers must treat "no data" as
 * distinct from "0% merged" so a healthy fresh start is never misreported as a
 * stall (issue #232 — the heartbeat false-stall guard depends on this null).
 *
 * Single source of truth for the `tasksMerged>0 → rounded percentage`
 * arithmetic, consumed by `projectAggregateStats` (the `/metrics` `mergedRate`)
 * and `scheduler/heartbeat.ts::computeRollingMergeRate` (the `/api/scheduler/status`
 * rolling merge-rate). The two out-of-scope `parseInt`-coercing sites
 * (`digest-format.ts`, `health/diagnostics.ts`) deliberately do NOT delegate
 * here — folding them would change string-coercion semantics (issue #2169).
 */
export function computeRollingMergeRateFromTrend(
  trend: Array<Record<string, any>>,
): number | null {
  if (trend.length === 0) return null;
  const merged = trend.filter((m) => (m?.tasksMerged ?? 0) > 0).length;
  return Math.round((merged / trend.length) * 100);
}

/**
 * Pure projection: fold an already-fetched metrics-trend array into the
 * aggregate-stats shape (`mergedRate` / `regressionRate` / `noOpMergeRate` /
 * the duration averages / the anchor distribution).
 *
 * Extracted verbatim from the inline body of `getAggregateStats` (issue #2143)
 * so the rate arithmetic is unit-testable on a synthetic trend array without a
 * live Redis fetch — matching the discipline of `projectCostByClass`,
 * `projectAnchorDistribution`, and `projectGroundingDuration`. The empty-trend
 * guard (`return { cycles: 0 }`) moves here verbatim so no rate divides by
 * total=0. The async `getAggregateStats` wrapper keeps the `count` knob and the
 * Redis fetch; this function only does arithmetic.
 */
export function projectAggregateStats(trend: Array<Record<string, any>>) {
  if (trend.length === 0) return { cycles: 0 };

  const total = trend.length;
  const merged = trend.filter((m) => m.tasksMerged > 0).length;
  const failed = trend.filter((m) => m.tasksFailed > 0).length;
  const abandoned = trend.filter((m) => m.tasksAbandoned > 0).length;
  const regressions = trend.filter((m) => m.regressionIntroduced).length;
  // Issue #222: aggregate no-op-merge counter so /metrics surfaces the
  // silent-rot guardrail across the trend window.
  const noOpMerges = trend.filter((m) => m.noOpMerges > 0).length;

  const durations = trend.map((m) => m.totalDurationMs).filter(Boolean);
  const avgDuration = durations.length > 0
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
    : 0;

  // Spec section 12: additional metrics
  const retries = trend.filter((m) => m.anchorType === "prior-failure").length;
  const filesChangedTotal = trend.reduce((s, m) => s + (m.filesChanged || 0), 0);
  const verificationDurations = trend.map((m) => m.verificationDurationMs).filter(Boolean);
  const groundingDurations = trend.map((m) => m.groundingDurationMs).filter(Boolean);

  const anchorDist: Record<string, number> = {};
  for (const m of trend) {
    const at = m.anchorType || "unknown";
    anchorDist[at] = (anchorDist[at] || 0) + 1;
  }

  return {
    cycles: total,
    // Delegate the rolling merge-rate arithmetic to the shared pure helper so
    // it lives in exactly one place (issue #2169). The trend.length===0 guard
    // above means total>0 here, so the helper returns a number, never null.
    mergedRate: computeRollingMergeRateFromTrend(trend),
    failedRate: Math.round((failed / total) * 100),
    abandonedRate: Math.round((abandoned / total) * 100),
    regressionRate: Math.round((regressions / total) * 100),
    noOpMerges,
    noOpMergeRate: Math.round((noOpMerges / total) * 100),
    retryRate: Math.round((retries / total) * 100),
    avgDurationMs: avgDuration,
    avgDurationHuman: `${Math.round(avgDuration / 1000)}s`,
    avgVerificationMs: verificationDurations.length > 0
      ? Math.round(verificationDurations.reduce((a, b) => a + b, 0) / verificationDurations.length) : 0,
    avgGroundingMs: groundingDurations.length > 0
      ? Math.round(groundingDurations.reduce((a, b) => a + b, 0) / groundingDurations.length) : 0,
    totalFilesChanged: filesChangedTotal,
    anchorDistribution: anchorDist,
    falseCompletionRate: 0,
    anchoredRate: 100,
    verifiedCompletionRate: merged > 0 ? 100 : 0,
  };
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
 * Pure projection: filter + map an already-fetched metrics-trend array into the
 * cumulative-accomplishments list (merged cycles with a title). Extracted from
 * `getCumulativeAccomplishments` (issue #2143) so the merged-and-titled filter
 * is unit-testable on synthetic fixtures without a live Redis. An empty trend
 * yields `[]` (a `.filter().map()` over `[]`), so no guard is needed.
 */
export function projectCumulativeAccomplishments(trend: Array<Record<string, any>>) {
  return trend
    .filter((m) => m.tasksMerged > 0 && m.taskTitle)
    .map((m) => ({
      cycle: m.cycleId,
      title: m.taskTitle,
      anchor: m.anchorType,
      tests: `${m.testsBefore}→${m.testsAfter}`,
    }));
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

// ---------------------------------------------------------------------------
// Anchor-distribution aggregation (issue #377, extracted in #2126)
// ---------------------------------------------------------------------------

/** One live priority lane's served-count rollup. */
interface AnchorDistributionEntry {
  priority: string;
  served: number;
  candidatesAvailable: number | null;
  suppressedReason: string | null;
}

/** The `{windowCycles, distribution, servedByAnchorType}` shape on the wire. */
export interface AnchorDistributionResult {
  windowCycles: number;
  distribution: AnchorDistributionEntry[];
  /** Raw served-bucket dict for clients that want a quick map. */
  servedByAnchorType: Record<string, number>;
}

/**
 * Pure projection: bucket a metrics-trend array by `anchorType` and roll the
 * counts up into the live priority lanes (issue #377). Extracted verbatim from
 * the inline body of `GET /metrics/anchor-distribution` (#2126) so the
 * priority-bucketing + hard-coded fallback logic is unit-testable on a
 * synthetic trend array without standing up the Express router or stubbing
 * Redis — matching the discipline of every other `src/metrics/` aggregator.
 *
 * Counts cycles only (no cost; the USD attribution plane was retired in #1651).
 * The reframe / prior-failure lanes and their starvation gauges were retired in
 * ADR-0016 (no live writer), so this covers only the live priority lanes.
 */
export function projectAnchorDistribution(
  trend: Array<Record<string, any>>,
): AnchorDistributionResult {
  // Bucket cycles by anchorType.
  const served: Record<string, number> = {};
  for (const m of trend) {
    const type = (m.anchorType && String(m.anchorType).trim()) || "unknown";
    served[type] = (served[type] || 0) + 1;
  }

  // Per-priority rollup over the live lanes only. `served` is the count from
  // the rolling window.
  const distribution: AnchorDistributionEntry[] = [
    {
      priority: "kanban",
      served: served["kanban"] || 0,
      candidatesAvailable: null,
      suppressedReason: null,
    },
    {
      priority: "failing-test",
      served: served["failing-test"] || 0,
      candidatesAvailable: null,
      suppressedReason: null,
    },
    {
      priority: "work-queue",
      served: served["work-queue"] || served["research"] || served["user-request"] || 0,
      candidatesAvailable: null,
      suppressedReason: null,
    },
    {
      priority: "codebase-health",
      served: served["health"] || served["codebase-health"] || 0,
      candidatesAvailable: null,
      suppressedReason: null,
    },
    {
      priority: "priorities-doc",
      served: served["doc"] || served["priorities-doc"] || 0,
      candidatesAvailable: null,
      suppressedReason: null,
    },
  ];

  return {
    windowCycles: trend.length,
    distribution,
    servedByAnchorType: served,
  };
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

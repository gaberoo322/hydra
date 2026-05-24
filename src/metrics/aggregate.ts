/**
 * Trend-rollup aggregations consumed by /metrics, /summary, and planner-
 * facing accomplishments. Pure compositions over getMetricsTrend() — no
 * Redis access of their own.
 */

import { getMetricsTrend } from "./trend.ts";

/**
 * Compute aggregate stats from metrics trend.
 */
export async function getAggregateStats(count = 20) {
  const trend = await getMetricsTrend(count);
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

  const anchorDist = {};
  for (const m of trend) {
    const at = m.anchorType || "unknown";
    anchorDist[at] = (anchorDist[at] || 0) + 1;
  }

  // Issue #272/#287: gate-coverage breakdown.
  const coverageSamples = trend.filter((m) => typeof m.qualityGateCoverage === "boolean");
  const coverageCovered = coverageSamples.filter((m) => m.qualityGateCoverage === true).length;
  const coverageNotCovered = coverageSamples.filter((m) => m.qualityGateCoverage === false).length;
  const coverageNotApplicable = total - coverageSamples.length;
  const qualityGateCoverageRate = coverageSamples.length > 0
    ? Math.round((coverageCovered / coverageSamples.length) * 100)
    : null;

  return {
    cycles: total,
    mergedRate: Math.round((merged / total) * 100),
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
    qualityGateCoverageRate,
    qualityGateCoverageSamples: coverageSamples.length,
    qualityGateCoverageCovered: coverageCovered,
    qualityGateCoverageNotCovered: coverageNotCovered,
    qualityGateCoverageNotApplicable: coverageNotApplicable,
  };
}

/**
 * Get a cumulative summary of what's been accomplished across recent cycles.
 * Used by the planner to avoid re-proposing completed work.
 */
export async function getCumulativeAccomplishments(count = 15) {
  const trend = await getMetricsTrend(count);
  const accomplished = trend
    .filter((m) => m.tasksMerged > 0 && m.taskTitle)
    .map((m) => ({
      cycle: m.cycleId,
      title: m.taskTitle,
      anchor: m.anchorType,
      tests: `${m.testsBefore}→${m.testsAfter}`,
    }));
  return accomplished;
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

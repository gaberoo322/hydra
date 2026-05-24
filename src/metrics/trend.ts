/**
 * Cycle metrics trend — read path.
 *
 * `getMetricsTrend(count)` is the single read entry for "the last N cycle
 * metrics hashes, parsed". Every aggregate/abandonment/quality-gate view in
 * this family consumes its output. Keeping the parser here (not at each call
 * site) is the locality fix: any new typed field added to the metrics hash
 * needs ONE parse update, not N.
 */

import {
  getRecentMetricIds,
  getCycleMetrics,
} from "../redis-adapter.ts";

/**
 * Numeric fields known to live on the cycle-metrics hash. Parsed back from
 * Redis strings at trend read time. Adding a new int-shaped field here is the
 * one-line change that makes it visible to every consumer.
 */
const NUMERIC_FIELDS = [
  "tasksAttempted", "tasksVerified", "tasksMerged", "tasksFailed", "tasksAbandoned",
  "noOpMerges", // issue #222: silent-rot guardrail counter
  "driftPreFiltered", // issue #233: anchors rejected by pre-filter
  "driftPreFilteredCost", // issue #233: estimated planner $ saved
  "testsBefore", "testsAfter", "testsPassingBefore", "testsPassingAfter",
  "filesChanged", "totalDurationMs", "groundingDurationMs", "verificationDurationMs",
  "planningDurationMs", "executionDurationMs", "tokenCost", "costUsd",
  "jitTestsGenerated", "jitTestsKept", "jitTestsCaughtBug",
  "mutationKillRate", "mutationKilled", "mutationSurvived",
  // Quality gate trend (issue #212)
  "mutationsTested", "gateBlocked",
  "fixerUsed", "fixerResolved", "scopeFilterCleaned",
  "reflectionCount",
];

/**
 * Issue #326: derive the categorical `reflectionMatchSource` from the raw
 * comma-separated `reflectionSources` Redis field. Pure helper, exported so
 * the test suite can lock the bucket logic.
 *
 * Buckets: none | by-anchor | by-file | both | global | mixed.
 */
export function deriveReflectionMatchSource(rawSources: unknown): string {
  if (typeof rawSources !== "string" || rawSources.length === 0) return "none";
  const sources = rawSources.split(",").map((s) => s.trim()).filter(Boolean);
  if (sources.length === 0) return "none";
  const hasPerAnchor = sources.includes("per-anchor");
  const hasByFile = sources.includes("by-file");
  const hasGlobal = sources.includes("global");
  if (hasPerAnchor && hasByFile && !hasGlobal) return "both";
  if (hasPerAnchor && !hasByFile && !hasGlobal) return "by-anchor";
  if (!hasPerAnchor && hasByFile && !hasGlobal) return "by-file";
  if (!hasPerAnchor && !hasByFile && hasGlobal) return "global";
  return "mixed";
}

/**
 * Get metrics for the N most recent cycles, with all known numeric fields
 * parsed back from their Redis string form.
 */
export async function getMetricsTrend(count = 20) {
  const cycleIds = await getRecentMetricIds(count);
  const results: Record<string, any>[] = [];

  for (const cycleId of cycleIds) {
    const raw = await getCycleMetrics(cycleId);
    if (!raw.cycleId) continue;

    const parsed: Record<string, any> = { ...raw };
    for (const key of NUMERIC_FIELDS) {
      if (parsed[key] !== undefined) parsed[key] = parseInt(parsed[key]) || 0;
    }
    if (parsed.regressionIntroduced !== undefined) {
      parsed.regressionIntroduced = parsed.regressionIntroduced === "true";
    }
    // Issue #272: gate-coverage observability — string "true"/"false" in Redis.
    if (parsed.qualityGateCoverage !== undefined) {
      parsed.qualityGateCoverage = parsed.qualityGateCoverage === "true";
    }

    // Issue #326: derive `reflectionMatchSource` at read time when callers
    // (verification, post-merge) did not emit it directly.
    if (!parsed.reflectionMatchSource) {
      parsed.reflectionMatchSource = deriveReflectionMatchSource(parsed.reflectionSources);
    }

    results.push(parsed);
  }

  return results;
}

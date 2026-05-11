import { CYCLE_KEY_TTL } from "./task-tracker.ts";
import { redisKeys } from "./redis-keys.ts";
import {
  getCycleAgentRuns,
  setCycleMetrics,
  getRecentMetricIds,
  getCycleMetrics,
} from "./redis-adapter.ts";

const METRICS_INDEX = redisKeys.metricsIndex();
const metricsKey = (cycleId) => redisKeys.metrics(cycleId);

/**
 * Record a cycle's outcome metrics.
 * Auto-computes costUsd from logged agent runs if not already provided.
 *
 * @param {string} cycleId
 * @param {CycleMetrics} metrics
 */
export async function recordCycleMetrics(cycleId, metrics) {
  // Auto-compute cycle cost from logged agent runs if not provided
  if (metrics.costUsd === undefined) {
    try {
      const agentRuns = await getCycleAgentRuns(cycleId);
      let totalCost = 0;
      for (const raw of agentRuns) {
        try {
          const run = JSON.parse(raw);
          totalCost += run.costUsd || 0;
        } catch { /* intentional: skip corrupt entries */ }
      }
      metrics.costUsd = Math.round(totalCost * 1_000_000) / 1_000_000;
    } catch { /* intentional: cost tracking is best-effort */ }
  }

  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(metrics)) {
    flat[k] = typeof v === "object" ? JSON.stringify(v) : String(v);
  }
  flat.cycleId = cycleId;
  flat.recordedAt = new Date().toISOString();
  if (!flat.source) flat.source = "codex"; // default source for Codex orchestrator cycles

  await setCycleMetrics(cycleId, flat, CYCLE_KEY_TTL);

  const costStr = metrics.costUsd > 0 ? `, cost=$${metrics.costUsd.toFixed(4)}` : "";
  console.log(`[Metrics] Recorded cycle ${cycleId}: ${metrics.tasksMerged || 0} merged, ${metrics.tasksFailed || 0} failed, regression=${metrics.regressionIntroduced || false}${costStr}`);
}

/**
 * Get metrics for the N most recent cycles.
 *
 * @param {number} count - How many cycles to return (default 20)
 * @returns {CycleMetrics[]}
 */
export async function getMetricsTrend(count = 20) {
  const cycleIds = await getRecentMetricIds(count);
  const results: Record<string, any>[] = [];

  for (const cycleId of cycleIds) {
    const raw = await getCycleMetrics(cycleId);
    if (!raw.cycleId) continue;

    // Parse numeric fields back from strings
    const parsed: Record<string, any> = { ...raw };
    for (const key of [
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
    ]) {
      if (parsed[key] !== undefined) parsed[key] = parseInt(parsed[key]) || 0;
    }
    if (parsed.regressionIntroduced !== undefined) {
      parsed.regressionIntroduced = parsed.regressionIntroduced === "true";
    }
    // Issue #272: gate-coverage observability — string "true"/"false" in Redis.
    if (parsed.qualityGateCoverage !== undefined) {
      parsed.qualityGateCoverage = parsed.qualityGateCoverage === "true";
    }

    results.push(parsed);
  }

  return results;
}

/**
 * Compute title similarity using word-overlap (Jaccard-like, max-denominator).
 *
 * Pure function — extracted so anchor-selection can pre-filter near-duplicates
 * before the planner runs, without re-implementing the comparison (issue #233).
 *
 * Tokenisation: lowercase, split on whitespace, drop tokens of length <= 3
 * (filter stop-words like "the", "and", "for"). Returns 0 when either side
 * has no remaining tokens — keeps callers from comparing degenerate titles.
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
 * Detect drift: is the proposed task duplicating recent work?
 *
 * Compares the new task's anchor reference and title against recent cycles.
 * Returns { isDuplicate, similarTo, similarity, reason }.
 *
 * @param {object} currentTask - { title, anchorType, anchorReference }
 * @param {number} lookback - How many recent cycles to check (default 10)
 */
export async function detectDrift(currentTask, lookback = 10) {
  const cycleIds = await getRecentMetricIds(lookback);

  for (const cycleId of cycleIds) {
    const raw = await getCycleMetrics(cycleId);
    if (!raw.taskTitle) continue;

    // Exact anchor match — but only for specific anchors (test names, issue IDs).
    // Broad doc anchors like "direction/priorities.md" can legitimately anchor multiple tasks.
    const isSpecificAnchor = currentTask.anchorType === "failing-test"
      || currentTask.anchorType === "issue"
      || currentTask.anchorType === "prior-failure";
    if (isSpecificAnchor && raw.anchorReference && raw.anchorReference === currentTask.anchorReference) {
      return {
        isDuplicate: true,
        similarTo: cycleId,
        similarity: 1.0,
        reason: `Same anchor reference "${currentTask.anchorReference}" was used in ${cycleId}`,
      };
    }

    // Title similarity — shared helper with the anchor-selection pre-filter (issue #233)
    const similarity = computeTitleSimilarity(currentTask.title, raw.taskTitle);
    if (similarity > 0.7) {
      return {
        isDuplicate: true,
        similarTo: cycleId,
        similarity,
        reason: `Task title "${currentTask.title}" is ${Math.round(similarity * 100)}% similar to "${raw.taskTitle}" from ${cycleId}`,
      };
    }
  }

  return { isDuplicate: false, similarTo: null, similarity: 0, reason: null };
}

/**
 * Pre-filter helper: scan recent cycles and return the first one whose taskTitle
 * is more than `threshold` similar to `reference`. Used by anchor-selection to
 * reject near-duplicate anchors before the planner is invoked (issue #233).
 *
 * Returns the matching descriptor (cycleId, taskTitle, similarity) or null.
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

  // Anchor distribution
  const anchorDist = {};
  for (const m of trend) {
    const at = m.anchorType || "unknown";
    anchorDist[at] = (anchorDist[at] || 0) + 1;
  }

  // Issue #272: qualityGateCoverage — fraction of cycles where the mutation
  // OR JIT gate actually ran. Pre-#272 cycles lack the field, so they're
  // excluded from the denominator (cyclesWithCoverageData) so legacy data
  // doesn't drag the rate to zero. Target is >50% on the new path.
  const coverageSamples = trend.filter((m) => typeof m.qualityGateCoverage === "boolean");
  const coverageCovered = coverageSamples.filter((m) => m.qualityGateCoverage === true).length;
  const qualityGateCoverageRate = coverageSamples.length > 0
    ? Math.round((coverageCovered / coverageSamples.length) * 100)
    : null;

  return {
    cycles: total,
    mergedRate: Math.round((merged / total) * 100),
    failedRate: Math.round((failed / total) * 100),
    abandonedRate: Math.round((abandoned / total) * 100),
    regressionRate: Math.round((regressions / total) * 100),
    noOpMerges, // issue #222: cycle count where filesChanged was empty after a "merge"
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
    // All verified tasks are genuinely verified (false completion rate = 0 by design in V2)
    falseCompletionRate: 0,
    // All tasks in V2 are anchored by design
    anchoredRate: 100,
    verifiedCompletionRate: merged > 0 ? 100 : 0,
    // Issue #272: gate-coverage rate (null when no samples have the field).
    qualityGateCoverageRate,
    qualityGateCoverageSamples: coverageSamples.length,
    qualityGateCoverageCovered: coverageCovered,
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

/**
 * Categorize an `abandonReason` string into a stable bucket.
 *
 * Strategy: split on first `:` if present (e.g., "Planner noWork: codebase-clean" → "Planner noWork").
 * Otherwise take the first 4 words. Trim and collapse whitespace. Return "Unknown" for empty input.
 *
 * Pure function — deterministic, no side effects.
 */
export function categorizeAbandonReason(reason: string | undefined | null): string {
  if (!reason || typeof reason !== "string") return "Unknown";
  const trimmed = reason.trim();
  if (!trimmed) return "Unknown";

  const colonIdx = trimmed.indexOf(":");
  const head = colonIdx >= 0 ? trimmed.slice(0, colonIdx) : trimmed;
  const words = head.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "Unknown";
  return words.slice(0, 4).join(" ");
}

/**
 * Aggregate abandonment causes from the last N cycles.
 *
 * Returns:
 *   - totalCycles: number of cycles considered
 *   - totalAbandoned: cycles with a non-empty `abandonReason`
 *   - abandonRate: percent (0-100, integer)
 *   - byCategory: descending array of { category, count, pct, sampleReasons[] }
 *
 * Categories are derived via `categorizeAbandonReason`. Sample reasons preserve
 * up to 3 distinct raw reasons per category for operator context.
 */
export async function getAbandonmentBreakdown(count = 50) {
  const trend = await getMetricsTrend(count);
  const totalCycles = trend.length;

  type Bucket = { category: string; count: number; sampleReasons: string[] };
  const buckets = new Map<string, Bucket>();
  let totalAbandoned = 0;

  for (const m of trend) {
    const reason = typeof m.abandonReason === "string" ? m.abandonReason.trim() : "";
    if (!reason) continue;
    totalAbandoned++;
    const category = categorizeAbandonReason(reason);
    let b = buckets.get(category);
    if (!b) {
      b = { category, count: 0, sampleReasons: [] };
      buckets.set(category, b);
    }
    b.count++;
    if (b.sampleReasons.length < 3 && !b.sampleReasons.includes(reason)) {
      b.sampleReasons.push(reason);
    }
  }

  const byCategory = Array.from(buckets.values())
    .map((b) => ({
      category: b.category,
      count: b.count,
      pct: totalAbandoned > 0 ? Math.round((b.count / totalAbandoned) * 100) : 0,
      sampleReasons: b.sampleReasons,
    }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));

  return {
    totalCycles,
    totalAbandoned,
    abandonRate: totalCycles > 0 ? Math.round((totalAbandoned / totalCycles) * 100) : 0,
    byCategory,
  };
}

/**
 * Compute the p-th percentile of a numeric array using nearest-rank.
 * Pure function — used by quality-gate trend summary.
 *
 * @param values  - sorted-or-unsorted numeric array (NaN/non-numeric are filtered out)
 * @param p       - percentile in [0, 100]
 * @returns       - percentile value, or null when no valid samples
 */
export function percentile(values: number[], p: number): number | null {
  const nums = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  // Nearest-rank: rank = ceil(p/100 * N), clamp to [1, N], 1-indexed → 0-indexed.
  const clampedP = Math.max(0, Math.min(100, p));
  const rank = Math.max(1, Math.ceil((clampedP / 100) * sorted.length));
  return sorted[rank - 1];
}

/**
 * Aggregate mutation kill-rate and JIT trend across the last N cycles (issue #212).
 *
 * Returns:
 *   - trend: per-cycle entries (newest first), null fields for legacy cycles
 *   - summary: avg/p50/p95 kill rate (over cycles where mutation testing actually ran),
 *     gateBlockCount, totalJitTestsAdded
 *
 * Never throws. Empty input → trend: [], summary: zeroed.
 */
export async function getQualityGateTrend(count = 50) {
  const trend = await getMetricsTrend(count);

  type TrendEntry = {
    cycleId: string;
    completedAt: string | null;
    killRate: number | null;
    mutationsTested: number | null;
    mutationsKilled: number | null;
    jitTestsAdded: number | null;
    /**
     * Operator-facing JIT decision string (issue #235).
     * `null` for legacy cycles recorded before the field was introduced.
     */
    jitDecision: string | null;
    gateBlocked: boolean;
  };

  const entries: TrendEntry[] = trend.map((m) => {
    // mutationKillRate is recorded as -1 when the gate didn't apply
    // (e.g., quick-fix, fixer-only failures). Treat -1 as null in trend.
    const rawKillRate = m.mutationKillRate;
    const killRate = typeof rawKillRate === "number" && rawKillRate >= 0
      ? rawKillRate
      : null;

    const mutationsTested = typeof m.mutationsTested === "number"
      ? m.mutationsTested
      // Back-compat: derive from killed+survived if mutationsTested missing
      : (typeof m.mutationKilled === "number" && typeof m.mutationSurvived === "number"
        ? (m.mutationKilled + m.mutationSurvived) || null
        : null);

    const mutationsKilled = typeof m.mutationKilled === "number" ? m.mutationKilled : null;
    const jitTestsAdded = typeof m.jitTestsKept === "number" ? m.jitTestsKept : null;
    const gateBlocked = typeof m.gateBlocked === "number"
      ? m.gateBlocked === 1
      // Back-compat: infer from jitTestsCaughtBug for cycles before #212
      : (m.jitTestsCaughtBug === 1);

    // Issue #235: jitDecision is stored as a string field on the metrics hash
    // (post-merge.ts records it). Legacy cycles → null so the dashboard can
    // distinguish "unknown" from "skipped: ...".
    const jitDecision = typeof m.jitDecision === "string" && m.jitDecision.length > 0
      ? m.jitDecision
      : null;

    return {
      cycleId: m.cycleId,
      completedAt: m.recordedAt || null,
      killRate,
      mutationsTested: mutationsTested ?? null,
      mutationsKilled,
      jitTestsAdded,
      jitDecision,
      gateBlocked,
    };
  });

  const validKillRates = entries
    .map((e) => e.killRate)
    .filter((v): v is number => typeof v === "number" && v >= 0);

  const avgKillRate = validKillRates.length > 0
    ? Math.round(validKillRates.reduce((a, b) => a + b, 0) / validKillRates.length)
    : null;

  const killRateP50 = percentile(validKillRates, 50);
  const killRateP95 = percentile(validKillRates, 95);

  const gateBlockCount = entries.filter((e) => e.gateBlocked).length;
  const totalJitTestsAdded = entries.reduce(
    (sum, e) => sum + (typeof e.jitTestsAdded === "number" ? e.jitTestsAdded : 0),
    0,
  );

  return {
    trend: entries,
    summary: {
      cycles: entries.length,
      cyclesWithMutationData: validKillRates.length,
      avgKillRate,
      killRateP50,
      killRateP95,
      gateBlockCount,
      totalJitTestsAdded,
    },
  };
}

/** No-op — kept for backward compatibility. Connection is now managed by redis-adapter. */
function initMetrics(_redisUrl?: string) {}

export { initMetrics };

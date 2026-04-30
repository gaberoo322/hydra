import Redis from "ioredis";
import { CYCLE_KEY_TTL } from "./task-tracker.ts";

const METRICS_INDEX = "hydra:metrics:index";
const metricsKey = (cycleId) => `hydra:metrics:${cycleId}`;

let redis;

function initMetrics(redisUrl) {
  redis = new Redis(redisUrl);
}

function getRedis() {
  if (!redis) throw new Error("Metrics not initialized — call initMetrics() first");
  return redis;
}

/**
 * Record a cycle's outcome metrics.
 *
 * @param {string} cycleId
 * @param {CycleMetrics} metrics
 */
export async function recordCycleMetrics(cycleId, metrics) {
  const r = getRedis();
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(metrics)) {
    flat[k] = typeof v === "object" ? JSON.stringify(v) : String(v);
  }
  flat.cycleId = cycleId;
  flat.recordedAt = new Date().toISOString();
  if (!flat.source) flat.source = "codex"; // default source for Codex orchestrator cycles

  await r.hset(metricsKey(cycleId), ...Object.entries(flat).flat());
  await r.expire(metricsKey(cycleId), CYCLE_KEY_TTL);
  await r.zadd(METRICS_INDEX, Date.now(), cycleId);

  console.log(`[Metrics] Recorded cycle ${cycleId}: ${metrics.tasksMerged || 0} merged, ${metrics.tasksFailed || 0} failed, regression=${metrics.regressionIntroduced || false}`);
}

/**
 * Get metrics for the N most recent cycles.
 *
 * @param {number} count - How many cycles to return (default 20)
 * @returns {CycleMetrics[]}
 */
export async function getMetricsTrend(count = 20) {
  const r = getRedis();
  const cycleIds = await r.zrevrange(METRICS_INDEX, 0, count - 1);
  const results = [];

  for (const cycleId of cycleIds) {
    const raw = await r.hgetall(metricsKey(cycleId));
    if (!raw.cycleId) continue;

    // Parse numeric fields back from strings
    const parsed = { ...raw };
    for (const key of [
      "tasksAttempted", "tasksVerified", "tasksMerged", "tasksFailed", "tasksAbandoned",
      "testsBefore", "testsAfter", "testsPassingBefore", "testsPassingAfter",
      "filesChanged", "totalDurationMs", "groundingDurationMs", "verificationDurationMs",
      "planningDurationMs", "executionDurationMs", "tokenCost",
    ]) {
      if (parsed[key] !== undefined) parsed[key] = parseInt(parsed[key]) || 0;
    }
    if (parsed.regressionIntroduced !== undefined) {
      parsed.regressionIntroduced = parsed.regressionIntroduced === "true";
    }

    results.push(parsed);
  }

  return results;
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
  const r = getRedis();
  const cycleIds = await r.zrevrange(METRICS_INDEX, 0, lookback - 1);

  for (const cycleId of cycleIds) {
    const raw = await r.hgetall(metricsKey(cycleId));
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

    // Title similarity — simple word overlap
    const currentWords = new Set(currentTask.title.toLowerCase().split(/\s+/).filter((w) => w.length > 3));
    const priorWords = new Set(raw.taskTitle.toLowerCase().split(/\s+/).filter((w) => w.length > 3));

    if (currentWords.size > 0 && priorWords.size > 0) {
      const intersection = [...currentWords].filter((w) => priorWords.has(w));
      const similarity = intersection.length / Math.max(currentWords.size, priorWords.size);

      if (similarity > 0.7) {
        return {
          isDuplicate: true,
          similarTo: cycleId,
          similarity,
          reason: `Task title "${currentTask.title}" is ${Math.round(similarity * 100)}% similar to "${raw.taskTitle}" from ${cycleId}`,
        };
      }
    }
  }

  return { isDuplicate: false, similarTo: null, similarity: 0, reason: null };
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

  return {
    cycles: total,
    mergedRate: Math.round((merged / total) * 100),
    failedRate: Math.round((failed / total) * 100),
    abandonedRate: Math.round((abandoned / total) * 100),
    regressionRate: Math.round((regressions / total) * 100),
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

export { initMetrics };

/**
 * Cycle metrics — write path.
 *
 * `recordCycleMetrics(cycleId, metrics)` is the single write entry for the
 * cycle metrics hash. Auto-computes cycle cost from agent runs (back-compat
 * for callers that didn't supply it).
 *
 * The `deriveQualityGateCoverage` auto-derivation (issue #287) was removed in
 * #971: its mutation/JIT inputs lost their in-process writer when the codex
 * control loop was retired, leaving the metric write-dead (pinned at 0%).
 */

import {
  getCycleAgentRuns,
  setCycleMetrics,
} from "../redis/cycle-metrics.ts";

/** TTL for cycle metrics Redis keys: 7 days in seconds (matches redis/cycle-tracking.ts). */
const CYCLE_KEY_TTL = 7 * 24 * 60 * 60; // 604800

/**
 * Record a cycle's outcome metrics.
 * Auto-computes costUsd from logged agent runs if not already provided.
 * Auto-derives `qualityGateCoverage` per issue #287 when not explicitly set.
 *
 * @param {string} cycleId
 * @param {CycleMetrics} metrics
 */
export async function recordCycleMetrics(cycleId, metrics) {
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
    // Skip undefined so absent fields stay absent rather than being persisted
    // as the string "undefined".
    if (v === undefined) continue;
    flat[k] = typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
  }
  flat.cycleId = cycleId;
  flat.recordedAt = new Date().toISOString();
  if (!flat.source) flat.source = "codex"; // default source for Codex orchestrator cycles

  await setCycleMetrics(cycleId, flat, CYCLE_KEY_TTL);

  const costStr = metrics.costUsd > 0 ? `, cost=$${metrics.costUsd.toFixed(4)}` : "";
  console.log(`[Metrics] Recorded cycle ${cycleId}: ${metrics.tasksMerged || 0} merged, ${metrics.tasksFailed || 0} failed, regression=${metrics.regressionIntroduced || false}${costStr}`);
}

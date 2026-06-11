/**
 * Cycle metrics — write path.
 *
 * `recordCycleMetrics(cycleId, metrics)` is the single write entry for the
 * cycle metrics hash. The USD cost fields that used to ride along here were
 * retired with the writer-less USD attribution plane (#1561 → #1651, per
 * ADR-0016): orchestrator spend truth is the token plane.
 *
 * The `deriveQualityGateCoverage` auto-derivation (issue #287) was removed in
 * #971: its mutation/JIT inputs lost their in-process writer when the codex
 * control loop was retired, leaving the metric write-dead (pinned at 0%).
 */

import { setCycleMetrics } from "../redis/cycle-metrics.ts";

/** TTL for cycle metrics Redis keys: 7 days in seconds (matches redis/cycle-tracking.ts). */
const CYCLE_KEY_TTL = 7 * 24 * 60 * 60; // 604800

/**
 * Record a cycle's outcome metrics.
 *
 * @param {string} cycleId
 * @param {CycleMetrics} metrics
 */
export async function recordCycleMetrics(cycleId, metrics) {
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

  console.log(`[Metrics] Recorded cycle ${cycleId}: ${metrics.tasksMerged || 0} merged, ${metrics.tasksFailed || 0} failed, regression=${metrics.regressionIntroduced || false}`);
}

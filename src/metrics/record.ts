/**
 * Cycle metrics — write path.
 *
 * `recordCycleMetrics(cycleId, metrics)` is the single write entry for the
 * cycle metrics hash. Auto-computes cycle cost from agent runs (back-compat
 * for callers that didn't supply it) and auto-derives `qualityGateCoverage`
 * via `deriveQualityGateCoverage` so cycles that exited before verification
 * land as "not-applicable" rather than dropping out of the rate denominator
 * (issue #287).
 */

import { CYCLE_KEY_TTL } from "../task-tracker.ts";
import {
  getCycleAgentRuns,
  setCycleMetrics,
} from "../redis-adapter.ts";
import { deriveQualityGateCoverage } from "./quality-gates.ts";

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

  // Issue #287: derive qualityGateCoverage so cycles that ran verification but
  // skipped the gate (or that didn't reach verification) get an explicit
  // false / not-applicable instead of dropping out of the rate denominator.
  const derivedCoverage = deriveQualityGateCoverage(metrics);
  if (derivedCoverage !== undefined) {
    metrics.qualityGateCoverage = derivedCoverage;
  } else {
    // Verification did not run — strip the field so it is genuinely absent
    // in Redis (parses back as undefined → "not applicable").
    delete metrics.qualityGateCoverage;
  }

  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(metrics)) {
    // Issue #287: skip undefined so "not-applicable" stays absent rather than
    // being persisted as the string "undefined".
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

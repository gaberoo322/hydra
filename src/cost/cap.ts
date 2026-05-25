/**
 * cap.ts — Per-cycle cost cap circuit breaker (issue #209, #286)
 *
 * Bug: There was no per-cycle cost cap on the build loop. Abandoned cycles
 * could consume up to $56 each before hitting their abandonment gate
 * (Preflight, Auto-decompose, Planner noWork). With ~31 abandoned cycles
 * in 50, this was the dominant cost-leak class.
 *
 * Fix: Track accumulated agent cost per cycle (via the existing
 * `costMicrodollars` Redis field that `task-tracker.logAgentRun` already
 * maintains). Reading this module's `checkCostCap()` after each agent
 * invocation tells the caller whether `HYDRA_PER_CYCLE_COST_CAP_USD`
 * (default $25) has been exceeded; callers abandon the cycle with reason
 * `Cost cap exceeded: $X.XX >= $Y` so it shows up as a distinct
 * abandonment category in `/api/metrics/abandonment`.
 *
 * Post-cutover surface
 * --------------------
 * Issue #286 ("Mid-stream projection") and the inter-step `runCostCapCheck`
 * gate it referenced both lived inside `codex-runner.ts`, which was deleted
 * in PR-3 (issue #383, ADR-0006). Streaming-projection abort was a codex-
 * SDK feature that has no analogue under autopilot subagents — the harness,
 * not this module, owns mid-call abort. Today this module exposes only the
 * post-call cap reads: `getCycleCostUsd`, `getCycleCostWithSurrogateUsd`,
 * and `checkCostCap`.
 *
 * Design notes
 * ------------
 * - This module is environment-driven and side-effect-free aside from
 *   reading from Redis. The check is cheap (one HGET).
 * - We still record cycle metrics on abort so we keep observability
 *   into how much each abort cost.
 * - Honors `Infinity` semantics consistent with `HYDRA_DAILY_COST_CAP_USD`:
 *   absent or non-finite env value → cap is `Infinity` (effectively off).
 */

import { getCycleCostMicrodollars } from "../redis/cycle-metrics.ts";
import { getCycleSubagentCostUsd } from "./surrogate.ts";

/**
 * Stable abandonment reason prefix. Tests assert on this; do NOT change
 * without bumping the reason category in `metrics.ts` consumers.
 */
export const COST_CAP_REASON_PREFIX = "Cost cap exceeded";

/**
 * Resolve the per-cycle cost cap from env. Returns Infinity if unset
 * or non-finite (matches `DAILY_COST_CAP_USD` semantics).
 *
 * Pure function — re-reads env each call so tests can mutate and
 * production callers see config-reload changes (e.g. via systemd
 * `EnvironmentFile=` reload + service restart).
 */
export function getPerCycleCostCapUsd(): number {
  const raw = process.env.HYDRA_PER_CYCLE_COST_CAP_USD;
  if (raw === undefined || raw === "") {
    return 25; // default $25
  }
  // Allow operators to disable via "Infinity" or "0" (treat 0 as off too).
  if (raw === "Infinity" || raw === "infinity") return Infinity;
  const parsed = parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return Infinity;
  return parsed;
}

/**
 * Read the current accumulated cost (in USD) for the given cycle.
 * Returns 0 if the cycle has no recorded spend yet (e.g. fresh cycle
 * before the first agent run, or Redis read fails — fail-open since
 * the cap is a safety net, not a correctness guarantee).
 */
export async function getCycleCostUsd(cycleId: string): Promise<number> {
  try {
    const micro = await getCycleCostMicrodollars(cycleId);
    if (!micro) return 0;
    const parsed = parseInt(micro);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return parsed / 1_000_000;
  } catch (err: any) {
    console.error(`[CostCap] Failed to read cycle cost for ${cycleId}: ${err.message}`);
    return 0;
  }
}

export interface CostCapStatus {
  /** Current accumulated spend for the cycle. */
  costUsd: number;
  /** Configured cap (Infinity if disabled). */
  capUsd: number;
  /** True if accumulated cost has met or exceeded the cap. */
  exceeded: boolean;
  /** Human-readable abandonment reason (only meaningful when `exceeded`). */
  reason: string;
  /** Issue #394: which writers contributed to costUsd. `"codex-recorded"`
   *  means only the legacy codex `costMicrodollars` path is active;
   *  `"autopilot-surrogate"` means only post-cut subagent tokens contributed;
   *  `"mixed"` means both. Allows operators to tell whether a cap trip
   *  was caused by surrogate-only inflation. */
  source?: "codex-recorded" | "autopilot-surrogate" | "mixed" | "none";
  /** Surrogate-only USD contribution (subset of costUsd). */
  surrogateUsd?: number;
}

/**
 * Read the cycle's combined spend — legacy codex `costMicrodollars` PLUS
 * the post-cut subagent-token surrogate (issue #394).
 *
 * Codex was removed in PR-3 (issue #383). The legacy field will be 0 in
 * any post-cut cycle; the surrogate is the only spend signal left for
 * cap purposes. The legacy reader is preserved so historical pre-cut
 * cycles, and any cross-over period, still report correctly.
 */
export async function getCycleCostWithSurrogateUsd(cycleId: string): Promise<{
  costUsd: number;
  legacyUsd: number;
  surrogateUsd: number;
  source: "codex-recorded" | "autopilot-surrogate" | "mixed" | "none";
}> {
  const legacyUsd = await getCycleCostUsd(cycleId);
  let surrogateUsd = 0;
  try {
    const surrogate = await getCycleSubagentCostUsd(cycleId);
    surrogateUsd = surrogate.costUsd;
  } catch (err: any) {
    console.error(`[CostCap] surrogate read failed for ${cycleId}: ${err?.message || err}`);
  }
  const total = legacyUsd + surrogateUsd;
  let source: "codex-recorded" | "autopilot-surrogate" | "mixed" | "none";
  if (legacyUsd > 0 && surrogateUsd > 0) source = "mixed";
  else if (surrogateUsd > 0) source = "autopilot-surrogate";
  else if (legacyUsd > 0) source = "codex-recorded";
  else source = "none";
  return { costUsd: total, legacyUsd, surrogateUsd, source };
}

/**
 * Check whether the cycle has exceeded its cost cap.
 *
 * Returns the current cost, configured cap, and a stable reason string
 * suitable for use as `abandonReason` in cycle metrics. The reason
 * always begins with `COST_CAP_REASON_PREFIX` so the abandonment-metrics
 * categorizer buckets it consistently.
 */
export async function checkCostCap(cycleId: string): Promise<CostCapStatus> {
  const capUsd = getPerCycleCostCapUsd();
  // Issue #394: cap now considers BOTH the legacy codex per-cycle cost
  // (read from `costMicrodollars`) AND the post-cut subagent surrogate
  // (`hydra:metrics:tokens:by-cycle:<id>`). Pre-cut cycles still report
  // identical numbers because the surrogate is zero unless tokens were
  // recorded. Post-cut cycles see the surrogate where they used to see 0.
  const { costUsd, surrogateUsd, source } = await getCycleCostWithSurrogateUsd(cycleId);
  const exceeded = Number.isFinite(capUsd) && costUsd >= capUsd;
  const capStr = Number.isFinite(capUsd) ? `$${capUsd.toFixed(2)}` : "Infinity";
  const reason = exceeded
    ? `${COST_CAP_REASON_PREFIX}: $${costUsd.toFixed(2)} >= ${capStr}`
    : `${COST_CAP_REASON_PREFIX}: under cap ($${costUsd.toFixed(2)} < ${capStr})`;
  return { costUsd, capUsd, exceeded, reason, source, surrogateUsd };
}

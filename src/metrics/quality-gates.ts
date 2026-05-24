/**
 * Quality-gate signals — derivation, percentiles, trend aggregation.
 *
 * `deriveQualityGateCoverage` is the bridge between recordCycleMetrics()
 * and the gate-coverage observability surface (issue #287). `percentile`
 * + `getQualityGateTrend` feed the /metrics/quality-gates endpoint
 * (issue #212).
 */

/**
 * Derive `qualityGateCoverage` from other metric signals when callers haven't
 * set it explicitly (issue #287).
 *
 * Pre-#287 only the post-merge path recorded the field — every other early-exit
 * (verification failure, mutation-gate block, JIT bug catch, drift, planner
 * no-work, preflight rejection, cost-cap) silently dropped out of the
 * denominator, biasing the rate upward (3/20 samples → reported 33% even
 * though the true denominator was 20).
 *
 * Rules:
 *   - explicit value wins (post-merge keeps its precise truth)
 *   - mutation OR JIT actually produced output → "true" (gate did useful work)
 *   - verification ran but neither gate did → "false" (explicit miss)
 *   - verification did not run at all → absent (null / not-applicable)
 *
 * Pure function — exported for unit tests.
 */
export function deriveQualityGateCoverage(metrics: Record<string, any>): "true" | "false" | undefined {
  // Caller already set it — preserve their value (boolean OR string form).
  if (metrics.qualityGateCoverage !== undefined && metrics.qualityGateCoverage !== null) {
    if (typeof metrics.qualityGateCoverage === "boolean") {
      return metrics.qualityGateCoverage ? "true" : "false";
    }
    const s = String(metrics.qualityGateCoverage).toLowerCase();
    if (s === "true" || s === "false") return s as "true" | "false";
    // Unknown explicit value — fall through to derive.
  }

  // Did mutation OR JIT actually run? Any of these signals means a gate
  // produced real output for this cycle.
  const mutationsTested = typeof metrics.mutationsTested === "number" ? metrics.mutationsTested : 0;
  const mutationKillRate = typeof metrics.mutationKillRate === "number" ? metrics.mutationKillRate : -1;
  const mutationDecision = typeof metrics.mutationDecision === "string" ? metrics.mutationDecision : "";
  const jitTestsGenerated = typeof metrics.jitTestsGenerated === "number" ? metrics.jitTestsGenerated : 0;
  const jitTestsKept = typeof metrics.jitTestsKept === "number" ? metrics.jitTestsKept : 0;
  const jitTestsCaughtBug = typeof metrics.jitTestsCaughtBug === "number" ? metrics.jitTestsCaughtBug : 0;
  const jitDecision = typeof metrics.jitDecision === "string" ? metrics.jitDecision : "";

  const mutationRan = mutationDecision === "ran" || mutationsTested > 0 || mutationKillRate >= 0;
  const jitRan = jitDecision.startsWith("ran")
    || jitTestsGenerated > 0
    || jitTestsKept > 0
    || jitTestsCaughtBug > 0;
  if (mutationRan || jitRan) return "true";

  // Did verification run at all? Any of these signals means we got past
  // the executor and into the verification step (test/typecheck/build).
  // tasksAttempted alone is not enough — drift-rejected and preflight-rejected
  // cycles also set tasksAttempted=1 without running verification.
  const verificationDurationMs = typeof metrics.verificationDurationMs === "number"
    ? metrics.verificationDurationMs : 0;
  const tasksVerified = typeof metrics.tasksVerified === "number" ? metrics.tasksVerified : 0;
  const tasksMerged = typeof metrics.tasksMerged === "number" ? metrics.tasksMerged : 0;
  // tasksFailed only counts as "verification ran" when not paired with an
  // abandonReason indicating pre-verification exit (drift, preflight, cost-cap).
  const tasksFailed = typeof metrics.tasksFailed === "number" ? metrics.tasksFailed : 0;
  const abandonReason = typeof metrics.abandonReason === "string" ? metrics.abandonReason : "";
  const preVerificationAbandon = abandonReason.length > 0; // any abandonReason means we exited early

  const verificationRan = verificationDurationMs > 0
    || tasksVerified > 0
    || tasksMerged > 0
    || (tasksFailed > 0 && !preVerificationAbandon);

  return verificationRan ? "false" : undefined;
}

/**
 * Compute the p-th percentile of a numeric array using nearest-rank.
 * Pure function — used by quality-gate trend summary.
 */
export function percentile(values: number[], p: number): number | null {
  const nums = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const clampedP = Math.max(0, Math.min(100, p));
  const rank = Math.max(1, Math.ceil((clampedP / 100) * sorted.length));
  return sorted[rank - 1];
}

import { getMetricsTrend } from "./trend.ts";

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
    const rawKillRate = m.mutationKillRate;
    const killRate = typeof rawKillRate === "number" && rawKillRate >= 0
      ? rawKillRate
      : null;

    const mutationsTested = typeof m.mutationsTested === "number"
      ? m.mutationsTested
      : (typeof m.mutationKilled === "number" && typeof m.mutationSurvived === "number"
        ? (m.mutationKilled + m.mutationSurvived) || null
        : null);

    const mutationsKilled = typeof m.mutationKilled === "number" ? m.mutationKilled : null;
    const jitTestsAdded = typeof m.jitTestsKept === "number" ? m.jitTestsKept : null;
    const gateBlocked = typeof m.gateBlocked === "number"
      ? m.gateBlocked === 1
      : (m.jitTestsCaughtBug === 1);

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

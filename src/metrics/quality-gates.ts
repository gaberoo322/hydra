/**
 * Quality-gate signals — percentiles + mutation/JIT trend aggregation.
 *
 * `percentile` + `getQualityGateTrend` feed the /metrics/quality-gates
 * endpoint (issue #212), reading the same `mutationKillRate` / `jitTestsKept`
 * cycle fields that `src/aggregators/builder-health.ts` renders.
 *
 * The `deriveQualityGateCoverage` derivation (issue #287) was retired in #971:
 * its mutation/JIT inputs lost their in-process writer when the codex control
 * loop was removed (ADR-0006 / ADR-0012 — the mutation gate moved to CI), so
 * the derived `qualityGateCoverage` metric was structurally pinned at 0% and
 * fed nothing live.
 */

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

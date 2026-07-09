/**
 * Cycle-metrics trend-rollup aggregations consumed by /metrics, /summary, and
 * planner-facing accomplishments — rolling merge-rate, aggregate stats,
 * cumulative accomplishments, anchor distribution, fix:feature ratio. Pure
 * compositions over getMetricsTrend() — no Redis access of their own.
 *
 * Per-class cost attribution (the `CostClass` / `skillToCostClass` /
 * `projectCostByClass` / `getCostByClass` surface) was relocated to the Cost
 * module at `src/cost/cost-attribution.ts` (issue #2219) so the Cost domain's
 * knowledge concentrates under `src/cost/`; import those symbols from
 * `../cost/index.ts`.
 */

import { getMetricsTrend } from "./trend.ts";

/**
 * Pure projection: the rolling merge-rate of a metrics-trend window, as a
 * rounded percentage (`Math.round((mergedCount / total) * 100)`).
 *
 * A cycle counts as "merged" when its persisted `tasksMerged` field is > 0.
 * The predicate is null-safe (`(m?.tasksMerged ?? 0) > 0`) — identical to the
 * bare `m.tasksMerged > 0` on real data (`undefined > 0 === false`) and
 * strictly safer on null/undefined entries.
 *
 * Returns `null` on an empty trend (not `0`): callers must treat "no data" as
 * distinct from "0% merged" so a healthy fresh start is never misreported as a
 * stall (issue #232 — the heartbeat false-stall guard depends on this null).
 *
 * Single source of truth for the `tasksMerged>0 → rounded percentage`
 * arithmetic, consumed by `projectAggregateStats` (the `/metrics` `mergedRate`)
 * and `scheduler/heartbeat.ts::computeRollingMergeRate` (the `/api/scheduler/status`
 * rolling merge-rate). The two out-of-scope `parseInt`-coercing sites
 * (`digest-format.ts`, `health/diagnostics.ts`) deliberately do NOT delegate
 * here — folding them would change string-coercion semantics (issue #2169).
 */
export function computeRollingMergeRateFromTrend(
  trend: Array<Record<string, any>>,
): number | null {
  if (trend.length === 0) return null;
  const merged = trend.filter((m) => (m?.tasksMerged ?? 0) > 0).length;
  return Math.round((merged / trend.length) * 100);
}

/**
 * Pure projection: the rolling EMPTY-cycle rate of a metrics-trend window, as a
 * rounded percentage (`Math.round((emptyCount / total) * 100)`).
 *
 * An "empty cycle" (a.k.a. "unaccounted cycle", issue #1919) is a cycle that
 * attempted work but produced no terminal outcome — the read-side mirror of the
 * write-side `bucketCycleStatus() === null` bucket. The predicate is EXACTLY
 * `tasksAttempted>0 && tasksMerged==0 && tasksFailed==0 && tasksAbandoned==0`,
 * null-safe on missing entries (`m?.field ?? 0`). This 1:1 correspondence with
 * the write-path `unaccounted` bucket is an invariant: if a status is ever added
 * to `MERGED_STATUSES`/`FAILED_STATUSES`, the two definitions must stay aligned.
 *
 * Returns `null` on an empty trend (not `0`): callers must treat "no data" as
 * distinct from "0% empty" so a healthy fresh start is never misreported (the
 * same #232 null-on-empty discipline `computeRollingMergeRateFromTrend` uses).
 *
 * Rolling WINDOW gauge, never lifetime — historical unaccounted cycles (the
 * 7772-cycle skew that motivated the #232 merge-rate window) must not distort
 * the live empty-rate signal. Consumed by `scheduler/heartbeat.ts` for the
 * `/api/scheduler/status` `emptyRateWindow` surface (issue #2818).
 */
export function computeEmptyRateFromTrend(
  trend: Array<Record<string, any>>,
): number | null {
  if (trend.length === 0) return null;
  const empty = trend.filter(
    (m) =>
      (m?.tasksAttempted ?? 0) > 0 &&
      (m?.tasksMerged ?? 0) === 0 &&
      (m?.tasksFailed ?? 0) === 0 &&
      (m?.tasksAbandoned ?? 0) === 0,
  ).length;
  return Math.round((empty / trend.length) * 100);
}

/**
 * Pure projection: tokens-per-merged-PR over a metrics-trend window — the
 * sanctioned cost-per-merge fitness metric under the token plane (ADR-0016;
 * Quota-Weighted Burn). Cost is TOKENS, never dollars (costUsd is retired,
 * #1651/#704) — this projection reads only the `tokenCost` field the trend
 * joins from `hydra:metrics:tokens:cycle:<id>` (issue #2930).
 *
 * A cycle contributes only when it BOTH merged (`tasksMerged > 0`) AND carries a
 * non-null joined `tokenCost` (a real per-cycle token record). Cycles whose
 * `tokenCost` is null are UNATTRIBUTED — they are excluded from both the token
 * sum and the merged-cycle count, so the average is over the attributed subset,
 * never diluted by a fabricated 0 (truthful-sentinel discipline).
 *
 * Returns `null` (not 0) when no merged cycle in the window carries a token
 * record — "unattributed" stays distinct from "0 tokens per merge", mirroring
 * the null-on-empty discipline of `computeRollingMergeRateFromTrend`.
 *
 * Exported so the test suite can pin the arithmetic on a synthetic trend array
 * without a live Redis fetch.
 */
export function projectTokensPerMergedPR(
  trend: Array<Record<string, any>>,
): number | null {
  let tokenSum = 0;
  let mergedWithTokens = 0;
  for (const m of trend) {
    const merged = (m?.tasksMerged ?? 0) > 0;
    const tokenCost = m?.tokenCost;
    if (merged && typeof tokenCost === "number" && Number.isFinite(tokenCost)) {
      tokenSum += tokenCost;
      mergedWithTokens += 1;
    }
  }
  if (mergedWithTokens === 0) return null;
  return Math.round(tokenSum / mergedWithTokens);
}

// ---------------------------------------------------------------------------
// Cost-by-outcome — a pure DERIVED read: token cost split by cycle outcome
// (issue #3024).
// ---------------------------------------------------------------------------
//
// Answers "what is the token cost of empty cycles vs failed retries vs
// successful merges?" — the cost/outcome granularity #3024 asked for. This is a
// PURE DERIVED read sitting beside `projectTokensPerMergedPR`, matching the
// token-plane "derive, don't record" invariant its two nearest precedents lock
// (design-concept 99ef93a0 / #2807 cost-per-merged-PR and 4d98ab3d / #2971 QA
// efficiency): NO new `outcomeType` writer, NO USD/dollar surface. Both inputs
// are already persisted — per-cycle `tokenCost` is joined into every
// getMetricsTrend() row, and the outcome is fully derivable from the
// `tasksMerged`/`tasksFailed`/`tasksAbandoned`/`tasksAttempted` fields
// recordCycleMetrics already stores.

/** The three cycle-outcome buckets. Local type, no CONTEXT.md term (the concept
 * already exists un-named as Empty Cycle + the merge/fail predicates). */
export type CycleOutcome = "merged" | "empty" | "failed";

/** Stable ordering for the buckets in the wire shape. */
export const CYCLE_OUTCOME_ORDER: readonly CycleOutcome[] = Object.freeze([
  "merged",
  "empty",
  "failed",
]);

/** One outcome bucket's cost line. */
interface CostByOutcomeEntry {
  /** Cycles that fell in this bucket over the window (attributed OR not). */
  cycles: number;
  /**
   * Tokens summed over ONLY the cycles in this bucket that carry a finite joined
   * `tokenCost`. A cycle whose `tokenCost` is null/absent counts toward `cycles`
   * but contributes 0 here — the truthful-unattributed sentinel, never a
   * fabricated 0 (identical to `projectTokensPerMergedPR`).
   */
  attributedTokens: number;
  /** Count of cycles in this bucket that carried a finite `tokenCost` — the
   * denominator of `tokensPerCycle` and the operator's coverage signal. */
  attributedCycles: number;
  /**
   * Derived: `attributedTokens / attributedCycles`, rounded to the nearest
   * integer token. `null` when `attributedCycles` is 0 — "unattributed" stays
   * distinct from "0 tokens per cycle", mirroring `projectTokensPerMergedPR`'s
   * null-on-no-attribution discipline. Consumers render `null` as "—".
   */
  tokensPerCycle: number | null;
}

export interface CostByOutcomeResult {
  /** Total cycles in the window (sum of the three buckets' `cycles`). */
  windowCycles: number;
  /**
   * Per-outcome cost keyed by CycleOutcome; every outcome present (zeros
   * included, in `CYCLE_OUTCOME_ORDER`) so the operator can compare merged vs
   * empty vs failed on the same basis even when a bucket is empty.
   */
  byOutcome: Record<CycleOutcome, CostByOutcomeEntry>;
}

/**
 * Classify a single trend row into its cycle outcome, reusing the EXACT field
 * checks the two live rate gauges use so the three-way split can never disagree
 * with `computeRollingMergeRateFromTrend` / `computeEmptyRateFromTrend`:
 *   - `merged` := tasksMerged>0                    (computeRollingMergeRateFromTrend)
 *   - `empty`  := tasksAttempted>0 && merged==0 && failed==0 && abandoned==0
 *                                                  (computeEmptyRateFromTrend / Empty Cycle)
 *   - `failed` := everything else that attempted work (tasksFailed>0 || tasksAbandoned>0)
 *
 * Returns `null` for a row that attempted no work AND merged nothing (no
 * terminal signal at all) — such rows contribute to no bucket, matching the
 * "attempted work" gate the empty/failed predicates share. Null-safe on missing
 * fields (`?? 0`), same as the sibling gauges.
 */
function classifyCycleOutcome(m: Record<string, any>): CycleOutcome | null {
  const merged = (m?.tasksMerged ?? 0) > 0;
  if (merged) return "merged";
  const failed = (m?.tasksFailed ?? 0) > 0 || (m?.tasksAbandoned ?? 0) > 0;
  if (failed) return "failed";
  const attempted = (m?.tasksAttempted ?? 0) > 0;
  if (attempted) return "empty";
  return null;
}

/**
 * Pure projection: split a metrics-trend window's token cost by cycle outcome
 * (merged / empty / failed) — the #3024 cost-granularity read.
 *
 * For each outcome bucket it reports {cycles, attributedTokens, attributedCycles,
 * tokensPerCycle}. `tokenCost` is read only when finite (the truthful sentinel):
 * a cycle with null/absent `tokenCost` still counts toward its bucket's `cycles`
 * but contributes 0 to `attributedTokens` and is excluded from the
 * `tokensPerCycle` denominator — never diluting the average with a fabricated 0,
 * exactly as `projectTokensPerMergedPR` handles unattributed cycles.
 *
 * Cost is TOKENS, never dollars (the USD attribution plane was retired, #1651;
 * CONTEXT.md `Cost` / `Quota-Burn Weight`) — this reads only the `tokenCost`
 * field the trend joins.
 *
 * Exported so the test suite can pin the arithmetic on a synthetic trend array
 * without a live Redis fetch.
 */
export function projectCostByOutcome(
  trend: Array<Record<string, any>>,
): CostByOutcomeResult {
  const byOutcome: Record<CycleOutcome, CostByOutcomeEntry> = {
    merged: { cycles: 0, attributedTokens: 0, attributedCycles: 0, tokensPerCycle: null },
    empty: { cycles: 0, attributedTokens: 0, attributedCycles: 0, tokensPerCycle: null },
    failed: { cycles: 0, attributedTokens: 0, attributedCycles: 0, tokensPerCycle: null },
  };

  let windowCycles = 0;
  for (const m of trend) {
    const outcome = classifyCycleOutcome(m);
    if (outcome === null) continue; // no terminal signal — attributed to no bucket
    windowCycles += 1;
    const entry = byOutcome[outcome];
    entry.cycles += 1;
    const tokenCost = m?.tokenCost;
    if (typeof tokenCost === "number" && Number.isFinite(tokenCost)) {
      entry.attributedTokens += tokenCost;
      entry.attributedCycles += 1;
    }
  }

  for (const outcome of CYCLE_OUTCOME_ORDER) {
    const entry = byOutcome[outcome];
    entry.tokensPerCycle =
      entry.attributedCycles > 0
        ? Math.round(entry.attributedTokens / entry.attributedCycles)
        : null;
  }

  return { windowCycles, byOutcome };
}

/**
 * Get the token cost broken down by cycle outcome over a recent trend window.
 *
 * Thin wrapper: fetch the trend (the `count` knob), then delegate the split to
 * the pure `projectCostByOutcome`. No new Redis write path — a derived read over
 * the `tokenCost` + outcome fields the trend already joins (issue #3024).
 */
export async function getCostByOutcome(count = 200): Promise<CostByOutcomeResult> {
  const trend = await getMetricsTrend(count);
  return projectCostByOutcome(trend);
}

/**
 * Pure projection: fold an already-fetched metrics-trend array into the
 * aggregate-stats shape (`mergedRate` / `regressionRate` / `noOpMergeRate` /
 * the duration averages / the anchor distribution).
 *
 * Extracted verbatim from the inline body of `getAggregateStats` (issue #2143)
 * so the rate arithmetic is unit-testable on a synthetic trend array without a
 * live Redis fetch — matching the discipline of `projectCostByClass`,
 * `projectAnchorDistribution`, and `projectGroundingDuration`. The empty-trend
 * guard (`return { cycles: 0 }`) moves here verbatim so no rate divides by
 * total=0. The async `getAggregateStats` wrapper keeps the `count` knob and the
 * Redis fetch; this function only does arithmetic.
 */
export function projectAggregateStats(trend: Array<Record<string, any>>) {
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

  const anchorDist: Record<string, number> = {};
  for (const m of trend) {
    const at = m.anchorType || "unknown";
    anchorDist[at] = (anchorDist[at] || 0) + 1;
  }

  return {
    cycles: total,
    // Delegate the rolling merge-rate arithmetic to the shared pure helper so
    // it lives in exactly one place (issue #2169). The trend.length===0 guard
    // above means total>0 here, so the helper returns a number, never null.
    mergedRate: computeRollingMergeRateFromTrend(trend),
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
    // Issue #2930: sanctioned cost-per-merge fitness metric in TOKENS (never
    // USD). null when no merged cycle in the window carries a joined token
    // record — the truthful unattributed sentinel, not a fabricated 0.
    tokensPerMergedPR: projectTokensPerMergedPR(trend),
    anchorDistribution: anchorDist,
    falseCompletionRate: 0,
    anchoredRate: 100,
    verifiedCompletionRate: merged > 0 ? 100 : 0,
  };
}

/**
 * Compute aggregate stats from metrics trend.
 *
 * Thin wrapper: fetch the rolling trend window from Redis (the `count` knob),
 * then delegate the arithmetic to the pure `projectAggregateStats`.
 */
export async function getAggregateStats(count = 20) {
  const trend = await getMetricsTrend(count);
  return projectAggregateStats(trend);
}

/**
 * Pure projection: filter + map an already-fetched metrics-trend array into the
 * cumulative-accomplishments list (merged cycles with a title). Extracted from
 * `getCumulativeAccomplishments` (issue #2143) so the merged-and-titled filter
 * is unit-testable on synthetic fixtures without a live Redis. An empty trend
 * yields `[]` (a `.filter().map()` over `[]`), so no guard is needed.
 */
export function projectCumulativeAccomplishments(trend: Array<Record<string, any>>) {
  return trend
    .filter((m) => m.tasksMerged > 0 && m.taskTitle)
    .map((m) => ({
      cycle: m.cycleId,
      title: m.taskTitle,
      anchor: m.anchorType,
      tests: `${m.testsBefore}→${m.testsAfter}`,
    }));
}

/**
 * Get a cumulative summary of what's been accomplished across recent cycles.
 * Used by the planner to avoid re-proposing completed work.
 *
 * Thin wrapper: fetch the trend (the `count` knob), then delegate to the pure
 * `projectCumulativeAccomplishments`.
 */
export async function getCumulativeAccomplishments(count = 15) {
  const trend = await getMetricsTrend(count);
  return projectCumulativeAccomplishments(trend);
}

// ---------------------------------------------------------------------------
// Anchor-distribution aggregation (issue #377, extracted in #2126)
// ---------------------------------------------------------------------------

/** One live priority lane's served-count rollup. */
interface AnchorDistributionEntry {
  priority: string;
  served: number;
  candidatesAvailable: number | null;
  suppressedReason: string | null;
}

/** The `{windowCycles, distribution, servedByAnchorType}` shape on the wire. */
export interface AnchorDistributionResult {
  windowCycles: number;
  distribution: AnchorDistributionEntry[];
  /** Raw served-bucket dict for clients that want a quick map. */
  servedByAnchorType: Record<string, number>;
}

/**
 * Pure projection: bucket a metrics-trend array by `anchorType` and roll the
 * counts up into the live priority lanes (issue #377). Extracted verbatim from
 * the inline body of `GET /metrics/anchor-distribution` (#2126) so the
 * priority-bucketing + hard-coded fallback logic is unit-testable on a
 * synthetic trend array without standing up the Express router or stubbing
 * Redis — matching the discipline of every other `src/metrics/` aggregator.
 *
 * Counts cycles only (no cost; the USD attribution plane was retired in #1651).
 * The reframe / prior-failure lanes and their starvation gauges were retired in
 * ADR-0016 (no live writer), so this covers only the live priority lanes.
 */
export function projectAnchorDistribution(
  trend: Array<Record<string, any>>,
): AnchorDistributionResult {
  // Bucket cycles by anchorType.
  const served: Record<string, number> = {};
  for (const m of trend) {
    const type = (m.anchorType && String(m.anchorType).trim()) || "unknown";
    served[type] = (served[type] || 0) + 1;
  }

  // Per-priority rollup over the live lanes only. `served` is the count from
  // the rolling window.
  const distribution: AnchorDistributionEntry[] = [
    {
      priority: "kanban",
      served: served["kanban"] || 0,
      candidatesAvailable: null,
      suppressedReason: null,
    },
    {
      priority: "failing-test",
      served: served["failing-test"] || 0,
      candidatesAvailable: null,
      suppressedReason: null,
    },
    {
      priority: "work-queue",
      served: served["work-queue"] || served["research"] || served["user-request"] || 0,
      candidatesAvailable: null,
      suppressedReason: null,
    },
    {
      priority: "codebase-health",
      served: served["health"] || served["codebase-health"] || 0,
      candidatesAvailable: null,
      suppressedReason: null,
    },
    {
      priority: "priorities-doc",
      served: served["doc"] || served["priorities-doc"] || 0,
      candidatesAvailable: null,
      suppressedReason: null,
    },
  ];

  return {
    windowCycles: trend.length,
    distribution,
    servedByAnchorType: served,
  };
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

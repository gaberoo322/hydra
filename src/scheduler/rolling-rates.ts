/**
 * Rolling-rate readers for the scheduler status surface (extracted from
 * `heartbeat.ts`, issue #2974).
 *
 * Two Redis-read wrappers that fetch recent cycle-metrics history and delegate
 * the arithmetic to the shared pure metrics-core computers. Both return null on
 * empty history so a fresh start is never misreported as a 0% stall. Extracted
 * as a sibling module so the heartbeat controller injects them as its default
 * `computeRollingMergeRate` / `computeRollingEmptyRate` deps and tests swap in
 * deterministic stubs; `heartbeat.ts` re-exports the window constants.
 */

import { getMetricsTrend } from "../metrics/trend.ts";
import { computeRollingMergeRateFromTrend, computeEmptyRateFromTrend } from "../metrics/stats-projection.ts";

// Rolling merge-rate window (issue #232): the operator-visible mergeRate is
// computed from the last N cycles in cycle-history (same source as
// `hydra metrics --count N`). Lifetime counters (cyclesMerged / cyclesRun)
// are still surfaced as `mergeRateLifetime` for audit, but they get heavily
// skewed by historical regressions (e.g. issue #218 where merges were 0 for
// 14 hours) and trip stall-style alerts long after the underlying bug is fixed.
export const ROLLING_MERGE_RATE_WINDOW = parseInt(process.env.HYDRA_ROLLING_MERGE_RATE_WINDOW) || 50;

// Rolling empty-cycle-rate window (issue #2818): the operator-visible fraction
// of recent cycles that attempted work but produced no terminal outcome (an
// "empty" a.k.a. "unaccounted" cycle, #1919). Same rolling-window discipline as
// the merge rate above — lifetime cyclesUnaccounted is skewed by the historical
// 7772-cycle backlog, so a live signal needs a bounded window. Defaults to the
// same window size as the merge rate unless overridden.
export const ROLLING_EMPTY_RATE_WINDOW = parseInt(process.env.HYDRA_ROLLING_EMPTY_RATE_WINDOW) || ROLLING_MERGE_RATE_WINDOW;

/**
 * Compute the rolling merge rate from cycle metrics history.
 *
 * Counts a cycle as "merged" when its persisted `tasksMerged` field is > 0,
 * matching the semantics used by `getAggregateStats()` and the post-merge
 * pattern detector (so the scheduler card and `hydra metrics --count N` no
 * longer disagree).
 *
 * Returns null when there's no recent history yet (caller should treat as
 * "no data" rather than 0%, which would falsely flag a healthy fresh start
 * as a stall).
 *
 * Pure-ish: only side effect is a Redis read via getMetricsTrend. The rate
 * arithmetic itself is delegated to the shared pure
 * `computeRollingMergeRateFromTrend` (metrics pure-core; issue #2169) so this
 * wrapper only does the Redis fetch + composes the status shape.
 *
 * Free function (not a controller method) so it can be injected as the default
 * `computeRollingMergeRate` dep — tests swap in a deterministic stub.
 */
export async function defaultComputeRollingMergeRate(window: number = ROLLING_MERGE_RATE_WINDOW): Promise<{ mergeRate: number | null; cyclesInWindow: number }> {
  try {
    const trend = await getMetricsTrend(window);
    if (!Array.isArray(trend) || trend.length === 0) {
      return { mergeRate: null, cyclesInWindow: 0 };
    }
    return {
      mergeRate: computeRollingMergeRateFromTrend(trend),
      cyclesInWindow: trend.length,
    };
  } catch (err: any) {
    console.error(`[Heartbeat] Rolling merge-rate computation failed: ${err?.message || err}`);
    return { mergeRate: null, cyclesInWindow: 0 };
  }
}

/**
 * Compute the rolling EMPTY-cycle rate from cycle-metrics history (issue #2818).
 *
 * An "empty cycle" is one that attempted work but produced no terminal outcome
 * (the read-side mirror of the write-path `unaccounted` bucket, #1919). Counts a
 * cycle as empty via the exact predicate in `computeEmptyRateFromTrend`.
 *
 * Returns null when there's no recent history yet (caller treats as "no data"
 * rather than 0%, so a fresh start is never misreported) — mirrors the
 * merge-rate reader's null-on-empty discipline (#232).
 *
 * Pure-ish: only side effect is a Redis read via getMetricsTrend. Free function
 * (not a controller method) so it can be injected as the default
 * `computeRollingEmptyRate` dep — tests swap in a deterministic stub.
 */
export async function defaultComputeRollingEmptyRate(window: number = ROLLING_EMPTY_RATE_WINDOW): Promise<{ emptyRate: number | null; cyclesInWindow: number }> {
  try {
    const trend = await getMetricsTrend(window);
    if (!Array.isArray(trend) || trend.length === 0) {
      return { emptyRate: null, cyclesInWindow: 0 };
    }
    return {
      emptyRate: computeEmptyRateFromTrend(trend),
      cyclesInWindow: trend.length,
    };
  } catch (err: any) {
    console.error(`[Heartbeat] Rolling empty-rate computation failed: ${err?.message || err}`);
    return { emptyRate: null, cyclesInWindow: 0 };
  }
}

/**
 * src/cost/cost-per-merged-pr.ts — the cost-per-merged-PR derived ratio (issue
 * #2807, split out of the former bundled cost-attribution module by issue
 * #4347).
 *
 * Answers the Cost-domain question "how many subagent tokens does the system
 * spend per merged PR?" — the cost/outcome unit-economics number. A PURE
 * DERIVED read (design-concept 99ef93a0): token totals are summed from the
 * per-day surrogate buckets, and the merged-PR count is INJECTED by the API
 * route from the existing cycle-metrics merged feed — this module introduces no
 * `src/metrics/` import and no new token-recording writer.
 *
 * Imports only `./surrogate.ts` (issue #4347 INV-5: the split's files stay
 * dependency-narrow — this ratio needs nothing but the per-day counter).
 *
 * Public symbols are re-exported from `src/cost/index.ts` — the single public
 * Interface of the Cost module; callers import from `../cost/index.ts`.
 */

import { getDailyTokenCounter, dateStringDaysAgo } from "./surrogate.ts";

/** Default trailing window (whole UTC days) for the cost/merged-PR read. */
export const DEFAULT_COST_PER_MERGED_PR_WINDOW_DAYS = 30;

export interface CostPerMergedPrResult {
  /** Total subagent tokens summed over the trailing window. */
  totalTokens: number;
  /** Count of merged PRs (merged cycles) over the trailing window. */
  mergedPrCount: number;
  /**
   * Derived ratio: `totalTokens / mergedPrCount`, rounded to the nearest
   * integer token. `null` when `mergedPrCount` is 0 — a zero merged count is
   * distinct from a genuine "0 tokens per merge", so the ratio is undefined
   * rather than a misleading Infinity/0. Consumers render `null` as "—".
   */
  tokensPerMergedPr: number | null;
  /** The trailing window (whole UTC days) the totals were summed over. */
  windowDays: number;
  /**
   * Human-readable window label for the operator-facing view, e.g.
   * "last 30d (UTC) · 2026-06-05 → 2026-07-04". Spells out the span so the
   * dashboard can label the ratio honestly.
   */
  window: string;
}

/**
 * Pure projection: derive the cost-per-merged-PR ratio from an already-summed
 * token total and an already-counted merged-PR count.
 *
 * Exported separately from the Redis/trend-reading `getCostPerMergedPr` so the
 * ratio math is unit-testable on fixtures without a live Redis or metrics feed
 * (ADR-0014 pure-core seam). This introduces NO new token-recording writer — it
 * is a derived read over totals the surrogate and the cycle-metrics feed already
 * record (design-concept 99ef93a0 / issue #2807 invariant).
 */
export function projectCostPerMergedPr(
  totalTokens: number,
  mergedPrCount: number,
  windowDays: number,
  window?: string,
): CostPerMergedPrResult {
  const tokens = Number.isFinite(totalTokens) && totalTokens > 0 ? Math.floor(totalTokens) : 0;
  const merged = Number.isFinite(mergedPrCount) && mergedPrCount > 0 ? Math.floor(mergedPrCount) : 0;
  const days = Number.isFinite(windowDays) && windowDays > 0 ? Math.floor(windowDays) : 0;
  const tokensPerMergedPr = merged > 0 ? Math.round(tokens / merged) : null;
  return {
    totalTokens: tokens,
    mergedPrCount: merged,
    tokensPerMergedPr,
    windowDays: days,
    window: window ?? `last ${days}d (UTC)`,
  };
}

/**
 * Sum the per-UTC-day subagent token buckets over the trailing `windowDays`
 * (inclusive of today). Composes the existing per-day surrogate counter — NO
 * new Redis write path; a pure read fold over the daily buckets the autopilot
 * already populates at reap time.
 *
 * Best-effort: each per-day sub-read already degrades to 0 on a Redis hiccup
 * (`getDailyTokenCounter`), so a partial window yields a partial sum rather
 * than a thrown error.
 */
export async function sumTokensOverWindow(
  windowDays: number = DEFAULT_COST_PER_MERGED_PR_WINDOW_DAYS,
  now: Date = new Date(),
): Promise<{ totalTokens: number; window: string; dates: [string, string] }> {
  const days = Number.isFinite(windowDays) && windowDays > 0 ? Math.floor(windowDays) : 1;
  const counters = await Promise.all(
    Array.from({ length: days }, (_unused, i) => getDailyTokenCounter(dateStringDaysAgo(i, now))),
  );
  const totalTokens = counters.reduce((sum, c) => sum + (Number.isFinite(c.tokens) ? c.tokens : 0), 0);
  const newest = dateStringDaysAgo(0, now);
  const oldest = dateStringDaysAgo(days - 1, now);
  return {
    totalTokens,
    window: `last ${days}d (UTC) · ${oldest} → ${newest}`,
    dates: [oldest, newest],
  };
}

/**
 * Read the cost-per-merged-PR ratio over a trailing `windowDays` UTC window.
 *
 * Composes the token total (summed from the per-day surrogate buckets via
 * `sumTokensOverWindow`) with a caller-supplied merged-PR count from the
 * existing cycle-metrics / PR-lifecycle merged feed, then folds them through the
 * pure `projectCostPerMergedPr`. The merged count is injected (not read here) so
 * the Cost module stays free of a `src/metrics/` import — the API route
 * (`src/api/metrics.ts`) owns the composition of the two feeds (design-concept
 * 99ef93a0 / issue #2807: derived ratio, single public Interface).
 */
export async function getCostPerMergedPr(
  mergedPrCount: number,
  windowDays: number = DEFAULT_COST_PER_MERGED_PR_WINDOW_DAYS,
  now: Date = new Date(),
): Promise<CostPerMergedPrResult> {
  const { totalTokens, window } = await sumTokensOverWindow(windowDays, now);
  return projectCostPerMergedPr(totalTokens, mergedPrCount, windowDays, window);
}

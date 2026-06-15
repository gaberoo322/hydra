/**
 * Cycle metrics trend — read path.
 *
 * `getMetricsTrend(count)` is the single read entry for "the last N cycle
 * metrics hashes, parsed". Every aggregate/abandonment/quality-gate view in
 * this family consumes its output. Keeping the parser here (not at each call
 * site) is the locality fix: any new typed field added to the metrics hash
 * needs ONE parse update, not N.
 */

import {
  getRecentMetricIds,
  getCycleMetrics,
} from "../redis/cycle-metrics.ts";
import { NUMERIC_FIELD_NAMES } from "./record.ts";

/**
 * Numeric fields known to live on the cycle-metrics hash. Parsed back from
 * Redis strings at trend read time.
 *
 * Issue #1890: this list is no longer a hand-maintained copy — it is the same
 * `NUMERIC_FIELD_NAMES` tuple the write side (`metrics/record.ts`) types
 * `CycleMetricsInput`'s numeric keys against. Adding/renaming an int metric is
 * a ONE-place edit in `record.ts` that surfaces here automatically, so the
 * write schema and the read schema can no longer silently drift apart.
 */
const NUMERIC_FIELDS = NUMERIC_FIELD_NAMES;

/**
 * Issue #326: derive the categorical `reflectionMatchSource` from the raw
 * comma-separated `reflectionSources` Redis field. Pure helper, exported so
 * the test suite can lock the bucket logic.
 *
 * Buckets: none | by-anchor | by-file | both | global | mixed.
 */
export function deriveReflectionMatchSource(rawSources: unknown): string {
  if (typeof rawSources !== "string" || rawSources.length === 0) return "none";
  const sources = rawSources.split(",").map((s) => s.trim()).filter(Boolean);
  if (sources.length === 0) return "none";
  const hasPerAnchor = sources.includes("per-anchor");
  const hasByFile = sources.includes("by-file");
  const hasGlobal = sources.includes("global");
  if (hasPerAnchor && hasByFile && !hasGlobal) return "both";
  if (hasPerAnchor && !hasByFile && !hasGlobal) return "by-anchor";
  if (!hasPerAnchor && hasByFile && !hasGlobal) return "by-file";
  if (!hasPerAnchor && !hasByFile && hasGlobal) return "global";
  return "mixed";
}

/**
 * Get metrics for the N most recent cycles, with all known numeric fields
 * parsed back from their Redis string form.
 */
export async function getMetricsTrend(count = 20) {
  const cycleIds = await getRecentMetricIds(count);
  const results: Record<string, any>[] = [];

  for (const cycleId of cycleIds) {
    const raw = await getCycleMetrics(cycleId);
    if (!raw.cycleId) continue;

    const parsed: Record<string, any> = { ...raw };
    for (const key of NUMERIC_FIELDS) {
      if (parsed[key] !== undefined) parsed[key] = parseInt(parsed[key]) || 0;
    }
    if (parsed.regressionIntroduced !== undefined) {
      parsed.regressionIntroduced = parsed.regressionIntroduced === "true";
    }

    // Issue #326: derive `reflectionMatchSource` at read time when callers
    // (verification, post-merge) did not emit it directly.
    if (!parsed.reflectionMatchSource) {
      parsed.reflectionMatchSource = deriveReflectionMatchSource(parsed.reflectionSources);
    }

    results.push(parsed);
  }

  return results;
}

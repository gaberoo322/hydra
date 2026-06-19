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

// ---------------------------------------------------------------------------
// Grounding-duration aggregation (issue #341, extracted in #2126)
// ---------------------------------------------------------------------------

/** One projected grounding/verification sample from a cycle metrics record. */
export interface GroundingDurationSample {
  cycleId: any;
  groundingMode: string;
  groundingDurationMs: number;
  verificationDurationMs: number;
  testsSelected: number | null;
}

/** p50/p95/mean rollup over one mode's grounding (or verification) samples. */
export interface GroundingDurationStat {
  p50: number | null;
  p95: number | null;
  mean: number | null;
}

/** Per-mode bucket: cycle count + grounding & verification duration stats. */
export interface GroundingDurationBucket {
  cycles: number;
  grounding: GroundingDurationStat;
  verification: GroundingDurationStat;
}

/** The `{sampleSize, buckets, recent}` shape on the wire. */
export interface GroundingDurationResult {
  sampleSize: number;
  buckets: {
    incremental: GroundingDurationBucket;
    full: GroundingDurationBucket;
    unlabelled: GroundingDurationBucket;
  };
  recent: GroundingDurationSample[];
}

/**
 * Pure percentile over a numeric array (nearest-rank, clamped to the last
 * index). Returns null for an empty array. Exported so the test suite can pin
 * the bucket math directly. Extracted verbatim from the inline
 * `GET /metrics/grounding-duration` route (#341, extracted in #2126).
 */
export function percentile(arr: number[], p: number): number | null {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[idx];
}

/**
 * Pure projection: bucket a metrics-trend array by `groundingMode`
 * ("incremental" | "full" | "") and roll up p50/p95/mean grounding &
 * verification durations per bucket (issue #341). Extracted verbatim from the
 * inline body of `GET /metrics/grounding-duration` (#2126) so the percentile
 * + bucketing math is unit-testable on a synthetic trend array without
 * standing up the Express router or stubbing Redis.
 *
 * Takes an already-fetched trend array; no Redis, no Express, no module-level
 * state.
 */
export function projectGroundingDuration(
  trend: Array<Record<string, any>>,
): GroundingDurationResult {
  const samples: GroundingDurationSample[] = trend.map((m: any) => ({
    cycleId: m.cycleId,
    groundingMode: typeof m.groundingMode === "string" ? m.groundingMode : "",
    groundingDurationMs: typeof m.groundingDurationMs === "number" ? m.groundingDurationMs : 0,
    verificationDurationMs: typeof m.verificationDurationMs === "number" ? m.verificationDurationMs : 0,
    // testsSelected: how many tests the incremental selector actually ran
    // (undefined for full-suite runs). Surfaced for rollout-vs-baseline
    // comparison without forcing callers to do bucket math.
    testsSelected: typeof m.incrementalTestsSelected === "number" ? m.incrementalTestsSelected : null,
  }));

  const bucket = (mode: string): GroundingDurationBucket => {
    const subset = samples.filter((s) => s.groundingMode === mode);
    const ground = subset.map((s) => s.groundingDurationMs).filter((x) => x > 0);
    const verify = subset.map((s) => s.verificationDurationMs).filter((x) => x > 0);
    return {
      cycles: subset.length,
      grounding: {
        p50: percentile(ground, 0.5),
        p95: percentile(ground, 0.95),
        mean: ground.length > 0 ? Math.round(ground.reduce((a, b) => a + b, 0) / ground.length) : null,
      },
      verification: {
        p50: percentile(verify, 0.5),
        p95: percentile(verify, 0.95),
        mean: verify.length > 0 ? Math.round(verify.reduce((a, b) => a + b, 0) / verify.length) : null,
      },
    };
  };

  const buckets = {
    incremental: bucket("incremental"),
    full: bucket("full"),
    unlabelled: bucket(""),
  };

  return {
    sampleSize: samples.length,
    buckets,
    recent: samples.slice(0, 20),
  };
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

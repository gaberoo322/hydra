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
  // Issue #2209: historical cycle-metrics hashes have the literal string
  // "none" persisted in `reflectionSources` (written before #1136's
  // empty-omit guards landed, or by a since-retired writer). Without this
  // guard the split below yields `["none"]` — length > 0, matches no bucket
  // token — and falls through to "mixed", mis-bucketing ~40% of recent
  // cycles. Treat the literal sentinel as empty so it truthfully buckets to
  // "none". The modern write path (reap.py / dispatch.sh / runs.ts) never
  // emits "none"; this only repairs the read of stale records.
  if (rawSources.trim() === "none") return "none";
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
// Reflection-deposit health projection (issue #2467; relocated here #2492)
// ---------------------------------------------------------------------------
//
// Issue #2492: this pure projection lived in src/api/learning.ts, but it is
// metrics-domain logic — a tally over the same cycle-trend rows that carry the
// `reflectionMatchSource` `deriveReflectionMatchSource` already derives above.
// It moved HERE (with `deriveReflectionMatchSource`, its conceptual sibling) so
// BOTH the HTTP route (GET /api/learning/reflection-health) and the pure
// deep-health diagnostics seam (src/health/diagnostics.ts) can consume it
// without the health seam importing an `src/api/` router module (a backwards
// inward edge). src/api/learning.ts re-exports these for its existing callers,
// so the route + its test keep their import site unchanged.
//
// The recurring #1912/#2450/#2467/#2492 false alarm is reading a flat
// 100%-`none` `reflectionMatchSource` distribution as broken telemetry when it
// is the HONEST steady state of an empty reflection store — reflections are
// PRODUCED only on a non-merged failure (reap.py `_fire_reflection_for_completion`),
// so a high-merge-rate run structurally serves nothing and `none` is correct,
// NOT a regression. `reflectionSourcesPresent` is the discriminator the raw
// metric hides: it counts cycles whose raw `reflectionSources` field is a
// non-empty, non-sentinel string (a deposit actually landed). When every cycle
// is `none` AND none carried a present deposit, that is consistent with an empty
// store (the expected case) → verdict `all-none-empty-store`, explicitly NOT an
// alarm. The verdict only flags `served-but-bucketed-none` when a cycle DID
// carry a present deposit yet still bucketed `none` (the real false-none).

/**
 * One cycle's projection for the reflection-health read: the derived bucket
 * plus whether its raw `reflectionSources` deposit field was actually present
 * (a non-empty, non-`"none"`-sentinel string).
 */
export interface ReflectionHealthSampleProjection {
  reflectionMatchSource: string;
  reflectionSourcesPresent: boolean;
}

/** The wire shape of `GET /learning/reflection-health`. */
export interface ReflectionHealthReport {
  /** Cycles examined (≤ requested window; fewer if the store has fewer). */
  sampleSize: number;
  /** Count per `reflectionMatchSource` bucket (only non-zero buckets appear). */
  distribution: Record<string, number>;
  /** Cycles whose raw `reflectionSources` deposit landed (non-empty, non-sentinel). */
  reflectionSourcesPresent: number;
  /**
   * Honest verdict over the window:
   *   - "no-data"                 — sampleSize 0 (nothing recorded yet).
   *   - "healthy"                 — at least one non-`none` bucket present.
   *   - "all-none-empty-store"    — every cycle `none` AND none carried a
   *                                 present deposit; consistent with an empty
   *                                 store / high merge rate. NOT an alarm.
   *   - "served-but-bucketed-none"— ≥1 cycle carried a present deposit yet still
   *                                 bucketed `none` — a candidate false-none
   *                                 (deposit/read plumbing worth an operator's eye).
   */
  verdict:
    | "no-data"
    | "healthy"
    | "all-none-empty-store"
    | "served-but-bucketed-none";
  /** One-line human-readable explanation of the verdict (for the dashboard). */
  note: string;
}

/**
 * The single cycle field this read inspects beyond the derived bucket: the raw
 * `reflectionSources` string reap forwarded. A non-empty, non-`"none"`-sentinel
 * value means a deposit actually landed for that cycle (the #2209 sentinel is
 * treated as absent, mirroring `deriveReflectionMatchSource`).
 */
function reflectionSourcesIsPresent(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  const trimmed = raw.trim();
  return trimmed.length > 0 && trimmed !== "none";
}

/**
 * Pure projection of a recent-cycles window into a `ReflectionHealthReport`
 * (issue #2467). Exported so the test suite can pin the bucket-distribution and
 * verdict logic on synthetic rows WITHOUT a Redis connection — the
 * `GET /learning/reflection-health` route feeds it `getMetricsTrend()`'s output,
 * and the deep-health reflection rule (issue #2492) feeds it the metrics-probe
 * trend it already collected.
 *
 * Never throws and reads nothing: it consumes already-read cycle rows (each
 * already carries a derived `reflectionMatchSource` from
 * `getMetricsTrend`/`deriveReflectionMatchSource`) and tallies. A row missing a
 * `reflectionMatchSource` is defensively bucketed `none` (the same default the
 * derive helper applies to an empty source string), so the projection stays
 * total over any input shape.
 */
export function projectReflectionHealth(
  cycles: Array<Record<string, any>>,
): ReflectionHealthReport {
  const distribution: Record<string, number> = {};
  let reflectionSourcesPresent = 0;
  let servedButNone = 0;

  for (const cycle of cycles) {
    const bucket =
      typeof cycle.reflectionMatchSource === "string" && cycle.reflectionMatchSource.length > 0
        ? cycle.reflectionMatchSource
        : "none";
    distribution[bucket] = (distribution[bucket] ?? 0) + 1;

    const present = reflectionSourcesIsPresent(cycle.reflectionSources);
    if (present) {
      reflectionSourcesPresent += 1;
      // A deposit landed yet the bucket is still `none` → a candidate false-none
      // (the real broken-plumbing / stale-record signal, distinct from the
      // honest empty-store none the operator keeps mis-reading as a regression).
      if (bucket === "none") servedButNone += 1;
    }
  }

  const sampleSize = cycles.length;
  const nonNoneBuckets = Object.keys(distribution).filter(b => b !== "none").length;

  let verdict: ReflectionHealthReport["verdict"];
  let note: string;
  if (sampleSize === 0) {
    verdict = "no-data";
    note = "No cycle metrics recorded yet — nothing to assess.";
  } else if (nonNoneBuckets > 0) {
    verdict = "healthy";
    const served = sampleSize - (distribution.none ?? 0);
    // Issue #2494: spell out WHY the served fraction is structurally low so a
    // small ratio (e.g. 1/20) is not re-read as a regression. Reflections are
    // PRODUCED only on a non-merged failure (reap.py
    // `_fire_reflection_for_completion`), so the served fraction tracks the
    // recent FAILURE rate — a high-merge-rate run serves few by design, and
    // `none` on the merged cycles is the expected honest steady state, not a
    // broken deposit. This closes the #1912→#2450→#2467→#2492→#2494 re-file
    // loop where the bare ratio looked alarming without its structural cause.
    note = `Reflection context reached ${served}/${sampleSize} recent cycles; deposit plumbing is live. Reflections are produced ONLY on non-merged failures, so this fraction tracks the recent failure rate — a low ratio on a high-merge run is expected, not a regression.`;
  } else if (servedButNone > 0) {
    verdict = "served-but-bucketed-none";
    note = `${servedButNone}/${sampleSize} cycles carried a reflectionSources deposit yet bucketed 'none' — candidate false-none; inspect the deposit/read path.`;
  } else {
    verdict = "all-none-empty-store";
    note = `All ${sampleSize} recent cycles bucketed 'none' with no deposit served — consistent with an empty reflection store (high merge rate). Expected, not an alarm.`;
  }

  return { sampleSize, distribution, reflectionSourcesPresent, verdict, note };
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

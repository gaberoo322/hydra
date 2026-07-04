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
import {
  isMalformedAnchorType,
  UNCLASSIFIED_ANCHOR_TYPE,
} from "../autopilot/cycle-close.ts";

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

/**
 * Honest-none discriminator (issue #2670): does this reflection-health report
 * describe a state that a discover / health filing decision must NOT flag as an
 * anomaly?
 *
 * The `reflectionMatchSource == none` signal has re-filed the SAME false alarm
 * repeatedly (#1912 → #2450 → #2467 → #2492 → #2336 → #2648) because the raw
 * bucket alone cannot tell an HONEST empty-store `none` (the expected steady
 * state of a high-merge run — reflections are produced only on a non-merged
 * failure, so a merged first attempt structurally serves nothing) apart from a
 * genuinely-broken deposit path. `projectReflectionHealth` already resolves that
 * ambiguity into a verdict via the `reflectionSourcesPresent` discriminator; this
 * predicate exposes the "safe to ignore" half of that verdict as a single call so
 * the code that DECIDES whether to file (hydra-discover, any health check) can
 * consult it directly instead of re-deriving the string comparison at each site
 * (the gap #2670 names: the discriminator existed but was not consulted at the
 * filing point).
 *
 * Returns `true` for every honest / non-actionable verdict —
 *   - `no-data`              (nothing recorded yet),
 *   - `healthy`              (a non-none bucket is present; deposit plumbing live),
 *   - `all-none-empty-store` (100%-`none` with no deposit served — the EXPECTED
 *                             high-merge steady state, explicitly not an alarm) —
 * and `false` ONLY for `served-but-bucketed-none`, the genuine candidate false-none
 * (a deposit landed yet still bucketed `none`) that warrants an operator's eye.
 * A merged-first-attempt `none` therefore classifies as honest-none and must not
 * be re-filed as "reflection silenced".
 *
 * Never throws; a report whose verdict is missing/unrecognised is treated as
 * honest-none (fail-safe: an unknown state defaults to "do not file the alarm").
 */
export function isHonestNoneVerdict(
  report: Pick<ReflectionHealthReport, "verdict">,
): boolean {
  return report.verdict !== "served-but-bucketed-none";
}

/**
 * Issue #2699: fold every "no real anchor type" form to the single "unknown"
 * bucket at trend read time, mirroring the stats aggregator's
 * `m.anchorType || "unknown"` fallback (src/metrics/aggregate.ts).
 *
 * Redis hashes only store strings, so a cycle recorded with a JS `null`
 * anchorType was flattened by `record.ts` via `String(null)` into the LITERAL
 * string "null" (undefined is skipped, but null is not). A bare truthy `||`
 * therefore lets "null" (and "undefined") slip through as a non-empty string,
 * which is exactly why the ~12 pre-fix records surfaced as `null` in the trend
 * array. This helper collapses absent, empty, and the "null"/"undefined"
 * stringified sentinels to "unknown"; any genuine anchor type passes through
 * unchanged. Pure and exported so the test suite can pin it without Redis.
 *
 * Issue #2824: the read path must ALSO reject the non-empty-but-MALFORMED forms
 * the write path already rejects — flag-shaped values (`--status`) and the
 * `unmapped:<skill>` sentinel — so pre-fix rows persisted in Redis before
 * `classifyAnchorType` (#2806) landed don't resurface here as distinct garbage
 * buckets. We reuse `isMalformedAnchorType` from cycle-close.ts (the write
 * path's own predicate) as the single source of truth to prevent write/read
 * drift, and fold those values to `UNCLASSIFIED_ANCHOR_TYPE` — the SAME bucket
 * the write path collapses them into — rather than "unknown". "unknown" stays
 * reserved for the absent/empty/`null`/`undefined` no-value forms.
 */
export function normalizeAnchorType(raw: unknown): string {
  if (typeof raw !== "string") return "unknown";
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed === "null" || trimmed === "undefined") {
    return "unknown";
  }
  // Issue #2824: mirror the write-path malformed-value rejection so stale
  // `--status` / `unmapped:*` rows collapse into the visible `unclassified`
  // data-quality bucket instead of surfacing as raw garbage strings.
  if (isMalformedAnchorType(trimmed)) return UNCLASSIFIED_ANCHOR_TYPE;
  return trimmed;
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

    // Issue #2699: normalize `anchorType` at the read/parse step, mirroring the
    // stats aggregator's `m.anchorType || "unknown"` fallback (aggregate.ts).
    // The write path was made explicit in f95fee2 (#2689), but the ~12 pre-fix
    // records already persisted in Redis carry an absent OR literal-"null"
    // anchorType (record.ts flattens a JS `null` via `String(null)` → the
    // string "null", which a bare truthy `||` does NOT catch). Without this
    // guard those historical rows surface as `null`/"null" in the trend array —
    // the distinct downstream read-path gap #2699 names. Fold every unknown
    // form (absent, empty, the "null"/"undefined" sentinels) to "unknown" so
    // the trend output matches the aggregator's honest bucket.
    parsed.anchorType = normalizeAnchorType(parsed.anchorType);

    results.push(parsed);
  }

  return results;
}

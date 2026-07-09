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
import { getCycleTokensRaw } from "../redis/cost.ts";
import { NUMERIC_FIELD_NAMES } from "./record.ts";
import {
  isMalformedAnchorType,
  UNCLASSIFIED_ANCHOR_TYPE,
} from "../autopilot/anchor-type.ts";

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
// Reflection-deposit health diagnostic — extracted to a sibling leaf (#3038)
// ---------------------------------------------------------------------------
//
// Issue #3038: the reflection-health diagnostic concern (the pure verdict fold
// `projectReflectionHealth` + `isHonestNoneVerdict` and their
// `ReflectionHealthReport` / `ReflectionHealthSampleProjection` types) moved OUT
// of this read-path module into its own focused leaf,
// `src/metrics/reflection-health.ts`. That leaf has ZERO Redis dependency — it
// tallies already-read rows — so "how is reflection health diagnosed?" and "how
// are cycle metrics read and normalized?" each have one home. This re-export
// preserves the historical `metrics/trend.ts` import surface for any consumer
// during/after the migration (the direct callers — `health/diagnostics.ts` and
// `api/learning.ts` — now import from the leaf directly).
//
// Prior lineage: issue #2467 introduced the projection in `src/api/learning.ts`;
// issue #2492 relocated it HERE beside its conceptual sibling
// `deriveReflectionMatchSource` so the pure deep-health diagnostics seam
// (src/health/diagnostics.ts) could consume it without a backwards inward edge
// into an `src/api/` router. Issue #3038 finished the separation into a focused
// leaf while keeping this back-compat re-export.
export {
  projectReflectionHealth,
  isHonestNoneVerdict,
} from "./reflection-health.ts";
export type {
  ReflectionHealthSampleProjection,
  ReflectionHealthReport,
} from "./reflection-health.ts";

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
 * buckets. We reuse `isMalformedAnchorType` from the shared anchor-type policy
 * leaf (`src/autopilot/anchor-type.ts`, extracted from the write coordinator in
 * #2858) as the single source of truth to prevent write/read
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
 * Issue #2930: parse a per-cycle token total read from the separate
 * `hydra:metrics:tokens:cycle:<id>` key (via the `getCycleTokensRaw` accessor)
 * into the trend row's `tokenCost` field.
 *
 * The per-cycle token count is NOT stored on the cycle-metrics hash — it lives
 * in its own Redis key written by `recordSubagentTokens` (src/cost/surrogate.ts)
 * on an independent, unordered path. `tokenCost` is declared in
 * `NUMERIC_FIELD_NAMES` but no writer ever populates it on the hash, so the trend
 * joins it at READ time (order-independent, unlike a write-time join that would
 * miss late-arriving token POSTs — see the rejected write-time alternative in
 * design-concept issue-2930).
 *
 * Truthful-sentinel discipline (the same rule that fixed filesChanged #2063 and
 * anchorType #2689): a cycle with no recorded token key reads `null`, NEVER a
 * fabricated `0`. A fake 0 would poison the tokens-per-merged-PR trend. A stored
 * value of literally `0` is a real recorded zero and passes through as `0`.
 *
 * Pure and exported so the test suite can pin the parse without a Redis fetch.
 * Returns `null` for any absent/empty/non-numeric raw value (fail-safe: an
 * unparseable token key degrades to the unattributed sentinel, never throws).
 */
export function parseCycleTokenTotal(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
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

    // Issue #2930: join the per-cycle token total from the separate
    // `hydra:metrics:tokens:cycle:<id>` key (read ONLY through the src/redis/cost.ts
    // typed accessor — the ADR-0009 Redis seam is preserved and the Tier-0 Cost
    // accounting seam is read, never mutated). `tokenCost` is declared in
    // NUMERIC_FIELD_NAMES but no writer populates it on the metrics hash, so the
    // numeric parse loop above leaves it undefined; this read-time join sets it
    // to the real token total or `null` when no key exists (truthful
    // unattributed sentinel — never a fabricated 0). Overriding any hash value
    // here is intentional: the per-cycle token key is the source of truth for
    // this field, not the never-written hash slot.
    parsed.tokenCost = parseCycleTokenTotal(await getCycleTokensRaw(cycleId));

    results.push(parsed);
  }

  return results;
}

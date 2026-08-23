/**
 * src/cost/snapshot-assembly.ts — the pure snapshot-slice leaf of the **Cost**
 * Module's Subscription Usage Tracker.
 *
 * Extracted out of `usage-tracker.ts` (issue #2279) so the snapshot-assembly
 * fold helpers — the pure scalar functions that take already-computed scalars /
 * sub-accumulators and return a `UsageSnapshot` slice (weighted burns, estimate
 * percents, Quota-Weight totals, pacing state, OAuth headline rebase, since-reset
 * fixed-window math, calibration-drift detection) — live in one focused leaf named
 * after the concept, not buried in the 1,130-line I/O coordinator. Same axis the
 * pure-math leaf `token-math.ts` (#1909), the env-reader leaf `config.ts` (#1896),
 * the eligibility fold `eligibility.ts` (#1377), and the JSONL-walk seam
 * `transcript-scan.ts` (#1971) each split along; the recognized #2188 deepening
 * the coordinator's own inline comment named.
 *
 * PURE: no IO (no readFile/stat), no Redis, no `process.env` reads, no
 * `Date.now()` — every time/env/scalar input enters as a function argument. The
 * `logger.warn`/`logger.error` calls retained here (the OAuth-fallback fail-loud,
 * the Anchor auto-correct, the drift detector) are intrinsic to the derivation
 * each helper performs, NOT assembly orchestration. The import direction is
 * strictly one-way: this leaf imports its primitives from the sibling pure leaves
 * (`token-math.ts`, `transcript-scan.ts`, `oauth-usage.ts`) and NOTHING from
 * `usage-tracker.ts` (which imports FROM here) — no cycle. The shared primitives
 * `familyWeight` + `MODEL_FAMILIES` live in the `token-math.ts` leaf both modules
 * import downward.
 *
 * Functions moved here are VERBATIM relocations (same body, signature,
 * doc-comment) of the helpers that previously lived in `usage-tracker.ts`:
 * behaviour is byte-for-byte unchanged. They stay exported FOR DIRECT UNIT TEST
 * only and are deliberately NOT added to the `cost/index.ts` public barrel —
 * same module-internal visibility as eligibility.ts's `deriveHardStop`.
 */

import { logger } from "../logger.ts";
import { isOAuthUsageOk } from "./oauth-usage.ts";
// Pure math leaf (issue #1909 / #2279): the weighted-token unit, the reset-window
// projection, the cache-hit ratio, and the shared family primitives
// (`familyWeight`, `MODEL_FAMILIES`) live in `./token-math.ts`. The
// snapshot-assembly folds below consume them one-way; token-math.ts imports
// nothing from src/cost/. `cacheHitRatio` joined this import list when the
// `assembleSnapshot` coordinator moved here (issue #2988).
import {
  weightedTokens,
  projectResetWindow,
  familyWeight,
  MODEL_FAMILIES,
  cacheHitRatio,
} from "./token-math.ts";
import type { TokenBreakdown, ModelFamily, CategoryWeights } from "./token-math.ts";
// Token-breakdown data-model leaf (issue #3513): the empty-breakdown constant +
// per-family accumulator helpers + the dispatch-kind vocabulary tuple are PURE
// primitives, so this pure leaf imports them from the pure `./token-breakdown.ts`
// leaf directly — a pure→pure edge that no longer drags in the filesystem-I/O
// transitive closure the old `./transcript-scan.ts` import did.
import { EMPTY_BREAKDOWN, emptyByModel, addBreakdown, DISPATCH_KINDS } from "./token-breakdown.ts";
import type { DispatchKind } from "./token-breakdown.ts";
// TranscriptScan seam (issue #1971): only the `ScanResult` I/O-boundary type the
// OAuth-rebase / since-reset folds read slices of. Type-only, one-way import.
import type { ScanResult } from "./transcript-scan.ts";
// Env-config readers (issue #1896) the relocated `assembleSnapshot` (issue #2988)
// consumes to gate the quota math on the calibration env vars. Pure, IO-free
// leaf — importing VALUES from it introduces no cycle (config.ts imports nothing
// from src/cost/).
import {
  getWeeklyQuotaTokens,
  getFiveHourQuotaTokens,
  getWeeklyResetAnchorMs,
  getCacheReadWeight,
  getDriftReferencePercent,
  getDriftFactor,
  getOAuthEstimateDivergenceFactor,
  getQuotaWeightOpus,
  getQuotaWeightSonnet,
  getQuotaWeightHaiku,
} from "./config.ts";
// The hard-stop threshold predicate `deriveHardStop` (issue #2041) lives with the
// dispatch-gating fold in `./eligibility.ts`. The relocated `assembleSnapshot`
// (issue #2988) folds it over the three headline scalars, exactly as the tracker
// did inline. This is a VALUE import; `eligibility.ts` imports only the
// `UsageSnapshot` TYPE (type-only, runtime-erased) from the pure `./types.ts`
// leaf (issue #3071) — NOT back from this leaf — so no runtime cycle forms.
import { deriveHardStop } from "./eligibility.ts";
// `UsageSnapshot` — the assembled snapshot shape this leaf's `assembleSnapshot`
// returns — and `SkillWoWEntry` (its per-skill week-over-week field type) live in
// the pure TYPE-vocabulary leaf `./types.ts` (issue #3071). Importing them DOWNWARD
// from that type root — instead of backwards from the `usage-tracker.ts` I/O
// coordinator (the old #2988 arrangement) — restores the one-way import direction:
// a pure leaf now depends only on the module's type vocabulary, never on the
// coordinator that consumes it. `import type` is fully compile-erased, so no
// runtime edge either way.
import type { UsageSnapshot, SkillWoWEntry } from "./types.ts";

/**
 * Length of the weekly quota window in ms. Duplicated as a private const here
 * (a fixed literal, not policy) rather than cross-imported — the same stance
 * `eligibility.ts`'s `WINDOW_7D_MS` documents — so the pure one-way import
 * discipline of this leaf is never broken for a single 7-day constant. The
 * OAuth meter's 7-day boundary minus this constant is the window START the
 * #4121 window-position math ratios against.
 */
const WEEKLY_WINDOW_MS = 7 * 86_400_000;

/**
 * Tolerance band (in percentage points of weekly quota) around the LINEAR
 * weekly-pace target within which consumption is judged "on" pace rather than
 * under/over it (issue #4121). Sibling of `eligibility.ts`'s
 * `PACE_STATE_TOLERANCE_PERCENT` (same ±2pp, same anti-flicker rationale) but
 * a DISTINCT constant: that band positions the ADR-0021 cumulative-since-Anchor
 * burn against the Pacing Curve, this one positions the rolling `percentLast7d`
 * against the linear window fraction — two independently-tuned pace signals
 * (the design-concept's naming invariant, issue #4121 INV-6).
 */
const LINEAR_PACE_TOLERANCE_PERCENT = 2;

/**
 * The composed two-axis quota-burn numerator over a per-family accumulator,
 * generalised to a full four-category weight set (issue #3825, building on
 * #873). Axis A (per-token-category weight) reshapes the token mix INSIDE each
 * family via {@link weightedTokens} over a {@link CategoryWeights}; Axis B
 * (per-model-family weight) scales OUTSIDE via {@link familyWeight}:
 *
 *   `Σ_family familyWeight(f) * weightedTokens(family[f], category)`
 *
 * The two axes are orthogonal, so they never double-count. The ranked culprit
 * report (`scripts/cost/weighted-quota-report.ts`) passes the list-price
 * `CategoryWeights` (cache read 0.1x / cache write 1.25x / output 5.0x / input
 * 1.0x) so its ranking reflects real burn rather than raw cache-read volume.
 * At the all-1.0 category weights AND all-1.0 family weights this reduces
 * exactly to the raw `Σ_family family[f].total` — the identity the pre-#873
 * fold expressed.
 *
 * Exported + re-exported via the `cost/index.ts` public barrel (issue #3825):
 * the ranked report reuses this exact fold on each per-consumer per-family
 * breakdown so the report and the live `weightedQuotaBurn` share ONE weighting
 * definition (the CONTEXT.md single-definition-of-Quota-Weight rule) rather
 * than the report re-deriving a divergent formula.
 */
export function weightedQuotaBurnByCategory(
  byModel: Record<ModelFamily, TokenBreakdown>,
  category: CategoryWeights,
  weights: { opus: number; sonnet: number; haiku: number },
): number {
  return MODEL_FAMILIES.reduce(
    (sum, f) => sum + familyWeight(f, weights) * weightedTokens(byModel[f], category),
    0,
  );
}

/**
 * The LEGACY single-axis cache-read-weighted quota-burn numerator (issue #873,
 * #3548). Kept as a thin delegator to {@link weightedQuotaBurnByCategory} (issue
 * #3825) so the live estimate/pacing path (`assembleSnapshot` below) and the
 * Class Yield Scoreboard (`src/autopilot/class-stats-math.ts`) keep their
 * byte-identical cache-read-only behaviour — input/output/cacheCreation stay at
 * full weight, only `cacheRead` carries the passed `wCache`. The four-category
 * generalisation is opted into ONLY by callers that pass a full
 * {@link CategoryWeights} via {@link weightedQuotaBurnByCategory} (the ranked
 * report); this signature stays stable so those consumers need no change.
 *
 * Exported + re-exported via the `cost/index.ts` public barrel (issue #3548):
 * the per-class **Weighted-Quota Cost Axis** on the Class Yield Scoreboard reuses
 * this exact fold on each `bySkillByModel[skill]` per-family breakdown. It is the
 * ONE legacy snapshot-assembly fold on the public barrel; the generalised
 * {@link weightedQuotaBurnByCategory} joins it (#3825), and the rest stay
 * module-internal (test-only exports).
 */
export function weightedQuotaBurn(
  byModel: Record<ModelFamily, TokenBreakdown>,
  wCache: number,
  weights: { opus: number; sonnet: number; haiku: number },
): number {
  return weightedQuotaBurnByCategory(
    byModel,
    { input: 1, output: 1, cacheRead: wCache, cacheCreation: 1 },
    weights,
  );
}

/** The weighted-burn numerator triple over the three rolling windows (issue #2247). */
export interface WeightedBurns {
  weightedBurn5h: number;
  weightedBurn7d: number;
  weightedBurn24h: number;
}

/**
 * Weighted quota-burn numerators over the 5h / 7d / 24h windows (issue #873;
 * extracted to a named pure helper in #2247). Composes the {@link weightedQuotaBurn}
 * two-axis fold (Axis A cache-read weight INSIDE each family, Axis B per-model-family
 * Quota Weight OUTSIDE) over each window's per-family accumulator. These are the
 * NUMERATORS the estimate percentages divide by their quotas — raw `.total` fields
 * are untouched; only these weighted numerators change with the env weights.
 *
 * Pure: takes the three already-accumulated per-family breakdowns plus the two
 * weighting scalars/objects, returns the triple — the #2041 scalar-input shape, no
 * I/O. Behaviour-neutral with the three inline `weightedQuotaBurn(...)` calls it
 * replaces. Exported for direct unit test, NOT added to the `index.ts` public barrel.
 */
export function deriveWeightedBurns(
  byModel5h: Record<ModelFamily, TokenBreakdown>,
  byModel7d: Record<ModelFamily, TokenBreakdown>,
  byModel24h: Record<ModelFamily, TokenBreakdown>,
  cacheReadWeight: number,
  burnWeights: { opus: number; sonnet: number; haiku: number },
): WeightedBurns {
  return {
    weightedBurn5h: weightedQuotaBurn(byModel5h, cacheReadWeight, burnWeights),
    weightedBurn7d: weightedQuotaBurn(byModel7d, cacheReadWeight, burnWeights),
    weightedBurn24h: weightedQuotaBurn(byModel24h, cacheReadWeight, burnWeights),
  };
}

/** The three transcript+calibration estimate percentages (issue #2247). */
export interface EstimatePercents {
  estimatePercentLast5h: number;
  estimatePercentLast7d: number;
  projectedWeeklyPercent: number;
}

/**
 * Transcript+calibration estimate percentages (the historical headline + fallback
 * path; extracted to a named pure helper in #2247). Each percent divides its
 * weighted burn numerator by the relevant quota; `projectedWeeklyPercent` extends
 * the 24h burn to a full 7 days (`* 7`). All three short-circuit to 0 when the quota
 * is uncalibrated — byte-for-byte the inline ternaries they replace, mirroring the
 * all-or-nothing calibration discipline the rest of the tracker follows.
 *
 * Pure: takes the {@link WeightedBurns} triple plus the two quota scalars and the
 * `calibrated` flag, returns the three percentages — the #2041 scalar-input shape, no
 * I/O. Exported for direct unit test, NOT added to the `index.ts` public barrel.
 */
export function deriveEstimatePercents(
  burns: WeightedBurns,
  weeklyQuota: number,
  fiveHourQuota: number,
  calibrated: boolean,
): EstimatePercents {
  return {
    estimatePercentLast5h: calibrated ? (burns.weightedBurn5h / fiveHourQuota) * 100 : 0,
    estimatePercentLast7d: calibrated ? (burns.weightedBurn7d / weeklyQuota) * 100 : 0,
    projectedWeeklyPercent: calibrated ? ((burns.weightedBurn24h * 7) / weeklyQuota) * 100 : 0,
  };
}

/** The Quota-Weight burn totals over the 5h / 7d windows (issue #2247). */
export interface QuotaWeightTotals {
  quotaWeightLast5h: number;
  quotaWeightLast7d: number;
}

/**
 * Quota-Weight burn totals over the 5h / 7d windows (issue #691; extracted to a
 * named pure helper in #2247). DISTINCT from the burn NUMERATORS above: this is the
 * raw `.total` per family scaled ONLY by the per-model-family Quota Weight (Axis B) —
 * NO cache-read weight (Axis A), and it sums the honest `.total` (input + output +
 * cacheCreation + cacheRead) rather than the cache-weighted token mix. Exactly 0
 * unless ALL THREE HYDRA_QUOTA_WEIGHT_* env vars are set to positive values
 * (`quotaWeightCalibrated`), mirroring the all-or-nothing percentage gate.
 *
 * Pure: takes the two per-family accumulators, the three family weights, and the
 * `quotaWeightCalibrated` flag, returns the pair — the #2041 scalar-input shape, no
 * I/O. Behaviour-neutral with the inline locally-captured `weightedTotal` arrow it
 * replaces. Exported for direct unit test, NOT added to the `index.ts` public barrel.
 */
export function deriveQuotaWeightTotals(
  byModel5h: Record<ModelFamily, TokenBreakdown>,
  byModel7d: Record<ModelFamily, TokenBreakdown>,
  weights: { opus: number; sonnet: number; haiku: number },
  quotaWeightCalibrated: boolean,
): QuotaWeightTotals {
  const weightedTotal = (acc: Record<ModelFamily, TokenBreakdown>): number =>
    MODEL_FAMILIES.reduce((sum, f) => sum + acc[f].total * familyWeight(f, weights), 0);
  return {
    quotaWeightLast5h: quotaWeightCalibrated ? weightedTotal(byModel5h) : 0,
    quotaWeightLast7d: quotaWeightCalibrated ? weightedTotal(byModel7d) : 0,
  };
}

/**
 * The weekly window-position slice of the snapshot (issue #4121).
 */
export interface WindowPace {
  /**
   * Fraction of the weekly window elapsed at the snapshot instant, clamped to
   * [0, 1]; `null` when no boundary is known.
   */
  windowElapsedFraction: number | null;
  /**
   * `percentLast7d / (100 * windowElapsedFraction)`; `null` when the fraction
   * is null or 0.
   */
  paceRatio: number | null;
}

/**
 * Weekly window-position fold (issue #4121).
 *
 * `(now - windowStart) / 7d` — where the weekly window stands relative to
 * `now` — plus the derived pace ratio `percentLast7d / (100 *
 * windowElapsedFraction)` (`< 1` under linear pace, `> 1` over). This is the
 * window-position reference `pacingState` lacked: pre-#4121 a single busy day
 * extrapolated across seven days read "over" while the account was comfortably
 * under pace (observed 2026-08-17: 67% consumed at 70.1% elapsed, `paceRatio`
 * 0.96, reported `"over"`).
 *
 * Window-start PRECEDENCE — the meter's own boundary first, the env-anchored
 * fixed window second:
 *   1. the OAuth meter's `sevenDayResetsAt - 7d` (the issue-#4121 formula;
 *      non-null exclusively on the `"oauth"` path, so it pairs with the real
 *      meter `percentLast7d` whose own window ENDS at that boundary);
 *   2. the Weekly Reset Anchor boundary (`deriveSinceReset`'s
 *      `weeklyResetAnchor`, ADR-0021) — available on the estimate-fallback
 *      path too, so a tracker with the Anchor seeded keeps a window reference
 *      while the meter is unreadable (design-concept issue-4121 INV-3);
 *   3. neither → `{null, null}` (and `pacingState` falls back to the legacy
 *      projection derivation — see {@link derivePacingState}, INV-4).
 * Defensive on a malformed ISO at either precedence level: skip it (fall
 * through), never a throw. Pure scalar fold — the #2041 shape, no I/O.
 * Exported for direct unit test, NOT added to the `index.ts` public barrel.
 */
export function deriveWindowPace(input: {
  nowMs: number;
  sevenDayResetsAt: string | null;
  weeklyResetAnchor: string | null;
  percentLast7d: number;
}): WindowPace {
  let windowStartMs: number | null = null;
  if (input.sevenDayResetsAt !== null) {
    const resetsMs = Date.parse(input.sevenDayResetsAt);
    if (Number.isFinite(resetsMs)) windowStartMs = resetsMs - WEEKLY_WINDOW_MS;
  }
  if (windowStartMs === null && input.weeklyResetAnchor !== null) {
    const anchorMs = Date.parse(input.weeklyResetAnchor);
    if (Number.isFinite(anchorMs)) windowStartMs = anchorMs;
  }
  if (windowStartMs === null) {
    return { windowElapsedFraction: null, paceRatio: null };
  }
  const elapsed = Math.min(1, Math.max(0, (input.nowMs - windowStartMs) / WEEKLY_WINDOW_MS));
  if (elapsed <= 0) {
    // Window boundary not yet reached (clock skew, or a boundary a full window
    // out): position 0 is honest, but a pace ratio against it is undefined.
    return { windowElapsedFraction: 0, paceRatio: null };
  }
  return {
    windowElapsedFraction: elapsed,
    paceRatio: input.percentLast7d / (100 * elapsed),
  };
}

/**
 * Pacing-state fold (issue #2188; re-derived from window position in #4121).
 *
 * `pacingState` keys off position relative to LINEAR weekly pace (NOT the 24h
 * burst projection it used pre-#4121): with a window position in hand, the
 * linear target is `100 * windowElapsedFraction` percent of quota and the
 * verdict compares `percentLast7d` against it within ±{@link
 * LINEAR_PACE_TOLERANCE_PERCENT}pp — `"over"` above the band, `"on"` inside
 * it, `"under"` below (67% consumed at 70% elapsed reads `"under"`: 3pp under
 * target). When NO window position exists (`windowElapsedFraction` is null or
 * 0 — no OAuth boundary and no Anchor), the fold falls back to the legacy
 * pre-#4121 `projectedWeeklyPercent` thresholds rather than a fixed state,
 * preserving the status quo for un-Anchor'd accounts (design-concept
 * issue-4121 INV-4). Uncalibrated is always `"under"`, byte-for-byte the
 * pre-#4121 short-circuit. Pure scalar fold over already-computed scalars.
 * Exported from this module for direct unit test, NOT added to the
 * `index.ts` public barrel.
 */
export function derivePacingState(
  calibrated: boolean,
  percentLast7d: number,
  windowElapsedFraction: number | null,
  projectedWeeklyPercent: number,
): "under" | "on" | "over" {
  if (!calibrated) return "under";
  if (windowElapsedFraction === null || windowElapsedFraction <= 0) {
    // Legacy fallback (INV-4): no window-position reference, so the pre-#4121
    // 24h-projection thresholds govern — byte-for-byte the old branch.
    if (projectedWeeklyPercent > 100) return "over";
    if (projectedWeeklyPercent >= 80) return "on";
    return "under";
  }
  const targetPercent = 100 * windowElapsedFraction;
  if (percentLast7d > targetPercent + LINEAR_PACE_TOLERANCE_PERCENT) return "over";
  if (percentLast7d >= targetPercent - LINEAR_PACE_TOLERANCE_PERCENT) return "on";
  return "under";
}

/**
 * The resolved OAuth-rebase slice of the snapshot headline (issue #2188).
 * Mirrors the inline `let` block in `assembleSnapshot` field-for-field — the
 * headline percentages plus the OAuth observability fields.
 */
export interface OAuthRebase {
  percentLast5h: number;
  percentLast7d: number;
  usageSource: "oauth" | "estimate";
  oauthError: string | null;
  oauthStale: boolean;
  oauthAgeMs: number | null;
  oauthFiveHourResetsAt: string | null;
  oauthSevenDayResetsAt: string | null;
}

/**
 * OAuth rebase (issue #1083, extracted to a named pure helper in #2188). When
 * the authoritative meter read succeeds, the headline `percentLast5h`/
 * `percentLast7d` are rebased onto the real OAuth utilization — the meter IS the
 * ground-truth 5h/7d utilization, strictly better than a calibration guess.
 *
 * HARD INVARIANT (#1083/#1124): on ANY failed/expired/garbage read the estimate
 * stands; the headline NEVER silently reads 0 (which would unblock dispatch
 * during an outage). The `logger.error` fail-loud on fallback is retained here
 * — it is intrinsic to the rebase decision, not assembly orchestration. A
 * served-stale last-good value (issue #1090) stays `usageSource:"oauth"` with
 * `oauthError:"oauth-usage-stale"` + `oauthStale:true`, so stale-but-real still
 * trips the downstream {@link deriveHardStop} (the meter is still the source).
 *
 * Takes the already-resolved {@link ScanResult.oauth} (the I/O fired + awaited
 * inside the #1971 transcript-scan seam) plus the two pre-computed estimate
 * scalars — no I/O of its own, exactly the #2041 `deriveHardStop` scalar-input
 * shape. Behaviour-neutral with the inline block it replaces. Exported for
 * direct unit test, NOT added to the `index.ts` public barrel.
 */
export function rebaseOnOAuth(
  cachedOAuth: ScanResult["oauth"],
  estimatePercentLast5h: number,
  estimatePercentLast7d: number,
): OAuthRebase {
  const oauth = cachedOAuth.result;
  // `isOAuthUsageOk` is the type guard the seam exports for narrowing under the
  // orchestrator's `strict:false` tsconfig (a bare `if (oauth.ok)` does not
  // narrow a discriminated union without strictNullChecks).
  if (isOAuthUsageOk(oauth)) {
    return {
      percentLast5h: oauth.data.fiveHour.utilization,
      percentLast7d: oauth.data.sevenDay.utilization,
      usageSource: "oauth",
      // A served-stale last-good still backs the headline with a stale sentinel
      // (so the operator sees WHY it's stale); a fresh read clears it to null.
      oauthError: cachedOAuth.stale ? "oauth-usage-stale" : null,
      oauthStale: cachedOAuth.stale,
      oauthAgeMs: cachedOAuth.ageMs,
      oauthFiveHourResetsAt: oauth.data.fiveHour.resetsAt,
      oauthSevenDayResetsAt: oauth.data.sevenDay.resetsAt,
    };
  }
  // Graceful degradation: fall back to the transcript+calibration estimate.
  // Reached only when there is NO recent-enough OAuth value to serve (a fresh
  // failure with no last-good, or a last-good aged past TTL+maxStale). Logged
  // (fail-loud) so a persistent OAuth outage is visible, but the gate stays
  // conservative on the estimate rather than reading 0.
  logger.error(
    { code: oauth.code },
    "[usage-tracker] OAuth usage meter unavailable; falling back to transcript estimate for percentLast5h/percentLast7d",
  );
  return {
    percentLast5h: estimatePercentLast5h,
    percentLast7d: estimatePercentLast7d,
    usageSource: "estimate",
    oauthError: oauth.code,
    oauthStale: false,
    oauthAgeMs: null,
    oauthFiveHourResetsAt: null,
    oauthSevenDayResetsAt: null,
  };
}

/** The since-reset slice of the snapshot (issue #2188). */
export interface SinceReset {
  tokensSinceReset: TokenBreakdown;
  percentSinceReset: number;
  weeklyResetAnchor: string | null;
}

/**
 * Weekly Reset Anchor / since-reset fixed-window derivation (issue #856,
 * ADR-0021; extracted to a named pure helper in #2188).
 *
 * Pure read-side projection: the effective boundary is derived ON READ from the
 * env projection, overridden by a more recent observed rate-limit reset (gated
 * `> envBoundary && <= now`). Nothing is persisted. Returns neutral
 * (all-zero/0/null) when the Anchor env var is unset (`anchorEnvMs === null`),
 * mirroring the uncalibrated-returns-neutral discipline. The auto-correct
 * `logger.warn` is retained here — it announces the boundary override, an
 * effect intrinsic to this derivation, not assembly orchestration.
 *
 * Takes the already-computed scalars/sub-accumulators (anchor env ms, the
 * observed-reset ms, the buffered since-reset entries, the two weighting axes,
 * the calibrated flag, and the weekly quota) — no I/O, the #2041 scalar-input
 * shape. The weighted `percentSinceReset` numerator composes both quota-weight
 * axes exactly like `percentLast7d` (#873). Behaviour-neutral with the inline
 * block it replaces. Exported for direct unit test, NOT added to the `index.ts`
 * public barrel.
 */
export function deriveSinceReset(input: {
  anchorEnvMs: number | null;
  mostRecentObservedResetMs: number | null;
  nowMs: number;
  sinceResetEntries: ScanResult["sinceResetEntries"];
  cacheReadWeight: number;
  burnWeights: { opus: number; sonnet: number; haiku: number };
  calibrated: boolean;
  weeklyQuota: number;
}): SinceReset {
  const {
    anchorEnvMs,
    mostRecentObservedResetMs,
    nowMs,
    sinceResetEntries,
    cacheReadWeight,
    burnWeights,
    calibrated,
    weeklyQuota,
  } = input;

  const tokensSinceReset: TokenBreakdown = { ...EMPTY_BREAKDOWN };
  if (anchorEnvMs === null) {
    return { tokensSinceReset, percentSinceReset: 0, weeklyResetAnchor: null };
  }

  const envWindow = projectResetWindow(anchorEnvMs, nowMs);
  let effectiveBoundaryMs = envWindow.currentMs;
  // Auto-correct: an observed reset that is more recent than the env
  // projection (but not in the future relative to now) is the real boundary.
  if (
    mostRecentObservedResetMs !== null &&
    mostRecentObservedResetMs > effectiveBoundaryMs &&
    mostRecentObservedResetMs <= nowMs
  ) {
    logger.warn(
      {
        observedReset: new Date(mostRecentObservedResetMs).toISOString(),
        envProjection: new Date(effectiveBoundaryMs).toISOString(),
        envAnchor: new Date(anchorEnvMs).toISOString(),
      },
      "[usage-tracker] Weekly Reset Anchor auto-corrected: observed reset overrides env projection",
    );
    effectiveBoundaryMs = mostRecentObservedResetMs;
  }
  // Accumulate the since-reset window both as a flat breakdown (the unchanged
  // `tokensSinceReset` snapshot field, honest raw counts) AND per-family (for
  // the WEIGHTED `percentSinceReset` numerator, which composes both weighting
  // axes exactly like `percentLast7d`). (issue #873)
  const byModelSinceReset = emptyByModel();
  for (const e of sinceResetEntries) {
    if (e.tsMs >= effectiveBoundaryMs) {
      addBreakdown(tokensSinceReset, e.tokens);
      addBreakdown(byModelSinceReset[e.family], e.tokens);
    }
  }
  const weightedBurnSinceReset = weightedQuotaBurn(byModelSinceReset, cacheReadWeight, burnWeights);
  const percentSinceReset = calibrated ? (weightedBurnSinceReset / weeklyQuota) * 100 : 0;
  const weeklyResetAnchor = new Date(effectiveBoundaryMs).toISOString();
  return { tokensSinceReset, percentSinceReset, weeklyResetAnchor };
}

// `SkillWoWEntry` — the per-skill week-over-week trend entry (issue #2404) —
// moved to the pure TYPE-vocabulary leaf `./types.ts` (issue #3071), alongside
// `UsageSnapshot` (which carries it as a field type). Imported type-only above;
// `deriveBySkillWoW` below builds it. It was NOT on the `index.ts` public barrel
// before the move and still isn't — same module-internal visibility.

/**
 * Per-skill week-over-week trend (issue #2404).
 *
 * For each skill present in the CURRENT week's `bySkillByModel` cross-tab,
 * compute its RAW total this week (sum over model families) and the delta vs
 * the SAME skill in the immediately-prior stored Weekly Usage Snapshot. The
 * trend is keyed off the current week's skills — a skill that dropped out of
 * the current week is simply absent (not surfaced as a -100% entry).
 *
 * PURE read-side projection (the ADR-0021 invariant): the prior-week per-skill
 * totals enter as an ARGUMENT (`priorBySkill`), fetched by `getUsage()` via the
 * typed `src/redis/usage-snapshots.ts` accessor BEFORE this assembler runs. This
 * helper itself reads NO Redis. When `priorBySkill` is `null` (no prior snapshot,
 * or Redis was down) every entry's `prior`/`deltaPct` is `null` ("new") — never
 * throws. `deltaPct` is computed only when the prior total is > 0.
 *
 * Exported for direct unit test, NOT added to the `index.ts` public barrel.
 */
export function deriveBySkillWoW(
  bySkillByModel: Record<string, Record<ModelFamily, TokenBreakdown>>,
  priorBySkill: Record<string, number> | null,
): Record<string, SkillWoWEntry> {
  const out: Record<string, SkillWoWEntry> = {};
  for (const skill of Object.keys(bySkillByModel)) {
    const row = bySkillByModel[skill];
    const current = MODEL_FAMILIES.reduce((sum, f) => sum + (row[f]?.total ?? 0), 0);
    const priorRaw = priorBySkill ? priorBySkill[skill] : undefined;
    const prior = typeof priorRaw === "number" && Number.isFinite(priorRaw) ? priorRaw : null;
    // deltaPct only when a positive prior exists (no divide-by-zero / Infinity,
    // no "new this week" % — that stays null and the UI renders it as "new").
    const deltaPct = prior !== null && prior > 0 ? ((current - prior) / prior) * 100 : null;
    out[skill] = { current, prior, deltaPct };
  }
  return out;
}

/**
 * **Attribution coverage %** (issue #2403): the inverse of the
 * `interactive`-residual token share over the 7d window. Pure read-side
 * projection over the {@link DispatchKind} cross-tab:
 *
 *   `attributedPercent = (total - interactive) / total * 100`
 *
 * where `total` and `interactive` are RAW `.total` summed across model families
 * (no quota-weight, no USD — matching the cross-tab's read-only posture). This
 * is the metric #2402 drives UP by shrinking the residual (formerly the
 * `UNATTRIBUTED_SKILL=100%` world). Returns 0 when `total === 0` OR every token
 * is interactive (no division by zero, and the all-residual world reads 0% —
 * not 100% — coverage). Result is clamped to `[0, 100]`. Exported for direct
 * unit test, NOT added to the `index.ts` public barrel.
 */
export function deriveAttributedPercent(
  byDispatchKind: Record<DispatchKind, Record<ModelFamily, TokenBreakdown>>,
): number {
  const kindTotal = (kind: DispatchKind): number =>
    MODEL_FAMILIES.reduce((sum, f) => sum + (byDispatchKind[kind][f]?.total ?? 0), 0);
  const total = DISPATCH_KINDS.reduce((sum, k) => sum + kindTotal(k), 0);
  if (total <= 0) return 0;
  const interactive = kindTotal("interactive");
  const pct = ((total - interactive) / total) * 100;
  // Clamp defensively to the documented [0,100] invariant.
  return pct < 0 ? 0 : pct > 100 ? 100 : pct;
}

/**
 * Calibration-drift detector (issue #873; extracted to a named pure helper in
 * #2188). Fail-loud, ONCE per scan: when an operator has seeded a reference
 * `percentSinceReset` reading AND the quota is calibrated AND the Weekly Reset
 * Anchor is set, warn if the tracker's `percentSinceReset` has diverged from the
 * reference by more than `driftFactor` in either direction — a coarse
 * "calibration has rotted" signal so it is visible, not silent.
 *
 * Read-time detection only: nothing is persisted, nothing self-recalibrates
 * (the tracker stays a pure read-side projection, ADR-0021). Inert when the
 * reference env var is unset (`driftReference === null`). A pure side-effecting
 * detector — returns nothing, exactly the inline block it replaces — over
 * already-computed scalars; no I/O. Exported for direct unit test, NOT added to
 * the `index.ts` public barrel.
 */
export function detectCalibrationDrift(input: {
  driftReference: number | null;
  driftFactor: number;
  percentSinceReset: number;
  calibrated: boolean;
  anchorEnvMs: number | null;
  cacheReadWeight: number;
  weeklyQuota: number;
}): void {
  const { driftReference, driftFactor, percentSinceReset, calibrated, anchorEnvMs } = input;
  if (driftReference === null || !calibrated || anchorEnvMs === null) return;
  const tooHigh = percentSinceReset > driftReference * driftFactor;
  const tooLow = percentSinceReset < driftReference / driftFactor;
  if (tooHigh || tooLow) {
    logger.warn(
      {
        percentSinceReset: Number(percentSinceReset.toFixed(2)),
        reference: Number(driftReference.toFixed(2)),
        driftFactor,
        cacheReadWeight: input.cacheReadWeight,
        weeklyQuota: input.weeklyQuota,
      },
      "[usage-tracker] calibration drift: percentSinceReset diverges from reference by more than driftFactor; " +
        "re-derive HYDRA_USAGE_WEEKLY_QUOTA_TOKENS / HYDRA_USAGE_CACHE_READ_WEIGHT against a fresh /usage reading",
    );
  }
}

/**
 * Estimate-vs-OAuth divergence detector (issue #2832 AC3). Fail-loud, ONCE per
 * scan: while the headline has fallen back to the transcript estimate during an
 * OAuth outage, warn if that fail-open estimate has diverged from the LAST-KNOWN
 * real OAuth utilization by more than `divergenceFactor` in either direction — a
 * "the number gating dispatch is a guess that no longer matches the last real
 * meter reading, so the un-gated-dispatch risk during this outage is real"
 * signal the operator can act on.
 *
 * DISTINCT from {@link detectCalibrationDrift}: that compares the since-reset
 * metric against an operator-SEEDED env reference (a slow calibration-rot
 * signal); THIS compares the live estimate against the meter's own last-known
 * value, and fires only DURING an active OAuth fallback where the stakes are
 * higher.
 *
 * INERT unless ALL of (issue #2832 invariant 4):
 *   - `usageSource === "estimate"` — the headline is CURRENTLY on the fail-open
 *     estimate (never fires while OAuth — fresh or served-stale — backs the
 *     headline; the meter is then ground truth and there is nothing to diverge
 *     from).
 *   - `lastKnownOAuthPercent !== null` — a real meter value was actually seen at
 *     some point (a null/absent baseline is the #1083 silent-0 trap — comparing
 *     against nothing would be a false alarm, so we stay silent).
 *   - `lastKnownOAuthPercent > 0` — a 0% baseline makes the ratio undefined; skip
 *     (a genuinely 0% real meter with a non-zero estimate is a distinct, rarer
 *     signal not worth a divide-by-zero).
 *
 * The comparison uses the 7d (weekly) axis — the window the emergencyBrake /
 * weekly gating keys off and the one the issue's "weekly utilization" framing
 * names. Read-time detection ONLY: persists nothing, self-recalibrates nothing,
 * mutates NO gating scalar (ADR-0021 pure read-side projection; issue #2832
 * invariant 1). A pure side-effecting detector — returns nothing — over
 * already-computed scalars; no I/O. Exported for direct unit test, NOT added to
 * the `index.ts` public barrel.
 */
export function detectEstimateOAuthDivergence(input: {
  usageSource: "oauth" | "estimate";
  estimatePercentLast7d: number;
  lastKnownOAuthPercent: number | null;
  divergenceFactor: number;
}): void {
  const { usageSource, estimatePercentLast7d, lastKnownOAuthPercent, divergenceFactor } = input;
  if (usageSource !== "estimate") return;
  if (lastKnownOAuthPercent === null || lastKnownOAuthPercent <= 0) return;
  const tooHigh = estimatePercentLast7d > lastKnownOAuthPercent * divergenceFactor;
  const tooLow = estimatePercentLast7d < lastKnownOAuthPercent / divergenceFactor;
  if (tooHigh || tooLow) {
    logger.warn(
      {
        estimatePercentLast7d: Number(estimatePercentLast7d.toFixed(2)),
        lastKnownOAuthPercent: Number(lastKnownOAuthPercent.toFixed(2)),
        divergenceFactor,
      },
      "[usage-tracker] estimate/OAuth divergence: transcript estimate (7d) diverges from the last-known OAuth " +
        "utilization by more than divergenceFactor during an OAuth outage — dispatch gating is currently on the " +
        "fail-open estimate; verify real weekly utilization at claude.ai before the next autopilot window",
    );
  }
}

/**
 * The pure snapshot-assembly phase (issue #1971): given the raw {@link
 * ScanResult} from the TranscriptScan seam and the anchor `now`, compute the
 * quota math (weighted burn numerators, estimate percents, pacingState, OAuth
 * rebase, drift detection, since-reset derivation) and build the final
 * {@link UsageSnapshot}. NO I/O — every input is in `scan` or read from the
 * pure env-config leaf. Behaviour-neutral with the former inline tail of
 * `scanUsage()`; the emitted snapshot is identical field-for-field for any
 * given scan input.
 *
 * `priorBySkill` (issue #2404) is the immediately-prior **Weekly Usage
 * Snapshot**'s per-skill raw totals, fetched by `getUsage()` via the typed
 * Redis accessor and INJECTED here so the assembler reads NO Redis itself
 * (ADR-0021). `null` means no prior week — every WoW entry is then "new".
 *
 * Relocated from `usage-tracker.ts` (issue #2988) so the COMPLETE assembly
 * story — the helper folds above AND this coordinator that composes them —
 * lives in the one leaf named for the concern. It reads its calibration env via
 * the `config.ts` readers, folds the two hard-stops via `eligibility.ts`'s
 * `deriveHardStop`, and composes the pure fold helpers above — all one-way
 * imports (no runtime cycle). Exported for direct unit test AND consumed by the
 * `getUsage()` I/O coordinator in `usage-tracker.ts`; deliberately NOT added to
 * the `cost/index.ts` public barrel (module-internal, same posture as the fold
 * helpers).
 */
export function assembleSnapshot(
  scan: ScanResult,
  now: Date,
  priorBySkill: Record<string, number> | null = null,
): UsageSnapshot {
  const nowMs = now.getTime();
  const {
    acc5h,
    acc7d,
    byModel5h,
    byModel7d,
    byModel24h,
    bySkillByModel,
    bySkillByModel24h,
    byDispatchKind,
    tokens24h,
    foreign7d,
    mostRecentObservedResetMs,
    sinceResetEntries,
    filesScanned,
    filesSkippedByMtime,
    linesParsed,
    linesWithUsage,
    parseErrors,
    filesServedFromMemo,
  } = scan;

  const weeklyQuota = getWeeklyQuotaTokens();
  const fiveHourQuota = getFiveHourQuotaTokens();
  const calibrated = weeklyQuota > 0 && fiveHourQuota > 0;

  const weights = {
    opus: getQuotaWeightOpus(),
    sonnet: getQuotaWeightSonnet(),
    haiku: getQuotaWeightHaiku(),
  };
  const quotaWeightCalibrated = weights.opus > 0 && weights.sonnet > 0 && weights.haiku > 0;

  // Weekly Reset Anchor env (issue #856): needed by the since-reset math below.
  // The scan already buffered `sinceResetEntries` only when this was set; here
  // we re-read it to gate the since-reset assembly (zero work when unset).
  const anchorEnvMs = getWeeklyResetAnchorMs();

  // Quota-burn numerator weighting (issue #873). The burn PERCENTAGES are
  // computed on the WEIGHTED unit `input + output + cacheCreation +
  // w_cache*cacheRead`, composed with the per-model-family Quota Weight. When
  // quota weights are uncalibrated (the default) the family multipliers are all
  // 1.0 (identity) so the result reduces to the single-axis cache-weighted
  // total; with `w_cache = 1.0` (the default) it reduces further to the raw
  // .total — i.e. byte-for-byte the pre-#873 behaviour. Raw `.total` fields are
  // untouched; only these numerators change.
  const cacheReadWeight = getCacheReadWeight();
  const burnWeights = quotaWeightCalibrated ? weights : { opus: 1, sonnet: 1, haiku: 1 };
  // The weighted-burn NUMERATOR triple — composed pure fold extracted to
  // {@link deriveWeightedBurns} (issue #2247).
  const weightedBurns = deriveWeightedBurns(
    byModel5h,
    byModel7d,
    byModel24h,
    cacheReadWeight,
    burnWeights,
  );

  // Transcript+calibration ESTIMATE (the historical headline + fallback path).
  // Pure derivation extracted to {@link deriveEstimatePercents} (issue #2247).
  // `projectedWeeklyPercent` is retained VERBATIM (a forward-looking burst
  // projection) — #4121 decoupled `pacingState` from it, not its meaning.
  const { estimatePercentLast5h, estimatePercentLast7d, projectedWeeklyPercent } =
    deriveEstimatePercents(weightedBurns, weeklyQuota, fiveHourQuota, calibrated);

  // OAuth rebase (issue #1083). When the authoritative meter read succeeds, the
  // headline `percentLast5h`/`percentLast7d` and the 5h `emergencyStop` are
  // rebased onto the real utilization — the meter IS the ground-truth 5h/7d
  // utilization, strictly better than a calibration guess. HARD INVARIANT: on
  // ANY failed/expired/garbage read the estimate stands; the headline NEVER
  // silently reads 0 (which would unblock dispatch during an outage). Since
  // #1124 BOTH hard-stops (5h `emergencyStop` and `weeklyEmergencyStop`) are
  // gated on `usageSource === "oauth"` so a failed read can no longer trigger a
  // stop on the estimate — autopilot fails open and defers to Claude's own
  // session-limit enforcement (#1089) + the operator. The ADR-0021 since-reset /
  // Pace-Gate PACING machinery (percentSinceReset, projectPacingCurve) is
  // byte-for-byte untouched — only the two hard-stops + rolling headline move.
  // The OAuth read was fired + awaited inside the TranscriptScan seam (issue
  // #1971) and arrives here already resolved on `scan.oauth` — same
  // fire-then-await-after-walk ordering, just owned by the I/O module now. The
  // rebase + fail-loud fallback is the pure {@link rebaseOnOAuth} helper (#2188).
  const {
    percentLast5h,
    percentLast7d,
    usageSource,
    oauthError,
    oauthStale,
    oauthAgeMs,
    oauthFiveHourResetsAt,
    oauthSevenDayResetsAt,
  } = rebaseOnOAuth(scan.oauth, estimatePercentLast5h, estimatePercentLast7d);

  // Both hard-stops (the 5h `emergencyStop` and the weekly `weeklyEmergencyStop`)
  // are derived by the pure `deriveHardStop` threshold predicate (issue #2041),
  // folding over the three scalars now in hand. They are driven EXCLUSIVELY by
  // the real OAuth meter (issue #1124): on the OAuth path the meter is a real
  // 0–100 utilization (a served-stale last-good is `usageSource === "oauth"` too
  // — stale-but-real still stops), so the >=90 gate fires on ground truth. On the
  // estimate fallback path the headline is the transcript+calibration guess
  // (~half-of-real, #1083), which caused FALSE stops during OAuth outages — so
  // the estimate NEVER triggers either stop regardless of percent. During a
  // prolonged OAuth outage autopilot does not self-stop on usage; it fails open
  // and defers to Claude's own session-limit enforcement (the #1089 pace-gate
  // block) plus the operator. The estimate is still surfaced as the displayed
  // headline (#1090) — only the STOP decision is decoupled from it. The weekly
  // analogue previously rode `percentSinceReset` (the ADR-0021 since-reset
  // CALIBRATION estimate) before #1124 moved it onto the real `percentLast7d`
  // meter; the ADR-0021 since-reset machinery (Pacing Curve) is untouched and
  // remains the pacing signal.
  const { emergencyStop, weeklyEmergencyStop } = deriveHardStop({
    percentLast5h,
    percentLast7d,
    usageSource,
  });

  // Quota-Weight burn totals (issue #691). Raw `.total` per family scaled ONLY by
  // the per-model-family Quota Weight (no cache-read weight); 0 unless all three
  // weights are positive. Pure derivation extracted to {@link deriveQuotaWeightTotals}
  // (issue #2247).
  const { quotaWeightLast5h, quotaWeightLast7d } = deriveQuotaWeightTotals(
    byModel5h,
    byModel7d,
    weights,
    quotaWeightCalibrated,
  );

  // Weekly Reset Anchor / since-reset fixed window (issue #856, ADR-0021).
  // Pure read-side projection extracted to {@link deriveSinceReset} (issue
  // #2188): the effective boundary is derived ON READ from the env projection,
  // overridden by a more recent observed reset. Nothing is persisted. Neutral
  // (null/0/all-zero) when the env Anchor is unset.
  const { tokensSinceReset, percentSinceReset, weeklyResetAnchor } = deriveSinceReset({
    anchorEnvMs,
    mostRecentObservedResetMs,
    nowMs,
    sinceResetEntries,
    cacheReadWeight,
    burnWeights,
    calibrated,
    weeklyQuota,
  });

  // Weekly window position + linear-pace verdict (issue #4121). Runs AFTER
  // deriveSinceReset because the window-start precedence needs its
  // `weeklyResetAnchor` as the fallback reference when the OAuth meter's own
  // 7-day boundary is unavailable (estimate-fallback path) — a pure reordering
  // of local consts; no other field's value changes (design-concept
  // issue-4121 INV-7). Keys off window position + the rebased headline
  // `percentLast7d`, NOT the 24h burst projection, which read a single busy
  // day as "over" regardless of how much of the window remained (observed
  // 2026-08-17: 67% consumed at 70.1% elapsed, paceRatio 0.96, reported
  // "over"). Pure folds: {@link deriveWindowPace} + {@link derivePacingState}.
  const { windowElapsedFraction, paceRatio } = deriveWindowPace({
    nowMs,
    sevenDayResetsAt: oauthSevenDayResetsAt,
    weeklyResetAnchor,
    percentLast7d,
  });
  const pacingState = derivePacingState(
    calibrated,
    percentLast7d,
    windowElapsedFraction,
    projectedWeeklyPercent,
  );

  // Drift detector (issue #873; pure side-effecting detector extracted to
  // {@link detectCalibrationDrift} in #2188). Fail-loud, ONCE per scan: when an
  // operator has seeded a reference `percentSinceReset` reading AND the quota is
  // calibrated AND the Anchor is set, warn if the tracker's `percentSinceReset`
  // diverges from the reference by more than `driftFactor`. Read-time detection
  // only — nothing is persisted, nothing self-recalibrates. Inert when unset.
  detectCalibrationDrift({
    driftReference: getDriftReferencePercent(),
    driftFactor: getDriftFactor(),
    percentSinceReset,
    calibrated,
    anchorEnvMs,
    cacheReadWeight,
    weeklyQuota,
  });

  // Estimate-vs-OAuth divergence detector (issue #2832 AC3; pure side-effecting
  // detector in {@link detectEstimateOAuthDivergence}). Fail-loud, ONCE per scan:
  // when the headline has fallen back to the transcript estimate during an OAuth
  // outage AND that estimate diverges from the LAST-KNOWN real OAuth utilization
  // by more than the configured factor (default 1.5x), warn so the operator knows
  // the number gating dispatch is a guess far from the last real reading. The
  // baseline rides in on `scan.oauth.lastKnownOAuth` (surfaced by the #1090 cache
  // layer even on the estimate-fallback path) so this stays a pure argument-fed
  // detector — NO new read, no mutation of any gating scalar (invariant 1). Inert
  // whenever the headline is on OAuth (fresh or served-stale) or no real meter
  // value has ever been seen (null baseline — the #1083 silent-0 trap).
  detectEstimateOAuthDivergence({
    usageSource,
    estimatePercentLast7d,
    lastKnownOAuthPercent: scan.oauth.lastKnownOAuth?.sevenDay.utilization ?? null,
    divergenceFactor: getOAuthEstimateDivergenceFactor(),
  });

  // (weeklyEmergencyStop was computed alongside emergencyStop above via the
  // shared `deriveHardStop` predicate — issue #2041.)

  return {
    tokensLast5h: acc5h,
    tokensLast7d: acc7d,
    tokensLast24h: tokens24h,
    // Foreign-provider spend (issue #3769) — reported ALONGSIDE the Anthropic
    // numbers, never folded into them. `tokensLast7d` above is Anthropic-only
    // by construction, so this is additive information, not a subtraction the
    // reader has to apply.
    tokensForeignLast7d: foreign7d.total,
    percentLast5h,
    percentLast7d,
    usageSource,
    oauthError,
    oauthStale,
    oauthAgeMs,
    oauthFiveHourResetsAt,
    oauthSevenDayResetsAt,
    windowElapsedFraction,
    paceRatio,
    projectedWeeklyPercent,
    pacingState,
    emergencyStop,
    weeklyEmergencyStop,
    calibrated,
    byModel: byModel7d,
    bySkillByModel,
    // Per-skill × per-family 24h cross-tab (issue #3752). Surfaced verbatim from
    // the scan so the comprehensive cost-by-class arm can re-project it through
    // skillToCostClass without a second walk. Pure read-side projection; no
    // weighting applied here (the cost fold owns the Quota-Weight axis).
    bySkillByModel24h,
    // Per-skill week-over-week trend (issue #2404). Pure fold over the current
    // cross-tab + the injected prior-week per-skill totals — no Redis here.
    bySkillWoW: deriveBySkillWoW(bySkillByModel, priorBySkill),
    // Dispatch-kind split + attribution coverage % (issue #2403). Pure
    // projections over the SAME per-file tokens as the per-skill cross-tab.
    byDispatchKind,
    attributedPercent: deriveAttributedPercent(byDispatchKind),
    quotaWeightLast5h,
    quotaWeightLast7d,
    quotaWeightCalibrated,
    weeklyQuotaTokens: weeklyQuota,
    fiveHourQuotaTokens: fiveHourQuota,
    filesScanned,
    filesSkippedByMtime,
    linesParsed,
    linesWithUsage,
    parseErrors,
    filesServedFromMemo,
    generatedAt: now.toISOString(),
    cacheHitRatioLast5h: cacheHitRatio(acc5h),
    cacheHitRatioLast7d: cacheHitRatio(acc7d),
    tokensSinceReset,
    percentSinceReset,
    weeklyResetAnchor,
  };
}

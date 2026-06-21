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
 * `console.warn`/`console.error` calls retained here (the OAuth-fallback fail-loud,
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

import { isOAuthUsageOk } from "./oauth-usage.ts";
// Pure math leaf (issue #1909 / #2279): the weighted-token unit, the reset-window
// projection, and the shared family primitives (`familyWeight`, `MODEL_FAMILIES`)
// live in `./token-math.ts`. The snapshot-assembly folds below consume them
// one-way; token-math.ts imports nothing from src/cost/.
import {
  weightedTokens,
  projectResetWindow,
  familyWeight,
  MODEL_FAMILIES,
} from "./token-math.ts";
import type { TokenBreakdown, ModelFamily } from "./token-math.ts";
// TranscriptScan seam (issue #1971): the empty-breakdown constants + per-family
// accumulator helpers, plus the `ScanResult` boundary type the OAuth-rebase /
// since-reset folds read slices of. One-way import (this leaf never imports back).
import { EMPTY_BREAKDOWN, emptyByModel, addBreakdown } from "./transcript-scan.ts";
import type { ScanResult } from "./transcript-scan.ts";

/**
 * The composed two-axis quota-burn numerator over a per-family accumulator
 * (issue #873). Axis A (per-token-type cache weight) reshapes the token mix
 * INSIDE each family via {@link weightedTokens}; Axis B (per-model-family
 * **Quota Weight**) scales OUTSIDE via {@link familyWeight}:
 *
 *   `Σ_family familyWeight(f) * weightedTokens(family[f], w_cache)`
 *
 * The two axes are orthogonal, so they never double-count. When all family
 * weights are 1.0 (the dormant `quotaWeightCalibrated === false` prod state)
 * this reduces EXACTLY to the single-axis cache-weighted total
 * (`Σ_family weightedTokens(family[f], w_cache)`), which in turn reduces to the
 * raw `Σ_family family[f].total` when `w_cache === 1.0`. Passing the
 * identity-weights object `{opus:1,sonnet:1,haiku:1}` (what the caller does
 * when quota weights are uncalibrated) keeps the percentage path honest
 * regardless of the #691 calibration state.
 *
 * The proof-of-pattern for the issue #2188 snapshot-assembly deepening: the
 * other inline math concerns ({@link rebaseOnOAuth}, {@link deriveSinceReset},
 * {@link detectCalibrationDrift}, {@link derivePacingState}) follow this same
 * pure-scalar-helper shape — each takes already-computed scalars/sub-accumulators
 * and returns its slice of the snapshot, never a `UsageSnapshot` (which
 * does not exist yet during assembly), mirroring eligibility.ts's
 * {@link deriveHardStop}.
 */
function weightedQuotaBurn(
  byModel: Record<ModelFamily, TokenBreakdown>,
  wCache: number,
  weights: { opus: number; sonnet: number; haiku: number },
): number {
  return MODEL_FAMILIES.reduce(
    (sum, f) => sum + familyWeight(f, weights) * weightedTokens(byModel[f], wCache),
    0,
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
 * Pacing-state fold (issue #2188; extracted from `assembleSnapshot`).
 *
 * The `pacingState` keys off the transcript-derived 24h projection (NOT the
 * OAuth headline) — it is part of the ADR-0021 projection family the #1971 seam
 * leaves intact. Pure scalar fold: `"over"` when projecting past quota, `"on"`
 * in the 80–100% informational band, `"under"` otherwise (including every
 * uncalibrated run, where `projectedWeeklyPercent` is 0). Byte-for-byte the
 * inline three-way branch it replaces. Exported from this module for direct
 * unit test, NOT added to the `index.ts` public barrel.
 */
export function derivePacingState(
  calibrated: boolean,
  projectedWeeklyPercent: number,
): "under" | "on" | "over" {
  if (!calibrated) return "under";
  if (projectedWeeklyPercent > 100) return "over";
  if (projectedWeeklyPercent >= 80) return "on";
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
 * during an outage). The `console.error` fail-loud on fallback is retained here
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
  console.error(
    `[usage-tracker] OAuth usage meter unavailable (${oauth.code}); falling back to transcript estimate for percentLast5h/percentLast7d`,
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
 * `console.warn` is retained here — it announces the boundary override, an
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
    console.warn(
      `[usage-tracker] Weekly Reset Anchor auto-corrected: observed reset ` +
        `${new Date(mostRecentObservedResetMs).toISOString()} overrides env projection ` +
        `${new Date(effectiveBoundaryMs).toISOString()} (env anchor ` +
        `${new Date(anchorEnvMs).toISOString()})`,
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
    console.warn(
      `[usage-tracker] calibration drift: percentSinceReset ` +
        `${percentSinceReset.toFixed(2)}% diverges from reference ` +
        `${driftReference.toFixed(2)}% by more than ${driftFactor}x ` +
        `(cacheReadWeight=${input.cacheReadWeight}, weeklyQuota=${input.weeklyQuota}); ` +
        `re-derive HYDRA_USAGE_WEEKLY_QUOTA_TOKENS / HYDRA_USAGE_CACHE_READ_WEIGHT ` +
        `against a fresh /usage reading`,
    );
  }
}

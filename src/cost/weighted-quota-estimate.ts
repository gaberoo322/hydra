/**
 * src/cost/weighted-quota-estimate.ts — the quota-weighted dispatch-cost-join
 * figure (issue #4126 INV-2; split out of the former bundled cost-attribution
 * module by issue #4347).
 *
 * `weightedQuotaTokensEstimate` is the quota-weighted figure
 * `POST /api/usage/dispatch-cost` computes at write time:
 * `projectWeightedQuotaTokensEstimate` is the pure fold (unit-testable on
 * fixtures); `getWeightedQuotaTokensEstimate` composes it with the
 * already-memoized `getUsage()` snapshot + the calibrated env weights.
 *
 * Imports only `./config.ts`, `./token-math.ts`, `./usage-tracker.ts` (+ the
 * pure type leaves) — issue #4347 INV-5: a write-time fold over the snapshot +
 * Quota-Weight env, deliberately separate from the Redis-seam read in
 * `usage-by-issue.ts` despite the shared issue number (#4126).
 *
 * Public symbols are re-exported from `src/cost/index.ts` — the single public
 * Interface of the Cost module; callers import from `../cost/index.ts`.
 */

// Quota-Weight env readers (issue #691) — the calibration gate for the
// weighted figure. Pure config leaf, no cycle.
import {
  getQuotaWeightOpus,
  getQuotaWeightSonnet,
  getQuotaWeightHaiku,
} from "./config.ts";
// Per-family Quota-Weight + the canonical family list (issue #1909). Pure math
// leaf; imported one-way.
import { familyWeight, MODEL_FAMILIES } from "./token-math.ts";
import type { TokenBreakdown, ModelFamily } from "./token-math.ts";
// The ALREADY-MEMOIZED Subscription Usage Tracker snapshot (60s in-process
// cache the autopilot tick and dashboard share) — no new filesystem walk per
// dispatch-cost POST. One-way import: usage-tracker.ts imports nothing back.
import { getUsage } from "./usage-tracker.ts";

/**
 * Pure fold: split one dispatch's raw `dispatchTokensEstimate` across model
 * families using a skill's per-family 7-day token mix, then apply the
 * calibrated per-family Quota-Weight — the SAME `familyWeight` fold
 * `cost-by-class.ts`'s `projectCostByClassFromTranscript` applies to each
 * class entry's `quotaWeight`, just applied to a single dispatch's raw total
 * instead of a class's already-real per-family split (a dispatch has no
 * per-family breakdown of its own — reap's hook-floor `total_tokens` is a
 * scalar — so this fold estimates one by assuming the dispatch's tokens land
 * across families in the SAME proportion as the skill's recent history).
 *
 * Degrades to `dispatchTokensEstimate` unchanged (identity, implicit weight
 * 1.0) when either guard fails: `quotaWeightCalibrated` is false (the env
 * weights are not all positive), or `familyTotals` has no tokens yet (a cold
 * skill with no 7-day history to split by) — never fabricates a family split
 * from data that isn't there.
 *
 * Pure + total: no Redis, no env read, no `Date.now()` — mirrors the Cost
 * module's other `project*` folds (ADR-0014).
 */
export function projectWeightedQuotaTokensEstimate(
  dispatchTokensEstimate: number,
  familyTotals: Record<ModelFamily, TokenBreakdown> | undefined,
  weights: { opus: number; sonnet: number; haiku: number },
  quotaWeightCalibrated: boolean,
): number {
  const raw =
    Number.isFinite(dispatchTokensEstimate) && dispatchTokensEstimate > 0 ? dispatchTokensEstimate : 0;
  if (raw === 0 || !quotaWeightCalibrated || !familyTotals) return raw;

  const skillTotal = MODEL_FAMILIES.reduce((sum, f) => sum + (familyTotals[f]?.total ?? 0), 0);
  if (skillTotal <= 0) return raw;

  const weighted = MODEL_FAMILIES.reduce((sum, f) => {
    const familyTokens = familyTotals[f]?.total ?? 0;
    const fraction = familyTokens / skillTotal;
    return sum + raw * fraction * familyWeight(f, weights);
  }, 0);
  return Math.round(weighted);
}

/**
 * Composer: reads the ALREADY-MEMOIZED `getUsage()` snapshot (the 60s
 * in-process cache the autopilot tick and dashboard share — no new
 * filesystem walk per dispatch-cost POST) and the calibrated env weights,
 * then folds them with {@link projectWeightedQuotaTokensEstimate}. `skill`
 * `null`/absent (reap could not resolve one) skips straight to the raw
 * identity — same degrade posture as an unknown skill.
 */
export async function getWeightedQuotaTokensEstimate(
  dispatchTokensEstimate: number,
  skill: string | null,
): Promise<{ weightedQuotaTokensEstimate: number; quotaWeightCalibrated: boolean }> {
  const weights = {
    opus: getQuotaWeightOpus(),
    sonnet: getQuotaWeightSonnet(),
    haiku: getQuotaWeightHaiku(),
  };
  const quotaWeightCalibrated = weights.opus > 0 && weights.sonnet > 0 && weights.haiku > 0;
  if (!skill) {
    return { weightedQuotaTokensEstimate: dispatchTokensEstimate, quotaWeightCalibrated };
  }
  const snapshot = await getUsage();
  const familyTotals = snapshot.bySkillByModel[skill];
  const weightedQuotaTokensEstimate = projectWeightedQuotaTokensEstimate(
    dispatchTokensEstimate,
    familyTotals,
    weights,
    quotaWeightCalibrated,
  );
  return { weightedQuotaTokensEstimate, quotaWeightCalibrated };
}

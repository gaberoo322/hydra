/**
 * src/cost/index.ts — public surface of the **Cost** Module.
 *
 * The Cost Module owns Claude Code subagent token accounting on the
 * orchestrator side: recording per-skill / per-cycle token usage, exposing
 * the daily token counter consumed by the `/api/metrics/cost` dashboard
 * tile, AND projecting Anthropic-quota consumption via the Subscription
 * Usage Tracker. Storage is delegated to
 * `src/redis/cost.ts` (the Redis Adapter for `hydra:cost:*`); the tracker
 * has no Redis surface — it scans Claude Code's on-disk JSONL transcripts.
 *
 * **Accounting only, not enforcement.** Quota gating for the autopilot lives
 * in the Subscription Usage Tracker (`./usage-tracker.ts`) via
 * `/api/usage/eligibility`; the token counter is exclusively for dashboard
 * observability.
 *
 * Codex-era / dollar-machinery pieces retired in the cleanup wave:
 *   - the JSONL reconciliation pipeline (#602)
 *   - the dollar-based daily-spend cap on the scheduler side (B-series)
 *   - the per-cycle circuit breaker in `cap.ts`
 *   - the dollar-conversion surrogate machinery (#704) and the writer-less
 *     USD attribution plane — `attribution.ts`, `/metrics/cost-attribution`,
 *     `/spending` (#1651). The surrogate is a pure token counter; the sole
 *     sanctioned USD surface left is the recs-engine daily-spend ledger
 *     (direct Anthropic API, real money).
 *
 * This file is the ONLY public import surface. Everything outside
 * `src/cost/` imports from here (`from "../cost/index.ts"`); the internal
 * split between `surrogate.ts` and `usage-tracker.ts` is an implementation
 * detail.
 */

// ---------------------------------------------------------------------------
// Surrogate — token recording + daily token counter (issue #394, #704)
// ---------------------------------------------------------------------------
export {
  recordSubagentTokens,
  getDailyTokenCounter,
  todayDateString,
  yesterdayDateString,
  // Re-export key helpers so tests that probe Redis directly stay on the
  // public Interface rather than reaching into `surrogate.ts`.
} from "./surrogate.ts";

// ---------------------------------------------------------------------------
// Env-config readers — the pure-leaf config cluster (issue #1896)
// ---------------------------------------------------------------------------
// The `getXxx()` env readers + their DEFAULT_* constants were extracted out of
// `usage-tracker.ts` (and `getWeeklyPaceCeiling` out of `eligibility.ts`) into
// the stateless leaf `./config.ts`. Re-exported here at the SAME names so the
// public surface is unchanged.
export {
  getWeeklyQuotaTokens,
  getFiveHourQuotaTokens,
  getOAuthUsageTtlMs,
  getOAuthUsageMaxStaleMs,
  getOAuthUsageBackoffBaseMs,
  getOAuthUsageBackoffMaxMs,
  DEFAULT_OAUTH_USAGE_TTL_MS,
  DEFAULT_OAUTH_USAGE_MAX_STALE_MS,
  DEFAULT_OAUTH_USAGE_BACKOFF_BASE_MS,
  DEFAULT_OAUTH_USAGE_BACKOFF_MAX_MS,
  getWeeklyResetAnchorMs,
  getCacheReadWeight,
  DEFAULT_CACHE_READ_WEIGHT,
  // Per-model-family Quota Weight readers (issue #691). Re-exported on the public
  // barrel for the Class Yield Scoreboard's Weighted-Quota Cost Axis (issue #3548):
  // its composer resolves the SAME calibration gate `assembleSnapshot` uses
  // (all-three-positive → the env weights, else identity) so the scoreboard and
  // `/api/usage` weight burn identically — one calibration surface, two consumers.
  getQuotaWeightOpus,
  getQuotaWeightSonnet,
  getQuotaWeightHaiku,
  getDriftReferencePercent,
  getDriftFactor,
  DEFAULT_DRIFT_FACTOR,
  getOAuthEstimateDivergenceFactor,
  DEFAULT_OAUTH_ESTIMATE_DIVERGENCE_FACTOR,
  getWeeklyPaceCeiling,
  DEFAULT_WEEKLY_PACE_CEILING,
  // Ranked-report burn weights (issue #3825). DISTINCT from the live-fold
  // readers above: these default to LIST-PRICE ratios (cache read 0.1x / cache
  // write 1.25x / output 5.0x / input 1.0x; family opus 5 / sonnet 3 / haiku 1)
  // under a separate `HYDRA_USAGE_BURN_WEIGHT_*` / `HYDRA_USAGE_BURN_FAMILY_*`
  // namespace so the report's calibration never leaks into the identity-by-
  // default live gate. Consumed by `scripts/cost/weighted-quota-report.ts`.
  getBurnWeightInput,
  getBurnWeightOutput,
  getBurnWeightCacheRead,
  getBurnWeightCacheCreation,
  DEFAULT_BURN_WEIGHT_INPUT,
  DEFAULT_BURN_WEIGHT_OUTPUT,
  DEFAULT_BURN_WEIGHT_CACHE_READ,
  DEFAULT_BURN_WEIGHT_CACHE_CREATION,
  getBurnCategoryWeights,
  getBurnFamilyWeightOpus,
  getBurnFamilyWeightSonnet,
  getBurnFamilyWeightHaiku,
  DEFAULT_BURN_FAMILY_OPUS,
  DEFAULT_BURN_FAMILY_SONNET,
  DEFAULT_BURN_FAMILY_HAIKU,
  getBurnFamilyWeights,
} from "./config.ts";

// ---------------------------------------------------------------------------
// Token math — the pure-leaf math cluster (issue #1909)
// ---------------------------------------------------------------------------
// The seven pure functions (model-family classifier, JSONL-line parser,
// quota-weight / cache-hit formulas, weekly-reset / session-limit time math)
// were extracted out of `usage-tracker.ts` into the stateless leaf
// `./token-math.ts`. Re-exported here at the SAME names so the public surface
// is unchanged.
export {
  parseSessionLimitReset,
  // `weightedTokens` (issue #3825) — the per-token-category weighted UNIT
  // (`w_input*input + w_output*output + w_cacheCreation*cacheCreation +
  // w_cacheRead*cacheRead`). Re-exported on the barrel so the ranked report
  // (`scripts/cost/weighted-quota-report.ts`) builds per-consumer weighted burn
  // from the same leaf the live fold uses, not a re-derived formula.
  weightedTokens,
} from "./token-math.ts";
// `CategoryWeights` — the four-knob weight shape `weightedTokens` consumes
// (issue #3825). Type-only on the barrel so callers compose it without a deep
// `./token-math.ts` import.
export type { CategoryWeights } from "./token-math.ts";

// ---------------------------------------------------------------------------
// Transcript scan — real per-session token recovery (issue #3250)
// ---------------------------------------------------------------------------
// `tokensForSession` recovers the REAL token count for a subagent session from
// Claude Code's on-disk JSONL transcripts (best-effort + total: returns 0 on any
// failure, never throws). Re-exported here so the `/api/metrics` reap-completion
// backfill imports it through the barrel rather than the deep `transcript-scan.ts`
// path.
export {
  tokensForSession,
} from "./transcript-scan.ts";

// ---------------------------------------------------------------------------
// Subscription Usage Tracker — Anthropic-quota projection (PR A #606, B-series)
// ---------------------------------------------------------------------------
export {
  getUsage,
  clearUsageCache,
  sessionIdFromPath,
  INTERACTIVE_SKILL,
} from "./usage-tracker.ts";

// `UsageSnapshot` — the assembled snapshot shape — moved to the pure
// TYPE-vocabulary leaf `./types.ts` (issue #3071); re-exported here from the leaf
// so every `from "../cost/index.ts"` import site is unchanged. `SkillResolver`
// stays sourced from `./usage-tracker.ts` (which itself re-exports it from the
// transcript-scan seam).
export type { UsageSnapshot } from "./types.ts";
export type {
  SkillResolver,
} from "./usage-tracker.ts";

// ---------------------------------------------------------------------------
// Weighted-quota fold — the ONE Quota-Weight definition (issue #873, #3548)
// ---------------------------------------------------------------------------
// `weightedQuotaBurn(byModel, cacheReadWeight, burnWeights)` is the two-axis
// quota-burn numerator that backs `/api/usage`'s `weightedBurn7d`. Promoted from a
// module-internal `snapshot-assembly.ts` helper onto the public barrel (issue
// #3548) so the Class Yield Scoreboard's per-class **Weighted-Quota Cost Axis**
// reuses the IDENTICAL fold on each `bySkillByModel[skill]` breakdown — the
// scoreboard and the usage snapshot share ONE weighting definition (the CONTEXT.md
// single-definition-of-Quota-Weight rule) rather than the scoreboard re-deriving a
// second, divergent formula. The remaining snapshot-assembly folds stay
// module-internal (test-only exports).
export {
  weightedQuotaBurn,
  // `weightedQuotaBurnByCategory` (issue #3825) — the general four-category
  // two-axis fold the ranked report uses; the legacy `weightedQuotaBurn` above
  // now delegates to it with cache-read-only weights, keeping the live gate +
  // Class Yield Scoreboard byte-identical. Same single-definition-of-Quota-Weight
  // posture as its sibling.
  weightedQuotaBurnByCategory,
} from "./snapshot-assembly.ts";

// ---------------------------------------------------------------------------
// Eligibility — the pure dispatch-gating fold over UsageSnapshot (issue #1377)
// ---------------------------------------------------------------------------
export {
  projectEligibility,
  projectEligibilityView,
  overlayPauseEligibility,
  overlaySessionBlockEligibility,
  overlayWorklessEligibility,
  overlayMeterUnavailableEligibility,
} from "./eligibility.ts";
// The narrowed pacing-dashboard read-model — the canonical view type the
// autopilot-status seam + idle-diagnostics route both consume (issue #3108).
export type { EligibilityView } from "./eligibility.ts";
// The full dispatch-gating verdict the overlay chain returns — the type the
// `/api/usage/eligibility` aggregator leaf composes and returns (issue #3182).
export type { UsageEligibility } from "./eligibility.ts";

// ---------------------------------------------------------------------------
// OAuth Usage Adapter — authoritative server-side meter (issue #1083)
// ---------------------------------------------------------------------------
export type { OAuthUsageResult } from "./oauth-usage.ts";

// ---------------------------------------------------------------------------
// Cost attribution — per-class token rollup (issue #1439, relocated #2219)
// ---------------------------------------------------------------------------
// The dispatch-class → cost-bucket mapping (`skillToCostClass`) and per-class
// token rollup, relocated out of `src/metrics/aggregate.ts` into
// `./cost-attribution.ts` (issue #2219) so the Cost domain's knowledge lives in
// one module. `projectCostByClass` / `getCostByClass` fold the dispatch-observed
// surrogate (historical `?date=` arm); `projectCostByClassFromTranscript` /
// `getRollingCostByClass` fold the transcript-scan snapshot (comprehensive
// rolling arm, issue #3752 — per-class tokens sum to `tokensLast24h`). Each
// result carries a `source` discriminator so the two arms are never mistaken.
// Re-exported here so the public Interface contract stays single-surface.
export {
  COST_CLASS_ORDER,
  skillToCostClass,
  projectCostByClass,
  projectCostByClassFromTranscript,
  getCostByClass,
  getRollingCostByClass,
} from "./cost-attribution.ts";
export type { CostByClassSource } from "./cost-attribution.ts";

// ---------------------------------------------------------------------------
// Cost per merged PR — pure derived ratio over recorded totals (issue #2807)
// ---------------------------------------------------------------------------
// A DERIVED read: token totals summed from the per-day surrogate buckets +
// a merged-PR count injected by the API route from the existing cycle-metrics
// merged feed. No new token-recording writer; accounting/projection only.
export {
  DEFAULT_COST_PER_MERGED_PR_WINDOW_DAYS,
  projectCostPerMergedPr,
  sumTokensOverWindow,
  getCostPerMergedPr,
} from "./cost-attribution.ts";

// ---------------------------------------------------------------------------
// Per-class cost efficiency — the QA-cost-dominance audit read (issue #2971)
// ---------------------------------------------------------------------------
// A DERIVED read reframing a class's raw token share into its falsifiable
// unit-economics (tokens per merged PR). Composes the per-class token rollup
// with a merged-PR count injected by the API route from the cycle-metrics
// merged feed. No new token-recording writer, no USD surface; accounting only.
export {
  projectClassCostEfficiency,
  getClassCostEfficiency,
} from "./cost-attribution.ts";


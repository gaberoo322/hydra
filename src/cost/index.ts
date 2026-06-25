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
  getRollingTokenCounter,
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
  DEFAULT_OAUTH_USAGE_TTL_MS,
  getWeeklyResetAnchorMs,
  getCacheReadWeight,
  DEFAULT_CACHE_READ_WEIGHT,
  getDriftReferencePercent,
  getDriftFactor,
  DEFAULT_DRIFT_FACTOR,
  getWeeklyPaceCeiling,
  DEFAULT_WEEKLY_PACE_CEILING,
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
} from "./token-math.ts";

// ---------------------------------------------------------------------------
// Subscription Usage Tracker — Anthropic-quota projection (PR A #606, B-series)
// ---------------------------------------------------------------------------
export {
  getUsage,
  clearUsageCache,
  sessionIdFromPath,
  INTERACTIVE_SKILL,
  UNATTRIBUTED_SKILL,
} from "./usage-tracker.ts";

export type {
  UsageSnapshot,
  SkillResolver,
} from "./usage-tracker.ts";

// ---------------------------------------------------------------------------
// Eligibility — the pure dispatch-gating fold over UsageSnapshot (issue #1377)
// ---------------------------------------------------------------------------
export {
  projectEligibility,
  overlayPauseEligibility,
  overlaySessionBlockEligibility,
} from "./eligibility.ts";

// ---------------------------------------------------------------------------
// OAuth Usage Adapter — authoritative server-side meter (issue #1083)
// ---------------------------------------------------------------------------
export type { OAuthUsageResult } from "./oauth-usage.ts";

// ---------------------------------------------------------------------------
// Cost attribution — per-class token rollup (issue #1439, relocated #2219)
// ---------------------------------------------------------------------------
// The dispatch-class → cost-bucket mapping (`skillToCostClass`) and per-class
// token rollup (`projectCostByClass` / `getCostByClass`), relocated out of
// `src/metrics/aggregate.ts` into `./cost-attribution.ts` (issue #2219) so the
// Cost domain's knowledge lives in one module. Re-exported here so the public
// Interface contract stays single-surface.
export {
  COST_CLASS_ORDER,
  skillToCostClass,
  projectCostByClass,
  getCostByClass,
  getRollingCostByClass,
} from "./cost-attribution.ts";

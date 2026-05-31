/**
 * src/cost/index.ts — public surface of the **Cost** Module.
 *
 * The Cost Module owns Claude Code subagent token accounting on the
 * orchestrator side: recording per-skill / per-cycle token usage, exposing
 * the daily token counter consumed by the `/api/metrics/cost` dashboard
 * tile, aggregating per-tier attribution, AND projecting Anthropic-quota
 * consumption via the Subscription Usage Tracker. Storage is delegated to
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
 *   - the dollar-conversion surrogate machinery — `tokensToUsd`,
 *     `getTokenUsdRate`, `getCycleSubagentCostUsd`, and the `costUsd` /
 *     `ratePerMillion` / `source` / `legacyRecordSpendUsd` fields (#704).
 *     `HYDRA_TOKEN_USD_RATE` was structurally $0 and no live dollar cap
 *     existed; the surrogate is now a pure token counter.
 *
 * This file is the ONLY public import surface. Everything outside
 * `src/cost/` imports from here (`from "../cost/index.ts"`); the internal
 * split between `surrogate.ts`, `attribution.ts`, and `usage-tracker.ts`
 * is an implementation detail.
 */

// ---------------------------------------------------------------------------
// Surrogate — token recording + daily token counter (issue #394, #704)
// ---------------------------------------------------------------------------
export {
  recordSubagentTokens,
  getDailyTokenCounter,
  todayDateString,
  // Re-export key helpers so tests that probe Redis directly stay on the
  // public Interface rather than reaching into `surrogate.ts`.
  tokensAutopilotDailyKey,
  tokensBySkillDailyKey,
  tokensByCycleKey,
} from "./surrogate.ts";

export type {
  RecordTokensResult,
  DailyTokenCounter,
} from "./surrogate.ts";

// ---------------------------------------------------------------------------
// Attribution — pure aggregation for /api/metrics/cost-attribution (issue #271)
// ---------------------------------------------------------------------------
export {
  aggregateCostAttribution,
  modelToTier,
  agentRoleToTier,
  deriveOutcome,
  KNOWN_AGENT_ROLES,
} from "./attribution.ts";

export type {
  AgentRun,
  CycleSummary,
  CostAttributionResult,
} from "./attribution.ts";

// ---------------------------------------------------------------------------
// Subscription Usage Tracker — Anthropic-quota projection (PR A #606, B-series)
// ---------------------------------------------------------------------------
export {
  getUsage,
  projectEligibility,
  clearUsageCache,
  getWeeklyQuotaTokens,
  getFiveHourQuotaTokens,
  getQuotaWeightOpus,
  getQuotaWeightSonnet,
  getQuotaWeightHaiku,
  modelToFamily,
  parseUsageLine,
  cacheHitRatio,
  sessionIdFromPath,
  PACING_SHEDDABLE_CLASSES,
  UNATTRIBUTED_SKILL,
} from "./usage-tracker.ts";

export type {
  UsageSnapshot,
  UsageEligibility,
  TokenBreakdown,
  ParsedUsageLine,
  ModelFamily,
  SkillResolver,
} from "./usage-tracker.ts";

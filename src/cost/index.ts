/**
 * src/cost/index.ts — public surface of the **Cost** Module.
 *
 * The Cost Module owns Claude Code subagent spend accounting on the
 * orchestrator side: recording per-skill / per-cycle token usage, exposing
 * the daily-spend surrogate the autopilot consults each tick, and
 * aggregating per-tier attribution for the dashboard. Storage is delegated
 * to `src/redis/cost.ts` (the Redis Adapter for `hydra:cost:*`).
 *
 * **Accounting only.** Daily-spend ENFORCEMENT lives in the autopilot's
 * decision brain (`scripts/autopilot/decide.py` compares
 * `state.scout_spend_usd_today` against `state.limits.daily_spend_cap_usd`).
 * This Module exposes `getDailyCapUsd()` so the orchestrator's
 * `/api/scheduler/status` JSON can surface the value the autopilot is
 * actually enforcing against — but the orchestrator does NOT abort cycles
 * based on it.
 *
 * The pre-cutover per-cycle circuit breaker (the cap-check family) and the
 * Codex JSONL reconciliation pipeline (the reconciliation module + its API
 * route) were retired with ADR-0006 (codex CLI removal) — see issue #602
 * and issue #576.
 *
 * This file is the ONLY public import surface. Everything outside `src/cost/`
 * imports from here (`from "../cost/index.ts"`); the internal split between
 * `surrogate.ts` and `attribution.ts` is an implementation detail.
 */

// ---------------------------------------------------------------------------
// Surrogate — token recording + daily-spend reader (issue #394)
// ---------------------------------------------------------------------------
export {
  recordSubagentTokens,
  getDailySpendSurrogate,
  getCycleSubagentCostUsd,
  tokensToUsd,
  getTokenUsdRate,
  todayDateString,
  // Re-export key helpers so tests that probe Redis directly stay on the
  // public Interface rather than reaching into `surrogate.ts`.
  tokensAutopilotDailyKey,
  tokensBySkillDailyKey,
  tokensByCycleKey,
} from "./surrogate.ts";

export type {
  RecordTokensResult,
  DailySpendSurrogate,
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
// Daily-spend cap config (issue #576)
// ---------------------------------------------------------------------------

/**
 * The daily-spend cap the autopilot enforces against. Source of truth is
 * `scripts/autopilot/bootstrap.sh`, which reads `HYDRA_AUTOPILOT_DAILY_SPEND_CAP_USD`
 * (default 50.0) and writes it into `state.limits.daily_spend_cap_usd` for
 * `decide.py` to consult.
 *
 * The orchestrator does NOT enforce this cap — it only mirrors the value so
 * the dashboard and `/api/scheduler/status` can show operators what the
 * autopilot is gating against. Replaces the dead pre-cutover per-cycle
 * cap reader, which surfaced the retired codex-era circuit breaker.
 *
 * Pure function — re-reads env each call so a systemd `EnvironmentFile=`
 * reload (or test mutation) takes effect immediately.
 *
 * Returns 50 (the bootstrap default) when the env var is unset, empty,
 * non-finite, or non-positive. Returns `Infinity` when the value is
 * literally `"Infinity"` or `"infinity"` (operator opt-out, matches the
 * historical cap semantics).
 */
export function getDailyCapUsd(): number {
  const raw = process.env.HYDRA_AUTOPILOT_DAILY_SPEND_CAP_USD;
  if (raw === undefined || raw === "") return 50;
  if (raw === "Infinity" || raw === "infinity") return Infinity;
  const parsed = parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 50;
  return parsed;
}

/**
 * Recommendation daily-cap ledger Module (issue #2119).
 *
 * Extracted from `src/autopilot/recommendation-engine.ts`, mirroring the
 * recommendation-materiality (#1986) and recommendation-consumer (#2024)
 * sibling Modules. This Module owns the recs-engine's **billing concern** —
 * the single sanctioned real-USD surface on the orchestrator (CONTEXT.md L203
 * / ADR-0005: `recommendation-engine.ts` bills outside the subscription via
 * the direct Anthropic API, so `HYDRA_RECS_DAILY_CAP_USD` is a live cost gate).
 *
 * Concentrating the cost-cap policy into its own Module lets the engine shrink
 * toward its true single concern (LLM dispatch + prompt schema) and gives the
 * billing latch its own narrow Interface + test.
 *
 * What lives here:
 *   - DEFAULT_DAILY_CAP_USD + envDailyCap() — the ONE home for
 *     HYDRA_RECS_DAILY_CAP_USD resolution.
 *   - the UTC date stamper (today()).
 *   - the spend READ (getDailySpendUsd) + post-success CHARGE
 *     (incrDailySpendUsd) calls.
 *   - the once-per-UTC-day `oak_resting` broadcast latch (maybeEmitResting),
 *     with date-rollover reset.
 *   - getDailyCapUsd().
 *
 * What deliberately does NOT live here (load-bearing money-safety boundary):
 *   - the cap > interval > no-change ordering. That stays the SINGLE authority
 *     of `shouldFire()` in recommendation-materiality.ts. This Module FEEDS
 *     `daily_spend_usd` + `daily_cap_usd` into that decision; it never
 *     re-implements the `>=` comparison or reorders the skip reasons. One
 *     short-circuit point means a capped day can never fire a paid LLM call.
 *   - the micro-USD INT rounding (USD*1e6 + INCRBY integer-safety) stays
 *     entirely inside the Redis accessor (`src/redis/recommendations.ts`); no
 *     float math crosses this seam.
 *
 * The four cost invariants are preserved 1:1 across the move:
 *   1. READ-BEFORE-FIRE — daily spend is read before shouldFire, which
 *      short-circuits on cap before any paid call.
 *   2. CHARGE-AFTER-SUCCESS-ONLY — chargeIfPositive() fires only when
 *      cost_usd > 0, after a successful LLM call.
 *   3. MICRO-USD INT confined to the Redis accessor (this Module only passes a
 *      USD float through to it).
 *   4. BROADCAST-ONCE-PER-UTC-DAY — the pauseDayState latch + rollover reset.
 */

import * as defaultRedis from "../redis/recommendations.ts";

/** Default daily cost cap in USD when HYDRA_RECS_DAILY_CAP_USD is unset/invalid. */
export const DEFAULT_DAILY_CAP_USD = 1.0;

/**
 * Resolve the recs-engine daily cap from `HYDRA_RECS_DAILY_CAP_USD`. This is
 * the ONLY home for that env resolution — the engine delegates to it so the
 * cap amount has a single source of truth (CONTEXT.md L203 / ADR-0005).
 */
export function envDailyCap(): number {
  const raw = process.env.HYDRA_RECS_DAILY_CAP_USD;
  if (!raw) return DEFAULT_DAILY_CAP_USD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_DAILY_CAP_USD;
  return n;
}

/** UTC `YYYY-MM-DD` stamp — the per-day bucket key for the spend ledger. */
export function utcDateStamp(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * The narrow Redis surface the cap ledger needs — the micro-USD INT spend
 * accessors. The integer-safety (USD*1e6 rounding + INCRBY) stays inside
 * `src/redis/recommendations.ts`; this Module only passes USD floats through.
 */
export interface CapRedisFacade {
  getDailySpendUsd(date: string): Promise<number>;
  incrDailySpendUsd(date: string, usd: number): Promise<number>;
}

export interface CapEnforcerDeps {
  /** Spend ledger accessor — defaults to the production Redis seam. */
  redis?: CapRedisFacade;
  /** Broadcaster for the one-shot `oak_resting` WS event. */
  broadcastResting?: (runId: string, daily_spend_usd: number, cap_usd: number) => void;
  /** Clock — defaults to `() => Math.floor(Date.now() / 1000)`. */
  now?: () => number;
  /** Date stamper — defaults to UTC YYYY-MM-DD. */
  today?: () => string;
  /** Daily cap in USD — defaults to env or DEFAULT_DAILY_CAP_USD. */
  dailyCapUsd?: number;
}

/**
 * The constructed cap-enforcer. It owns the billing ledger but NOT the fire
 * decision — `readDailySpend()` + `getDailyCapUsd()` feed the engine's
 * `shouldFire()` call; the enforcer never decides whether to proceed.
 */
export interface CapEnforcer {
  /** The resolved daily cap in USD. */
  getDailyCapUsd(): number;
  /** Current UTC date stamp — the spend-ledger bucket key. */
  today(): string;
  /** Read the recs-engine daily spend in USD for the given date. */
  readDailySpend(date: string): Promise<number>;
  /**
   * Charge a successful call's USD cost into the daily tally — a no-op when
   * `costUsd <= 0` (CHARGE-AFTER-SUCCESS-ONLY invariant: only paid calls
   * charge). The caller invokes this only after a successful LLM call.
   */
  chargeIfPositive(date: string, costUsd: number): Promise<void>;
  /**
   * Emit the one-shot `oak_resting` WS broadcast for the current UTC day.
   * Returns `true` if it broadcast this call, `false` if already emitted
   * today. Resets on date rollover (BROADCAST-ONCE-PER-UTC-DAY invariant).
   */
  maybeEmitResting(spendUsd: number): boolean;
}

/**
 * Construct the cap enforcer. Mirrors `createRecommendationEngine`'s deps
 * defaulting (redis/now/today/cap all overridable for tests).
 */
export function createCapEnforcer(deps: CapEnforcerDeps = {}): CapEnforcer {
  const redis = deps.redis ?? (defaultRedis as CapRedisFacade);
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const today = deps.today ?? (() => utcDateStamp(new Date(now() * 1000)));
  const dailyCapUsd = Number.isFinite(deps.dailyCapUsd as number)
    ? (deps.dailyCapUsd as number)
    : envDailyCap();

  // Tracks whether we've already broadcast the `oak_resting` pause event
  // for this UTC day. Reset on date rollover.
  const pauseDayState = { date: "", emitted: false };

  return {
    getDailyCapUsd: () => dailyCapUsd,

    today,

    async readDailySpend(date: string): Promise<number> {
      return redis.getDailySpendUsd(date);
    },

    async chargeIfPositive(date: string, costUsd: number): Promise<void> {
      if (costUsd > 0) {
        await redis.incrDailySpendUsd(date, costUsd);
      }
    },

    maybeEmitResting(spendUsd: number): boolean {
      const date = today();
      if (pauseDayState.date !== date) {
        pauseDayState.date = date;
        pauseDayState.emitted = false;
      }
      if (pauseDayState.emitted) return false;
      pauseDayState.emitted = true;
      try {
        deps.broadcastResting?.("__system__", spendUsd, dailyCapUsd);
      } catch (err: any) {
        console.error(
          `[recs-engine] oak_resting broadcaster threw: ${err?.message || err}`,
        );
      }
      return true;
    },
  };
}

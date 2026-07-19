/**
 * Recs-engine daily-cap ledger — focused leaf (issue #3499).
 *
 * The recs-engine's **billing concern** — the single sanctioned real-USD
 * surface on the orchestrator (CONTEXT.md L203 / ADR-0005:
 * `recommendation-engine.ts` bills outside the subscription via the direct
 * Anthropic API, so `HYDRA_RECS_DAILY_CAP_USD` is a live cost gate).
 *
 * ## Module shape (issue #2119, #2317, #3499)
 *
 * This concern was first extracted to `recommendation-cap.ts` in #2119, then
 * folded back into `recommendation-engine.ts` as a concern SECTION in #2317
 * (that pass collapsed a shallow pass-through). #3499 RE-EXTRACTED it here as
 * a focused pure leaf — mirroring the #2867 prompt-grammar and #3099
 * materiality-gate re-extractions — because the cap's mutable-ledger state has
 * a separate test-surface identity (its behavior under reset / time-advance /
 * date-rollover) that the engine-factory coupling obscures. A test that asserts
 * "at spend > HYDRA_RECS_DAILY_CAP_USD, the ledger caps" now imports only THIS
 * leaf — no Anthropic Request Adapter, no prompt-grammar chain, no engine
 * factory pulled in at module-load time. The leaf carries NO Anthropic imports;
 * its ONLY external dependency is the narrow micro-USD spend accessor on the
 * recs Redis facade.
 *
 * `recommendation-engine.ts` RE-EXPORTS every symbol below so the
 * consumer-facing + test surface (`createCapEnforcer`, `CapEnforcer`,
 * `envDailyCap`, `utcDateStamp`, `DEFAULT_DAILY_CAP_USD`, `CapRedisFacade`,
 * `CapEnforcerDeps`) stays byte-identical — `interfaceImpact: none`.
 *
 * What lives here:
 *   - DEFAULT_DAILY_CAP_USD + envDailyCap() — the ONE home for
 *     HYDRA_RECS_DAILY_CAP_USD resolution.
 *   - the UTC date stamper (utcDateStamp / today()).
 *   - the spend READ (readDailySpend) + post-success CHARGE
 *     (chargeIfPositive) calls.
 *   - the once-per-UTC-day `oak_resting` broadcast latch (maybeEmitResting),
 *     with date-rollover reset.
 *   - getDailyCapUsd().
 *
 * What deliberately does NOT live here (load-bearing money-safety boundary):
 *   - the cap > interval > no-change ordering. That stays the SINGLE authority
 *     of `shouldFire()` in `recommendation-materiality.ts`. This ledger FEEDS
 *     `daily_spend_usd` + `daily_cap_usd` into that decision; it never
 *     re-implements the `>=` comparison or reorders the skip reasons. One
 *     short-circuit point means a capped day can never fire a paid LLM call.
 *   - the micro-USD INT rounding (USD*1e6 + INCRBY integer-safety) stays
 *     entirely inside the Redis accessor (`src/redis/recommendations.ts`); no
 *     float math crosses this seam.
 *
 * The four cost invariants are preserved 1:1:
 *   1. READ-BEFORE-FIRE — daily spend is read before shouldFire, which
 *      short-circuits on cap before any paid call.
 *   2. CHARGE-AFTER-SUCCESS-ONLY — chargeIfPositive() fires only when
 *      cost_usd > 0, after a successful LLM call.
 *   3. MICRO-USD INT confined to the Redis accessor (this ledger only passes a
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
 * `src/redis/recommendations.ts`; this ledger only passes USD floats through.
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

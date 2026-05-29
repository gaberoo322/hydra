/**
 * Cost-burn aggregator (issue #618, PRD #615).
 *
 * Now-page widget data — answers "how fast is hydra spending right now?".
 *
 * Shape:
 *
 *   { lastHourSpark: number[], daySpent, dailyBudget, headroomPct }
 *
 * # Why the spark is "coarse" today
 *
 * The cost surrogate (`src/cost/surrogate.ts`) is day-bucketed. The
 * Subscription Usage Tracker (`src/cost/usage-tracker.ts`) exposes rolling
 * 5h / 24h windows by re-scanning Claude Code JSONL transcripts. Neither
 * exposes per-hour buckets today. We synthesise a small spark by deriving
 * two averaged rates — last-5h hourly average and last-24h hourly average,
 * both denominated in USD per hour — so the dashboard can render a tiny
 * "is the burn rate rising or falling?" comparison without an O(N) JSONL
 * re-scan inside this aggregator. Tooling for honest per-hour buckets is
 * a follow-up; documenting the shape as a `number[]` lets that future
 * change ship without a schema migration.
 *
 * # daySpent / dailyBudget
 *
 * - `daySpent` — USD spent so far today (UTC). The cost surrogate's
 *   dollar-conversion machinery was removed in #704 (`HYDRA_TOKEN_USD_RATE`
 *   was structurally $0 and no live dollar cap existed), so the default
 *   reader now returns 0. The field is retained for shape stability; a
 *   caller can still inject a `readDaySpentUsd` dep if it ever has an
 *   authoritative dollar source.
 * - `dailyBudget` — operator-set daily budget in USD. Sourced from the
 *   `HYDRA_DAILY_BUDGET_USD` env var (live, operator-set — unaffected by
 *   #704). Zero when unset. The Subscription Usage Tracker is the
 *   *enforcement* surface (`/api/usage/eligibility`); this number is
 *   operator-informational, displayed alongside the spend.
 * - `headroomPct` — `(1 - daySpent / dailyBudget) * 100`, clamped to
 *   `[0, 100]`. Returns 100 when `dailyBudget` is 0 or unset (no budget →
 *   no headroom pressure to display).
 *
 * # Design contract — same as overnight-summary.ts
 *
 * - Pure aggregator. All external touchpoints in `deps`.
 * - Never throws. Sub-source failures degrade individual fields, not the
 *   whole payload.
 */

import type { UsageSnapshot } from "../cost/usage-tracker.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CostBurn {
  /**
   * Coarse burn-rate spark — see file JSDoc. Today: two USD-per-hour
   * averages — 5h average then 24h average — so the dashboard can render
   * a two-point line. May grow into a 12-bucket spark in a follow-up
   * without changing the type.
   */
  lastHourSpark: number[];
  /** USD spent so far today (UTC). 0 by default — the surrogate's dollar
   *  machinery was removed in #704; only an injected `readDaySpentUsd` dep
   *  produces a non-zero value. */
  daySpent: number;
  /** Operator-set daily budget in USD. Zero when unset. */
  dailyBudget: number;
  /**
   * `(1 - daySpent / dailyBudget) * 100`, clamped to [0, 100]. 100 when
   * the budget is unset.
   */
  headroomPct: number;
}

export interface CostBurnDeps {
  /**
   * Reader for the per-day USD spend. The surrogate's dollar machinery was
   * removed in #704, so the default returns 0. Exposed so callers (and tests)
   * can inject a dollar figure if they have an authoritative source.
   */
  readDaySpentUsd?: () => Promise<number>;
  /**
   * Reader for the rolling usage-tracker snapshot. Defaults to
   * `getUsage()` from `src/cost/`.
   */
  readUsage?: () => Promise<Pick<UsageSnapshot, "tokensLast5h" | "tokensLast24h">>;
  /**
   * USD-per-million-tokens rate for the burn-rate spark. Defaults to a local
   * read of `HYDRA_TOKEN_USD_RATE` (structurally $0 since #704 removed the
   * surrogate's dollar machinery). Exposed so callers/tests can drive the
   * spark math with a concrete rate.
   */
  getTokenUsdRate?: () => number;
  /**
   * Reader for the operator's daily budget in USD. Defaults to the
   * `HYDRA_DAILY_BUDGET_USD` env var. Exposed for tests.
   */
  readDailyBudgetUsd?: () => number;
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export async function getCostBurn(deps: CostBurnDeps = {}): Promise<CostBurn> {
  const [daySpentResult, usageResult] = await Promise.allSettled([
    readDaySpent(deps),
    readUsage(deps),
  ]);

  const daySpent = settledOr(daySpentResult, 0, "cost-burn/daySpent");
  const usage = settledOr(
    usageResult,
    { tokensLast5h: { total: 0 } as UsageSnapshot["tokensLast5h"], tokensLast24h: 0 },
    "cost-burn/usage",
  );

  const dailyBudget = (deps.readDailyBudgetUsd ?? readDailyBudgetFromEnv)();
  const rate = (deps.getTokenUsdRate ?? getDefaultRate)();

  const lastHourSpark = computeSpark({
    tokensLast5hTotal: usage.tokensLast5h?.total ?? 0,
    tokensLast24hTotal: usage.tokensLast24h ?? 0,
    tokenUsdRate: rate,
  });

  return {
    lastHourSpark,
    daySpent,
    dailyBudget,
    headroomPct: computeHeadroomPct(daySpent, dailyBudget),
  };
}

function settledOr<T>(result: PromiseSettledResult<T>, fallback: T, label: string): T {
  if (result.status === "fulfilled") return result.value;
  console.error(`[cost-burn] ${label} failed: ${result.reason?.message || result.reason}`);
  return fallback;
}

async function readDaySpent(deps: CostBurnDeps): Promise<number> {
  if (deps.readDaySpentUsd) return deps.readDaySpentUsd();
  // The cost surrogate's dollar-conversion machinery was removed in #704
  // (`HYDRA_TOKEN_USD_RATE` was structurally $0; no live dollar cap existed).
  // There is no authoritative per-day dollar source, so the default is 0.
  return 0;
}

async function readUsage(
  deps: CostBurnDeps,
): Promise<Pick<UsageSnapshot, "tokensLast5h" | "tokensLast24h">> {
  if (deps.readUsage) return deps.readUsage();
  const { getUsage } = await import("../cost/index.ts");
  const usage = await getUsage();
  return { tokensLast5h: usage.tokensLast5h, tokensLast24h: usage.tokensLast24h };
}

function getDefaultRate(): number {
  // Synchronous env read for the burn-rate spark. The surrogate's
  // `getTokenUsdRate` helper was removed in #704 (the dollar machinery was
  // dead — `HYDRA_TOKEN_USD_RATE` was structurally $0). This local read keeps
  // the spark self-contained; it returns 0 unless an operator sets the rate.
  const raw = process.env.HYDRA_TOKEN_USD_RATE;
  if (raw === undefined || raw === "") return 0;
  const parsed = parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

function readDailyBudgetFromEnv(): number {
  const raw = process.env.HYDRA_DAILY_BUDGET_USD;
  if (raw === undefined || raw === "") return 0;
  const parsed = parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for tests
// ---------------------------------------------------------------------------

/**
 * Convert tokens to USD using `rate` USD per million tokens. Self-contained
 * helper for the burn-rate spark (the surrogate's `tokensToUsd` was removed
 * in #704). Returns 0 when the rate is 0/negative or tokens are 0/negative.
 */
export function tokensToUsdPerMillion(tokens: number, rate: number): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  // Round to four decimal places — sub-cent precision is the right
  // resolution for the dashboard widget.
  return Math.round((tokens / 1_000_000) * rate * 10_000) / 10_000;
}

/**
 * Pure helper — derive the coarse burn-rate spark.
 *
 * Returns `[usd_per_hour_5h_avg, usd_per_hour_24h_avg]`. Both points are
 * USD per hour, averaged over the 5h / 24h rolling window.
 *
 * Edge cases:
 *   - rate 0 → returns `[0, 0]` (caller should still render the row;
 *     headroomPct is the meaningful signal in that mode).
 *   - missing 5h or 24h → that bucket goes to 0.
 */
export function computeSpark(input: {
  tokensLast5hTotal: number;
  tokensLast24hTotal: number;
  tokenUsdRate: number;
}): number[] {
  const usd5h = tokensToUsdPerMillion(input.tokensLast5hTotal, input.tokenUsdRate);
  const usd24h = tokensToUsdPerMillion(input.tokensLast24hTotal, input.tokenUsdRate);
  // Average to per-hour. 5h window → /5, 24h window → /24.
  const ratePerHour5h = Math.round((usd5h / 5) * 10_000) / 10_000;
  const ratePerHour24h = Math.round((usd24h / 24) * 10_000) / 10_000;
  return [ratePerHour5h, ratePerHour24h];
}

/**
 * Pure helper — compute the headroom %.
 *
 * Clamps to [0, 100]. When `dailyBudget` is 0 (unset), returns 100 —
 * "no budget set, no pressure to display." This matches the operator's
 * mental model: a dashboard widget should never claim "0% headroom" just
 * because they haven't filled in the env var.
 */
export function computeHeadroomPct(daySpent: number, dailyBudget: number): number {
  if (!Number.isFinite(dailyBudget) || dailyBudget <= 0) return 100;
  if (!Number.isFinite(daySpent) || daySpent <= 0) return 100;
  const pct = (1 - daySpent / dailyBudget) * 100;
  if (pct <= 0) return 0;
  if (pct >= 100) return 100;
  return Math.round(pct * 100) / 100;
}

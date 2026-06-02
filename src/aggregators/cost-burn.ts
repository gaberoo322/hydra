/**
 * Cost-burn aggregator (issue #618, PRD #615).
 *
 * Now-page widget data — answers "how fast is hydra burning right now?".
 *
 * Shape:
 *
 *   { lastHourSpark: number[] }
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
 * # Retired: daySpent / dailyBudget / headroomPct (issue #885)
 *
 * The USD dollar-budget fields — `daySpent`, `dailyBudget`, `headroomPct` —
 * were removed in #885. Under the Claude Code subscription the orchestrator
 * pays no per-call charge, so a USD attribution is a fiction (see CONTEXT.md
 * **Quota Weight**): the dollar-conversion machinery was deleted in #704
 * (`HYDRA_TOKEN_USD_RATE` was structurally $0 and no live dollar cap
 * existed), leaving `daySpent` always 0 and `headroomPct` always 100% — a
 * display-only signal that fed no live decision. The real enforcement
 * surface is the Subscription Usage Tracker / Pace Gate
 * (`/api/usage/eligibility`), which is token-and-quota denominated. The
 * re-expression of "burn + headroom" in that vocabulary is the interface-
 * design step deferred to a separate triaged pickup; this change is the
 * honest deletion only.
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
}

export interface CostBurnDeps {
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
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export async function getCostBurn(deps: CostBurnDeps = {}): Promise<CostBurn> {
  const usageResult = await Promise.allSettled([readUsage(deps)]).then((r) => r[0]);

  const usage = settledOr(
    usageResult,
    { tokensLast5h: { total: 0 } as UsageSnapshot["tokensLast5h"], tokensLast24h: 0 },
    "cost-burn/usage",
  );

  const rate = (deps.getTokenUsdRate ?? getDefaultRate)();

  const lastHourSpark = computeSpark({
    tokensLast5hTotal: usage.tokensLast5h?.total ?? 0,
    tokensLast24hTotal: usage.tokensLast24h ?? 0,
    tokenUsdRate: rate,
  });

  return { lastHourSpark };
}

function settledOr<T>(result: PromiseSettledResult<T>, fallback: T, label: string): T {
  if (result.status === "fulfilled") return result.value;
  console.error(`[cost-burn] ${label} failed: ${result.reason?.message || result.reason}`);
  return fallback;
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
 *   - rate 0 → returns `[0, 0]` (the spark collapses to a flat line; the
 *     dashboard should still render the row).
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

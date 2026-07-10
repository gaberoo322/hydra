/**
 * Cost-burn aggregator (issue #618, PRD #615).
 *
 * Now-page widget data — answers "how fast is hydra burning right now?".
 *
 * Shape:
 *
 *   { tokensPerHour5h: number, tokensPerHour24h: number }
 *
 * # Token-denominated burn rate (issue #1413)
 *
 * The Subscription Usage Tracker (`src/cost/usage-tracker.ts`) measures
 * rolling 5h / 24h token windows by re-scanning Claude Code JSONL
 * transcripts. That is the real, live metric: under the Claude Code
 * subscription the orchestrator pays no per-call charge, so tokens — not
 * dollars — are what's actually consumed (see CONTEXT.md **Quota Weight**).
 *
 * We derive two averaged token rates — the last-5h hourly average and the
 * last-24h hourly average — so the dashboard can render a tiny "is the burn
 * rate rising or falling?" comparison without an O(N) JSONL re-scan inside
 * this aggregator.
 *
 * # Retired: USD conversion (issues #885, #704, #1413)
 *
 * The USD dollar-budget fields — `daySpent`, `dailyBudget`, `headroomPct` —
 * were removed in #885; the dollar-conversion machinery in the surrogate was
 * deleted in #704. The remaining token-to-USD *display* interface here
 * (`getTokenUsdRate`, `tokensToUsdPerMillion`, and the `HYDRA_TOKEN_USD_RATE`
 * read) was structurally $0 — `HYDRA_TOKEN_USD_RATE` defaults to 0 and no
 * live dollar cap consumes this aggregator's output — so it rendered a flat
 * `$0/h` line that fed no decision. #1413 honest-deletes it, re-expressing
 * the spark in the token vocabulary the usage tracker actually measures.
 *
 * NOTE: the live USD cost gates (`HYDRA_RECS_DAILY_CAP_USD`, the per-cycle
 * cap in `src/cost/cap.ts`, `HYDRA_AUTOPILOT_DAILY_SPEND_CAP_USD`) are
 * unrelated and untouched — this file was a display surface only.
 *
 * # Design contract — same as overnight-summary.ts
 *
 * - Pure aggregator. All external touchpoints in `deps`.
 * - Never throws. Sub-source failures degrade individual fields, not the
 *   whole payload.
 */

import type { UsageSnapshot } from "../cost/index.ts";
import { settledOr } from "./settle.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CostBurn {
  /**
   * Average tokens consumed per hour over the rolling 5h window
   * (5h token total / 5). Token-denominated — see file JSDoc.
   */
  tokensPerHour5h: number;
  /**
   * Average tokens consumed per hour over the rolling 24h window
   * (24h token total / 24). Token-denominated — see file JSDoc.
   */
  tokensPerHour24h: number;
}

export interface CostBurnDeps {
  /**
   * Reader for the rolling usage-tracker snapshot. Defaults to
   * `getUsage()` from `src/cost/`.
   */
  readUsage?: () => Promise<Pick<UsageSnapshot, "tokensLast5h" | "tokensLast24h">>;
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

  return computeBurnRates({
    tokensLast5hTotal: usage.tokensLast5h?.total ?? 0,
    tokensLast24hTotal: usage.tokensLast24h ?? 0,
  });
}

async function readUsage(
  deps: CostBurnDeps,
): Promise<Pick<UsageSnapshot, "tokensLast5h" | "tokensLast24h">> {
  if (deps.readUsage) return deps.readUsage();
  const { getUsage } = await import("../cost/index.ts");
  const usage = await getUsage();
  return { tokensLast5h: usage.tokensLast5h, tokensLast24h: usage.tokensLast24h };
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for tests
// ---------------------------------------------------------------------------

/**
 * Average a rolling-window token total down to a per-hour rate over
 * `windowHours`. Returns 0 for non-finite / non-positive inputs. Tokens are
 * whole numbers, so the per-hour rate is rounded to the nearest token.
 */
export function tokensPerHour(windowTotal: number, windowHours: number): number {
  if (!Number.isFinite(windowTotal) || windowTotal <= 0) return 0;
  if (!Number.isFinite(windowHours) || windowHours <= 0) return 0;
  return Math.round(windowTotal / windowHours);
}

/**
 * Pure helper — derive the token-denominated burn-rate pair.
 *
 * Returns `{ tokensPerHour5h, tokensPerHour24h }`, each the average tokens
 * per hour over the respective rolling window (5h → /5, 24h → /24).
 *
 * Edge cases:
 *   - missing 5h or 24h total → that rate goes to 0.
 */
export function computeBurnRates(input: {
  tokensLast5hTotal: number;
  tokensLast24hTotal: number;
}): CostBurn {
  return {
    tokensPerHour5h: tokensPerHour(input.tokensLast5hTotal, 5),
    tokensPerHour24h: tokensPerHour(input.tokensLast24hTotal, 24),
  };
}

import { useApi } from "../../../hooks/useApi.js";
import { Section } from "./Section.jsx";

function formatTokens(n) {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

/**
 * BurnRate — coarse two-point rate display. The aggregator returns
 * token-denominated per-hour averages (`tokensPerHour5h`, `tokensPerHour24h`)
 * — issue #1413 retired the structurally-$0 USD conversion. Rendered as a
 * tiny "rising / falling" arrow plus the two token-per-hour numbers.
 */
function BurnRate({ r5h, r24h }) {
  if (typeof r5h !== "number" || typeof r24h !== "number") return null;
  const delta = r5h - r24h;
  // 5% of the 24h baseline (min 1 tok/h) as the rising/falling threshold.
  const threshold = Math.max(1, r24h * 0.05);
  const trend = delta > threshold ? "rising" : delta < -threshold ? "falling" : "steady";
  const trendColor = trend === "rising" ? "text-amber-300" : trend === "falling" ? "text-emerald-300" : "text-zinc-400";
  const arrow = trend === "rising" ? "↑" : trend === "falling" ? "↓" : "→";
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-zinc-500">5h:</span>
      <span className="text-zinc-200 font-mono">{formatTokens(r5h)} tok/h</span>
      <span className={`${trendColor} font-semibold`}>{arrow}</span>
      <span className="text-zinc-500">24h:</span>
      <span className="text-zinc-200 font-mono">{formatTokens(r24h)} tok/h</span>
    </div>
  );
}

/**
 * CostBurn — coarse hourly burn-rate display. Polls every 30s (PRD #615) —
 * cost moves slowly enough that 5s would just spam the usage-tracker read.
 *
 * The burn rate is token-denominated (issue #1413): under the Claude Code
 * subscription the orchestrator consumes tokens, not dollars, so the rate
 * reflects what the Subscription Usage Tracker actually measures. The USD
 * daily-budget / headroom half was retired in #885 and the structurally-$0
 * token-to-USD interface was honest-deleted in #1413.
 */
export function CostBurn() {
  const { data, error, loading } = useApi("/now/cost-burn", { poll: 30_000 });

  return (
    <Section
      title="Cost burn"
      subtitle="Burn rate only."
      loading={loading}
      error={error}
    >
      {data && (
        <div className="space-y-3">
          <BurnRate r5h={data.tokensPerHour5h} r24h={data.tokensPerHour24h} />
        </div>
      )}
    </Section>
  );
}

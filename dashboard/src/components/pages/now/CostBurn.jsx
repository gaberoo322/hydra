import { useApi } from "../../../hooks/useApi.js";
import { Section } from "./Section.jsx";

function formatMoney(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "$0";
  if (n >= 100) return `$${Math.round(n)}`;
  return `$${n.toFixed(2)}`;
}

/**
 * Spark — coarse two-point rate display. The aggregator returns a
 * `lastHourSpark` array of USD-per-hour averages (5h-average, 24h-average).
 * Rendered as a tiny "rising / falling" arrow plus the two numbers.
 */
function Spark({ spark }) {
  if (!Array.isArray(spark) || spark.length < 2) return null;
  const [r5h, r24h] = spark;
  const delta = r5h - r24h;
  const trend = delta > 0.01 ? "rising" : delta < -0.01 ? "falling" : "steady";
  const trendColor = trend === "rising" ? "text-amber-300" : trend === "falling" ? "text-emerald-300" : "text-zinc-400";
  const arrow = trend === "rising" ? "↑" : trend === "falling" ? "↓" : "→";
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-zinc-500">5h:</span>
      <span className="text-zinc-200 font-mono">{formatMoney(r5h)}/h</span>
      <span className={`${trendColor} font-semibold`}>{arrow}</span>
      <span className="text-zinc-500">24h:</span>
      <span className="text-zinc-200 font-mono">{formatMoney(r24h)}/h</span>
    </div>
  );
}

/**
 * CostBurn — coarse hourly burn-rate spark. Polls every 30s (PRD #615) —
 * cost moves slowly enough that 5s would just spam the surrogate read.
 *
 * The USD daily-budget / headroom half was retired in #885 — under the
 * Claude Code subscription a dollar attribution is a fiction (the dollar
 * machinery was already structurally $0 since #704). The re-expression of
 * "headroom" in token/quota vocabulary is deferred to a separate pickup.
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
          <Spark spark={data.lastHourSpark} />
        </div>
      )}
    </Section>
  );
}

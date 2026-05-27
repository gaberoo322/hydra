import { useApi } from "../../../hooks/useApi.js";
import { Section } from "./Section.jsx";

function formatMoney(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "$0";
  if (n >= 100) return `$${Math.round(n)}`;
  return `$${n.toFixed(2)}`;
}

function HeadroomBar({ pct }) {
  const clamped = Math.max(0, Math.min(100, pct ?? 100));
  // Color escalates as headroom shrinks. >50% remaining is green, 25-50% is
  // yellow, <25% is red. Matches the dashboard-wide chip vocabulary.
  const barColor = clamped > 50 ? "bg-emerald-500" : clamped > 25 ? "bg-yellow-500" : "bg-red-500";
  return (
    <div className="h-2 w-full bg-zinc-700/40 rounded overflow-hidden">
      <div
        className={`h-full ${barColor} transition-all duration-300`}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
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
 * CostBurn — daily-budget headroom + coarse hourly burn spark. Polls
 * every 30s (PRD #615) — cost moves slowly enough that 5s would just
 * spam the surrogate read.
 */
export function CostBurn() {
  const { data, error, loading } = useApi("/now/cost-burn", { poll: 30_000 });
  const daySpent = data?.daySpent ?? 0;
  const dailyBudget = data?.dailyBudget ?? 0;
  const headroomPct = data?.headroomPct ?? 100;
  const subtitle = dailyBudget > 0
    ? `${formatMoney(daySpent)} of ${formatMoney(dailyBudget)} today · ${headroomPct.toFixed(0)}% headroom`
    : "Daily budget not set — burn rate only.";

  return (
    <Section
      title="Cost burn"
      subtitle={subtitle}
      loading={loading}
      error={error}
    >
      {data && (
        <div className="space-y-3">
          {dailyBudget > 0 && <HeadroomBar pct={headroomPct} />}
          <Spark spark={data.lastHourSpark} />
          {dailyBudget === 0 && (
            <p className="text-[11px] text-zinc-500">
              Set <code className="text-zinc-400">HYDRA_DAILY_BUDGET_USD</code> to see the headroom bar.
            </p>
          )}
        </div>
      )}
    </Section>
  );
}

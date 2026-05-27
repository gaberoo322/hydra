import { useApi } from "../../../hooks/useApi.js";
import { TabShell } from "./TabShell.jsx";

const METRIC_LABEL = {
  "cost-per-hour": "Cost / hour",
  "abandonment-rate": "Abandonment rate",
  "dispatch-class-failure-rate": "Class failure rate",
};

const DIRECTION_STYLE = {
  high: "bg-red-500/10 text-red-300 border-red-500/30",
  low: "bg-sky-500/10 text-sky-300 border-sky-500/30",
};

function fmt(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 100) return n.toFixed(0);
  return n.toFixed(2);
}

export function AnomaliesTab() {
  const { data, error, loading } = useApi("/explore/anomalies", { poll: 60_000 });
  const items = data?.anomalies ?? [];
  const empty = !loading && !error && items.length === 0;

  const subtitle = data
    ? `Z-score threshold ${data.threshold}σ over prior ${data.baselineWindowDays}d baseline.`
    : "Z-score deviations from rolling baseline.";

  return (
    <TabShell
      title="Anomalies"
      subtitle={subtitle}
      loading={loading}
      error={error}
      empty={empty}
      emptyMessage="No anomalies detected. Metrics are within the baseline band."
    >
      <ul className="divide-y divide-zinc-700/50">
        {items.map((a) => (
          <li key={`${a.metric}:${a.subKey ?? ""}`} className="py-2 flex items-center gap-3">
            <span className="text-sm text-zinc-100 shrink-0 w-48 truncate">
              {METRIC_LABEL[a.metric] || a.metric}
              {a.subKey && <span className="text-zinc-500"> · {a.subKey}</span>}
            </span>
            <span className={`text-[10px] uppercase px-1.5 py-0.5 rounded border ${DIRECTION_STYLE[a.direction]}`}>
              {a.direction}
            </span>
            <span className="text-xs text-amber-300 font-mono shrink-0 w-16 text-right">
              z={fmt(a.zScore)}
            </span>
            <span className="text-xs text-zinc-300 font-mono shrink-0 w-32 text-right">
              latest {fmt(a.latest)}
            </span>
            <span className="flex-1 min-w-0 text-xs text-zinc-500 truncate">
              vs μ={fmt(a.baselineMean)} σ={fmt(a.baselineStd)}
            </span>
          </li>
        ))}
      </ul>
    </TabShell>
  );
}

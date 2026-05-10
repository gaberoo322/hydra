import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from "recharts";
import { useApi } from "../hooks/useApi.js";

/**
 * Quality gates trend panel (issue #212).
 *
 * Renders rolling mutation kill-rate + JIT test additions from
 * `GET /api/metrics/quality-gates` so operators can spot quality regressions
 * (drop in kill rate, surge in JIT-generated tests, gate blocks) without
 * digging through per-cycle logs.
 */
export default function QualityGatesPanel({ count = 50 }) {
  const { data, error } = useApi(`/metrics/quality-gates?count=${count}`);

  const trend = Array.isArray(data?.trend) ? data.trend : [];
  const summary = data?.summary || {};

  // Reverse so older cycles render on the left (chronological)
  const chartData = [...trend]
    .reverse()
    .map((e) => ({
      name: (e.cycleId || "").replace("cycle-", "").slice(0, 10),
      killRate: typeof e.killRate === "number" ? e.killRate : null,
      jitTestsAdded: typeof e.jitTestsAdded === "number" ? e.jitTestsAdded : 0,
      jitDecision: typeof e.jitDecision === "string" ? e.jitDecision : null,
      gateBlocked: e.gateBlocked,
    }));

  // Issue #235: most-recent cycles first for the decision list so operators
  // see the latest outcome at a glance.
  const recentDecisions = trend.slice(0, 10).map((e) => ({
    cycleId: (e.cycleId || "").replace("cycle-", "").slice(0, 10),
    killRate: typeof e.killRate === "number" ? e.killRate : null,
    jitDecision: typeof e.jitDecision === "string" ? e.jitDecision : null,
  }));

  const cyclesWithData = summary.cyclesWithMutationData ?? 0;
  const avg = summary.avgKillRate;
  const p50 = summary.killRateP50;
  const p95 = summary.killRateP95;
  const blocks = summary.gateBlockCount ?? 0;
  const totalJit = summary.totalJitTestsAdded ?? 0;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-sm font-semibold text-zinc-400">Quality Gates Trend</h2>
        <span className="text-xs text-zinc-500">
          {cyclesWithData}/{summary.cycles ?? 0} cycles with mutation data
        </span>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
        <SummaryStat label="Avg Kill Rate" value={avg !== null && avg !== undefined ? `${avg}%` : "—"} />
        <SummaryStat label="P50 Kill Rate" value={p50 !== null && p50 !== undefined ? `${p50}%` : "—"} />
        <SummaryStat label="P95 Kill Rate" value={p95 !== null && p95 !== undefined ? `${p95}%` : "—"} />
        <SummaryStat label="Gate Blocks" value={blocks} highlight={blocks > 0 ? "amber" : undefined} />
        <SummaryStat label="JIT Tests Added" value={totalJit} />
      </div>

      {error ? (
        <p className="text-sm text-zinc-600 py-8 text-center">No quality-gate data ({error})</p>
      ) : chartData.length === 0 ? (
        <p className="text-sm text-zinc-600 py-8 text-center">No quality-gate data</p>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
            <XAxis dataKey="name" tick={{ fontSize: 10, fill: "#71717a" }} />
            <YAxis
              yAxisId="killRate"
              domain={[0, 100]}
              tick={{ fontSize: 10, fill: "#71717a" }}
              tickFormatter={(v) => `${v}%`}
            />
            <YAxis
              yAxisId="jit"
              orientation="right"
              tick={{ fontSize: 10, fill: "#71717a" }}
            />
            <Tooltip
              contentStyle={{ backgroundColor: "#18181b", border: "1px solid #27272a", fontSize: 12 }}
            />
            <ReferenceLine yAxisId="killRate" y={30} stroke="#f87171" strokeDasharray="3 3" label={{ value: "gate", fill: "#f87171", fontSize: 10 }} />
            <Line
              yAxisId="killRate"
              type="monotone"
              dataKey="killRate"
              name="Kill Rate %"
              stroke="#34d399"
              dot={false}
              connectNulls
            />
            <Line
              yAxisId="jit"
              type="monotone"
              dataKey="jitTestsAdded"
              name="JIT Tests Added"
              stroke="#a78bfa"
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      )}

      {/* Issue #235: per-cycle JIT decision so operators can answer
          "is JIT working?" without digging through logs. */}
      {recentDecisions.length > 0 && (
        <div className="mt-4">
          <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-2">
            Recent JIT Decisions
          </p>
          <div className="space-y-1">
            {recentDecisions.map((d) => (
              <div
                key={d.cycleId}
                className="flex items-center justify-between text-xs bg-zinc-950 border border-zinc-800 rounded px-2 py-1"
              >
                <span className="text-zinc-500 font-mono">{d.cycleId}</span>
                <span className="text-zinc-400">
                  kill {d.killRate !== null ? `${d.killRate}%` : "—"}
                </span>
                <span
                  className={
                    d.jitDecision === null
                      ? "text-zinc-600"
                      : d.jitDecision.startsWith("error")
                        ? "text-red-400"
                        : d.jitDecision.startsWith("ran: bug")
                          ? "text-amber-400"
                          : d.jitDecision.startsWith("ran:")
                            ? "text-emerald-400"
                            : "text-zinc-400"
                  }
                >
                  {d.jitDecision ?? "unknown"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryStat({ label, value, highlight }) {
  const valueClass = highlight === "amber" ? "text-amber-400" : "text-white";
  return (
    <div className="bg-zinc-950 border border-zinc-800 rounded p-2">
      <p className="text-[10px] text-zinc-500 uppercase tracking-wider">{label}</p>
      <p className={`text-lg font-semibold ${valueClass} mt-0.5 tabular-nums`}>{value}</p>
    </div>
  );
}

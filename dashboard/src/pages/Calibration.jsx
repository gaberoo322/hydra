import { useApi } from "../hooks/useApi.js";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from "recharts";

function Stat({ label, value, detail }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
      <p className="text-xs text-zinc-500 uppercase tracking-wider">{label}</p>
      <p className="text-2xl font-bold text-white mt-1">{value}</p>
      {detail && <p className="text-xs text-zinc-500 mt-1">{detail}</p>}
    </div>
  );
}

function formatScore(v, digits = 3) {
  if (v === null || v === undefined) return "--";
  return Number(v).toFixed(digits);
}

export default function Calibration() {
  const { data, loading } = useApi("/calibration/outcomes", { poll: 60000 });

  if (loading && !data) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Calibration</h1>
        <div className="p-8 animate-pulse bg-zinc-800/30 rounded-lg" />
      </div>
    );
  }

  const empty = !data || data.totalForecasts === 0;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Calibration</h1>

      {empty ? (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-12 text-center">
          <svg className="w-12 h-12 mx-auto text-zinc-700 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
          </svg>
          <p className="text-zinc-400 text-sm">No forecast outcome data yet</p>
          <p className="text-zinc-600 text-xs mt-2">
            Outcomes will appear here as markets resolve and predictions are recorded via <code className="text-zinc-500">recordForecastOutcome()</code>.
          </p>
        </div>
      ) : (
        <>
          {/* Stat cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Stat label="Total Forecasts" value={data.totalForecasts} />
            <Stat
              label="Brier Score"
              value={formatScore(data.brierScore)}
              detail="Lower is better (0 = perfect)"
            />
            <Stat
              label="Log Loss"
              value={formatScore(data.logLoss)}
              detail="Lower is better"
            />
            <Stat
              label="Hit Rate"
              value={data.hitRate !== null ? `${(data.hitRate * 100).toFixed(1)}%` : "--"}
              detail="Directional accuracy"
            />
          </div>

          {/* Calibration curve */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
            <h2 className="text-sm font-medium text-zinc-300 mb-4">Calibration Curve</h2>
            <p className="text-xs text-zinc-600 mb-3">
              Predicted probability vs. actual outcome rate. Perfect calibration follows the diagonal.
            </p>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={data.calibrationCurve} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                <XAxis
                  dataKey="label"
                  tick={{ fill: "#71717a", fontSize: 11 }}
                  axisLine={{ stroke: "#3f3f46" }}
                />
                <YAxis
                  domain={[0, 1]}
                  tick={{ fill: "#71717a", fontSize: 11 }}
                  axisLine={{ stroke: "#3f3f46" }}
                  tickFormatter={(v) => `${Math.round(v * 100)}%`}
                />
                <Tooltip
                  contentStyle={{ backgroundColor: "#18181b", border: "1px solid #3f3f46", borderRadius: 8 }}
                  labelStyle={{ color: "#a1a1aa" }}
                  formatter={(value, name) => {
                    if (name === "actualRate") return [value !== null ? `${(value * 100).toFixed(1)}%` : "--", "Actual Rate"];
                    if (name === "avgForecastProbability") return [value !== null ? `${(value * 100).toFixed(1)}%` : "--", "Avg Forecast"];
                    return [value, name];
                  }}
                />
                <ReferenceLine
                  segment={[{ x: "0-10%", y: 0.05 }, { x: "90-100%", y: 0.95 }]}
                  stroke="#52525b"
                  strokeDasharray="4 4"
                  label={{ value: "Perfect", fill: "#52525b", fontSize: 10 }}
                />
                <Bar dataKey="actualRate" fill="#34d399" radius={[4, 4, 0, 0]} name="actualRate" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Source breakdown */}
          {Object.keys(data.bySource).length > 0 && (
            <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
              <h2 className="text-sm font-medium text-zinc-300 px-4 pt-4 pb-2">By Source</h2>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-800 text-zinc-500 text-xs uppercase tracking-wider">
                    <th className="text-left px-4 py-2 font-medium">Source</th>
                    <th className="text-right px-4 py-2 font-medium">Count</th>
                    <th className="text-right px-4 py-2 font-medium">Brier</th>
                    <th className="text-right px-4 py-2 font-medium">Log Loss</th>
                    <th className="text-right px-4 py-2 font-medium">Hit Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(data.bySource).map(([src, s]) => (
                    <tr key={src} className="border-b border-zinc-800/50 hover:bg-zinc-800/30">
                      <td className="px-4 py-2 text-zinc-200 font-mono">{src}</td>
                      <td className="px-4 py-2 text-right text-zinc-400">{s.count}</td>
                      <td className="px-4 py-2 text-right text-zinc-400">{formatScore(s.brierScore)}</td>
                      <td className="px-4 py-2 text-right text-zinc-400">{formatScore(s.logLoss)}</td>
                      <td className="px-4 py-2 text-right text-zinc-400">
                        {s.hitRate !== null ? `${(s.hitRate * 100).toFixed(1)}%` : "--"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Recent forecasts */}
          {data.recentForecasts?.length > 0 && (
            <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
              <h2 className="text-sm font-medium text-zinc-300 px-4 pt-4 pb-2">Recent Forecasts</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-zinc-800 text-zinc-500 text-xs uppercase tracking-wider">
                      <th className="text-left px-4 py-2 font-medium">Ticker</th>
                      <th className="text-left px-4 py-2 font-medium">Side</th>
                      <th className="text-right px-4 py-2 font-medium">Forecast</th>
                      <th className="text-right px-4 py-2 font-medium">Market</th>
                      <th className="text-center px-4 py-2 font-medium">Result</th>
                      <th className="text-right px-4 py-2 font-medium">Resolved</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recentForecasts.map((f) => (
                      <tr key={f.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/30">
                        <td className="px-4 py-2 text-zinc-200 font-mono text-xs">{f.ticker}</td>
                        <td className="px-4 py-2 text-zinc-400">{f.side}</td>
                        <td className="px-4 py-2 text-right text-zinc-300">{(f.forecastProbability * 100).toFixed(1)}%</td>
                        <td className="px-4 py-2 text-right text-zinc-500">{(f.marketProbability * 100).toFixed(1)}%</td>
                        <td className="px-4 py-2 text-center">
                          <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                            f.outcomePayoff === 1
                              ? "bg-emerald-900/50 text-emerald-400"
                              : "bg-red-900/50 text-red-400"
                          }`}>
                            {f.resolution}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-right text-zinc-500 text-xs">
                          {new Date(f.resolvedAt).toLocaleDateString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

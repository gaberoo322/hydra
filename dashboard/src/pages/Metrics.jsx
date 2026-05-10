import { useApi } from "../hooks/useApi.js";
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import AbandonmentPanel from "../components/AbandonmentPanel.jsx";
import QualityGatesPanel from "../components/QualityGatesPanel.jsx";

export default function Metrics() {
  const { data: metricsData } = useApi("/metrics?count=30");
  const { data: spendData } = useApi("/spending?count=30");

  const metrics = (metricsData?.trend || metricsData?.metrics || []).reverse();
  const spending = (spendData?.perCycle || []).reverse();

  const chartData = metrics.map((m) => ({
    name: m.cycleId?.replace("cycle-", "").slice(0, 10) || "",
    merged: Number(m.tasksMerged) || 0,
    failed: Number(m.tasksFailed) || 0,
    abandoned: Number(m.tasksAbandoned) || 0,
    testsBefore: Number(m.testsBefore) || 0,
    testsAfter: Number(m.testsAfter) || 0,
    duration: Math.round(Number(m.totalDurationMs) / 1000) || 0,
  }));

  const spendChart = spending.map((s) => ({
    name: s.cycleId?.replace("cycle-", "").slice(0, 10) || "",
    cost: Number(s.totalCostUsd) || 0,
  }));

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Metrics</h1>

      {/* Aggregate stats */}
      {(metricsData?.stats || metricsData?.aggregate) && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Stat label="Total Cycles" value={(metricsData.stats || metricsData.aggregate)?.totalCycles || metrics.length} />
          <Stat label="Merge Rate" value={`${(metricsData.stats || metricsData.aggregate)?.mergedRate || (metricsData.stats || metricsData.aggregate)?.mergeRate || 0}%`} />
          <Stat label="Avg Duration" value={`${Math.round(((metricsData.stats || metricsData.aggregate)?.avgDurationMs || 0) / 1000)}s`} />
          <Stat label="Regressions" value={(metricsData.stats || metricsData.aggregate)?.regressionCount || 0} />
        </div>
      )}

      {/* Outcomes chart */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
        <h2 className="text-sm font-semibold text-zinc-400 mb-4">Cycle Outcomes</h2>
        {chartData.length > 0 ? (
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
              <XAxis dataKey="name" tick={{ fontSize: 10, fill: "#71717a" }} />
              <YAxis tick={{ fontSize: 10, fill: "#71717a" }} />
              <Tooltip contentStyle={{ backgroundColor: "#18181b", border: "1px solid #27272a", fontSize: 12 }} />
              <Bar dataKey="merged" stackId="a" fill="#34d399" name="Merged" />
              <Bar dataKey="failed" stackId="a" fill="#f87171" name="Failed" />
              <Bar dataKey="abandoned" stackId="a" fill="#71717a" name="Abandoned" />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <p className="text-sm text-zinc-600 py-8 text-center">No metrics data</p>
        )}
      </div>

      {/* Quality gates trend (issue #212) */}
      <QualityGatesPanel count={50} />

      {/* Abandonment causes (issue #195) */}
      <AbandonmentPanel count={50} />

      {/* Test trend */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
        <h2 className="text-sm font-semibold text-zinc-400 mb-4">Test Count Trend</h2>
        {chartData.length > 0 ? (
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
              <XAxis dataKey="name" tick={{ fontSize: 10, fill: "#71717a" }} />
              <YAxis tick={{ fontSize: 10, fill: "#71717a" }} />
              <Tooltip contentStyle={{ backgroundColor: "#18181b", border: "1px solid #27272a", fontSize: 12 }} />
              <Line type="monotone" dataKey="testsAfter" stroke="#34d399" name="Tests After" dot={false} />
              <Line type="monotone" dataKey="testsBefore" stroke="#71717a" name="Tests Before" dot={false} strokeDasharray="4 4" />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <p className="text-sm text-zinc-600 py-8 text-center">No data</p>
        )}
      </div>

      {/* Cost trend */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
        <h2 className="text-sm font-semibold text-zinc-400 mb-4">Cost per Cycle</h2>
        {spendChart.length > 0 ? (
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={spendChart}>
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
              <XAxis dataKey="name" tick={{ fontSize: 10, fill: "#71717a" }} />
              <YAxis tick={{ fontSize: 10, fill: "#71717a" }} tickFormatter={(v) => `$${v.toFixed(2)}`} />
              <Tooltip contentStyle={{ backgroundColor: "#18181b", border: "1px solid #27272a", fontSize: 12 }} formatter={(v) => `$${v.toFixed(3)}`} />
              <Bar dataKey="cost" fill="#a78bfa" name="Cost (USD)" />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <p className="text-sm text-zinc-600 py-8 text-center">No spending data</p>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
      <p className="text-xs text-zinc-500 uppercase tracking-wider">{label}</p>
      <p className="text-2xl font-bold text-white mt-1">{value}</p>
    </div>
  );
}

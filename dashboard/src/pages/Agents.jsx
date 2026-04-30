import { useApi } from "../hooks/useApi.js";
import { useState, useEffect } from "react";
import StatusBadge from "../components/StatusBadge.jsx";

const API_BASE = import.meta.env.VITE_API_BASE || "/api";

export default function Agents() {
  const { data: status } = useApi("/agents/status", { poll: 5000 });
  const { data: report } = useApi("/cycle/report", { poll: 5000 });
  const [summary, setSummary] = useState(null);

  // /summary returns plain text, not JSON
  useEffect(() => {
    async function fetchSummary() {
      try {
        const res = await fetch(`${API_BASE}/summary`);
        if (res.ok) setSummary(await res.text());
      } catch {}
    }
    fetchSummary();
    const interval = setInterval(fetchSummary, 15000);
    return () => clearInterval(interval);
  }, []);

  // agents may be an object or array — normalize to array
  const agentsRaw = status?.agents;
  const agents = Array.isArray(agentsRaw) ? agentsRaw
    : agentsRaw && typeof agentsRaw === "object" ? Object.values(agentsRaw)
    : [];
  const agentRuns = report?.agents || [];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Agents</h1>

      {/* Agent status cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {["planner", "skeptic", "executor"].map((name) => {
          const agent = agents.find(a => a.id === name || a.name === name);
          const lastRun = agentRuns.filter(r => r.agent === name).pop();
          return (
            <div key={name} className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-white capitalize">{name}</h3>
                <StatusBadge status={agent?.status || (lastRun ? "completed" : "idle")} />
              </div>
              {lastRun && (
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between text-zinc-500">
                    <span>Duration</span>
                    <span className="text-zinc-300">{Math.round(lastRun.duration / 1000)}s</span>
                  </div>
                  {lastRun.verdict && (
                    <div className="flex justify-between text-zinc-500">
                      <span>Verdict</span>
                      <StatusBadge status={lastRun.verdict === "approve" ? "approved" : lastRun.verdict} />
                    </div>
                  )}
                  {lastRun.costUsd != null && (
                    <div className="flex justify-between text-zinc-500">
                      <span>Cost</span>
                      <span className="text-zinc-300">${lastRun.costUsd.toFixed(3)}</span>
                    </div>
                  )}
                </div>
              )}
              {!lastRun && !agent && (
                <p className="text-xs text-zinc-600">No recent activity</p>
              )}
            </div>
          );
        })}
      </div>

      {/* Agent run history (from current/last cycle) */}
      {agentRuns.length > 0 && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
          <h2 className="text-sm font-semibold text-zinc-400 mb-3">Current Cycle Agent Runs</h2>
          <div className="space-y-2">
            {agentRuns.map((run, i) => (
              <div key={i} className="flex items-center justify-between bg-zinc-800/50 rounded px-3 py-2">
                <div className="flex items-center gap-3">
                  <span className="text-sm text-white font-medium capitalize w-16">{run.agent}</span>
                  <span className="text-xs text-zinc-500 font-mono">{run.task || ""}</span>
                </div>
                <div className="flex items-center gap-4 text-xs">
                  {run.verdict && <StatusBadge status={run.verdict === "approve" ? "approved" : run.verdict} />}
                  <span className="text-zinc-500">{Math.round(run.duration / 1000)}s</span>
                  {run.costUsd != null && <span className="text-zinc-500">${run.costUsd.toFixed(3)}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Summary text */}
      {summary && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
          <h2 className="text-sm font-semibold text-zinc-400 mb-3">Summary</h2>
          <pre className="text-xs text-zinc-400 whitespace-pre-wrap font-mono">{summary}</pre>
        </div>
      )}
    </div>
  );
}

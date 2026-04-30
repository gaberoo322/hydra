import { useApi, apiFetch } from "../hooks/useApi.js";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useToast } from "../hooks/useToast.jsx";
import StatusBadge from "../components/StatusBadge.jsx";
import ConfirmDialog from "../components/ConfirmDialog.jsx";

const PIPELINE_STEPS = ["grounding", "planning", "skeptic", "execution", "verification", "merge"];

export default function Overview({ ws }) {
  const { data: health } = useApi("/health", { poll: 15000 });
  const { data: cycle, refresh: refreshCycle } = useApi("/cycle/status", { poll: 5000 });
  const { data: report } = useApi("/cycle/report", { poll: 5000 });
  const { data: scheduler, refresh: refreshScheduler } = useApi("/scheduler/status", { poll: 10000 });
  const { data: backlog } = useApi("/backlog/counts", { poll: 30000 });
  const { data: metrics } = useApi("/metrics?count=10", { poll: 30000 });
  const { data: alerts } = useApi("/alerts?limit=5", { poll: 30000 });
  const [startingCycle, setStartingCycle] = useState(false);
  const [togglingScheduler, setTogglingScheduler] = useState(false);
  const [runningResearch, setRunningResearch] = useState(false);
  const [showKillDialog, setShowKillDialog] = useState(false);
  const toast = useToast();
  const navigate = useNavigate();

  useEffect(() => {
    return ws.subscribe("*", () => { refreshCycle(); });
  }, [ws, refreshCycle]);

  const recentMetrics = metrics?.trend || metrics?.metrics || [];
  const mergeRate = recentMetrics.length > 0
    ? Math.round((recentMetrics.filter(m => Number(m.tasksMerged) > 0).length / recentMetrics.length) * 100)
    : 0;
  const cycleRunning = cycle?.status === "running";
  const recentMerges = recentMetrics
    .filter(m => Number(m.tasksMerged) > 0)
    .slice(0, 5);
  const undismissedAlerts = (alerts || []).filter(a => !a.dismissed);

  async function handleStartCycle() {
    setStartingCycle(true);
    try {
      await apiFetch("/cycle/start", { method: "POST" });
      toast("Cycle started");
      refreshCycle();
    } catch (err) {
      toast(err.message.includes("409") ? "Cycle already running" : err.message, "error");
    } finally {
      setStartingCycle(false);
    }
  }

  async function handleToggleScheduler() {
    setTogglingScheduler(true);
    try {
      const endpoint = scheduler?.running ? "/scheduler/stop" : "/scheduler/start";
      await apiFetch(endpoint, { method: "POST" });
      toast(scheduler?.running ? "Scheduler stopped" : "Scheduler started");
      refreshScheduler();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setTogglingScheduler(false);
    }
  }

  async function handleRunResearch() {
    setRunningResearch(true);
    try {
      const result = await apiFetch("/research/start", { method: "POST" });
      toast(`Research complete — ${result.autoQueued ?? 0} items queued`);
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setRunningResearch(false);
    }
  }

  async function handleKill() {
    try {
      await apiFetch("/kill", { method: "POST" });
      toast("Emergency kill triggered");
      setShowKillDialog(false);
      refreshCycle();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <div className="flex items-center gap-2">
          {cycleRunning && (
            <button
              onClick={() => setShowKillDialog(true)}
              className="text-xs px-3 py-1.5 bg-red-600/20 hover:bg-red-600/40 text-red-400 border border-red-600/30 rounded transition-colors"
            >
              Kill
            </button>
          )}
        </div>
      </div>

      {/* Active Cycle — full width hero */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-zinc-400">Active Cycle</h2>
            <StatusBadge status={cycleRunning ? "running" : "idle"} />
          </div>
          {!cycleRunning && (
            <button
              onClick={handleStartCycle}
              disabled={startingCycle}
              className="text-xs px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded transition-colors"
            >
              {startingCycle ? "Starting..." : "Start Cycle"}
            </button>
          )}
        </div>

        {cycleRunning ? (
          <>
            <p className="text-xs font-mono text-zinc-500 mb-3">{cycle.id || cycle.cycleId}</p>
            {/* Pipeline visualization */}
            <div className="flex items-center gap-1 mb-2">
              {PIPELINE_STEPS.map((step, i) => {
                const agentRuns = report?.agents || [];
                const completed = agentRuns.some(a => a.agent === step || (step === "planning" && a.agent === "planner"));
                return (
                  <div key={step} className="flex items-center gap-1 flex-1">
                    <div className={`flex-1 h-2 rounded-full ${completed ? "bg-emerald-500" : "bg-zinc-800"}`} />
                    {i < PIPELINE_STEPS.length - 1 && <div className="w-1" />}
                  </div>
                );
              })}
            </div>
            <div className="flex justify-between text-[10px] text-zinc-600 px-1">
              {PIPELINE_STEPS.map(s => <span key={s}>{s}</span>)}
            </div>
            {/* Agent runs */}
            {report?.agents?.length > 0 && (
              <div className="mt-3 space-y-1.5">
                {report.agents.map((agent, i) => (
                  <div key={i} className="flex items-center justify-between text-xs bg-zinc-800/50 rounded px-3 py-1.5">
                    <div className="flex items-center gap-2">
                      <span className="text-white font-medium">{agent.agent}</span>
                      <StatusBadge status={agent.verdict || "completed"} />
                    </div>
                    <div className="flex items-center gap-3 text-zinc-500">
                      <span>{Math.round(agent.duration / 1000)}s</span>
                      {agent.costUsd != null && <span>${agent.costUsd.toFixed(3)}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <p className="text-sm text-zinc-600">No active cycle. Scheduler will start one automatically.</p>
        )}
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {/* Scheduler */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-semibold text-zinc-500">Scheduler</p>
            <StatusBadge status={scheduler?.running ? "running" : "idle"} />
          </div>
          <p className="text-lg font-bold text-white">{scheduler?.cyclesRun ?? 0} <span className="text-xs font-normal text-zinc-500">cycles</span></p>
          <div className="flex items-center gap-2 mt-2">
            <button
              onClick={handleToggleScheduler}
              disabled={togglingScheduler}
              className={`text-xs px-2.5 py-1 rounded transition-colors ${
                scheduler?.running
                  ? "bg-zinc-700 hover:bg-zinc-600 text-zinc-300"
                  : "bg-emerald-600 hover:bg-emerald-500 text-white"
              } disabled:bg-zinc-700 disabled:text-zinc-500`}
            >
              {togglingScheduler ? "..." : scheduler?.running ? "Stop" : "Start"}
            </button>
            <button
              onClick={handleRunResearch}
              disabled={runningResearch}
              className="text-xs px-2.5 py-1 bg-purple-600 hover:bg-purple-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded transition-colors"
            >
              {runningResearch ? "..." : "Research"}
            </button>
          </div>
        </div>

        {/* Merge Rate */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3">
          <p className="text-xs font-semibold text-zinc-500 mb-2">Merge Rate</p>
          <p className="text-lg font-bold text-white">{mergeRate}%</p>
          <p className="text-xs text-zinc-600 mt-1">
            {recentMetrics.filter(m => Number(m.tasksMerged) > 0).length}/{recentMetrics.length} merged
          </p>
        </div>

        {/* Daily Spend */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3">
          <p className="text-xs font-semibold text-zinc-500 mb-2">Daily Spend</p>
          <p className="text-lg font-bold text-white">
            ${Number(scheduler?.research?.dailySpendUsd || 0).toFixed(2)}
          </p>
          <p className="text-xs text-zinc-600 mt-1">
            of ${Number(scheduler?.research?.dailyCostCapUsd || 50).toFixed(0)} cap
          </p>
        </div>

        {/* System */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3">
          <p className="text-xs font-semibold text-zinc-500 mb-2">System</p>
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${health?.status === "ok" ? "bg-emerald-400" : "bg-red-400"}`} />
            <span className="text-sm text-white">{health?.status === "ok" ? "Healthy" : "Down"}</span>
          </div>
          <p className="text-xs text-zinc-600 mt-1">
            Redis: {health?.redis ? "ok" : "down"} | Errors: {scheduler?.consecutiveErrors ?? 0}
          </p>
        </div>
      </div>

      {/* Two-column: Backlog + Recent Merges */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {/* Backlog summary */}
        <div
          className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 cursor-pointer hover:border-zinc-700 transition-colors"
          onClick={() => navigate("/backlog")}
        >
          <h2 className="text-sm font-semibold text-zinc-400 mb-3">Backlog</h2>
          {backlog ? (
            <div className="grid grid-cols-3 gap-3">
              {["queued", "inProgress", "blocked", "triage", "backlog", "done"].map((lane) => {
                const value = backlog[lane];
                if (value === undefined) return null;
                if (typeof value === "object" && value !== null) {
                  return (
                    <div key={lane} className="text-center">
                      <p className={`text-lg font-bold ${value.atLimit ? "text-amber-400" : "text-white"}`}>
                        {value.count}/{value.limit}
                      </p>
                      <p className="text-[10px] text-zinc-600 uppercase">{lane}</p>
                    </div>
                  );
                }
                const highlight = lane === "blocked" && value > 0 ? "text-red-400" :
                                  lane === "queued" && value > 0 ? "text-emerald-400" : "text-white";
                return (
                  <div key={lane} className="text-center">
                    <p className={`text-lg font-bold ${highlight}`}>{value}</p>
                    <p className="text-[10px] text-zinc-600 uppercase">{lane}</p>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-zinc-600">Loading...</p>
          )}
        </div>

        {/* Recent merges */}
        <div
          className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 cursor-pointer hover:border-zinc-700 transition-colors"
          onClick={() => navigate("/cycles")}
        >
          <h2 className="text-sm font-semibold text-zinc-400 mb-3">Recent Merges</h2>
          {recentMerges.length > 0 ? (
            <div className="space-y-2">
              {recentMerges.map((m, i) => (
                <div key={i} className="flex items-center justify-between text-xs">
                  <span className="text-zinc-300 truncate flex-1 mr-3">{m.taskTitle || m.cycleId || "?"}</span>
                  <div className="flex items-center gap-2 text-zinc-600 shrink-0">
                    {m.anchorType && <span className="text-zinc-700">{m.anchorType}</span>}
                    {m.totalDurationMs && <span>{Math.round(m.totalDurationMs / 1000)}s</span>}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-zinc-600">No recent merges</p>
          )}
        </div>
      </div>

      {/* Alerts — only show if there are undismissed alerts */}
      {undismissedAlerts.length > 0 && (
        <div
          className="bg-zinc-900 border border-red-900/30 rounded-lg p-4 cursor-pointer hover:border-red-900/50 transition-colors"
          onClick={() => navigate("/alerts")}
        >
          <h2 className="text-sm font-semibold text-red-400 mb-2">
            {undismissedAlerts.length} Alert{undismissedAlerts.length !== 1 ? "s" : ""}
          </h2>
          <div className="space-y-1.5">
            {undismissedAlerts.slice(0, 3).map((alert, i) => (
              <div key={i} className="flex items-start gap-2 text-xs">
                <span className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${
                  alert.severity === "error" ? "bg-red-400" : "bg-amber-400"
                }`} />
                <span className="text-zinc-400">{alert.message?.slice(0, 120)}</span>
              </div>
            ))}
            {undismissedAlerts.length > 3 && (
              <p className="text-xs text-zinc-600">+{undismissedAlerts.length - 3} more</p>
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={showKillDialog}
        title="Emergency Kill"
        message="This will immediately stop all running cycles and prevent new ones from starting. A manual restart will be required. Are you sure?"
        confirmLabel="Kill All Cycles"
        danger
        onConfirm={handleKill}
        onCancel={() => setShowKillDialog(false)}
      />
    </div>
  );
}

import { useApi, apiFetch } from "../hooks/useApi.js";
import { useEffect, useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useToast } from "../hooks/useToast.jsx";
import StatusBadge from "../components/StatusBadge.jsx";
import ConfirmDialog from "../components/ConfirmDialog.jsx";

const PIPELINE_STEPS = ["grounding", "planning", "skeptic", "execution", "verification", "merge"];

const EVIDENCE_STATES = ["proposed", "approved", "in-progress", "changed-code", "verified", "merged", "failed", "abandoned", "blocked"];
const EVIDENCE_COLORS = {
  proposed: "bg-zinc-500", approved: "bg-blue-500", "in-progress": "bg-blue-400",
  "changed-code": "bg-purple-400", verified: "bg-emerald-400", merged: "bg-emerald-500",
  failed: "bg-red-500", abandoned: "bg-zinc-600", blocked: "bg-yellow-500",
};

const SEVERITY_STYLES = {
  error: "border-red-500/50 bg-red-500/5",
  warning: "border-yellow-500/50 bg-yellow-500/5",
  info: "border-blue-500/50 bg-blue-500/5",
};
const SEVERITY_DOT = {
  error: "bg-red-400",
  warning: "bg-yellow-400",
  info: "bg-blue-400",
};

const AGENT_COLORS = {
  "domain-researcher": "text-blue-400",
  "technical-researcher": "text-purple-400",
  "market-researcher": "text-amber-400",
  "research-strategist": "text-emerald-400",
  "director": "text-emerald-400",
  "planner": "text-cyan-400",
  "skeptic": "text-red-400",
  "executor": "text-orange-400",
  "fixer": "text-yellow-400",
  "meta": "text-zinc-400",
};

function timeAgo(timestamp) {
  const diff = Date.now() - new Date(timestamp).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function Overview({ ws }) {
  const { data: health } = useApi("/health", { poll: 15000 });
  const { data: cycle, refresh: refreshCycle } = useApi("/cycle/status", { poll: 5000 });
  const { data: report } = useApi("/cycle/report", { poll: 5000 });
  const { data: scheduler, refresh: refreshScheduler } = useApi("/scheduler/status", { poll: 10000 });
  const { data: backlog } = useApi("/backlog/counts", { poll: 30000 });
  const { data: metrics } = useApi("/metrics?count=10", { poll: 30000 });
  const { data: alertsData, refresh: refreshAlerts } = useApi("/alerts?limit=50", { poll: 10000 });
  // Issue #252 — surface stuckness count in header so the operator notices
  // when cycles are green but outcomes aren't moving (vision pain-point 3).
  const { data: stucknessData } = useApi("/stuckness", { poll: 30000 });
  const [startingCycle, setStartingCycle] = useState(false);
  const [togglingScheduler, setTogglingScheduler] = useState(false);
  const [runningResearch, setRunningResearch] = useState(false);
  const [showKillDialog, setShowKillDialog] = useState(false);
  const [bottomTab, setBottomTab] = useState("activity");
  const [historyLimit, setHistoryLimit] = useState(50);
  const { data: historyMetrics } = useApi(`/metrics?count=${historyLimit}`);
  const { data: tasks, refresh: refreshTasks } = useApi("/tasks", { poll: 5000 });
  const [selectedTaskId, setSelectedTaskId] = useState(null);
  const [selectedCycleId, setSelectedCycleId] = useState(null);
  const toast = useToast();
  const navigate = useNavigate();

  // Agent stream state
  const [streamEvents, setStreamEvents] = useState([]);
  const [activeAgents, setActiveAgents] = useState({});
  const [autoScroll, setAutoScroll] = useState(true);
  const bottomRef = useRef(null);

  useEffect(() => {
    return ws.subscribe("*", (event) => {
      refreshCycle();
      refreshTasks();
      if (event.stream === "hydra:notifications") refreshAlerts();
    });
  }, [ws, refreshCycle, refreshTasks, refreshAlerts]);

  // Agent stream subscription
  useEffect(() => {
    return ws.subscribe("agent:stream", (data) => {
      const evt = data.event || {};
      const agent = data.agent || "unknown";
      const text = evt.item?.text || evt.message || "";

      setActiveAgents((prev) => {
        const next = { ...prev };
        if (evt.type === "thread.started" || evt.type === "turn.started") {
          next[agent] = { status: "running", startedAt: data.timestamp, taskId: data.taskId };
        } else if (evt.type === "turn.completed" || evt.type === "item.completed") {
          if (next[agent]) next[agent] = { ...next[agent], status: "done" };
        }
        return next;
      });

      if (evt.type === "item.completed" && text) {
        setStreamEvents((prev) => [...prev, {
          agent, taskId: data.taskId, text: text.slice(0, 2000),
          timestamp: data.timestamp, type: "output",
        }].slice(-200));
      } else if (evt.type === "turn.completed" && evt.usage) {
        setStreamEvents((prev) => [...prev, {
          agent, taskId: data.taskId,
          text: `${evt.usage.input_tokens?.toLocaleString() || 0} in / ${evt.usage.output_tokens?.toLocaleString() || 0} out tokens`,
          timestamp: data.timestamp, type: "usage",
        }].slice(-200));
      } else if (evt.type === "error") {
        setStreamEvents((prev) => [...prev, {
          agent, taskId: data.taskId,
          text: evt.message || JSON.stringify(evt).slice(0, 500),
          timestamp: data.timestamp, type: "error",
        }].slice(-200));
      }
    });
  }, [ws]);

  useEffect(() => {
    if (autoScroll && bottomRef.current && bottomTab === "activity") {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [streamEvents, autoScroll, bottomTab]);

  const recentMetrics = metrics?.trend || metrics?.metrics || [];
  const mergeRate = recentMetrics.length > 0
    ? Math.round((recentMetrics.filter(m => Number(m.tasksMerged) > 0).length / recentMetrics.length) * 100)
    : 0;
  const cycleRunning = cycle?.status === "running";
  const recentMerges = recentMetrics
    .filter(m => Number(m.tasksMerged) > 0)
    .slice(0, 5);
  const undismissedAlerts = (alertsData || []).filter(a => !a.dismissed);

  // Stuckness summary for the header badge (issue #252).
  const stucknessRows = Array.isArray(stucknessData?.outcomes) ? stucknessData.outcomes : [];
  const stucknessFiredCount = stucknessRows.filter((r) => r?.fired).length;
  const stucknessTotal = stucknessRows.length;

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

  async function handleDismissAlert(id) {
    await apiFetch(`/alerts/${id}/dismiss`, { method: "POST" });
    refreshAlerts();
  }

  async function handleDismissAllAlerts() {
    await apiFetch("/alerts/dismiss-all", { method: "POST" });
    refreshAlerts();
  }

  // Issue #397: when the in-process control loop is disabled (the post-#383
  // default), surface that explicitly so dashboard widgets that show
  // "0 cycles / merge rate 0% / last cycle: never" are not misread as
  // a degraded scheduler — work happens via autopilot subagents instead.
  const codexCycleDisabled = scheduler && scheduler.codexCycleEnabled === false;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <StucknessBadge firedCount={stucknessFiredCount} total={stucknessTotal} onClick={() => navigate("/outcomes")} />
        </div>
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

      {/* Issue #397: codex-disabled / autopilot-mode banner */}
      {codexCycleDisabled && (
        <div
          className="bg-amber-900/20 border border-amber-700/40 rounded-lg px-4 py-2 text-xs text-amber-200"
          title="In-process codex control loop disabled — code-writing work happens via autopilot subagents, not the legacy cycle. Cycle-shaped widgets below reflect housekeeping ticks only."
        >
          <span className="font-semibold">Autopilot mode</span>
          <span className="text-amber-300/80"> — in-process control loop disabled. Cycle counters reflect housekeeping ticks; actual code-writing runs as Claude Code subagents.</span>
        </div>
      )}

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
          onClick={() => setBottomTab("cycles")}
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

      {/* Tabbed section: Live Activity + Alerts */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg">
        {/* Tab bar */}
        <div className="flex items-center border-b border-zinc-800">
          <button
            onClick={() => setBottomTab("activity")}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
              bottomTab === "activity"
                ? "border-emerald-400 text-white"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            Live Activity
            {Object.values(activeAgents).some(a => a.status === "running") && (
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            )}
          </button>
          <button
            onClick={() => setBottomTab("cycles")}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
              bottomTab === "cycles"
                ? "border-emerald-400 text-white"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            Cycles
          </button>
          <button
            onClick={() => setBottomTab("alerts")}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
              bottomTab === "alerts"
                ? "border-emerald-400 text-white"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            Alerts
            {undismissedAlerts.length > 0 && (
              <span className="bg-red-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full min-w-[18px] text-center">
                {undismissedAlerts.length}
              </span>
            )}
          </button>

          {/* Tab-specific controls */}
          <div className="ml-auto flex items-center gap-2 pr-3">
            {bottomTab === "activity" && (
              <>
                <label className="flex items-center gap-2 text-xs text-zinc-500">
                  <input
                    type="checkbox"
                    checked={autoScroll}
                    onChange={(e) => setAutoScroll(e.target.checked)}
                    className="rounded"
                  />
                  Auto-scroll
                </label>
                <button
                  onClick={() => setStreamEvents([])}
                  className="text-xs px-2.5 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-400 rounded transition-colors"
                >
                  Clear
                </button>
              </>
            )}
            {bottomTab === "alerts" && undismissedAlerts.length > 0 && (
              <button
                onClick={handleDismissAllAlerts}
                className="text-xs px-2.5 py-1 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded transition-colors"
              >
                Dismiss all
              </button>
            )}
          </div>
        </div>

        {/* Tab content */}
        <div className="p-4">
          {bottomTab === "activity" && (
            <>
              {/* Active agents */}
              {Object.keys(activeAgents).length > 0 && (
                <div className="flex gap-2 flex-wrap mb-3">
                  {Object.entries(activeAgents).map(([name, info]) => (
                    <div
                      key={name}
                      className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs border ${
                        info.status === "running"
                          ? "border-emerald-500/30 bg-emerald-500/10"
                          : "border-zinc-700 bg-zinc-800/50"
                      }`}
                    >
                      {info.status === "running" && (
                        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                      )}
                      <span className={AGENT_COLORS[name] || "text-zinc-400"}>{name}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Event stream */}
              <div className="max-h-80 overflow-y-auto font-mono text-sm">
                {streamEvents.length === 0 && (
                  <p className="text-zinc-600 text-center py-8">
                    Waiting for agent activity...
                  </p>
                )}
                {streamEvents.map((evt, i) => (
                  <div key={i} className={`py-2 ${i > 0 ? "border-t border-zinc-800/50" : ""}`}>
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`font-semibold ${AGENT_COLORS[evt.agent] || "text-zinc-400"}`}>{evt.agent}</span>
                      {evt.type === "error" && <span className="text-xs px-1.5 py-0.5 bg-red-500/20 text-red-400 rounded">error</span>}
                      {evt.type === "usage" && <span className="text-xs px-1.5 py-0.5 bg-zinc-700 text-zinc-400 rounded">tokens</span>}
                      <span className="text-[10px] text-zinc-700 ml-auto">
                        {evt.timestamp ? new Date(evt.timestamp).toLocaleTimeString() : ""}
                      </span>
                    </div>
                    <div className={`text-xs leading-relaxed whitespace-pre-wrap ${
                      evt.type === "error" ? "text-red-300" :
                      evt.type === "usage" ? "text-zinc-500" :
                      "text-zinc-300"
                    }`}>
                      {evt.text}
                    </div>
                  </div>
                ))}
                <div ref={bottomRef} />
              </div>
            </>
          )}

          {bottomTab === "cycles" && (
            <>
              {/* Tasks */}
              {(() => {
                const taskList = Array.isArray(tasks) ? tasks : tasks?.tasks || [];
                return taskList.length > 0 && (
                  <div className="mb-4">
                    <h3 className="text-xs font-semibold text-zinc-500 mb-2">Tasks</h3>
                    <div className="space-y-1.5">
                      {taskList.map((task) => {
                        const id = task.taskId || task.id;
                        const isSelected = selectedTaskId === id;
                        return (
                          <div key={id}>
                            <button
                              onClick={() => setSelectedTaskId(isSelected ? null : id)}
                              className={`w-full flex items-center justify-between text-sm px-3 py-2 rounded transition-colors text-left ${
                                isSelected ? "bg-zinc-800 border border-zinc-700" : "bg-zinc-800/50 hover:bg-zinc-800"
                              }`}
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                <StatusBadge status={task.state || task.status || "pending"} />
                                <span className="text-zinc-200 truncate">{task.title}</span>
                              </div>
                              <div className="flex items-center gap-3 text-xs text-zinc-500 shrink-0 ml-3">
                                {task.confidence && (
                                  <span className={`px-1.5 py-0.5 rounded ${
                                    task.confidence === "high" ? "bg-emerald-500/20 text-emerald-400" :
                                    task.confidence === "medium" ? "bg-yellow-500/20 text-yellow-400" :
                                    "bg-red-500/20 text-red-400"
                                  }`}>{task.confidence}</span>
                                )}
                                {task.anchorType && <span className="text-zinc-600">{task.anchorType}</span>}
                              </div>
                            </button>
                            {isSelected && <TaskDetail taskId={id} />}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}

              {/* History */}
              {(() => {
                const cycles = historyMetrics?.trend || historyMetrics?.metrics || [];
                return (
                  <div>
                    <h3 className="text-xs font-semibold text-zinc-500 mb-2">History ({cycles.length} cycles)</h3>
                    <div className="space-y-0.5 max-h-96 overflow-y-auto">
                      {cycles.map((m) => {
                        const merged = Number(m.tasksMerged) > 0;
                        const failed = Number(m.tasksFailed) > 0;
                        const abandoned = Number(m.tasksAbandoned) > 0;
                        const rolledBack = m.rolledBack === true || m.rolledBack === "true";
                        const status = rolledBack ? "rolled-back" : merged ? "merged" : failed ? "failed" : abandoned ? "abandoned" : "completed";
                        const dur = m.totalDurationMs ? `${Math.round(m.totalDurationMs / 1000)}s` : "";
                        const title = m.taskTitle || m.cycleId || "?";
                        const ts = m.recordedAt;
                        const time = ts ? new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
                        const testDelta = (m.testsAfter && m.testsBefore && m.testsAfter !== m.testsBefore)
                          ? `${m.testsBefore}→${m.testsAfter}` : "";
                        const isExpanded = selectedCycleId === m.cycleId;
                        return (
                          <div key={m.cycleId}>
                            <button
                              onClick={() => setSelectedCycleId(isExpanded ? null : m.cycleId)}
                              className={`w-full flex items-center justify-between text-sm px-3 py-2 rounded transition-colors gap-3 text-left ${
                                isExpanded ? "bg-zinc-800 border border-zinc-700" : "hover:bg-zinc-800/50"
                              }`}
                            >
                              <div className="flex items-center gap-2 min-w-0 flex-1">
                                <StatusBadge status={status} />
                                <span className="text-zinc-300 truncate">{title}</span>
                              </div>
                              <div className="flex items-center gap-3 text-xs text-zinc-600 shrink-0">
                                {m.anchorType && <span className="text-zinc-700">{m.anchorType}</span>}
                                {testDelta && <span className="text-emerald-700">{testDelta}</span>}
                                {dur && <span>{dur}</span>}
                                <span className="w-28 text-right">{time}</span>
                              </div>
                            </button>
                            {isExpanded && <CycleDetail cycleId={m.cycleId} />}
                          </div>
                        );
                      })}
                      {cycles.length === 0 && (
                        <p className="text-sm text-zinc-600 py-2">No cycle history</p>
                      )}
                    </div>
                    {cycles.length >= historyLimit && (
                      <button
                        onClick={() => setHistoryLimit(l => l + 50)}
                        className="mt-3 w-full text-sm text-zinc-500 hover:text-zinc-300 py-2 border border-zinc-800 rounded hover:border-zinc-700 transition-colors"
                      >
                        Load more
                      </button>
                    )}
                  </div>
                );
              })()}
            </>
          )}

          {bottomTab === "alerts" && (
            <>
              {undismissedAlerts.length === 0 ? (
                <p className="text-zinc-600 text-center py-8">No active alerts</p>
              ) : (
                <div className="space-y-2 max-h-80 overflow-y-auto">
                  {undismissedAlerts.map((alert) => (
                    <div
                      key={alert.id}
                      className={`border rounded-lg p-3 flex items-start justify-between ${SEVERITY_STYLES[alert.severity] || SEVERITY_STYLES.info}`}
                    >
                      <div className="flex items-start gap-3">
                        <span className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${SEVERITY_DOT[alert.severity] || SEVERITY_DOT.info}`} />
                        <div>
                          <p className="text-sm text-zinc-200">{alert.message}</p>
                          <div className="flex items-center gap-3 mt-1">
                            <span className="text-[10px] text-zinc-500 font-mono">{alert.type}</span>
                            <span className="text-[10px] text-zinc-600">
                              {alert.timestamp ? timeAgo(alert.timestamp) : ""}
                            </span>
                          </div>
                        </div>
                      </div>
                      <button
                        onClick={() => handleDismissAlert(alert.id)}
                        className="text-xs text-zinc-600 hover:text-zinc-300 px-2 py-1 shrink-0"
                      >
                        Dismiss
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>

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

/**
 * Stuckness summary badge for the header (issue #252).
 * - 0 outcomes total → don't render (no signal to show)
 * - 0 fired → muted/grey "all clear"
 * - N fired → red, alert icon, clickable link to /outcomes
 */
function StucknessBadge({ firedCount, total, onClick }) {
  if (total === 0) return null;
  const stuck = firedCount > 0;
  const classes = stuck
    ? "bg-red-500/10 border-red-500/50 text-red-300 hover:bg-red-500/20"
    : "bg-zinc-800 border-zinc-700 text-zinc-400 hover:bg-zinc-700/70";
  return (
    <button
      type="button"
      onClick={onClick}
      title="View outcomes"
      className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded border transition-colors ${classes}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${stuck ? "bg-red-400 animate-pulse" : "bg-zinc-500"}`} />
      <span className="font-medium">
        {firedCount} of {total} outcomes stuck
      </span>
    </button>
  );
}

function TaskDetail({ taskId }) {
  const [task, setTask] = useState(null);
  const [evidence, setEvidence] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      apiFetch(`/tasks/${taskId}`).catch(() => null),
      apiFetch(`/tasks/${taskId}/evidence`).catch(() => null),
    ]).then(([taskData, evidenceData]) => {
      if (cancelled) return;
      setTask(taskData);
      setEvidence(evidenceData);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [taskId]);

  if (loading) return <div className="mt-2 p-4 bg-zinc-800/30 rounded animate-pulse h-32" />;
  if (!task) return <div className="mt-2 p-4 bg-zinc-800/30 rounded text-sm text-zinc-600">No task data</div>;

  const scope = typeof task.scopeBoundary === "string" ? JSON.parse(task.scopeBoundary || "{}") : (task.scopeBoundary || {});
  const plan = typeof task.verificationPlan === "string" ? JSON.parse(task.verificationPlan || "[]") : (task.verificationPlan || []);
  const evidenceEntries = evidence?.evidence || evidence || {};
  const timeline = EVIDENCE_STATES
    .filter((state) => evidenceEntries[state])
    .map((state) => ({ state, ...evidenceEntries[state] }));

  return (
    <div className="mt-2 bg-zinc-800/30 border border-zinc-800 rounded-lg p-4 space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        <div><p className="text-zinc-600 mb-0.5">Anchor</p><p className="text-zinc-300">{task.anchorType || "—"}</p></div>
        <div><p className="text-zinc-600 mb-0.5">Confidence</p><p className="text-zinc-300">{task.confidence || "—"}</p></div>
        <div><p className="text-zinc-600 mb-0.5">Scope In</p><p className="text-zinc-300">{scope.in ?? "—"} files</p></div>
        <div><p className="text-zinc-600 mb-0.5">Scope Out</p><p className="text-zinc-300">{scope.out ?? "—"} files</p></div>
      </div>
      {task.whyNow && (
        <div className="border-l-2 border-zinc-700 pl-3">
          <p className="text-xs text-zinc-600 mb-0.5">Why now</p>
          <p className="text-sm text-zinc-400 italic">{task.whyNow}</p>
        </div>
      )}
      {plan.length > 0 && (
        <div>
          <p className="text-xs text-zinc-600 mb-1.5">Verification Plan</p>
          <div className="space-y-1">
            {plan.map((step, i) => (
              <div key={i} className="flex items-start gap-2 text-xs">
                <span className="text-zinc-600 mt-0.5">•</span>
                <span className="text-zinc-400">{typeof step === "string" ? step : step.label || step.command || JSON.stringify(step)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {timeline.length > 0 && (
        <div>
          <p className="text-xs text-zinc-600 mb-2">Evidence Chain</p>
          <div className="space-y-0">
            {timeline.map((entry, i) => (
              <div key={entry.state} className="flex gap-3">
                <div className="flex flex-col items-center w-3 shrink-0">
                  <div className={`w-2.5 h-2.5 rounded-full ${EVIDENCE_COLORS[entry.state] || "bg-zinc-500"} shrink-0 mt-0.5`} />
                  {i < timeline.length - 1 && <div className="w-px flex-1 bg-zinc-700 my-0.5" />}
                </div>
                <div className="pb-3 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-zinc-300">{entry.state}</span>
                    {entry.transitionedAt && (
                      <span className="text-[10px] text-zinc-600">{new Date(entry.transitionedAt).toLocaleTimeString()}</span>
                    )}
                  </div>
                  {entry.proof && <p className="text-xs text-zinc-500 mt-0.5 truncate">{typeof entry.proof === "string" ? entry.proof : JSON.stringify(entry.proof)}</p>}
                  {entry.reason && <p className="text-xs text-zinc-500 mt-0.5">{entry.reason}</p>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CycleDetail({ cycleId }) {
  const [reality, setReality] = useState(null);
  const [cycleReport, setCycleReport] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      apiFetch(`/cycle/${cycleId}/reality`).catch(() => null),
      apiFetch(`/cycle/report/${cycleId}`).catch(() => null),
    ]).then(([realityData, reportData]) => {
      if (cancelled) return;
      setReality(realityData);
      setCycleReport(reportData);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [cycleId]);

  if (loading) return <div className="mt-2 p-4 bg-zinc-800/30 rounded animate-pulse h-40" />;

  const r = reality;
  const agents = cycleReport?.agents || [];
  const costs = cycleReport?.costs || {};

  return (
    <div className="mt-2 bg-zinc-800/30 border border-zinc-800 rounded-lg p-4 space-y-4">
      {/* Task info */}
      {r?.task && (
        <div>
          <h4 className="text-xs font-semibold text-zinc-500 mb-2">Task</h4>
          <p className="text-sm text-zinc-200 font-medium">{r.task.title}</p>
          {r.task.description && <p className="text-xs text-zinc-400 mt-1">{r.task.description}</p>}
          <div className="flex flex-wrap gap-3 mt-2 text-xs">
            <span className="text-zinc-500">State: <span className={`font-medium ${
              r.task.finalState === "merged" ? "text-emerald-400" :
              r.task.finalState === "failed" ? "text-red-400" :
              r.task.finalState === "abandoned" ? "text-zinc-400" : "text-zinc-300"
            }`}>{r.task.finalState}</span></span>
            {r.task.anchorType && <span className="text-zinc-500">Anchor: <span className="text-zinc-300">{r.task.anchorType}</span></span>}
            {r.task.confidence && <span className="text-zinc-500">Confidence: <span className="text-zinc-300">{r.task.confidence}</span></span>}
            {r.task.risk && <span className="text-zinc-500">Risk: <span className={
              r.task.risk === "high" ? "text-red-400" : r.task.risk === "medium" ? "text-yellow-400" : "text-zinc-300"
            }>{r.task.risk}</span></span>}
          </div>
        </div>
      )}

      {/* Anchor */}
      {r?.anchor && (
        <div>
          <h4 className="text-xs font-semibold text-zinc-500 mb-1">Anchor</h4>
          <p className="text-xs text-zinc-300">{r.anchor.reference}</p>
          {r.anchor.whyNow && <p className="text-xs text-zinc-500 italic mt-0.5">{r.anchor.whyNow}</p>}
        </div>
      )}

      {/* Grounding before/after */}
      {r?.grounding && (
        <div>
          <h4 className="text-xs font-semibold text-zinc-500 mb-2">Grounding</h4>
          <div className="grid grid-cols-2 gap-4 text-xs">
            <div>
              <p className="text-zinc-600 mb-1">Before</p>
              <p className="text-zinc-300">{r.grounding.before?.passed ?? "?"} tests passing</p>
              <p className="text-zinc-300">Typecheck: {r.grounding.before?.typecheckClean ? "clean" : "errors"}</p>
            </div>
            <div>
              <p className="text-zinc-600 mb-1">After</p>
              <p className={r.grounding.after?.passed > r.grounding.before?.passed ? "text-emerald-400" :
                r.grounding.after?.passed < r.grounding.before?.passed ? "text-red-400" : "text-zinc-300"
              }>{r.grounding.after?.passed ?? "?"} tests passing</p>
              <p className={r.grounding.after?.typecheckClean ? "text-zinc-300" : "text-red-400"}>
                Typecheck: {r.grounding.after?.typecheckClean ? "clean" : "errors"}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Agent runs */}
      {agents.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-zinc-500 mb-2">Agent Runs</h4>
          <div className="space-y-1.5">
            {agents.map((agent, i) => (
              <div key={i} className="flex items-center justify-between text-xs bg-zinc-800/50 rounded px-3 py-1.5">
                <div className="flex items-center gap-2">
                  <span className={`font-medium ${AGENT_COLORS[agent.agent] || "text-zinc-300"}`}>{agent.agent}</span>
                  <StatusBadge status={agent.verdict || "completed"} />
                </div>
                <div className="flex items-center gap-3 text-zinc-500">
                  <span>{Math.round(agent.duration / 1000)}s</span>
                  {agent.costUsd != null && <span>${Number(agent.costUsd).toFixed(3)}</span>}
                </div>
              </div>
            ))}
          </div>
          {(costs.inputTokens > 0 || costs.outputTokens > 0) && (
            <p className="text-[10px] text-zinc-600 mt-1.5">
              Tokens: {costs.inputTokens?.toLocaleString()} in / {costs.outputTokens?.toLocaleString()} out
              {costs.cachedInputTokens > 0 && ` (${costs.cachedInputTokens?.toLocaleString()} cached)`}
            </p>
          )}
        </div>
      )}

      {/* Verification */}
      {r?.verification && (
        <div>
          <h4 className="text-xs font-semibold text-zinc-500 mb-2">Verification</h4>
          <div className="space-y-1">
            {(r.verification.steps || []).map((step, i) => (
              <div key={i} className="flex items-center gap-2 text-xs">
                <span className={`w-4 text-center ${step.passed ? "text-emerald-400" : "text-red-400"}`}>
                  {step.passed ? "\u2713" : "\u2717"}
                </span>
                <span className="text-zinc-300">{step.label}</span>
                {step.duration && <span className="text-zinc-600 ml-auto">{Math.round(step.duration / 1000)}s</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Scope reconciliation */}
      {r?.reconciliation && (
        <div>
          <h4 className="text-xs font-semibold text-zinc-500 mb-2">Scope Reconciliation</h4>
          <div className="text-xs">
            <span className={r.reconciliation.aligned ? "text-emerald-400" : "text-yellow-400"}>
              {r.reconciliation.aligned ? "Aligned" : "Drift detected"}
            </span>
            {r.reconciliation.scopeCreep?.length > 0 && (
              <div className="mt-1">
                <p className="text-zinc-600">Scope creep ({r.reconciliation.scopeCreep.length} files):</p>
                {r.reconciliation.scopeCreep.map((f, i) => (
                  <p key={i} className="text-yellow-400/70 font-mono pl-2">{f}</p>
                ))}
              </div>
            )}
            {r.reconciliation.scopeGap?.length > 0 && (
              <div className="mt-1">
                <p className="text-zinc-600">Scope gap ({r.reconciliation.scopeGap.length} files):</p>
                {r.reconciliation.scopeGap.map((f, i) => (
                  <p key={i} className="text-red-400/70 font-mono pl-2">{f}</p>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Mutation testing */}
      {r?.mutationTesting && r.mutationTesting.totalMutants > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-zinc-500 mb-1">Mutation Testing</h4>
          <p className="text-xs text-zinc-300">
            Kill rate: <span className={r.mutationTesting.killRate >= 80 ? "text-emerald-400" : r.mutationTesting.killRate >= 50 ? "text-yellow-400" : "text-red-400"}>
              {r.mutationTesting.killRate}%
            </span>
            <span className="text-zinc-600"> ({r.mutationTesting.killed}/{r.mutationTesting.totalMutants} mutants killed, {r.mutationTesting.survived} survived)</span>
          </p>
        </div>
      )}

      {/* Files changed */}
      {r?.filesChanged?.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-zinc-500 mb-1">Files Changed ({r.filesChanged.length})</h4>
          <div className="text-xs font-mono text-zinc-400 space-y-0.5 max-h-24 overflow-y-auto">
            {r.filesChanged.map((f, i) => <p key={i}>{f}</p>)}
          </div>
        </div>
      )}

      {/* Bottom row: commit, duration, risk, uncertainties */}
      <div className="flex flex-wrap gap-4 text-xs border-t border-zinc-800 pt-3">
        {r?.commitSha && (
          <span className="text-zinc-500">Commit: <span className="text-zinc-300 font-mono">{r.commitSha.slice(0, 10)}</span></span>
        )}
        {r?.durationMs && (
          <span className="text-zinc-500">Duration: <span className="text-zinc-300">{Math.round(r.durationMs / 1000)}s</span></span>
        )}
        {r?.rollbackRisk && (
          <span className="text-zinc-500">Rollback risk: <span className={
            r.rollbackRisk === "high" ? "text-red-400" : r.rollbackRisk === "medium" ? "text-yellow-400" : "text-emerald-400"
          }>{r.rollbackRisk}</span></span>
        )}
        {r?.regressionIntroduced && <span className="text-red-400 font-medium">Regression introduced</span>}
        {r?.rolledBack && <span className="text-red-400 font-medium">Rolled back</span>}
      </div>

      {/* Unresolved uncertainty */}
      {r?.unresolvedUncertainty?.length > 0 && (
        <div className="border-l-2 border-yellow-600/50 pl-3">
          <p className="text-xs text-yellow-500 font-medium mb-1">Unresolved Uncertainty</p>
          {r.unresolvedUncertainty.map((u, i) => (
            <p key={i} className="text-xs text-yellow-400/70">{u}</p>
          ))}
        </div>
      )}

      {/* Recommended next */}
      {r?.recommendedNext && (
        <div className="border-l-2 border-blue-600/50 pl-3">
          <p className="text-xs text-blue-500 font-medium mb-0.5">Recommended Next</p>
          <p className="text-xs text-blue-400/70">{r.recommendedNext}</p>
        </div>
      )}

      {/* No reality report fallback */}
      {!r && agents.length === 0 && (
        <p className="text-sm text-zinc-600 text-center py-4">No detailed data available for this cycle</p>
      )}
    </div>
  );
}

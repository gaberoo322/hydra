import { useApi, apiFetch } from "../hooks/useApi.js";
import { useEffect, useState } from "react";
import StatusBadge from "../components/StatusBadge.jsx";

const PIPELINE_STEPS = ["grounding", "planning", "skeptic", "execution", "verification", "merge", "reporting"];

const EVIDENCE_STATES = ["proposed", "approved", "in-progress", "changed-code", "verified", "merged", "failed", "abandoned", "blocked"];

const EVIDENCE_COLORS = {
  proposed: "bg-zinc-500",
  approved: "bg-blue-500",
  "in-progress": "bg-blue-400",
  "changed-code": "bg-purple-400",
  verified: "bg-emerald-400",
  merged: "bg-emerald-500",
  failed: "bg-red-500",
  abandoned: "bg-zinc-600",
  blocked: "bg-yellow-500",
};

// Issue #207 (Tier-3 OTel): build a deep-link to the operator's trace UI
// using the template returned by /observability/config. Mirrors the
// buildTraceUrl logic in src/codex-otel.ts so the link renders client-side
// without a round-trip per row.
function traceUrlFor(template, cycleId) {
  if (!template || !cycleId) return null;
  const encoded = encodeURIComponent(String(cycleId));
  if (template.includes("{cycleId}")) {
    return template.replace(/\{cycleId\}/g, encoded);
  }
  const sep = template.includes("?") ? "&" : "?";
  return `${template}${sep}hydra_cycle_id=${encoded}`;
}

export default function CycleStatus({ ws }) {
  const { data: current, refresh: refreshCurrent } = useApi("/cycle/status", { poll: 3000 });
  const { data: report } = useApi("/cycle/report", { poll: 5000 });
  const [historyLimit, setHistoryLimit] = useState(50);
  const { data: historyMetrics } = useApi(`/metrics?count=${historyLimit}`);
  const { data: tasks, refresh: refreshTasks } = useApi("/tasks", { poll: 5000 });
  // Issue #207: fetch operator-configured trace UI template once; cached for the page.
  const { data: obsConfig } = useApi("/observability/config");
  const traceTemplate = obsConfig?.traceUrlTemplate || null;
  const [selectedCycle, setSelectedCycle] = useState(null);
  const [selectedTaskId, setSelectedTaskId] = useState(null);

  useEffect(() => {
    return ws.subscribe("*", () => {
      refreshCurrent();
      refreshTasks();
    });
  }, [ws, refreshCurrent, refreshTasks]);

  const taskList = Array.isArray(tasks) ? tasks : tasks?.tasks || [];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Cycles</h1>

      {/* Current cycle pipeline */}
      {current?.cycleId && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-semibold text-zinc-400">Active Cycle</h2>
              <p className="font-mono text-xs text-zinc-500 mt-0.5">
                {current.cycleId}
                {/* Issue #207: Tier-3 OTel deep-link to the operator's trace UI. */}
                {traceUrlFor(traceTemplate, current.cycleId) && (
                  <a
                    href={traceUrlFor(traceTemplate, current.cycleId)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-2 text-blue-400 hover:text-blue-300 underline"
                    title="Open traces in the configured observability backend"
                  >
                    traces ↗
                  </a>
                )}
              </p>
            </div>
            <StatusBadge status={current.status || "running"} />
          </div>

          {/* Pipeline visualization */}
          <div className="flex items-center gap-1 mb-4">
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
            <div className="mt-4 space-y-2">
              {report.agents.map((agent, i) => (
                <div key={i} className="flex items-center justify-between text-sm bg-zinc-800/50 rounded px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="text-white font-medium">{agent.agent}</span>
                    <StatusBadge status={agent.verdict || "completed"} />
                  </div>
                  <div className="flex items-center gap-4 text-xs text-zinc-500">
                    <span>{Math.round(agent.duration / 1000)}s</span>
                    {agent.costUsd != null && <span>${agent.costUsd.toFixed(3)}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {!current?.cycleId && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-8 text-center">
          <p className="text-zinc-500">No active cycle</p>
        </div>
      )}

      {/* Tasks */}
      {taskList.length > 0 && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
          <h2 className="text-sm font-semibold text-zinc-400 mb-3">Tasks</h2>
          <div className="space-y-2">
            {taskList.map((task) => {
              const id = task.taskId || task.id;
              const isSelected = selectedTaskId === id;
              return (
                <div key={id}>
                  <button
                    onClick={() => setSelectedTaskId(isSelected ? null : id)}
                    className={`w-full flex items-center justify-between text-sm px-3 py-2.5 rounded transition-colors text-left ${
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
      )}

      {/* History */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
        {(() => {
          const cycles = historyMetrics?.trend || historyMetrics?.metrics || [];
          return (
            <>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-zinc-400">History ({cycles.length} cycles)</h2>
              </div>
              <div className="space-y-1">
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
                    ? `${m.testsBefore}→${m.testsAfter}`
                    : "";
                  return (
                    <button
                      key={m.cycleId}
                      onClick={() => setSelectedCycle(selectedCycle === m.cycleId ? null : m.cycleId)}
                      className="w-full flex items-center justify-between text-sm px-3 py-2 rounded hover:bg-zinc-800/50 transition-colors text-left gap-3"
                    >
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <StatusBadge status={status} />
                        <span className="text-zinc-300 truncate">{title}</span>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-zinc-600 shrink-0">
                        {m.anchorType && <span className="text-zinc-700">{m.anchorType}</span>}
                        {testDelta && <span className="text-emerald-700">{testDelta}</span>}
                        {dur && <span>{dur}</span>}
                        {/* Issue #207: per-row OTel deep-link, only rendered when configured. */}
                        {traceUrlFor(traceTemplate, m.cycleId) && (
                          <a
                            href={traceUrlFor(traceTemplate, m.cycleId)}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="text-blue-400 hover:text-blue-300 underline"
                            title="Open traces for this cycle in the configured observability backend"
                          >
                            traces ↗
                          </a>
                        )}
                        <span className="w-28 text-right">{time}</span>
                      </div>
                    </button>
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
            </>
          );
        })()}
      </div>
    </div>
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

  if (loading) {
    return <div className="mt-2 p-4 bg-zinc-800/30 rounded animate-pulse h-32" />;
  }

  if (!task) {
    return <div className="mt-2 p-4 bg-zinc-800/30 rounded text-sm text-zinc-600">No task data</div>;
  }

  const scope = typeof task.scopeBoundary === "string" ? JSON.parse(task.scopeBoundary || "{}") : (task.scopeBoundary || {});
  const plan = typeof task.verificationPlan === "string" ? JSON.parse(task.verificationPlan || "[]") : (task.verificationPlan || []);

  const evidenceEntries = evidence?.evidence || evidence || {};
  const timeline = EVIDENCE_STATES
    .filter((state) => evidenceEntries[state])
    .map((state) => ({ state, ...evidenceEntries[state] }));

  return (
    <div className="mt-2 bg-zinc-800/30 border border-zinc-800 rounded-lg p-4 animate-slide-in space-y-4">
      {/* Metadata */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        <div>
          <p className="text-zinc-600 mb-0.5">Anchor</p>
          <p className="text-zinc-300">{task.anchorType || "—"}</p>
        </div>
        <div>
          <p className="text-zinc-600 mb-0.5">Confidence</p>
          <p className="text-zinc-300">{task.confidence || "—"}</p>
        </div>
        <div>
          <p className="text-zinc-600 mb-0.5">Scope In</p>
          <p className="text-zinc-300">{scope.in ?? "—"} files</p>
        </div>
        <div>
          <p className="text-zinc-600 mb-0.5">Scope Out</p>
          <p className="text-zinc-300">{scope.out ?? "—"} files</p>
        </div>
      </div>

      {/* Why Now */}
      {task.whyNow && (
        <div className="border-l-2 border-zinc-700 pl-3">
          <p className="text-xs text-zinc-600 mb-0.5">Why now</p>
          <p className="text-sm text-zinc-400 italic">{task.whyNow}</p>
        </div>
      )}

      {/* Verification Plan */}
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

      {/* Evidence Timeline */}
      {timeline.length > 0 && (
        <div>
          <p className="text-xs text-zinc-600 mb-2">Evidence Chain</p>
          <div className="space-y-0">
            {timeline.map((entry, i) => (
              <div key={entry.state} className="flex gap-3">
                {/* Timeline line + dot */}
                <div className="flex flex-col items-center w-3 shrink-0">
                  <div className={`w-2.5 h-2.5 rounded-full ${EVIDENCE_COLORS[entry.state] || "bg-zinc-500"} shrink-0 mt-0.5`} />
                  {i < timeline.length - 1 && <div className="w-px flex-1 bg-zinc-700 my-0.5" />}
                </div>
                {/* Content */}
                <div className="pb-3 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-zinc-300">{entry.state}</span>
                    {entry.transitionedAt && (
                      <span className="text-[10px] text-zinc-600">
                        {new Date(entry.transitionedAt).toLocaleTimeString()}
                      </span>
                    )}
                  </div>
                  {entry.proof && (
                    <p className="text-xs text-zinc-500 mt-0.5 truncate">{typeof entry.proof === "string" ? entry.proof : JSON.stringify(entry.proof)}</p>
                  )}
                  {entry.reason && (
                    <p className="text-xs text-zinc-500 mt-0.5">{entry.reason}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

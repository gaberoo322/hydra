import { useState } from "react";
import { useApi } from "../hooks/useApi.js";
import StatusBadge from "../components/StatusBadge.jsx";

const BANNER_COLORS = {
  healthy: "bg-emerald-500/10 border-emerald-500/30",
  degraded: "bg-yellow-500/10 border-yellow-500/30",
  unhealthy: "bg-red-500/10 border-red-500/30",
  critical: "bg-red-500/20 border-red-500/50",
};
const BANNER_TEXT = {
  healthy: "text-emerald-400",
  degraded: "text-yellow-400",
  unhealthy: "text-red-400",
  critical: "text-red-300",
};
const BANNER_DOT = {
  healthy: "bg-emerald-400",
  degraded: "bg-yellow-400",
  unhealthy: "bg-red-400",
  critical: "bg-red-400 animate-pulse",
};
const DIAG_BORDER = {
  critical: "border-l-4 border-red-500 bg-red-500/5",
  error: "border-l-4 border-red-400 bg-red-400/5",
  warning: "border-l-4 border-yellow-400 bg-yellow-400/5",
  info: "border-l-4 border-blue-400 bg-blue-400/5",
};
const DIAG_DOT = {
  critical: "bg-red-500",
  error: "bg-red-400",
  warning: "bg-yellow-400",
  info: "bg-blue-400",
};

export default function Health() {
  const { data: deep, loading } = useApi("/health/deep", { poll: 10000 });
  const { data: grounding } = useApi("/grounding/latest", { poll: 30000 });

  if (loading && !deep) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">System Health</h1>
        <div className="bg-zinc-800/30 rounded-lg animate-pulse h-16" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[1, 2, 3, 4].map(i => <div key={i} className="bg-zinc-800/30 rounded-lg animate-pulse h-24" />)}
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          {[1, 2, 3, 4, 5, 6].map(i => <div key={i} className="bg-zinc-800/30 rounded-lg animate-pulse h-28" />)}
        </div>
      </div>
    );
  }

  const status = deep?.status || "healthy";
  const diagnostics = deep?.diagnostics || [];
  const svc = deep?.services || {};
  const pipe = deep?.pipeline || {};
  const infra = deep?.infrastructure || {};
  const intel = deep?.intelligence || {};
  const metrics = pipe.recentMetrics || {};

  const hasInfraDiag = diagnostics.some(d => ["disk", "memory", "infrastructure"].includes(d.component));
  const hasIntelDiag = diagnostics.some(d => ["intelligence", "openviking"].includes(d.component));

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">System Health</h1>

      {/* Health Banner */}
      <HealthBanner status={status} summary={deep?.summary} diagnostics={diagnostics} />

      {/* Active Cycle */}
      {deep?.activeCycle && <ActiveCycleCard cycle={deep.activeCycle} />}

      {/* Pipeline Health */}
      <div>
        <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">Pipeline</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Queue Depth" value={pipe.queueDepth ?? "?"} color={pipe.queueDepth === 0 && svc.scheduler?.status === "running" ? "text-yellow-400" : "text-white"} sub={pipe.priorFailures > 0 ? `${pipe.priorFailures} prior failures` : null} />
          <StatCard label="Merge Rate" value={`${metrics.mergeRate ?? "?"}%`} color={metrics.mergeRate >= 60 ? "text-emerald-400" : metrics.mergeRate >= 40 ? "text-yellow-400" : "text-red-400"} sub={`${metrics.cycleCount || 0} recent cycles`} />
          <StatCard label="No-Task Rate" value={`${metrics.noTaskRate ?? "?"}%`} color={metrics.noTaskRate <= 20 ? "text-emerald-400" : metrics.noTaskRate <= 40 ? "text-yellow-400" : "text-red-400"} sub="wasted cycles" />
          <StatCard label="Revert Rate" value={`${metrics.revertRate ?? "?"}%`} color={metrics.revertRate <= 5 ? "text-emerald-400" : metrics.revertRate <= 15 ? "text-yellow-400" : "text-red-400"} sub="of merges reverted" />
        </div>
      </div>

      {/* Services */}
      <div>
        <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">Services</h2>
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          <ServiceCard name="Orchestrator" port={4000} status={svc.orchestrator?.status} details={{ uptime: svc.orchestrator?.uptimeHuman, cycle: svc.orchestrator?.cycle || "idle" }} />
          <ServiceCard name="Redis" port={6379} status={svc.redis?.status} details={{
            ...(svc.redis?.memoryHuman ? { memory: svc.redis.memoryHuman } : {}),
            ...(svc.redis?.connectedClients != null ? { clients: svc.redis.connectedClients } : {}),
            ...(svc.redis?.uptimeSeconds ? { uptime: formatUptime(svc.redis.uptimeSeconds) } : {}),
          }} />
          <ServiceCard name="Scheduler" status={svc.scheduler?.status} details={{
            interval: svc.scheduler?.intervalHuman || "not set",
            cycles: `${svc.scheduler?.cyclesMerged || 0} merged / ${svc.scheduler?.cyclesRun || 0} run`,
            // Issue #232: surface the rolling N-cycle merge rate as the
            // operator-visible metric. Lifetime ratio is shown as a tooltip
            // on hover for audit context. Window size comes from the API so
            // the label updates if HYDRA_ROLLING_MERGE_RATE_WINDOW changes.
            ...(svc.scheduler?.mergeRate > 0 ? {
              [`Recent Merge Rate (${svc.scheduler?.mergeRateWindow ?? 50})`]: {
                value: `${svc.scheduler.mergeRate}%`,
                tooltip: `Rolling merge rate over the last ${svc.scheduler?.mergeRateCyclesInWindow ?? 0} cycles (window size ${svc.scheduler?.mergeRateWindow ?? 50}). Lifetime: ${svc.scheduler?.mergeRateLifetime ?? 0}% across ${svc.scheduler?.cyclesRun ?? 0} cycles — kept for audit only because historical regressions skew it (see issue #232).`,
              },
            } : {}),
            ...(svc.scheduler?.consecutiveErrors > 0 ? { errors: `${svc.scheduler.consecutiveErrors} consecutive` } : {}),
            ...(svc.scheduler?.lastError ? { "last error": svc.scheduler.lastError.slice(0, 80) } : {}),
            spend: `$${(svc.scheduler?.research?.dailySpendUsd || 0).toFixed(2)} / $${svc.scheduler?.research?.dailyCostCapUsd || 50}`,
          }} />
          <ServiceCard name="VikingDB" port={5000} status={svc.vikingdb?.status} details={svc.vikingdb?.latencyMs != null ? { latency: `${svc.vikingdb.latencyMs}ms` } : {}} />
          <ServiceCard name="OpenViking" port={1933} status={svc.openviking?.status} details={{
            ...(svc.openviking?.latencyMs != null ? { latency: `${svc.openviking.latencyMs}ms` } : {}),
          }} />
          <ServiceCard name="OpenAI Proxy" port={4001} status={svc.openaiProxy?.status} details={svc.openaiProxy?.latencyMs != null ? { latency: `${svc.openaiProxy.latencyMs}ms` } : {}} />
        </div>
      </div>

      {/* Infrastructure (collapsible) */}
      <CollapsibleSection title="Infrastructure" forceOpen={hasInfraDiag} defaultOpen={false}>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="space-y-2">
            <p className="text-xs font-semibold text-zinc-500">Disk (NVMe /)</p>
            <ProgressBar value={infra.disk?.usedPercent || 0} label={`${infra.disk?.availableGb || "?"}GB free of ${infra.disk?.totalGb || "?"}GB`} warn={85} crit={95} />
          </div>
          <div className="space-y-2">
            <p className="text-xs font-semibold text-zinc-500">Memory</p>
            <ProgressBar value={infra.memory?.usedPercent || 0} label={`${infra.memory?.availableGb || "?"}GB free of ${infra.memory?.totalGb || "?"}GB`} warn={85} crit={95} />
          </div>
          <div className="space-y-2">
            <p className="text-xs font-semibold text-zinc-500">Systemd</p>
            <div className="space-y-1">
              <SystemdRow name="Orchestrator" state={infra.systemd?.orchestrator} />
              <SystemdRow name="Watchdog" state={infra.systemd?.watchdog} />
              <SystemdRow name="Betting Web" state={infra.systemd?.bettingWeb} />
            </div>
          </div>
        </div>
      </CollapsibleSection>

      {/* Agent Intelligence (collapsible) */}
      <CollapsibleSection title="Agent Intelligence" forceOpen={hasIntelDiag} defaultOpen={false}>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <MiniStat label="Planner Patterns" value={intel.patterns?.planner ?? 0} />
          <MiniStat label="Executor Patterns" value={intel.patterns?.executor ?? 0} />
          <MiniStat label="Skeptic Patterns" value={intel.patterns?.skeptic ?? 0} />
          <MiniStat label="Active Reflections" value={intel.reflections ?? 0} />
        </div>
        <div className="mt-3 flex items-center gap-3 text-xs text-zinc-500">
          <span className={`w-2 h-2 rounded-full ${intel.ovSearch?.status === "running" ? "bg-emerald-400" : "bg-red-400"}`} />
          <span>OpenViking Search: {intel.ovSearch?.status === "running" ? `${intel.ovSearch.resultCount} results (${intel.ovSearch.latencyMs}ms)` : "unavailable"}</span>
        </div>
      </CollapsibleSection>

      {/* Grounding */}
      {grounding && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
          <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">Latest Grounding</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <p className="text-xs text-zinc-500">Tests Passed</p>
              <p className="text-white font-medium">{grounding.testReport?.passed ?? "?"}</p>
            </div>
            <div>
              <p className="text-xs text-zinc-500">Tests Failed</p>
              <p className={`font-medium ${grounding.testReport?.failed > 0 ? "text-red-400" : "text-white"}`}>
                {grounding.testReport?.failed ?? "?"}
              </p>
            </div>
            <div>
              <p className="text-xs text-zinc-500">Typecheck</p>
              <p className={`font-medium ${grounding.typecheckReport?.exitCode === 0 ? "text-emerald-400" : "text-red-400"}`}>
                {grounding.typecheckReport?.exitCode === 0 ? "Clean" : "Errors"}
              </p>
            </div>
            <div>
              <p className="text-xs text-zinc-500">Dirty Files</p>
              <p className="text-white font-medium">{grounding.dirtyFiles?.length ?? 0}</p>
            </div>
          </div>
        </div>
      )}

      {/* Diagnostics */}
      <div>
        <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">Diagnostics</h2>
        {diagnostics.length === 0 ? (
          <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-lg p-4 text-sm text-emerald-400">
            All systems healthy — no issues detected.
          </div>
        ) : (
          <div className="space-y-2">
            {diagnostics.map((d, i) => (
              <DiagnosticCard key={i} diag={d} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// --- Inline components ---

function HealthBanner({ status, summary, diagnostics }) {
  const counts = { critical: 0, error: 0, warning: 0, info: 0 };
  for (const d of diagnostics) counts[d.severity]++;
  const badges = [];
  if (counts.critical) badges.push(`${counts.critical} critical`);
  if (counts.error) badges.push(`${counts.error} error${counts.error > 1 ? "s" : ""}`);
  if (counts.warning) badges.push(`${counts.warning} warning${counts.warning > 1 ? "s" : ""}`);

  return (
    <div className={`rounded-lg border p-4 ${BANNER_COLORS[status] || BANNER_COLORS.healthy}`}>
      <div className="flex items-center gap-3">
        <span className={`w-3 h-3 rounded-full ${BANNER_DOT[status] || BANNER_DOT.healthy}`} />
        <span className={`text-lg font-bold uppercase ${BANNER_TEXT[status] || BANNER_TEXT.healthy}`}>
          {status}
        </span>
        {badges.length > 0 && (
          <span className="text-xs text-zinc-400 ml-2">{badges.join(", ")}</span>
        )}
      </div>
      {summary && <p className="text-sm text-zinc-300 mt-1 ml-6">{summary}</p>}
    </div>
  );
}

function ActiveCycleCard({ cycle }) {
  const task = cycle.tasks?.[0];
  return (
    <div className="bg-blue-500/5 border border-blue-500/20 rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
          <span className="text-sm font-semibold text-blue-400">Active Cycle</span>
          <span className="text-xs text-zinc-500 font-mono">{cycle.id}</span>
        </div>
        <span className="text-xs text-zinc-400">{cycle.durationHuman}</span>
      </div>
      {task && (
        <div className="ml-4">
          <p className="text-sm text-white">{task.title || "Planning..."}</p>
          <div className="flex items-center gap-2 mt-1">
            <StatusBadge status={task.state || "running"} />
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, color = "text-white", sub }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
      {sub && <p className="text-[10px] text-zinc-600 mt-0.5">{sub}</p>}
    </div>
  );
}

function ServiceCard({ name, port, status, details }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-sm font-semibold text-white">{name}</h3>
        <StatusBadge status={status || "pending"} />
      </div>
      {port && <p className="text-xs text-zinc-600 font-mono">:{port}</p>}
      {details && Object.keys(details).length > 0 && (
        <div className="mt-2 space-y-0.5">
          {Object.entries(details).map(([key, val]) => {
            // Support `{ value, tooltip }` shape so callers can attach
            // explanatory hover text to a single field (issue #232).
            const isObj = val && typeof val === "object" && "value" in val;
            const display = isObj ? String(val.value) : String(val);
            const tooltip = isObj ? val.tooltip : undefined;
            return (
              <p key={key} className="text-xs text-zinc-500" title={tooltip}>
                <span className="text-zinc-600">{key}:</span> {display}
                {tooltip && <span className="ml-1 text-zinc-700 cursor-help">ⓘ</span>}
              </p>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CollapsibleSection({ title, defaultOpen = false, forceOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  const isOpen = forceOpen || open;
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between p-4 text-left hover:bg-zinc-800/50 transition-colors rounded-lg"
      >
        <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">{title}</h2>
        <span className="text-xs text-zinc-600">{isOpen ? "collapse" : "expand"}</span>
      </button>
      {isOpen && <div className="px-4 pb-4 border-t border-zinc-800 pt-3">{children}</div>}
    </div>
  );
}

function ProgressBar({ value, label, warn = 80, crit = 95 }) {
  const color = value >= crit ? "bg-red-400" : value >= warn ? "bg-yellow-400" : "bg-emerald-400";
  return (
    <div>
      <div className="flex justify-between text-xs text-zinc-500 mb-1">
        <span>{label}</span>
        <span className={value >= crit ? "text-red-400" : value >= warn ? "text-yellow-400" : ""}>{value}%</span>
      </div>
      <div className="w-full h-2 bg-zinc-700 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(value, 100)}%` }} />
      </div>
    </div>
  );
}

function SystemdRow({ name, state }) {
  const dot = state === "active" ? "bg-emerald-400" : state === "inactive" ? "bg-zinc-500" : state === "failed" ? "bg-red-400" : "bg-zinc-600";
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
      <span className="text-zinc-400">{name}</span>
      <span className="text-zinc-600 ml-auto">{state || "unknown"}</span>
    </div>
  );
}

function MiniStat({ label, value }) {
  return (
    <div>
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="text-lg font-bold text-white">{value}</p>
    </div>
  );
}

function DiagnosticCard({ diag }) {
  return (
    <div className={`rounded-lg p-3 ${DIAG_BORDER[diag.severity] || DIAG_BORDER.info}`}>
      <div className="flex items-center gap-2 mb-1">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${DIAG_DOT[diag.severity] || DIAG_DOT.info}`} />
        <span className="text-xs font-mono text-zinc-500">{diag.component}</span>
        <span className="text-sm font-semibold text-white">{diag.what}</span>
        {diag.autoRecovery && (
          <span className="text-[10px] bg-zinc-700 text-zinc-400 px-1.5 py-0.5 rounded ml-auto">auto-recovery</span>
        )}
      </div>
      <p className="text-xs text-zinc-400 ml-4">{diag.why}</p>
      {diag.impact && <p className="text-xs text-zinc-500 ml-4 mt-1"><span className="text-zinc-600">Impact:</span> {diag.impact}</p>}
      {diag.action && <p className="text-xs text-zinc-500 ml-4"><span className="text-zinc-600">Action:</span> <span className="text-zinc-300">{diag.action}</span></p>}
    </div>
  );
}

function formatUptime(seconds) {
  if (!seconds) return "unknown";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

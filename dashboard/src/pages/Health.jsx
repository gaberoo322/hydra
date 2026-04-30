import { useApi } from "../hooks/useApi.js";
import StatusBadge from "../components/StatusBadge.jsx";

export default function Health() {
  const { data: health, loading } = useApi("/health", { poll: 10000 });
  const { data: scheduler } = useApi("/scheduler/status", { poll: 10000 });
  const { data: grounding } = useApi("/grounding/latest", { poll: 30000 });
  const { data: services } = useApi("/health/services", { poll: 30000 });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">System Health</h1>

      {/* Service status */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <ServiceCard
          name="Orchestrator"
          port={4000}
          status={health?.status === "ok" ? "running" : "failed"}
          details={health ? { uptime: formatUptime(health.uptime), cycle: health.cycle || "idle" } : null}
          loading={loading}
        />
        <ServiceCard
          name="Redis"
          port={6379}
          status={health?.redis ? "running" : "failed"}
          loading={loading}
        />
        <ServiceCard
          name="Scheduler"
          port={null}
          status={scheduler?.running ? "running" : "idle"}
          details={scheduler ? {
            interval: scheduler.intervalHuman || `${scheduler.intervalMs}ms`,
            cyclesRun: scheduler.cyclesRun,
            lastCycle: scheduler.lastCycleAt ? new Date(scheduler.lastCycleAt).toLocaleString() : "never",
          } : null}
        />
        <ServiceCard
          name="VikingDB"
          port={5000}
          status={services?.vikingdb?.status || "pending"}
          details={services?.vikingdb?.latencyMs != null ? { latency: `${services.vikingdb.latencyMs}ms` } : null}
        />
        <ServiceCard
          name="OpenViking"
          port={1933}
          status={services?.openviking?.status || "pending"}
          details={services?.openviking?.latencyMs != null ? { latency: `${services.openviking.latencyMs}ms` } : null}
        />
        <ServiceCard
          name="OpenAI Proxy"
          port={4001}
          status={services?.openaiProxy?.status || "pending"}
          details={services?.openaiProxy?.latencyMs != null ? { latency: `${services.openaiProxy.latencyMs}ms` } : null}
        />
      </div>

      {/* Latest grounding */}
      {grounding && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
          <h2 className="text-sm font-semibold text-zinc-400 mb-3">Latest Grounding</h2>
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
    </div>
  );
}

function ServiceCard({ name, port, status, details, loading }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-white">{name}</h3>
        {loading ? (
          <span className="text-xs text-zinc-600">...</span>
        ) : (
          <StatusBadge status={status} />
        )}
      </div>
      {port && <p className="text-xs text-zinc-600 font-mono">:{port}</p>}
      {details && (
        <div className="mt-2 space-y-0.5">
          {Object.entries(details).map(([key, val]) => (
            <p key={key} className="text-xs text-zinc-500">
              <span className="text-zinc-600">{key}:</span> {String(val)}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function formatUptime(seconds) {
  if (!seconds) return "unknown";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

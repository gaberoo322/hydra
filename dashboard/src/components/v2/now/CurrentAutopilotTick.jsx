import { useApi } from "../../../hooks/useApi.js";
import { Section } from "./Section.jsx";

function formatAge(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/**
 * CurrentAutopilotTick — scheduler + current autopilot run summary.
 *
 * Polls every 5s (PRD #615) — the operator wants near-real-time visibility
 * into whether the orchestrator is alive and what turn it's on.
 */
export function CurrentAutopilotTick() {
  const { data, error, loading } = useApi("/v2/now/autopilot-tick", { poll: 5_000 });
  const run = data?.currentRun;

  const subtitle = data
    ? data.running
      ? `Scheduler running · last tick ${data.lastTickAt ? new Date(data.lastTickAt).toLocaleTimeString() : "—"}`
      : "Scheduler stopped."
    : "Tick + current autopilot run.";

  return (
    <Section
      title="Autopilot tick"
      subtitle={subtitle}
      loading={loading}
      error={error}
      empty={!loading && !error && !run}
      emptyMessage="No active autopilot run."
    >
      {run && (
        <div className="space-y-2">
          <div className="flex items-baseline justify-between gap-3">
            <div className="min-w-0">
              <span className="font-mono text-sm text-zinc-100">{run.id}</span>
              <span className="ml-2 text-xs text-zinc-500">trigger: {run.trigger}</span>
            </div>
            <span className="text-xs text-zinc-500 shrink-0">
              {formatAge(run.elapsedSeconds)} elapsed
            </span>
          </div>
          <div className="grid grid-cols-3 gap-3 text-sm">
            <div>
              <div className="text-xs uppercase tracking-wide text-zinc-500">Turns</div>
              <div className="text-zinc-100 font-semibold">{run.turns}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-zinc-500">Dispatches</div>
              <div className="text-zinc-100 font-semibold">{run.dispatches}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-zinc-500">Last heartbeat</div>
              <div className="text-zinc-100 font-semibold">{formatAge(run.ageSeconds)} ago</div>
            </div>
          </div>
        </div>
      )}
    </Section>
  );
}

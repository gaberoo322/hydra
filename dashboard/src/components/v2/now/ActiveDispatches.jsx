import { useApi } from "../../../hooks/useApi.js";
import { Section } from "./Section.jsx";

const SOURCE_STYLES = {
  autopilot: "bg-sky-500/10 text-sky-300 border-sky-500/30",
  operator: "bg-amber-500/10 text-amber-300 border-amber-500/30",
};

function formatAge(startedAt) {
  if (!startedAt) return "";
  const startedMs = Date.parse(startedAt);
  if (!Number.isFinite(startedMs)) return "";
  const ageSec = Math.max(0, Math.floor((Date.now() - startedMs) / 1000));
  if (ageSec < 60) return `${ageSec}s`;
  if (ageSec < 3600) return `${Math.round(ageSec / 60)}m`;
  return `${Math.floor(ageSec / 3600)}h ${Math.round((ageSec % 3600) / 60)}m`;
}

/**
 * ActiveDispatches — every live Claude Code session known to the
 * orchestrator. Polls every 5s (PRD #615) so the operator can watch
 * sessions come and go.
 */
export function ActiveDispatches() {
  const { data, error, loading } = useApi("/v2/now/active-dispatches", { poll: 5_000 });
  const items = data?.items ?? [];

  return (
    <Section
      title="Active dispatches"
      subtitle="Every live Claude Code session — autopilot or operator."
      count={items.length}
      loading={loading}
      error={error}
      empty={!loading && !error && items.length === 0}
      emptyMessage="No dispatches running right now."
    >
      <ul className="divide-y divide-zinc-700/50">
        {items.map((item) => (
          <li key={item.id} className="py-2 flex items-center gap-3">
            <span
              className={`px-1.5 py-0.5 text-[10px] rounded border shrink-0 ${SOURCE_STYLES[item.source] || "bg-zinc-700/60 text-zinc-300 border-zinc-600"}`}
            >
              {item.source}
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-sm text-zinc-100 truncate">
                <span className="font-mono text-zinc-300 mr-2">{item.classLabel}</span>
                {item.currentStep && (
                  <span className="text-zinc-500 text-xs">· {item.currentStep}</span>
                )}
              </div>
              <div className="flex items-center gap-2 text-[11px] text-zinc-500 mt-0.5">
                <span className="font-mono truncate">{item.id}</span>
                {item.issueRef && <span>· issue {item.issueRef}</span>}
                {item.prRef && <span>· PR {item.prRef}</span>}
              </div>
            </div>
            <span className="text-xs text-zinc-500 shrink-0">{formatAge(item.startedAt)}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

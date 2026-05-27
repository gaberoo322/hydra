import { useApi } from "../../../hooks/useApi.js";
import { TabShell } from "./TabShell.jsx";

/**
 * ArchitectureTab — compact reshape of the existing `/api/architecture`
 * data. We don't re-render the SVG diagram (that lives on the legacy
 * `/architecture` page); instead we surface the per-group module counts
 * and the total edge count so the operator gets a sense of system shape
 * inside the Explore hub, with a deep-link to the full diagram.
 */
export function ArchitectureTab() {
  const { data, error, loading } = useApi("/architecture", { poll: 60_000 });
  const groups = data?.groups ?? [];
  const nodes = data?.nodes ?? [];
  const edges = data?.edges ?? [];
  const empty = !loading && !error && groups.length === 0;

  const subtitle = data
    ? `${data.moduleCount ?? nodes.length} modules · ${data.edgeCount ?? edges.length} edges · scanned ${data.scannedAt ? new Date(data.scannedAt).toLocaleTimeString() : ""}`
    : "Per-group module + edge counts from the orchestrator source graph.";

  const groupCounts = groups.map((g) => ({
    ...g,
    moduleCount: nodes.filter((n) => n.groupId === g.id || n.group === g.id).length,
  }));

  // The legacy `/architecture` top-level route was retired in slice 6
  // (issue #621). The Architecture tab is the only remaining surface.
  const actions = null;

  return (
    <TabShell
      title="Architecture"
      subtitle={subtitle}
      loading={loading}
      error={error}
      empty={empty}
      emptyMessage="No architecture data available."
      actions={actions}
    >
      <ul className="divide-y divide-zinc-700/50">
        {groupCounts.map((g) => (
          <li key={g.id} className="py-1.5 flex items-center gap-3">
            <span className="text-sm text-zinc-100 shrink-0 w-44 truncate">{g.label}</span>
            <span className="text-xs text-zinc-500 shrink-0 w-24">{g.id}</span>
            <span className="flex-1 text-xs text-zinc-500">color: {g.color}</span>
            <span className="text-xs text-amber-300 font-mono shrink-0">
              {g.moduleCount} modules
            </span>
          </li>
        ))}
      </ul>
    </TabShell>
  );
}

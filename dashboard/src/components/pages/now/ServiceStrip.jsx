import { useApi } from "../../../hooks/useApi.js";

/**
 * Health strip — pinned to the top of the Now page. Polls every 15s
 * (PRD #615). Renders as a horizontal row of small chips, one per
 * service. The first question every morning is "is anything red?";
 * the strip answers it without scrolling.
 */
const STATUS_STYLES = {
  ok: {
    chip: "bg-emerald-500/10 text-emerald-300 border border-emerald-500/30",
    dot: "bg-emerald-400",
  },
  degraded: {
    chip: "bg-yellow-500/10 text-yellow-300 border border-yellow-500/30",
    dot: "bg-yellow-400",
  },
  down: {
    chip: "bg-red-500/10 text-red-300 border border-red-500/30",
    dot: "bg-red-400 animate-pulse",
  },
};

function ServiceChip({ row }) {
  const style = STATUS_STYLES[row.status] ?? STATUS_STYLES.down;
  const label = row.latencyMs !== undefined && row.status !== "down"
    ? `${row.service} · ${row.latencyMs}ms`
    : row.service;
  return (
    <div
      className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs whitespace-nowrap ${style.chip}`}
      title={row.lastError || `${row.service}: ${row.status}`}
    >
      <span className={`w-2 h-2 rounded-full ${style.dot}`} />
      <span className="font-medium">{label}</span>
      {row.status === "down" && row.lastError && (
        <span className="text-[10px] opacity-80 truncate max-w-[12rem]">{row.lastError}</span>
      )}
    </div>
  );
}

export function ServiceStrip() {
  const { data, error, loading } = useApi("/now/service-strip", { poll: 15_000 });
  const rows = data?.rows ?? [];

  return (
    <div className="sticky top-0 z-10 -mx-4 px-4 py-3 bg-zinc-900/95 backdrop-blur border-b border-zinc-800">
      {loading && !data && (
        <div className="h-9 bg-zinc-800/30 rounded animate-pulse" />
      )}
      {error && (
        <div className="text-xs text-red-300 font-mono">Health strip error: {error}</div>
      )}
      {!error && rows.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {rows.map((row) => (
            <ServiceChip key={row.service} row={row} />
          ))}
          {data?.generatedAt && (
            <span className="ml-auto text-[10px] text-zinc-500">
              checked {new Date(data.generatedAt).toLocaleTimeString()}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

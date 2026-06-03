import { useApi } from "../../hooks/useApi.js";

/**
 * RunHistoryStrip — recent-runs trend strip (issue #891, now-console-4).
 *
 * Renders the last N runs from /api/autopilot/runs with
 * merged/failed/term_reason/duration, so the operator can see the recent
 * shape of autopilot behaviour at a glance (the slice-3 stuck signals are
 * derived from this same window).
 */

const STATUS_DOT = {
  running: "bg-emerald-400 animate-pulse",
  ended: "bg-sky-400",
  killed: "bg-rose-400",
  crashed: "bg-rose-400",
};

function formatDuration(s) {
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 3600) return `${(n / 3600).toFixed(1)}h`;
  if (n >= 60) return `${Math.round(n / 60)}m`;
  return `${Math.round(n)}s`;
}

export default function RunHistoryStrip() {
  const { data, loading } = useApi("/autopilot/runs?limit=8", { poll: 30_000 });
  const runs = Array.isArray(data?.runs) ? data.runs : [];

  return (
    <section
      data-testid="run-history-strip"
      className="rounded-lg border border-zinc-800 bg-zinc-950 p-4"
    >
      <h2 className="text-sm font-semibold text-zinc-200 mb-2">Recent runs</h2>
      {loading && !data ? (
        <p className="text-xs text-zinc-500 italic">Loading run history…</p>
      ) : runs.length === 0 ? (
        <p data-testid="run-history-empty" className="text-xs text-zinc-500 italic">
          No runs recorded yet.
        </p>
      ) : (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {runs.map((r) => {
            const dot = STATUS_DOT[String(r.status)] ?? "bg-zinc-500";
            return (
              <div
                key={r.run_id}
                data-testid="run-history-cell"
                data-status={r.status}
                className="shrink-0 rounded border border-zinc-800 bg-zinc-900/50 px-2 py-1.5 min-w-[120px]"
                title={`${r.run_id}${r.term_reason ? ` · ${r.term_reason}` : ""}`}
              >
                <div className="flex items-center gap-1.5 mb-1">
                  <span className={`inline-block h-2 w-2 rounded-full ${dot}`} aria-hidden />
                  <span className="text-[10px] font-mono text-zinc-400">{r.status}</span>
                </div>
                <div className="text-[10px] font-mono text-zinc-300">
                  <span className="text-emerald-400">{r.merged_count ?? 0}✓</span>{" "}
                  <span className="text-rose-400">{r.failed_count ?? 0}✗</span>{" "}
                  <span className="text-zinc-500">{formatDuration(r.duration_s)}</span>
                </div>
                {r.term_reason && (
                  <div className="text-[9px] text-zinc-500 truncate mt-0.5">{r.term_reason}</div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

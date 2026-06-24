import { useEffect, useState } from "react";
import { useApi } from "../../hooks/useApi.js";
import { formatTokens } from "./console-state.ts";
import { formatRelativeTime } from "../now-pixel/oak-tab-state.ts";

/**
 * RunHistoryStrip — recent-runs trend strip (issue #891, now-console-4;
 * enriched + clickable in issue #2410, parent #2408).
 *
 * Renders the last N runs from /api/autopilot/runs with
 * merged/failed/term_reason/duration plus relative start time, trigger, and
 * tokens burned, so the operator can see the recent shape of autopilot
 * behaviour at a glance (the slice-3 stuck signals are derived from this same
 * window). Each cell is a keyboard-accessible button that opens a
 * RunDetailDrawer for its run_id via the `onSelect` callback owned by
 * NowConsole.
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

export default function RunHistoryStrip({ onSelect }) {
  const { data, loading } = useApi("/autopilot/runs?limit=8", { poll: 30_000 });
  const runs = Array.isArray(data?.runs) ? data.runs : [];

  // A ticking "now" keeps the relative start times honest without re-fetching.
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(t);
  }, []);

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
            const rel = formatRelativeTime(r.started_epoch, nowSec);
            return (
              <button
                type="button"
                key={r.run_id}
                data-testid="run-history-cell"
                data-status={r.status}
                onClick={() => onSelect?.(r.run_id)}
                title={`${r.run_id}${r.term_reason ? ` · ${r.term_reason}` : ""}`}
                className="shrink-0 rounded border border-zinc-800 bg-zinc-900/50 px-2 py-1.5 min-w-[120px] text-left cursor-pointer hover:border-zinc-600 focus:outline-none focus:ring-1 focus:ring-sky-500"
              >
                <div className="flex items-center gap-1.5 mb-1">
                  <span className={`inline-block h-2 w-2 rounded-full ${dot}`} aria-hidden />
                  <span className="text-[10px] font-mono text-zinc-400">{r.status}</span>
                  {rel && <span className="text-[9px] text-zinc-500 ml-auto">{rel}</span>}
                </div>
                <div className="text-[10px] font-mono text-zinc-300">
                  <span className="text-emerald-400">{r.merged_count ?? 0}✓</span>{" "}
                  <span className="text-rose-400">{r.failed_count ?? 0}✗</span>{" "}
                  <span className="text-zinc-500">{formatDuration(r.duration_s)}</span>
                </div>
                <div className="text-[9px] text-zinc-500 truncate mt-0.5">
                  {r.trigger ?? "manual"} · {formatTokens(r.total_tokens)} tok
                </div>
                {r.term_reason && (
                  <div className="text-[9px] text-zinc-500 truncate mt-0.5">{r.term_reason}</div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

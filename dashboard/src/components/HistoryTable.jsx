import { Link } from "react-router-dom";
import { useApi } from "../hooks/useApi.js";
import { StatusPillSmall } from "./AutopilotAtoms.jsx";
import { formatElapsed, formatTokens, relativeTime } from "../lib/autopilot-format.js";

// Slice 4 of epic #496 (issue #500) — previous-runs table. Extracted from
// dashboard/src/pages/Autopilot.jsx (issue #3589) into its own focused module
// so its /autopilot/runs poll is independently visible and modifiable without
// risking the turn timeline. Behavior is identical to the inline original.
//
// Last 14 runs from /api/autopilot/runs, polled every 60s. Row click
// navigates to /autopilot/:runId for the detail page. "see cycles" link
// scopes the /metrics view to cycles whose autopilotTurnId starts with
// "<runId>:".

export default function HistoryTable() {
  const { data, error, loading } = useApi("/autopilot/runs", { poll: 60000 });
  const runs = Array.isArray(data?.runs) ? data.runs : [];

  return (
    <div className="border border-zinc-800 rounded-lg p-5 bg-zinc-900/40 space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-base font-semibold text-zinc-100">Previous runs</h2>
        <span className="text-[10px] uppercase tracking-widest text-zinc-500">
          last {runs.length} · polls every 60s
        </span>
      </div>
      {loading && !data && (
        <div className="text-sm text-zinc-500">Loading…</div>
      )}
      {error && (
        <div className="text-xs text-red-400 font-mono">{error}</div>
      )}
      {!loading && !error && runs.length === 0 && (
        <div className="text-sm text-zinc-500 italic">
          No previous runs recorded. The first row appears at the next bootstrap.
        </div>
      )}
      {runs.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-zinc-500 text-[10px] uppercase tracking-widest border-b border-zinc-800">
                <th className="text-left py-2 pr-3 font-semibold">Started</th>
                <th className="text-left py-2 pr-3 font-semibold">Duration</th>
                <th className="text-left py-2 pr-3 font-semibold">Status</th>
                <th className="text-left py-2 pr-3 font-semibold">Term</th>
                <th className="text-left py-2 pr-3 font-semibold">Trigger</th>
                <th className="text-right py-2 pr-3 font-semibold">Turns</th>
                <th className="text-right py-2 pr-3 font-semibold">Disp (M/F)</th>
                <th className="text-right py-2 pr-3 font-semibold">Tokens</th>
                <th className="text-right py-2 pr-1 font-semibold">Cycles</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr
                  key={r.run_id}
                  className="border-b border-zinc-800/40 hover:bg-zinc-800/30 transition-colors"
                >
                  <td className="py-2 pr-3">
                    <Link
                      to={`/autopilot/${encodeURIComponent(r.run_id)}`}
                      className="text-zinc-300 hover:text-emerald-300"
                      title={r.started}
                    >
                      {relativeTime(r.started_epoch)}
                    </Link>
                  </td>
                  <td className="py-2 pr-3 font-mono text-zinc-400">
                    {r.duration_s !== null && r.duration_s !== undefined ? formatElapsed(r.duration_s) : "—"}
                  </td>
                  <td className="py-2 pr-3">
                    <StatusPillSmall row={r} />
                  </td>
                  <td className="py-2 pr-3 text-zinc-400">{r.term_reason || "—"}</td>
                  <td className="py-2 pr-3 text-zinc-400">{r.trigger || "—"}</td>
                  <td className="py-2 pr-3 text-right font-mono text-zinc-300">{r.turns}</td>
                  <td className="py-2 pr-3 text-right font-mono text-zinc-300">
                    {r.dispatches}{" "}
                    <span className="text-[10px] text-zinc-500">
                      ({r.merged_count}/{r.failed_count})
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-right font-mono text-zinc-300">
                    {formatTokens(r.total_tokens)}
                  </td>
                  <td className="py-2 pr-1 text-right">
                    <Link
                      to={`/metrics?run=${encodeURIComponent(r.run_id)}`}
                      className="text-[10px] text-blue-400 hover:underline"
                    >
                      see cycles
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

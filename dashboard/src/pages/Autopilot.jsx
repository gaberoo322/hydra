import { Link, useParams } from "react-router-dom";
import { useApi } from "../hooks/useApi.js";
import RunView from "../components/RunView.jsx";
import HistoryTable from "../components/HistoryTable.jsx";

// Slice 1 of epic #496 — "Is it alive?" header strip.
// Slice 2 of epic #496 (issue #498) — pipeline snapshot + turn timeline.
// Slice 3 of epic #496 (issue #499) — "Why did that crash?" log tail + journal.
// Slice 4 of epic #496 (issue #500) — previous runs + token budget +
// cross-links (the USD cost breakdown was retired in #1651).
// Dashboard v2 atomic swap (issue #621) removed the LIVE list
// route at `/autopilot`; the live view now lives on the Now page. Only the
// per-run DETAIL route at `/autopilot/:runId` remains — one-shot fetch of
// /api/autopilot/runs/:runId, frozen (non-polling) mode.
//
// Decomposed by architecture-scan (issue #3589): the run-view display
// components were extracted into focused modules —
//   - components/RunView.jsx        (header + pipeline + timeline + logs shell)
//   - components/PipelineSnapshot.jsx, TurnTimeline.jsx, LogsSection.jsx,
//     HistoryTable.jsx, AutopilotAtoms.jsx (display atoms)
//   - hooks/useTaxonomy.js          (dispatch-class alphabet hook)
//   - lib/autopilot-format.js       (pure formatting utilities + STATUS_STYLES)
// This file is now the routing shell: AutopilotLive, AutopilotDetail, and the
// default export.

// ---------------------------------------------------------------------------
// LIVE page mounted at `/autopilot`.
// ---------------------------------------------------------------------------

function AutopilotLive() {
  const { data, error, loading } = useApi("/autopilot/runs/current", { poll: 5000 });

  if (loading && !data) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-white mb-4">Autopilot</h1>
        <div className="text-zinc-500 text-sm">Loading…</div>
      </div>
    );
  }

  // 404 (no run yet) bubbles up as `error`. Friendly empty state — but we
  // STILL render the history table below in case prior runs exist with
  // expired live-row TTLs.
  const isNoRun = error && /404|no autopilot runs/i.test(error);

  if (error || !data) {
    return (
      <div className="p-6 space-y-5">
        <div>
          <div className="flex items-baseline justify-between mb-1">
            <h1 className="text-2xl font-bold text-white">Autopilot</h1>
          </div>
          <p className="text-sm text-zinc-500">Header · pipeline · timeline · logs · history.</p>
        </div>
        <div className="border border-zinc-800 rounded-lg p-6 bg-zinc-900/50">
          {isNoRun ? (
            <>
              <h2 className="text-base font-semibold text-zinc-200 mb-1">No autopilot run recorded yet</h2>
              <p className="text-sm text-zinc-500">
                The first row appears when bootstrap.sh runs at the start of the next
                <code className="mx-1 px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 font-mono text-xs">hydra-autopilot</code>
                invocation.
              </p>
            </>
          ) : (
            <>
              <h2 className="text-base font-semibold text-red-400 mb-1">Failed to load run</h2>
              <p className="text-sm text-zinc-500 font-mono">{error}</p>
            </>
          )}
        </div>
        <HistoryTable />
      </div>
    );
  }

  const run = data;
  const turns = Array.isArray(run.turns) ? run.turns : [];

  return (
    <div className="p-6 space-y-5">
      <div>
        <div className="flex items-baseline justify-between mb-1">
          <h1 className="text-2xl font-bold text-white">Autopilot</h1>
          <span className="text-xs text-zinc-500 font-mono">polls every 5s</span>
        </div>
        <p className="text-sm text-zinc-500">Header · pipeline · timeline · logs · history.</p>
      </div>
      <RunView run={run} turns={turns} mode="live" />
      <HistoryTable />
    </div>
  );
}

// ---------------------------------------------------------------------------
// DETAIL page mounted at `/autopilot/:runId`. One-shot fetch (no polling) —
// the run is terminal by definition. If you land here while a run is still
// going, the data is just a snapshot.
// ---------------------------------------------------------------------------

function AutopilotDetail({ runId }) {
  const { data, error, loading } = useApi(`/autopilot/runs/${encodeURIComponent(runId)}`);

  if (loading && !data) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-white mb-4">Autopilot run</h1>
        <div className="text-zinc-500 text-sm">Loading…</div>
      </div>
    );
  }

  if (error || !data) {
    const is404 = error && /404|unknown run_id/i.test(error);
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-white mb-2">Autopilot run</h1>
        <p className="text-sm text-zinc-500 mb-6">
          <Link to="/now" className="text-blue-400 hover:underline">← Back to Now</Link>
        </p>
        <div className="border border-zinc-800 rounded-lg p-6 bg-zinc-900/50">
          {is404 ? (
            <>
              <h2 className="text-base font-semibold text-zinc-200 mb-1">Run not found</h2>
              <p className="text-sm text-zinc-500">
                Run <code className="font-mono">{runId}</code> is not in Redis. Records expire after 7 days.
              </p>
            </>
          ) : (
            <>
              <h2 className="text-base font-semibold text-red-400 mb-1">Failed to load run</h2>
              <p className="text-sm text-zinc-500 font-mono">{error}</p>
            </>
          )}
        </div>
      </div>
    );
  }

  const run = data.run;
  const turns = Array.isArray(data.turns) ? data.turns : [];

  return (
    <div className="p-6 space-y-5">
      <div>
        <div className="flex items-baseline justify-between mb-1">
          <h1 className="text-2xl font-bold text-white">Autopilot run</h1>
          <Link to="/now" className="text-xs text-blue-400 hover:underline">← Back to Now</Link>
        </div>
        <p className="text-sm text-zinc-500">
          Detail view
        </p>
      </div>
      <RunView run={run} turns={turns} mode="detail" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Default export is the per-run detail page. The legacy `/autopilot` live
// list route was retired in slice 6 (issue #621); AutopilotLive is kept in
// this file (rather than deleted) because its sub-components (RunView,
// LogsSection, JournalPanel, history table) are still consumed by the
// detail view. If a runId is somehow missing we fall back to AutopilotLive
// for diagnostics, but this path is no longer mounted in App.jsx.
// ---------------------------------------------------------------------------

export default function Autopilot() {
  const params = useParams();
  const runId = params?.runId;
  return runId ? <AutopilotDetail runId={runId} /> : <AutopilotLive />;
}

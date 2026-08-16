import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useApi } from "../hooks/useApi.js";
import RunView from "../components/RunView.jsx";
import HistoryTable from "../components/HistoryTable.jsx";
import { classifyRunOutcome } from "../components/pages/runs/runs-state.js";

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
// DETAIL page mounted at `/runs/:runId` (issue #4009 — the /runs forensics
// spine's level two). One-shot fetch (no polling) — the run is terminal by
// definition. If you land here while a run is still going, the data is just
// a snapshot. The legacy `/autopilot/:runId` deep link redirects here
// (App.jsx).
// ---------------------------------------------------------------------------

/**
 * FailureNextSteps — resume and re-dispatch presented as the two DISTINCT,
 * separately labelled operations they are (issue #4009 / ADR-0034 §2,
 * n8n's "retry with the currently saved workflow" distinction). Resume
 * continues the SAME session and keeps its spent tokens; re-dispatch starts
 * a fresh agent on the anchor and re-pays the investigation cost. Collapsing
 * them into one "retry" button is exactly how the wrong one gets clicked.
 *
 * Read-only by design in this slice: no resume/reap write route exists
 * anywhere in the API yet (verified by grep), and wiring one is a
 * deliberately-rejected alternative (design-concept a4cc4156) — the
 * controls surface the operator command each operation maps to instead.
 */
function FailureNextSteps({ run }) {
  const [open, setOpen] = useState(null); // "resume" | "redispatch" | null
  const toggle = (which) => setOpen((cur) => (cur === which ? null : which));
  const base =
    "w-full text-left rounded-md border px-3 py-2.5 transition-colors space-y-1";
  return (
    <section data-testid="failure-next-steps" className="border border-zinc-800 rounded-lg p-5 bg-zinc-900/40 space-y-3">
      <h2 className="text-base font-semibold text-zinc-100">This run failed — two distinct next steps</h2>
      <p className="text-xs text-zinc-500">
        These are two different operations with different costs, never one overloaded retry button.
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        <button
          type="button"
          data-testid="resume-session"
          aria-expanded={open === "resume"}
          onClick={() => toggle("resume")}
          className={`${base} border-emerald-500/40 hover:bg-emerald-500/10`}
        >
          <span className="text-sm font-semibold text-emerald-300">Resume the stalled session</span>
          <span className="block text-xs text-zinc-400">
            Continue the SAME agent session — its context and already-spent tokens are kept. Use when the
            agent stopped mid-flight (stall, backgrounded wait, session cut).
          </span>
          {open === "resume" && (
            <span className="block text-[11px] text-zinc-500 font-mono break-all pt-1">
              no live write route yet — resume via the harness session (SendMessage to the session id, or
              relabel the anchor needs-dev-resume so the autopilot resumes instead of re-dispatching)
            </span>
          )}
        </button>
        <button
          type="button"
          data-testid="re-dispatch"
          aria-expanded={open === "redispatch"}
          onClick={() => toggle("redispatch")}
          className={`${base} border-violet-500/40 hover:bg-violet-500/10`}
        >
          <span className="text-sm font-semibold text-violet-300">Re-dispatch from scratch</span>
          <span className="block text-xs text-zinc-400">
            Start a FRESH agent on the same anchor. The prior attempt's tokens are sunk; this pays the
            investigation cost again. Use when the session or its worktree is unrecoverable.
          </span>
          {open === "redispatch" && (
            <span className="block text-[11px] text-zinc-500 font-mono break-all pt-1">
              no live write route yet — re-dispatch by returning the anchor to ready-for-agent (via gh api
              …/labels, not gh pr edit) and letting the autopilot pick it up
            </span>
          )}
        </button>
      </div>
      <p className="text-[11px] text-zinc-600">
        run_id {run.run_id} · term_reason {run.term_reason || "—"}
      </p>
    </section>
  );
}

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
          <Link to="/runs" className="text-blue-400 hover:underline">← Back to Runs</Link>
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
  // A failed run lands on its failing turn (INV-4) and gets the distinct
  // resume / re-dispatch next steps (INV-6). classifyRunOutcome is the same
  // closed-set classifier the /runs list uses, so the list's failure chip
  // and this landing behavior can never disagree.
  const outcome = classifyRunOutcome(
    run.status,
    typeof run.exit_code === "number" ? run.exit_code : null,
    typeof run.term_reason === "string" ? run.term_reason : null,
  );
  const runFailed = outcome === "failure";

  return (
    <div className="p-6 space-y-5">
      <div>
        <div className="flex items-baseline justify-between mb-1">
          <h1 className="text-2xl font-bold text-white">Autopilot run</h1>
          <Link to="/runs" className="text-xs text-blue-400 hover:underline">← Back to Runs</Link>
        </div>
        <p className="text-sm text-zinc-500">
          Detail view · outcome: <span className={runFailed ? "text-red-400" : "text-zinc-400"}>{outcome}</span>
        </p>
      </div>
      <RunView run={run} turns={turns} mode="detail" focusFailingTurn={runFailed} />
      {runFailed && <FailureNextSteps run={run} />}
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

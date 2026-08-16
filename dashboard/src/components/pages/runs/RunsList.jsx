import { useState } from "react";
import { Link } from "react-router-dom";
import { usePageItems } from "../../../hooks/usePageItems.js";
import LocalTimestamp from "../../LocalTimestamp.jsx";
import { classifyRunOutcome, formatRunDuration } from "./runs-state.js";

/**
 * RunsList — the list-level entry point of the forensics drill-down spine
 * (issue #4009, ADR-0034 §2): runs list → run → dispatch → transcript.
 *
 * Data: GET /autopilot/runs (raw run digests) — the list source the ADR
 * names for /runs, with the generatedAt field this slice adds server-side.
 * Outcome chips / the outcome filter are the content absorbed from the
 * retired Explore › Behavior tab, re-derived client-side through
 * runs-state.js's classifyRunOutcome so /runs and /explore/behavior can
 * never disagree.
 *
 * Trust seam (slice alpha #4006, ADR-0034 §5): the whole
 * loading/unknown/stale/empty/ready state machine is delegated to
 * usePageItems — this component re-implements no loading/error/empty
 * ternary of its own. An unproven list renders UNKNOWN, not a hopeful
 * table; an aged or failed-refresh payload keeps its rows but demotes the
 * as-of marker to amber. The as-of age is always visible.
 *
 * Anti-scope (ADR-0034 §2): no aggregate trends — every column here is a
 * per-run observed value, nothing is rolled up.
 */

const OUTCOME_FILTERS = ["", "failure", "in-progress", "success", "aborted"];

const OUTCOME_STYLE = {
  success: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
  failure: "bg-red-500/10 text-red-300 border-red-500/30",
  aborted: "bg-zinc-500/10 text-zinc-300 border-zinc-500/30",
  "in-progress": "bg-sky-500/10 text-sky-300 border-sky-500/30",
  unknown: "bg-zinc-500/10 text-zinc-400 border-zinc-500/30",
};

function OutcomeChip({ outcome }) {
  const style = OUTCOME_STYLE[outcome] || OUTCOME_STYLE.unknown;
  return (
    <span
      data-testid={`run-outcome-${outcome}`}
      className={`text-[10px] uppercase px-1.5 py-0.5 rounded border shrink-0 ${style}`}
    >
      {outcome}
    </span>
  );
}

function RunRow({ run }) {
  const runId = typeof run.run_id === "string" ? run.run_id : "";
  if (!runId) return null;
  const outcome = classifyRunOutcome(
    run.status,
    typeof run.exit_code === "number" ? run.exit_code : null,
    typeof run.term_reason === "string" ? run.term_reason : null,
  );
  return (
    <li className="py-2 flex items-center gap-3" data-testid="runs-list-row">
      <Link
        to={`/runs/${runId}`}
        data-testid="runs-list-detail-link"
        className="text-zinc-100 hover:text-amber-300 font-mono text-xs shrink-0 w-32 truncate"
        title={runId}
      >
        {runId.slice(0, 8)}
      </Link>
      <OutcomeChip outcome={outcome} />
      {/* Attribution: what fired this run (the digest's `trigger`). */}
      <span
        className="text-xs text-zinc-400 shrink-0 w-20 truncate"
        title={run.trigger}
        data-testid="runs-list-trigger"
      >
        {run.trigger || "—"}
      </span>
      <LocalTimestamp ts={run.started} className="text-xs text-zinc-400 font-mono shrink-0" />
      <span className="text-xs text-zinc-300 shrink-0 w-12 font-mono text-right">
        {formatRunDuration(run.duration_s)}
      </span>
      <span className="text-xs text-zinc-300 shrink-0 w-20 font-mono text-right">
        {run.merged_count}m/{run.failed_count}f
      </span>
      <span className="text-xs text-zinc-500 shrink-0 w-24 font-mono text-right">
        {run.turns}t/{run.dispatches}d
      </span>
      <span className="flex-1 min-w-0 text-xs text-zinc-500 truncate" title={run.term_reason || ""}>
        {run.term_reason || (run.status === "running" ? "" : "—")}
      </span>
    </li>
  );
}

export default function RunsList() {
  // The absorbed Behavior-tab outcome filter, evaluated client-side over the
  // fetched digests (usePageItems's `filter` option — no second fetch).
  const [outcome, setOutcome] = useState("");

  const { items, data, status } = usePageItems("/autopilot/runs?limit=50", {
    itemsKey: "runs",
    filter: outcome
      ? (run) =>
          classifyRunOutcome(
            run.status,
            typeof run.exit_code === "number" ? run.exit_code : null,
            typeof run.term_reason === "string" ? run.term_reason : null,
          ) === outcome
      : undefined,
    // Forensics is an activity-tier surface: ~1h freshness budget (ADR-0034
    // §5). An idle-but-healthy autopilot with an older last run honestly
    // reads as stale context, never as a current value.
    freshnessMs: 60 * 60 * 1000,
    poll: 30_000,
  });

  const unknown = status === "loading" || status === "unknown";
  const stale = status === "stale";

  return (
    <section data-testid="runs-list-section" className="space-y-2">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h2 className="text-sm uppercase tracking-wide text-zinc-400">
          Runs{" "}
          <span className="text-zinc-600">
            ({items.length}
            {outcome ? ` · ${outcome}` : ""})
          </span>
        </h2>
        <div className="text-xs text-zinc-500">
          {stale && <span className="text-amber-400">stale · </span>}
          as of <LocalTimestamp ts={data?.generatedAt} stale={stale} />
        </div>
      </div>

      {/* The absorbed Behavior-tab filter affordance. */}
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter runs by outcome">
        {OUTCOME_FILTERS.map((o) => (
          <button
            key={o || "all"}
            type="button"
            data-testid={`runs-filter-${o || "all"}`}
            data-active={outcome === o ? "true" : "false"}
            aria-pressed={outcome === o}
            onClick={() => setOutcome(o)}
            className={`text-[11px] px-2 py-0.5 rounded-full border font-mono ${
              outcome === o
                ? "border-emerald-500/50 bg-emerald-900/20 text-emerald-300"
                : "border-zinc-700 text-zinc-400 hover:border-zinc-600"
            }`}
          >
            {o || "all"}
          </button>
        ))}
      </div>

      {unknown ? (
        // Trust rule 1: unproven renders UNKNOWN, never a hopeful empty table.
        <div
          data-testid="runs-list-unknown"
          className="border border-zinc-700 rounded-md px-4 py-6 text-center text-sm text-zinc-400 bg-zinc-900/40"
        >
          UNKNOWN — run history unproven (fetch failed, no payload, or no as-of timestamp).
        </div>
      ) : status === "empty" ? (
        // An ASSERTED zero only: the lookup ran cleanly and found nothing.
        <div
          data-testid="runs-list-empty"
          className="border border-zinc-800 rounded-md px-4 py-6 text-center text-sm text-zinc-500 bg-zinc-900/30"
        >
          No autopilot runs recorded yet.
        </div>
      ) : (
        <ul className="divide-y divide-zinc-800/60 border border-zinc-800 rounded-lg bg-zinc-900/30 px-3">
          {items.map((run) => (
            <RunRow key={run.run_id} run={run} />
          ))}
        </ul>
      )}
    </section>
  );
}

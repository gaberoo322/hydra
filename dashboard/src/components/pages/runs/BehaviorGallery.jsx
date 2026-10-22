import { useCallback, useState } from "react";
import { Link } from "react-router-dom";
import { usePageItems } from "../../../hooks/usePageItems.js";
import LocalTimestamp from "../../LocalTimestamp.jsx";
import { formatTokens } from "../../../lib/autopilot-format.js";
import { BEHAVIOR_OUTCOMES, describeBehaviorClasses } from "./runs-state.js";

/**
 * BehaviorGallery — the Explore › Behavior fold restored onto /runs (issue
 * #4634, design-concept a7e7fedb INV-2/4/6; ADR-0034 §3: "Friction and
 * Behavior → /runs"). App.jsx said Behavior was folded into /runs but nothing
 * called GET /explore/behavior — this section is that consumer.
 *
 * Distinct from RunsList (the list level: status, duration, failure chip):
 * each row shows which dispatch CLASSES the run fired, beside the server's
 * closed `outcome`, its trigger, turns, dispatches (merged/failed) and
 * tokens. Class chips follow runs-state.js describeBehaviorClasses: an empty
 * `classes[]` reads "no classes recorded" ONLY when the run dispatched
 * nothing; with dispatches > 0 it reads "classes UNKNOWN" (the server's class
 * read missed them — never a confident none).
 *
 * The run link is built from `runId` → `/runs/${runId}` (the canonical
 * detail route), NOT the server's `detailHref` — that is the retired
 * `/autopilot/:id` deep link App.jsx only redirects.
 *
 * The outcome filter is CLIENT-SIDE through usePageItems' `filter` option
 * over the 50 fetched rows — one fetch, no query rewrite.
 *
 * Trust (ADR-0034 §5): usePageItems on a ~1 h budget. Anti-scope (ADR-0034
 * §2 /runs): no aggregate, no trend, no chart.
 */

const HOUR_MS = 60 * 60 * 1000;


const OUTCOME_CHIP = {
  success: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
  failure: "bg-red-500/10 text-red-300 border-red-500/30",
  aborted: "bg-amber-500/10 text-amber-300 border-amber-500/30",
  "in-progress": "bg-sky-500/10 text-sky-300 border-sky-500/30",
  unknown: "bg-zinc-700/40 text-zinc-400 border-zinc-600",
};

function BehaviorClasses({ row }) {
  const view = describeBehaviorClasses(row);
  if (view.kind === "unknown") {
    return (
      <span className="text-[11px] font-bold text-zinc-500" title="the run dispatched, but no class was recorded">
        classes UNKNOWN
      </span>
    );
  }
  if (view.kind === "none") {
    return <span className="text-[11px] italic text-zinc-500">no classes recorded</span>;
  }
  return (
    <span className="flex flex-wrap gap-1 min-w-0">
      {view.classes.map((c) => (
        <span key={c} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300">
          {c}
        </span>
      ))}
    </span>
  );
}

export default function BehaviorGallery() {
  const [outcome, setOutcome] = useState(null); // null = all outcomes
  const filter = useCallback((row) => outcome === null || row?.outcome === outcome, [outcome]);
  const { items, data, status } = usePageItems("/explore/behavior?limit=50", {
    itemsKey: "items",
    filter,
    freshnessMs: HOUR_MS,
    poll: 60_000,
  });

  const unknown = status === "loading" || status === "unknown";
  const stale = status === "stale";
  const fetched = Array.isArray(data?.items) ? data.items.length : 0;

  return (
    <section data-testid="behavior-gallery" className="space-y-2">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h2 className="text-sm uppercase tracking-wide text-zinc-400">
          Behavior — which classes each run dispatched{" "}
          <span className="text-zinc-600">
            ({items.length}
            {outcome !== null ? ` of ${fetched}` : ""})
          </span>
        </h2>
        <div className="text-xs text-zinc-500">
          {stale && <span className="text-amber-400">stale · </span>}
          as of <LocalTimestamp ts={data?.generatedAt} stale={stale} />
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5 text-[11px]" role="group" aria-label="Filter by outcome">
        {[null, ...BEHAVIOR_OUTCOMES].map((o) => (
          <button
            key={o ?? "all"}
            type="button"
            aria-pressed={outcome === o}
            onClick={() => setOutcome(o)}
            className={`px-2 py-0.5 rounded border ${
              outcome === o
                ? "border-zinc-400 text-zinc-100 bg-zinc-700/50"
                : "border-zinc-700 text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {o ?? "all"}
          </button>
        ))}
      </div>

      {unknown ? (
        <div
          data-testid="behavior-gallery-unknown"
          className="border border-zinc-700 rounded-md px-4 py-4 text-center text-sm text-zinc-400 bg-zinc-900/40"
        >
          UNKNOWN — behavior read unproven (fetch failed or no as-of timestamp).
        </div>
      ) : status === "empty" ? (
        <div
          data-testid="behavior-gallery-empty"
          className="border border-zinc-800 rounded-md px-4 py-4 text-center text-sm text-zinc-500 bg-zinc-900/30"
        >
          {outcome === null
            ? "No autopilot runs recorded."
            : `No ${outcome} runs among the last ${fetched} fetched.`}
        </div>
      ) : (
        <ul className="divide-y divide-zinc-800/60 border border-zinc-800 rounded-lg bg-zinc-900/30 px-3">
          {items.map((r) => (
            <li key={r.runId} className="py-2 flex items-center gap-3 flex-wrap" data-testid="behavior-row">
              <span
                className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border shrink-0 ${
                  OUTCOME_CHIP[r.outcome] ?? "bg-zinc-700/40 text-zinc-400 border-zinc-600"
                }`}
              >
                {r.outcome}
              </span>
              <span className="text-xs text-zinc-400 shrink-0">{r.trigger || "—"}</span>
              <BehaviorClasses row={r} />
              <span className="flex-1" />
              <span className="text-xs font-mono text-zinc-400 shrink-0">{r.turns ?? "—"} turns</span>
              <span className="text-xs font-mono text-zinc-400 shrink-0">
                {r.dispatches ?? "—"} disp ({r.mergedCount ?? 0}/{r.failedCount ?? 0})
              </span>
              <span className="text-xs font-mono text-zinc-400 shrink-0">{formatTokens(r.totalTokens)}</span>
              <Link
                to={`/runs/${encodeURIComponent(r.runId)}`}
                data-testid="behavior-run-link"
                className="text-xs text-blue-400 hover:underline shrink-0"
              >
                run →
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

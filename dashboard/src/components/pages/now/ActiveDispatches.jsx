import { Link } from "react-router-dom";
import { usePageItems } from "../../../hooks/usePageItems.js";
import { SourceBadge } from "../../badges/Badges.jsx";
import { formatAge } from "../../../lib/page-item-format.ts";
import { Section } from "./Section.jsx";

/**
 * ActiveDispatches — every live Claude Code session known to the
 * orchestrator. Polls every 5s (PRD #615) so the operator can watch
 * sessions come and go.
 *
 * Thin renderer over the page-item seam (issue #822): usePageItems supplies
 * the typed item list + status; SourceBadge/formatAge come from the shared
 * Modules. The row markup (incl. the subagent transcript affordance) stays
 * local — rows genuinely differ across pages.
 */
export function ActiveDispatches() {
  const { items, status, error, loading } = usePageItems("/now/active-dispatches", {
    poll: 5_000,
  });

  return (
    <Section
      title="Active dispatches"
      subtitle="Every live Claude Code session — autopilot or operator."
      count={items.length}
      loading={loading}
      error={error}
      empty={status === "empty"}
      emptyMessage="No dispatches running right now."
    >
      <ul className="divide-y divide-zinc-700/50">
        {items.map((item) => (
          <li key={item.id} className="py-2 flex items-center gap-3">
            <SourceBadge source={item.source} />
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
            {/* Issue #695 — transcript affordance. Subagent rows are keyed on
                the harness sessionId (item.id), which the transcript route
                resolves; other sources have no JSONL transcript in v1. */}
            {item.source === "subagent" && (
              <Link
                to={`/dispatch/${encodeURIComponent(item.id)}/transcript`}
                className="text-[11px] px-1.5 py-0.5 rounded border border-violet-500/30 text-violet-300 hover:bg-violet-500/10 shrink-0"
                title="View this subagent's conversation transcript"
              >
                transcript
              </Link>
            )}
            <span className="text-xs text-zinc-500 shrink-0">{formatAge(item.startedAt)}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

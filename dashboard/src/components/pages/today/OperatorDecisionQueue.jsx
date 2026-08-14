import { usePageItems } from "../../../hooks/usePageItems.js";
import { DecisionSourceBadge } from "../../badges/Badges.jsx";
import { relativeAge } from "../../../lib/page-item-format.ts";
import { Section } from "./Section.jsx";

/**
 * OperatorDecisionQueue — unifies the three operator-attention sources
 * (overnight digest, ready-for-human, needs-info) into one age-sorted
 * list. Each row links to the GitHub issue and shows badges for every
 * source that surfaced it.
 *
 * Polls /api/today/decision-queue every 30s per PRD #615. Thin renderer
 * over the page-item seam (issue #822): DecisionSourceBadge + the shared
 * coarse-age formatter (relativeAge).
 *
 * Trust contract (ADR-0034 §5, tracer bullet #4006): the seam now derives
 * unknown/stale/empty from the payload's `sourcesOk` + `generatedAt`. This
 * panel declares a minutes-tier freshness budget (attention data) and
 * forwards the resolved status into Section so an unasserted empty renders
 * UNKNOWN — never a confident-looking zero — while the as-of age stays
 * visible in every branch.
 */
export function OperatorDecisionQueue() {
  const { items, data, status, error, loading } = usePageItems("/today/decision-queue", {
    poll: 30_000,
    // ADR-0034 §5: attention data is a minutes-tier surface — a payload older
    // than 5 min is stale (the queue may have changed since it was generated).
    freshnessMs: 5 * 60 * 1000,
  });

  // Trust mapping: a failed refresh WITH retained data is `stale` (show the
  // data, aged); only a hard `unknown` surfaces the raw failure message, muted
  // inside the UNKNOWN block — never as a confident value.
  return (
    <Section
      title="Operator decision queue"
      subtitle="Items waiting on you — oldest first."
      count={items.length}
      loading={loading}
      error={status === "stale" ? null : error}
      empty={status === "empty"}
      unknown={status === "unknown"}
      stale={status === "stale"}
      generatedAt={data?.generatedAt}
      emptyMessage="Inbox zero. Nothing waiting on a human decision."
    >
      <ul className="divide-y divide-zinc-700/50">
        {items.map((item) => (
          <li key={item.number} className="py-2 flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <a
                href={item.url}
                target="_blank"
                rel="noreferrer"
                className="text-sm text-zinc-100 hover:text-violet-300 truncate block"
              >
                <span className="text-zinc-500 mr-1">#{item.number}</span>
                {item.title}
              </a>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {item.sources?.map((s) => (
                <DecisionSourceBadge key={s} source={s} />
              ))}
            </div>
            <span className="text-xs text-zinc-500 w-8 text-right">{relativeAge(item.createdAt)}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

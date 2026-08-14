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
 * ADR-0034 §5 trust contract (issue #4006): this is the first panel through
 * the seam, so it declares its own freshness budget (5 min — this is an
 * attention/is-it-on-fire surface, the minutes tier) and forwards the
 * resolved status into Section. The endpoint now asserts its lookup ran
 * (`sourcesOk`), so an unasserted or failed lookup renders UNKNOWN rather
 * than a confident-looking empty inbox.
 */
export function OperatorDecisionQueue() {
  const { items, data, status, error, loading } = usePageItems("/today/decision-queue", {
    poll: 30_000,
    freshnessMs: 5 * 60 * 1000,
  });

  // The raw error message is only diagnostically relevant in the unknown/stale
  // branches (deriveItemStatus folds a fetch failure into one of those, never
  // into a confident state). Scoping it here avoids a stale error string
  // flashing a red banner during a later foreground refresh.
  const showErrorDetail = status === "unknown" || status === "stale";

  return (
    <Section
      title="Operator decision queue"
      subtitle="Items waiting on you — oldest first."
      count={items.length}
      loading={loading}
      error={showErrorDetail ? error : null}
      unknown={status === "unknown"}
      stale={status === "stale"}
      empty={status === "empty"}
      emptyMessage="Inbox zero. Nothing waiting on a human decision."
      generatedAt={data?.generatedAt}
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

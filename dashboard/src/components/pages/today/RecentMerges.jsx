import { usePageItems } from "../../../hooks/usePageItems.js";
import { TierBadge, ClassLabelBadge } from "../../badges/Badges.jsx";
import { formatClock } from "../../../lib/page-item-format.ts";
import { Section } from "./Section.jsx";

/**
 * RecentMerges — the most-recent merged PRs on master, each with the
 * Hydra-specific tier chip and autopilot class label so the operator
 * can see what the system actually shipped overnight.
 *
 * Polls every 60s per PRD #615 (slower than the 30s sections — merges
 * aren't time-sensitive). Thin renderer over the page-item seam (issue
 * #822): TierBadge/ClassLabelBadge + the shared clock formatter.
 */
export function RecentMerges({ limit = 10 }) {
  const { items, data, status, error, loading } = usePageItems(`/today/merges?limit=${limit}`, {
    poll: 60_000,
  });

  return (
    <Section
      title="Recent merges"
      subtitle={`Last ${data?.limit ?? limit} PRs merged to master.`}
      count={items.length}
      loading={loading}
      error={error}
      empty={status === "empty"}
      emptyMessage="No PRs merged recently."
    >
      <ul className="divide-y divide-zinc-700/50">
        {items.map((item) => (
          <li key={item.prNumber} className="py-2 flex items-center gap-3">
            <span className="text-xs text-zinc-500 w-12 shrink-0 text-right">
              {formatClock(item.mergedAt)}
            </span>
            <a
              href={item.url}
              target="_blank"
              rel="noreferrer"
              className="flex-1 min-w-0 text-sm text-zinc-100 hover:text-emerald-300 truncate"
            >
              <span className="text-zinc-500 mr-1">#{item.prNumber}</span>
              {item.title}
            </a>
            <div className="flex items-center gap-1 shrink-0">
              <TierBadge tier={item.tier} />
              <ClassLabelBadge label={item.classLabel} />
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}

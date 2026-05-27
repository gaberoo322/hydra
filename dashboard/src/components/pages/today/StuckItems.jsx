import { useApi } from "../../../hooks/useApi.js";
import { Section } from "./Section.jsx";

function Bucket({ title, items, kind }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h3 className="text-xs uppercase tracking-wide text-zinc-500 mb-1">
        {title} <span className="text-zinc-600">({items.length})</span>
      </h3>
      <ul className="divide-y divide-zinc-700/50">
        {items.map((item) => (
          <li key={`${kind}-${item.number}`} className="py-1.5 flex items-center gap-3">
            <a
              href={item.url}
              target="_blank"
              rel="noreferrer"
              className="flex-1 min-w-0 text-sm text-zinc-100 hover:text-amber-300 truncate"
            >
              <span className="text-zinc-500 mr-1">#{item.number}</span>
              {item.title}
            </a>
            {kind === "issue" ? (
              <span className="text-xs text-zinc-500 shrink-0">{item.ageDays}d</span>
            ) : (
              <span className="text-xs text-red-300 shrink-0 truncate max-w-[12rem]">
                {item.failedChecks?.join(", ")}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * StuckItems — three buckets: blocked over threshold, needs-info waiting,
 * PRs with at least one failing check. Polls every 30s per PRD #615.
 */
export function StuckItems() {
  const { data, error, loading } = useApi("/today/stuck", { poll: 30_000 });

  const blocked = data?.blockedOver2d ?? [];
  const info = data?.needsInfoWaiting ?? [];
  const prs = data?.prsWithFailedCi ?? [];
  const total = blocked.length + info.length + prs.length;
  const thresholds = data?.thresholds;

  const subtitle = thresholds
    ? `Blocked ≥ ${thresholds.blockedDays}d · needs-info ≥ ${thresholds.needsInfoDays}d · CI failing.`
    : "What's stalled.";

  return (
    <Section
      title="Stuck items"
      subtitle={subtitle}
      count={total}
      loading={loading}
      error={error}
      empty={!loading && !error && total === 0}
      emptyMessage="Nothing stuck. Work is flowing."
    >
      <div className="space-y-4">
        <Bucket title={`Blocked > ${thresholds?.blockedDays ?? 2}d`} items={blocked} kind="issue" />
        <Bucket title="Needs-info waiting" items={info} kind="issue" />
        <Bucket title="PRs with failed CI" items={prs} kind="pr" />
      </div>
    </Section>
  );
}

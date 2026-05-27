import { useApi } from "../../../hooks/useApi.js";
import { Section } from "./Section.jsx";

const TIER_STYLE = {
  0: "bg-red-500/10 text-red-300 border-red-500/30",
  1: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
  2: "bg-sky-500/10 text-sky-300 border-sky-500/30",
  3: "bg-amber-500/10 text-amber-300 border-amber-500/30",
};

function formatMergedAt(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()) || d.getTime() === 0) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * RecentMerges — the most-recent merged PRs on master, each with the
 * Hydra-specific tier chip and autopilot class label so the operator
 * can see what the system actually shipped overnight.
 *
 * Polls every 60s per PRD #615 (slower than the 30s sections — merges
 * aren't time-sensitive).
 */
export function RecentMerges({ limit = 10 }) {
  const { data, error, loading } = useApi(`/v2/today/merges?limit=${limit}`, { poll: 60_000 });
  const items = data?.items ?? [];

  return (
    <Section
      title="Recent merges"
      subtitle={`Last ${data?.limit ?? limit} PRs merged to master.`}
      count={items.length}
      loading={loading}
      error={error}
      empty={!loading && !error && items.length === 0}
      emptyMessage="No PRs merged recently."
    >
      <ul className="divide-y divide-zinc-700/50">
        {items.map((item) => (
          <li key={item.prNumber} className="py-2 flex items-center gap-3">
            <span className="text-xs text-zinc-500 w-12 shrink-0 text-right">
              {formatMergedAt(item.mergedAt)}
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
              {item.tier !== null && item.tier !== undefined && (
                <span
                  className={`px-1.5 py-0.5 text-[10px] rounded border ${TIER_STYLE[item.tier] || "bg-zinc-700/60 text-zinc-300 border-zinc-600"}`}
                >
                  T{item.tier}
                </span>
              )}
              {item.classLabel && (
                <span className="px-1.5 py-0.5 text-[10px] rounded bg-zinc-700/60 text-zinc-300 border border-zinc-600">
                  {item.classLabel}
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}

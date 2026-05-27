import { useApi } from "../../../hooks/useApi.js";
import { Section } from "./Section.jsx";

const SOURCE_LABEL = {
  "operator-decision-queue": "queue",
  "ready-for-human": "human",
  "needs-info": "info",
};

const SOURCE_STYLE = {
  "operator-decision-queue": "bg-violet-500/10 text-violet-300 border-violet-500/30",
  "ready-for-human": "bg-yellow-500/10 text-yellow-300 border-yellow-500/30",
  "needs-info": "bg-sky-500/10 text-sky-300 border-sky-500/30",
};

function relativeAge(iso) {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * OperatorDecisionQueue — unifies the three operator-attention sources
 * (overnight digest, ready-for-human, needs-info) into one age-sorted
 * list. Each row links to the GitHub issue and shows badges for every
 * source that surfaced it.
 *
 * Polls /api/v2/today/decision-queue every 30s per PRD #615.
 */
export function OperatorDecisionQueue() {
  const { data, error, loading } = useApi("/v2/today/decision-queue", { poll: 30_000 });
  const items = data?.items ?? [];

  return (
    <Section
      title="Operator decision queue"
      subtitle="Items waiting on you — oldest first."
      count={items.length}
      loading={loading}
      error={error}
      empty={!loading && !error && items.length === 0}
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
                <span
                  key={s}
                  className={`px-1.5 py-0.5 text-[10px] rounded border ${SOURCE_STYLE[s] || ""}`}
                >
                  {SOURCE_LABEL[s] || s}
                </span>
              ))}
            </div>
            <span className="text-xs text-zinc-500 w-8 text-right">{relativeAge(item.createdAt)}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

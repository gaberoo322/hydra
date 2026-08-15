import { useCallback, useState } from "react";
import { usePageItems } from "../../../hooks/usePageItems.js";
import { apiFetch } from "../../../hooks/useApi.js";
import { relativeAge } from "../../../lib/page-item-format.ts";
import { Section } from "./Section.jsx";

/**
 * AttentionFeed — the `/` page's "what needs me" surface (issue #4007,
 * ADR-0034 §4). One heterogeneous list of items that each CROSSED A STATED
 * LINE — never a weighted score. Each row renders the line it crossed as its
 * own explanation ("4d · blocked ≥ 2d"), deep-links to the page that owns
 * its detail, and is dismissable with a reason (immediate-fire tier,
 * ADR-0034 §7 — no confirm step).
 *
 * Trust contract (ADR-0034 §5): reuses the #4006 seam — usePageItems derives
 * unknown/stale/empty from `sourcesOk` + `generatedAt`, so an unasserted
 * empty renders UNKNOWN while a genuine zero-crossed-items day renders the
 * all-clear ("Nothing crossed a line."). Minutes-tier freshness budget:
 * attention data older than 5 min is stale.
 */

const SIGNAL_LABEL = {
  "blocked-on-human": "blocked on human",
  breakage: "breakage",
  repetition: "repetition",
};

const SIGNAL_CLASS = {
  "blocked-on-human": "bg-amber-500/15 text-amber-300 border-amber-500/30",
  breakage: "bg-red-500/15 text-red-300 border-red-500/30",
  repetition: "bg-violet-500/15 text-violet-300 border-violet-500/30",
};

export function AttentionFeed() {
  const { items, data, status, error, loading, refresh } = usePageItems(
    "/attention/feed",
    {
      poll: 30_000,
      // ADR-0034 §5: attention data is a minutes-tier surface — a payload
      // older than 5 min is stale (crossings may have changed since).
      freshnessMs: 5 * 60 * 1000,
    },
  );

  const [dismissing, setDismissing] = useState({});
  const [dismissError, setDismissError] = useState(null);

  // Dismiss fires immediately on click (ADR-0034 §7 action tier). The reason
  // is mandatory at the API boundary; the feed supplies the operator-context
  // default (signal + observed value) so a one-click dismiss still leaves a
  // legible audit line behind.
  const dismiss = useCallback(
    async (item) => {
      setDismissing((m) => ({ ...m, [item.id]: true }));
      setDismissError(null);
      try {
        await apiFetch(`/attention/${encodeURIComponent(item.id)}/dismiss`, {
          method: "POST",
          body: JSON.stringify({
            reason: `dismissed from Today attention feed — ${item.signal} (${item.observedValue} vs ${item.thresholdLabel})`,
            signal: item.signal,
          }),
        });
        await refresh();
      } catch (err) {
        setDismissError(err.message);
      } finally {
        setDismissing((m) => ({ ...m, [item.id]: false }));
      }
    },
    [refresh],
  );

  return (
    <Section
      title="Needs attention"
      subtitle="Crossed a line — oldest crossing first. Dismiss with a reason."
      count={items.length}
      loading={loading}
      error={status === "stale" ? null : error}
      empty={status === "empty"}
      unknown={status === "unknown"}
      stale={status === "stale"}
      generatedAt={data?.generatedAt}
      emptyMessage="All clear — nothing crossed a line."
    >
      {dismissError && (
        <div className="mb-2 text-xs text-red-300 font-mono break-all">
          dismiss failed: {dismissError}
        </div>
      )}
      <ul className="divide-y divide-zinc-700/50">
        {items.map((item) => (
          <li key={item.id} className="py-2 flex items-center gap-3">
            <span
              className={`shrink-0 px-2 py-0.5 text-xs rounded border ${SIGNAL_CLASS[item.signal] ?? ""}`}
            >
              {SIGNAL_LABEL[item.signal] ?? item.signal}
            </span>
            <div className="flex-1 min-w-0">
              <a
                href={item.url}
                target={item.url.startsWith("http") ? "_blank" : undefined}
                rel="noreferrer"
                className="text-sm text-zinc-100 hover:text-violet-300 truncate block"
              >
                {item.title}
              </a>
            </div>
            {/* The line is the explanation: observed value next to the
                threshold it crossed (ADR-0034 §4/§5.3). */}
            <span className="text-xs text-zinc-400 shrink-0 font-mono">
              {item.observedValue} · {item.thresholdLabel}
            </span>
            <span className="text-xs text-zinc-500 w-8 text-right shrink-0">
              {relativeAge(item.crossedAt)}
            </span>
            <button
              type="button"
              onClick={() => dismiss(item)}
              disabled={Boolean(dismissing[item.id])}
              title="Dismiss with a reason (30-day snooze)"
              className="shrink-0 px-2 py-0.5 text-xs rounded border border-zinc-600 text-zinc-400 hover:text-zinc-100 hover:border-zinc-400 disabled:opacity-40"
            >
              {dismissing[item.id] ? "…" : "dismiss"}
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

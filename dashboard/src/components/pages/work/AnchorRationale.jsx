import { usePageItems } from "../../../hooks/usePageItems.js";
import { Section } from "../today/Section.jsx";

/**
 * AnchorRationale — the /work page's "why that?" panel (issue #4010,
 * ADR-0034 §2).
 *
 * Surfaces GET /metrics/anchor-distribution LIVE as the explanation of what
 * the autopilot has been picking and why: which priority lanes (the Candidate
 * Feed's anchor vocabulary) actually served cycles over the recent window.
 * The queue above says what is dispatchable NOW; this says what the lanes
 * have been DOING — together they are the backlog journey's answer to "what
 * is next, and why that".
 *
 * Trust contract (ADR-0034 §5, #4006/#4007): the endpoint stamps
 * `generatedAt` + `sourcesOk` at the HTTP boundary; a degraded trend read
 * (sourcesOk:false) renders UNKNOWN, never a confident all-zero lane table.
 * Slow aggregate — an hour-tier freshness budget, minutes-tier poll.
 */
export default function AnchorRationale() {
  const { items, data, status, error, loading } = usePageItems(
    "/metrics/anchor-distribution",
    {
      itemsKey: "distribution",
      // Served-counts roll over a ~50-cycle window: an hour-tier budget.
      freshnessMs: 60 * 60 * 1000,
      poll: 5 * 60_000,
    },
  );

  const byType = data?.servedByAnchorType ?? {};
  const anchorTypes = Object.entries(byType).sort((a, b) => b[1] - a[1]);
  const windowCycles = data?.windowCycles;

  return (
    <Section
      title="Anchor rationale"
      subtitle="Why the autopilot picked what it picked — served cycles per priority lane."
      count={items.length}
      loading={loading}
      error={status === "stale" ? null : error}
      empty={status === "empty"}
      unknown={status === "unknown"}
      stale={status === "stale"}
      generatedAt={data?.generatedAt}
      emptyMessage="No served cycles in the window — nothing has been dispatched through these lanes yet."
    >
      <div data-testid="anchor-rationale-table" className="space-y-1.5">
        {items.map((lane) => {
          const total = typeof windowCycles === "number" && windowCycles > 0 ? windowCycles : 0;
          const pct = total > 0 ? Math.round((lane.served / total) * 100) : null;
          return (
            <div key={lane.priority} className="flex items-center gap-3 text-xs" data-testid="anchor-lane">
              <span className="font-mono text-zinc-200 w-32 shrink-0">{lane.priority}</span>
              <div className="flex-1 h-2 bg-zinc-700/40 rounded overflow-hidden">
                <div
                  className="h-full bg-violet-400/70"
                  style={{ width: `${pct ?? 0}%` }}
                />
              </div>
              <span className="font-mono text-zinc-300 w-16 text-right shrink-0">
                {lane.served} served
              </span>
              <span className="text-zinc-500 w-10 text-right shrink-0">
                {pct === null ? "—" : `${pct}%`}
              </span>
            </div>
          );
        })}
      </div>
      <p data-testid="anchor-window" className="text-xs text-zinc-500 mt-3">
        window: {typeof windowCycles === "number" ? windowCycles : "—"} cycles
        {anchorTypes.length > 0 && (
          <>
            {" · by anchor type: "}
            <span className="font-mono text-zinc-400">
              {anchorTypes.map(([t, n]) => `${t} ${n}`).join(" · ")}
            </span>
          </>
        )}
      </p>
    </Section>
  );
}

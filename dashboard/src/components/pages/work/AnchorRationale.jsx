import { usePageItems } from "../../../hooks/usePageItems.js";
import { Section } from "../today/Section.jsx";

/**
 * AnchorRationale — the /work page's "why that?" surface (issue #4010,
 * ADR-0034 §3): the anchor-distribution projection (GET
 * /metrics/anchor-distribution) as the why-explanation for what the
 * autopilot has been serving — per priority lane, cycles served over the
 * recent window.
 *
 * Trust contract (ADR-0034 §5, INV-2/INV-4): the endpoint stamps
 * `sourcesOk` + `generatedAt` at the HTTP boundary, so a trend read that
 * degraded to empty renders UNKNOWN — never a confident all-zeros
 * distribution — and the as-of age is always visible. Hour-tier freshness
 * budget (a 50-cycle rolling window moves slowly).
 *
 * Anti-scope (issue #4010): no run history or failure detail here — /runs
 * owns forensics; this panel is distribution only.
 */
export function AnchorRationale() {
  const { items, data, status, error, loading } = usePageItems(
    "/metrics/anchor-distribution",
    {
      itemsKey: "distribution",
      poll: 60_000,
      // ADR-0034 §5: a rolling 50-cycle window is an hour-tier surface.
      freshnessMs: 60 * 60 * 1000,
    },
  );

  const windowCycles = typeof data?.windowCycles === "number" ? data.windowCycles : null;
  const totalServed = items.reduce((sum, lane) => sum + (lane.served ?? 0), 0);

  return (
    <Section
      title="Anchor distribution"
      subtitle={
        windowCycles === null
          ? "What the autopilot served, per priority lane, over the recent window."
          : `What the autopilot served, per priority lane — ${totalServed} served across ${windowCycles} cycles in the window.`
      }
      count={items.length}
      loading={loading}
      error={status === "stale" ? null : error}
      unknown={status === "unknown" || status === "loading"}
      stale={status === "stale"}
      generatedAt={data?.generatedAt}
      emptyMessage="No anchor lanes in the window."
    >
      <ul className="divide-y divide-zinc-700/50" data-testid="work-anchor-distribution">
        {items.map((lane) => {
          // Share of served cycles — a DERIVED ratio, rendered as one: 0
          // only when the window itself asserts zero (sourcesOk !== false
          // is what got us past `unknown`).
          const share = totalServed > 0 ? Math.round(((lane.served ?? 0) / totalServed) * 100) : 0;
          return (
            <li
              key={lane.priority}
              data-testid="work-anchor-lane"
              className="py-2 flex items-center gap-3"
            >
              <span className="text-sm font-mono text-zinc-200 w-40 shrink-0">
                {lane.priority}
              </span>
              <div className="flex-1 h-2 bg-zinc-700/40 rounded overflow-hidden">
                <div
                  className="h-full bg-blue-500/60"
                  style={{ width: `${share}%` }}
                  role="img"
                  aria-label={`${lane.priority}: ${share}%`}
                />
              </div>
              <span className="text-xs text-zinc-400 w-24 text-right shrink-0 font-mono">
                {lane.served ?? 0} · {share}%
              </span>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

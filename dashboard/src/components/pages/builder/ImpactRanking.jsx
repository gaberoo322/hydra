import { usePageItems } from "../../../hooks/usePageItems.js";
import { Section } from "../today/Section.jsx";

/**
 * ImpactRanking — the /builder producer-class impact ranking (issue #4634,
 * design-concept a7e7fedb INV-2/4/5; ADR-0034 §9.4).
 *
 * Homes GET /attribution/impact: producer classes ranked by favorable outcome
 * impact per unit of build cost (the discover reverse-loop's ranking key).
 *
 * Derived-value rule (ADR-0034 §5.3): `impactPerCost` is DERIVED, so every
 * row renders it beside its two inputs — `favorableImpact` and `meanTier`
 * (the server's cost proxy, floored at 1; a null tier means the ranking key
 * is the raw favorable impact) — and lists each per-metric contribution with
 * its β, `directed`, `belowNoiseFloor` and `identifiabilitySuspect` flags
 * verbatim. Never a bare point estimate (the Runs.jsx OutcomeAttribution
 * precedent).
 *
 * Trust (ADR-0034 §5): rides usePageItems on a ~1-day budget. An empty
 * `rows` with `metricCount: 0` is the server's asserted "no impact signal
 * yet" (dark ledger) — rendered as that, never as a ranking.
 *
 * Read-only: /builder carries no action controls (ADR-0034 §2).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function fmt(n, digits = 4) {
  return typeof n === "number" && Number.isFinite(n) ? n.toFixed(digits) : "—";
}

function Flags({ row }) {
  const flags = [];
  if (row.belowNoiseFloor) flags.push("below-noise-floor");
  if (row.identifiabilitySuspect) flags.push("identifiability-suspect");
  if (flags.length === 0) return null;
  return (
    <span className="text-[10px] uppercase tracking-wide text-amber-400/80">{flags.join(" · ")}</span>
  );
}

export function ImpactRanking() {
  const { items, data, status, error } = usePageItems("/attribution/impact?topN=8", {
    itemsKey: "rows",
    freshnessMs: DAY_MS,
    poll: 5 * 60_000,
  });

  const unknown = status === "loading" || status === "unknown";
  const stale = status === "stale";
  const metricCount = typeof data?.metricCount === "number" ? data.metricCount : null;

  return (
    <Section
      title="Impact per cost"
      subtitle={`Producer classes by favorable outcome impact ÷ build-cost proxy (mean tier) — derived, every input shown${
        metricCount !== null ? ` · folded over ${metricCount} metric(s)` : ""
      }.`}
      count={unknown ? undefined : items.length}
      error={unknown ? error : null}
      unknown={unknown}
      stale={stale}
      empty={status === "empty"}
      emptyMessage="No impact signal yet — the attribution ledger has no identifiable class effects."
      generatedAt={data?.generatedAt}
    >
      <ol className="space-y-2" data-testid="impact-ranking">
        {items.map((row) => (
          <li
            key={row.producerClass}
            className="border border-zinc-800 rounded-md bg-zinc-900/30 p-3"
            data-testid="impact-ranking-row"
          >
            <div className="flex items-baseline gap-3 flex-wrap text-xs">
              <span className="font-mono text-sm text-zinc-100 w-28 shrink-0">{row.producerClass}</span>
              <span className="font-mono text-zinc-200">impact/cost {fmt(row.impactPerCost)}</span>
              {/* §5.3: the derived key beside the inputs it decomposes into. */}
              <span className="font-mono text-zinc-500">
                = favorable {fmt(row.favorableImpact)} ÷{" "}
                {row.meanTier === null || row.meanTier === undefined
                  ? "1 (no tier recorded — raw favorable impact)"
                  : `max(mean tier ${fmt(row.meanTier, 2)}, 1)`}
              </span>
              <Flags row={row} />
            </div>
            <ul className="mt-1.5 ml-2 space-y-0.5">
              {(Array.isArray(row.contributions) ? row.contributions : []).map((c) => (
                <li key={c.metric} className="flex items-center gap-2 flex-wrap text-[11px]">
                  <span className="font-mono text-zinc-400">{c.metric}</span>
                  <span className="font-mono text-zinc-500">β {fmt(c.beta)}</span>
                  <span className="font-mono text-zinc-500">favorable {fmt(c.favorable)}</span>
                  {/* `directed`: whether the metric's direction oriented β (verbatim). */}
                  <span className="text-[10px] uppercase tracking-wide text-zinc-500">
                    {c.directed ? "directed" : "undirected (raw β)"}
                  </span>
                  <Flags row={c} />
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </Section>
  );
}

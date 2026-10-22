import { usePageItems } from "../../../hooks/usePageItems.js";
import { Section } from "../today/Section.jsx";

/**
 * UnclassifiedResidue — the /builder unclassified-cycle residue panel (issue
 * #4634, design-concept a7e7fedb INV-2/4/5; ADR-0034 §9.4).
 *
 * Homes GET /metrics/unclassified: the cycles in the recent window whose
 * dispatch class could not be decoded, split into `fixable` (a second decode
 * source recovers a lane — a genuine classifier gap) vs `no-attribution`
 * (structurally undecodable harness noise).
 *
 * Derived-value rule (ADR-0034 §5.3): `rate`, `fixableRate` and the
 * `noAttributionShapes` breakdown are rendered as three LABELLED inputs over
 * `windowCycles` — the server's own numbers, never recomputed here — then the
 * fixable rows (cycleId, prNumber, anchorReference, shape).
 *
 * Trust (ADR-0034 §5): rides usePageItems on a ~1-day budget, filtered to the
 * fixable rows. Zero is asserted only on evidence: `windowCycles` is the count
 * the zero is measured over, so "0 fixable" renders only when the window held
 * cycles; an empty window asserts nothing and renders UNKNOWN.
 *
 * Read-only: /builder carries no action controls (ADR-0034 §2).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Module-level so usePageItems' memo sees a stable predicate. */
const isFixable = (row) => row?.classification === "fixable";

export function UnclassifiedResidue() {
  const { items, data, status, error } = usePageItems("/metrics/unclassified?count=50", {
    itemsKey: "unclassified",
    filter: isFixable,
    freshnessMs: DAY_MS,
    poll: 5 * 60_000,
  });

  const windowCycles = typeof data?.windowCycles === "number" ? data.windowCycles : null;
  // No cycles in the window → nothing was measured; never a confident zero.
  const unknown =
    status === "loading" || status === "unknown" || windowCycles === null || windowCycles === 0;
  const stale = status === "stale";
  const shapes =
    data?.noAttributionShapes && typeof data.noAttributionShapes === "object"
      ? Object.entries(data.noAttributionShapes)
      : [];

  return (
    <Section
      title="Unclassified residue"
      subtitle="Cycles whose dispatch class could not be decoded — fixable classifier gaps vs undecodable harness noise."
      count={unknown ? undefined : items.length}
      error={unknown ? error : null}
      unknown={unknown}
      stale={stale}
      generatedAt={data?.generatedAt}
    >
      <div className="space-y-3" data-testid="unclassified-residue">
        <dl className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
          <div>
            <dt className="uppercase tracking-wide text-zinc-500">rate (all unclassified)</dt>
            <dd className="font-mono text-lg text-zinc-100">
              {data?.rate}% <span className="text-xs text-zinc-500">of {windowCycles} cycles</span>
            </dd>
          </div>
          <div>
            <dt className="uppercase tracking-wide text-zinc-500">fixableRate (classifier gaps)</dt>
            <dd className="font-mono text-lg text-zinc-100">
              {data?.fixableRate}%{" "}
              <span className="text-xs text-zinc-500">
                {data?.fixable} of {windowCycles} cycles
              </span>
            </dd>
          </div>
          <div>
            <dt className="uppercase tracking-wide text-zinc-500">
              noAttributionShapes ({data?.noAttribution} undecodable)
            </dt>
            <dd className="font-mono text-zinc-300">
              {shapes.length === 0
                ? "none"
                : shapes.map(([shape, n]) => `${shape}: ${n}`).join(" · ")}
            </dd>
          </div>
        </dl>

        {items.length === 0 ? (
          <p className="text-sm text-zinc-500 italic">
            0 fixable unclassified cycles over the last {windowCycles} cycles.
          </p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-zinc-500 text-[10px] uppercase tracking-widest border-b border-zinc-800">
                <th className="text-left py-2 pr-3 font-semibold">cycleId</th>
                <th className="text-left py-2 pr-3 font-semibold">PR</th>
                <th className="text-left py-2 pr-3 font-semibold">Anchor</th>
                <th className="text-left py-2 pr-1 font-semibold">Shape</th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr key={row.cycleId} className="border-b border-zinc-800/40" data-testid="unclassified-row">
                  <td className="py-1.5 pr-3 font-mono text-zinc-200 break-all">{row.cycleId}</td>
                  <td className="py-1.5 pr-3 font-mono text-zinc-400">{row.prNumber ? `#${row.prNumber}` : "—"}</td>
                  <td className="py-1.5 pr-3 font-mono text-zinc-400">{row.anchorReference || "—"}</td>
                  <td className="py-1.5 pr-1 font-mono text-zinc-500">{row.shape || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Section>
  );
}

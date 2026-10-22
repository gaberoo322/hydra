import { usePageItems } from "../../../hooks/usePageItems.js";
import { Section } from "../today/Section.jsx";
import LocalTimestamp from "../../LocalTimestamp.jsx";

/**
 * DeclaredOutcomes — the /builder declared-outcomes table (issue #4634,
 * design-concept a7e7fedb INV-2/4/5; ADR-0034 §9.4).
 *
 * Homes GET /outcomes: one row per declared outcome from the outcomes file —
 * name, kind, direction, baseline → target, current reading, holdback.
 *
 * Trust (ADR-0034 §5): rides usePageItems on a ~1-day budget. Every row also
 * shows its OWN as-of — the reading's `ts` — because the file adapter's stale
 * mtime IS the staleness signal for that outcome (CONTEXT.md Target
 * Outcomes). A missing reading renders "—, no reading", never a zero.
 *
 * Read-only: /builder carries no action controls (ADR-0034 §2).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export function DeclaredOutcomes() {
  const { items, data, status, error } = usePageItems("/outcomes", {
    itemsKey: "outcomes",
    freshnessMs: DAY_MS,
    poll: 5 * 60_000,
  });

  const unknown = status === "loading" || status === "unknown";
  const stale = status === "stale";

  return (
    <Section
      title="Declared outcomes"
      subtitle="The outcomes file's rows — baseline → target, the current reading, and that reading's own as-of."
      count={unknown ? undefined : items.length}
      error={unknown ? error : null}
      unknown={unknown}
      stale={stale}
      empty={status === "empty"}
      emptyMessage="The outcomes file declares no outcomes."
      generatedAt={data?.generatedAt}
    >
      <div className="overflow-x-auto" data-testid="declared-outcomes">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-zinc-500 text-[10px] uppercase tracking-widest border-b border-zinc-800">
              <th className="text-left py-2 pr-3 font-semibold">Outcome</th>
              <th className="text-left py-2 pr-3 font-semibold">Kind</th>
              <th className="text-left py-2 pr-3 font-semibold">Direction</th>
              <th className="text-right py-2 pr-3 font-semibold">Baseline → target</th>
              <th className="text-right py-2 pr-3 font-semibold">Current</th>
              <th className="text-left py-2 pr-3 font-semibold">Holdback</th>
              <th className="text-left py-2 pr-1 font-semibold">Reading as of</th>
            </tr>
          </thead>
          <tbody>
            {items.map((o) => (
              <tr key={o.name} className="border-b border-zinc-800/40" data-testid="declared-outcome-row">
                <td className="py-1.5 pr-3 font-mono text-zinc-200">{o.name}</td>
                <td className="py-1.5 pr-3 text-zinc-400">{o.kind}</td>
                <td className="py-1.5 pr-3 text-zinc-400">{o.direction}</td>
                <td className="py-1.5 pr-3 text-right font-mono text-zinc-300">
                  {o.baseline} → {o.target}
                </td>
                <td className="py-1.5 pr-3 text-right font-mono text-zinc-100">
                  {o.current === null || o.current === undefined ? (
                    <span className="text-zinc-500">—, no reading</span>
                  ) : (
                    o.current
                  )}
                </td>
                <td className="py-1.5 pr-3 text-zinc-400">{o.holdback}</td>
                <td className="py-1.5 pr-1 text-zinc-500">
                  {o.ts ? <LocalTimestamp ts={o.ts} /> : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

import { usePageItems } from "../../../hooks/usePageItems.js";
import { Section } from "../today/Section.jsx";

/**
 * AnchorRationale — /work's "why that" panel (issue #4010, ADR-0034 §2).
 *
 * The ready-for-agent queue says WHAT is next; this panel explains WHY the
 * autopilot's candidate feed ranks what it ranks — the served-cycles-per-
 * priority-lane distribution behind anchor selection (the autopilot playbook's
 * Candidate Feed vocabulary: kanban / failing-test / work-queue /
 * codebase-health / priorities-doc). Read-only: the acting surface is the
 * queue panel, not this one.
 *
 * Trust contract (ADR-0034 §5): renders through usePageItems + Section —
 * /metrics/anchor-distribution stamps `generatedAt` + `sourcesOk` at its HTTP
 * boundary (#4010), so an unasserted all-zero distribution renders UNKNOWN,
 * never a confident "the autopilot served nothing". Derived values explain
 * themselves (§5.3): the share is rendered as "N of windowCycles cycles",
 * showing its own denominator.
 *
 * Anti-scope (ADR-0034 §2): no run history, no failure detail — this panel
 * explains lane balance, it does not audit cycles.
 */

/** Display names for the live priority lanes (Candidate Feed vocabulary). */
const PRIORITY_LABELS = {
  kanban: "Kanban",
  "failing-test": "Failing test",
  "work-queue": "Work queue",
  "codebase-health": "Codebase health",
  "priorities-doc": "Priorities doc",
};

export function AnchorRationale() {
  const { items, data, status, error, loading } = usePageItems(
    "/metrics/anchor-distribution",
    {
      poll: 60_000,
      itemsKey: "distribution",
      // ADR-0034 §5: the /work surface is an hours-tier board review — an
      // hour freshness budget, tighter than /builder's day tier.
      freshnessMs: 60 * 60 * 1000,
    },
  );

  const windowCycles = typeof data?.windowCycles === "number" ? data.windowCycles : 0;

  return (
    <Section
      title="Why the autopilot picked what it picked"
      subtitle="Served cycles per priority lane over the recent window — the candidate feed's lane balance behind the next dispatch."
      count={items.length}
      loading={loading}
      error={status === "stale" ? null : error}
      empty={status === "empty"}
      unknown={status === "unknown"}
      stale={status === "stale"}
      generatedAt={data?.generatedAt}
      emptyMessage="No cycles recorded in the window yet — the lane balance is an asserted zero only once cycles have served."
    >
      <table data-testid="anchor-rationale-table" className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-zinc-500 border-b border-zinc-700">
            <th className="py-2 pr-4 font-normal">Priority lane</th>
            <th className="py-2 pr-4 font-normal text-right">Served</th>
            <th className="py-2 pr-4 font-normal text-right">Share of window</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-700/50">
          {items.map((lane) => {
            // §5.3: the derived share shows its own denominator, so the row
            // explains itself rather than asserting a bare percentage.
            const share =
              windowCycles > 0
                ? `${Math.round((lane.served / windowCycles) * 100)}% (${lane.served} of ${windowCycles})`
                : "—";
            return (
              <tr key={lane.priority} data-testid={`anchor-lane-${lane.priority}`}>
                <td className="py-1.5 pr-4 text-zinc-200">
                  {PRIORITY_LABELS[lane.priority] ?? lane.priority}
                </td>
                <td className="py-1.5 pr-4 text-right font-mono text-zinc-300">{lane.served}</td>
                <td className="py-1.5 pr-4 text-right font-mono text-zinc-500">{share}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Section>
  );
}

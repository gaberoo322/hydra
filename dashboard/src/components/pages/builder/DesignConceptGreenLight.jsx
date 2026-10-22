import { usePageItems } from "../../../hooks/usePageItems.js";
import { Section } from "../today/Section.jsx";
import { Sparkline } from "../outcomes/Sparkline.jsx";

/**
 * DesignConceptGreenLight — the /builder design-concept production panel
 * (issue #4634, design-concept a7e7fedb INV-2/4/5; ADR-0034 §9.4).
 *
 * Homes GET /design-concepts/snapshots: the Housekeeping chore's daily
 * snapshot of how many design concepts were produced per day, plus the
 * idle-tolerant green-light criterion over it.
 *
 * Derived-value rule (ADR-0034 §5.3): `greenLightReady` is DERIVED, so it is
 * rendered ONLY alongside the inputs it decomposes into —
 * `greenDaysInWindow / requiredGreenDays over windowDays` — plus
 * `indexSizeNow`. The daily counts are drawn with the shared Sparkline
 * (reused, not rebuilt) and listed numerically underneath, oldest → newest.
 *
 * Trust (ADR-0034 §5): rides usePageItems on a ~1-day budget (one snapshot
 * per day). An empty `snapshots` list on a clean read is the asserted "no
 * snapshot days recorded yet".
 *
 * Read-only: /builder carries no action controls (ADR-0034 §2).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export function DesignConceptGreenLight() {
  const { items, data, status, error } = usePageItems("/design-concepts/snapshots", {
    itemsKey: "snapshots",
    freshnessMs: DAY_MS,
    poll: 5 * 60_000,
  });

  const unknown = status === "loading" || status === "unknown";
  const stale = status === "stale";
  // Snapshots arrive newest-first; the glyph and the strip read oldest → newest.
  const oldestFirst = [...items].reverse();
  const points = oldestFirst.map((s) => ({ t: Date.parse(s.date) || 0, v: Number(s.count) || 0 }));

  return (
    <Section
      title="Design-concept green light"
      subtitle="Concepts produced per day (daily snapshot) — green light only beside the window it is measured over."
      count={unknown ? undefined : items.length}
      error={unknown ? error : null}
      unknown={unknown}
      stale={stale}
      empty={status === "empty"}
      emptyMessage="No snapshot days recorded yet."
      generatedAt={data?.generatedAt}
    >
      <div className="space-y-3" data-testid="design-concept-green-light">
        <div className="flex items-baseline gap-4 flex-wrap text-sm">
          <span
            className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${
              data?.greenLightReady
                ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/30"
                : "bg-zinc-700/40 text-zinc-400 border-zinc-600"
            }`}
          >
            {data?.greenLightReady ? "green light" : "not yet"}
          </span>
          {/* §5.3: the verdict next to the inputs it decomposes into. */}
          <span className="font-mono text-zinc-200">
            {data?.greenDaysInWindow} / {data?.requiredGreenDays} green days required over the last{" "}
            {data?.windowDays} days
          </span>
          <span className="font-mono text-xs text-zinc-500">index size now: {data?.indexSizeNow}</span>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1">
            Concepts per day (oldest → newest, {oldestFirst.length} days)
          </div>
          <Sparkline points={points} width={360} height={40} stroke="#34d399" />
          <div className="mt-1 flex flex-wrap gap-1 font-mono text-[10px] text-zinc-500">
            {oldestFirst.map((s) => (
              <span
                key={s.date}
                title={s.date}
                className={`px-1 rounded ${Number(s.count) > 0 ? "bg-emerald-500/10 text-emerald-300" : "bg-zinc-800"}`}
              >
                {s.count}
              </span>
            ))}
          </div>
        </div>
      </div>
    </Section>
  );
}

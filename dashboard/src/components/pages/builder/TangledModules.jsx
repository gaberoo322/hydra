import { usePageItems } from "../../../hooks/usePageItems.js";
import { Section } from "../today/Section.jsx";

/**
 * TangledModules — the /builder page's ranked maintainability view
 * (issue #4011, ADR-0034 §2): the architecture graph re-rendered as
 * most-tangled modules instead of the 363-node / 1004-edge node soup.
 * Answers "what should I refactor next" — rung one of the work ranking
 * (#3981).
 *
 * The ranking itself is computed server-side (src/api/architecture.ts →
 * `rankTangledModules`): cycle membership (SCC size) first, then fan-in +
 * fan-out. ADR-0034 §5.3 — each row decomposes the rank into its inputs
 * (fan-in, fan-out, cycle size), so the derived ordering explains itself.
 *
 * Trust contract (ADR-0034 §5): renders through usePageItems + Section —
 * /architecture emits `generatedAt` (an alias of `scannedAt`), so the panel
 * derives unknown / stale / empty / ready instead of asserting a value it
 * cannot verify. Weekly surface → day-tier freshness budget.
 *
 * No action controls (ADR-0034 §2: /builder "must not show anything
 * actionable today").
 */
export function TangledModules({ limit = 20 }) {
  const { items, data, status, error, loading } = usePageItems("/architecture", {
    poll: 60_000,
    itemsKey: "tangledModules",
    // ADR-0034 §5: weekly-review surface — a day-tier freshness budget.
    freshnessMs: 24 * 60 * 60 * 1000,
  });

  const ranked = items.slice(0, limit);

  return (
    <Section
      title="Most-tangled modules"
      subtitle="What to refactor next — ranked by dependency-cycle size, then fan-in + fan-out."
      count={ranked.length}
      loading={loading}
      error={status === "stale" ? null : error}
      empty={status === "empty"}
      unknown={status === "unknown"}
      stale={status === "stale"}
      generatedAt={data?.generatedAt}
      emptyMessage="No modules found by the architecture scan."
    >
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-zinc-500 border-b border-zinc-700">
            <th className="py-2 pr-4 font-normal">#</th>
            <th className="py-2 pr-4 font-normal">Module</th>
            <th className="py-2 pr-4 font-normal">Group</th>
            <th className="py-2 pr-4 font-normal text-right">Fan-in</th>
            <th className="py-2 pr-4 font-normal text-right">Fan-out</th>
            <th className="py-2 pr-4 font-normal text-right">Cycle</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-700/50">
          {ranked.map((m, i) => (
            <tr key={m.id}>
              <td className="py-1.5 pr-4 text-xs text-zinc-500 font-mono">{i + 1}</td>
              <td className="py-1.5 pr-4 font-mono text-zinc-200">{m.id}</td>
              <td className="py-1.5 pr-4 text-xs text-zinc-500">{m.group}</td>
              <td className="py-1.5 pr-4 text-right font-mono text-zinc-300">{m.fanIn}</td>
              <td className="py-1.5 pr-4 text-right font-mono text-zinc-300">{m.fanOut}</td>
              <td className="py-1.5 pr-4 text-right font-mono">
                {m.cycleSize >= 2 ? (
                  <span className="text-amber-300" title={`member of a ${m.cycleSize}-module dependency cycle`}>
                    {m.cycleSize}
                  </span>
                ) : (
                  <span className="text-zinc-600">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {items.length > limit && (
        <p className="mt-2 text-xs text-zinc-500">
          Showing top {limit} of {items.length} ranked modules.
        </p>
      )}
    </Section>
  );
}

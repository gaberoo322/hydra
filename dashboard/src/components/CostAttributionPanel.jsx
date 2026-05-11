import { useApi } from "../hooks/useApi.js";

/**
 * Cost attribution panel (issue #271).
 *
 * Surfaces the per-role / per-tier / per-complexity breakdown returned by
 * `GET /api/metrics/cost-attribution`. Designed to make the 2026-04 -> 2026-05
 * cost/merge regression ($2.21 -> $11.68) operator-visible at a glance —
 * which agent role and which complexity tier is driving spend.
 *
 * Panel is intentionally light (no charts library calls) — see Metrics page
 * for full charting. This sits beside QualityGates / Abandonment to keep
 * each panel single-purpose.
 */
export default function CostAttributionPanel({ count = 50 }) {
  const { data } = useApi(`/metrics/cost-attribution?count=${count}`);

  if (!data) {
    return (
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
        <h2 className="text-sm font-semibold text-zinc-400 mb-4">Cost Attribution</h2>
        <p className="text-sm text-zinc-600 py-8 text-center">Loading…</p>
      </div>
    );
  }

  const fmtUsd = (v) => `$${(v ?? 0).toFixed(2)}`;
  const fmtCpm = (v) => v == null ? "—" : `$${v.toFixed(2)}`;
  const byRole = Array.isArray(data.byRole) ? data.byRole : [];
  const byTier = Array.isArray(data.byTier) ? data.byTier : [];
  const byComplexity = Array.isArray(data.byComplexity) ? data.byComplexity : [];
  const top5 = Array.isArray(data.top5ExpensiveCycles) ? data.top5ExpensiveCycles : [];

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-sm font-semibold text-zinc-400">Cost Attribution</h2>
        <span className="text-xs text-zinc-500">
          {data.windowCycles} cycles · {fmtUsd(data.totalCostUsd)} total · cost/merge {fmtCpm(data.costPerMerge)}
        </span>
      </div>

      {/* Outcome counts */}
      <div className="grid grid-cols-4 gap-2 mb-4 text-xs">
        <Counter label="Merged" value={data.mergedCycles} />
        <Counter label="Failed" value={data.failedCycles} />
        <Counter label="Abandoned" value={data.abandonedCycles} />
        <Counter label="No-work" value={data.noWorkCycles} />
      </div>

      {byRole.length === 0 ? (
        <p className="text-sm text-zinc-600 py-8 text-center">No cost data</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Roles */}
          <BarList title="By agent role" items={byRole.map((r) => ({ key: r.role, label: r.role, costUsd: r.costUsd, pct: r.pct, hint: `${r.runs} runs` }))} color="bg-sky-500" />

          {/* Tiers */}
          <BarList title="By model tier" items={byTier.map((t) => ({ key: t.tier, label: t.tier, costUsd: t.costUsd, pct: t.pct, hint: `${t.runs} runs` }))} color="bg-emerald-500" />
        </div>
      )}

      {/* Complexity table — cost/merge by complexity is the key regression signal */}
      {byComplexity.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-semibold text-zinc-500 mb-2">Cost per merge by complexity</h3>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-zinc-500">
                <th className="text-left font-normal pb-1">Complexity</th>
                <th className="text-right font-normal pb-1">Cycles</th>
                <th className="text-right font-normal pb-1">Merged</th>
                <th className="text-right font-normal pb-1">Total</th>
                <th className="text-right font-normal pb-1">$/merge</th>
              </tr>
            </thead>
            <tbody>
              {byComplexity.map((c) => (
                <tr key={c.complexity} className="border-t border-zinc-800">
                  <td className="py-1 text-zinc-200">{c.complexity}</td>
                  <td className="py-1 text-right text-zinc-400 tabular-nums">{c.cycles}</td>
                  <td className="py-1 text-right text-zinc-400 tabular-nums">{c.mergedCycles}</td>
                  <td className="py-1 text-right text-zinc-300 tabular-nums">{fmtUsd(c.costUsd)}</td>
                  <td className="py-1 text-right text-amber-300 tabular-nums">{fmtCpm(c.costPerMerge)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Top 5 expensive cycles */}
      {top5.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-semibold text-zinc-500 mb-2">Top 5 most expensive cycles</h3>
          <ul className="space-y-1">
            {top5.map((c) => (
              <li key={c.cycleId} className="flex items-baseline justify-between text-xs">
                <span className="truncate text-zinc-300 mr-2" title={c.taskTitle}>
                  {c.taskTitle}
                </span>
                <span className="text-zinc-500 tabular-nums shrink-0">
                  {fmtUsd(c.totalCostUsd)} · {c.outcome}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function BarList({ title, items, color }) {
  return (
    <div>
      <h3 className="text-xs font-semibold text-zinc-500 mb-2">{title}</h3>
      <ul className="space-y-2">
        {items.map((it) => (
          <li key={it.key}>
            <div className="flex items-baseline justify-between text-xs">
              <span className="text-zinc-200">{it.label}</span>
              <span className="text-zinc-500 tabular-nums">
                ${it.costUsd.toFixed(2)} ({it.pct}%){it.hint ? ` · ${it.hint}` : ""}
              </span>
            </div>
            <div className="h-1.5 bg-zinc-800 rounded mt-1 overflow-hidden">
              <div className={`h-full ${color}`} style={{ width: `${Math.max(it.pct, 2)}%` }} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Counter({ label, value }) {
  return (
    <div className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1">
      <p className="text-zinc-500 uppercase tracking-wider text-[10px]">{label}</p>
      <p className="text-zinc-200 font-semibold tabular-nums">{value ?? 0}</p>
    </div>
  );
}

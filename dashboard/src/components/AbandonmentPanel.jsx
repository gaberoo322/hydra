import { useApi } from "../hooks/useApi.js";

/**
 * Abandonment causes panel (issue #195).
 *
 * Renders the top categories from `GET /api/metrics/abandonment` as a horizontal
 * bar table so operators can see — at a glance — which causes are recurring
 * across the most recent N cycles.
 */
export default function AbandonmentPanel({ count = 50 }) {
  const { data } = useApi(`/metrics/abandonment?count=${count}`);

  const totalCycles = data?.totalCycles ?? 0;
  const totalAbandoned = data?.totalAbandoned ?? 0;
  const abandonRate = data?.abandonRate ?? 0;
  const byCategory = Array.isArray(data?.byCategory) ? data.byCategory : [];

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-sm font-semibold text-zinc-400">Abandonment Causes</h2>
        <span className="text-xs text-zinc-500">
          {totalAbandoned}/{totalCycles} cycles ({abandonRate}%)
        </span>
      </div>

      {byCategory.length === 0 ? (
        <p className="text-sm text-zinc-600 py-8 text-center">No abandonment data</p>
      ) : (
        <ul className="space-y-3">
          {byCategory.map((c) => (
            <li key={c.category}>
              <div className="flex items-baseline justify-between text-sm">
                <span className="font-medium text-zinc-200">{c.category}</span>
                <span className="text-zinc-500 tabular-nums">
                  {c.count} ({c.pct}%)
                </span>
              </div>
              <div className="h-2 bg-zinc-800 rounded mt-1 overflow-hidden">
                <div
                  className="h-full bg-amber-500"
                  style={{ width: `${Math.max(c.pct, 2)}%` }}
                />
              </div>
              {Array.isArray(c.sampleReasons) && c.sampleReasons.length > 0 && (
                <ul className="mt-1 text-xs text-zinc-600 space-y-0.5">
                  {c.sampleReasons.slice(0, 3).map((r, i) => (
                    <li key={i} className="truncate" title={r}>
                      &middot; {r}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

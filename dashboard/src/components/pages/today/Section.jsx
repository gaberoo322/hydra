import LocalTimestamp from "../../LocalTimestamp.jsx";

/**
 * Shared section wrapper for the Dashboard v2 Today page.
 *
 * Every section (OperatorDecisionQueue, StuckItems, RecentMerges,
 * NewTargetFindings, LessonsOvernight) has the same chrome — a header row with
 * a title + optional count badge, an explanatory subtitle, and a content well
 * with consistent loading / error / empty states. This component captures that
 * chrome once so the individual sections can focus on their data shape.
 *
 * ADR-0034 §5 trust surfaces (added by the trust-seam tracer bullet, #4006):
 *   - `generatedAt` renders an always-visible "as of" age in the header, in
 *     every status branch (rule 4). Optional — panels yet to adopt the seam
 *     simply omit it.
 *   - `unknown` renders a neutral UNKNOWN placeholder instead of the red error
 *     banner or the empty-state message — an unasserted/unverifiable value must
 *     never read as a confident zero (rule 1) or a clean empty (rule 2).
 *   - `stale` styles the as-of age amber and labels it stale; the retained
 *     value still renders as context (rule 1 — last known value may appear as
 *     context, never in the position a current value would occupy).
 *
 * All three are optional and additive, so panels not yet opted into the trust
 * contract (e.g. RecentMerges) keep rendering exactly as before.
 */
export function Section({
  id,
  title,
  subtitle,
  count,
  loading,
  error,
  empty,
  emptyMessage,
  generatedAt,
  unknown,
  stale,
  children,
}) {
  return (
    <section id={id} className="bg-zinc-800/50 rounded-lg border border-zinc-700 p-6">
      <header className="flex items-baseline justify-between gap-4 mb-3">
        <div>
          <h2 className="text-sm uppercase tracking-wide text-zinc-400 mb-1">
            {title}
            {typeof count === "number" && (
              <span className="ml-2 px-2 py-0.5 text-xs rounded bg-zinc-700/60 text-zinc-300">
                {count}
              </span>
            )}
          </h2>
          {subtitle && <p className="text-xs text-zinc-500">{subtitle}</p>}
        </div>
        {/* ADR-0034 §5.4 — as-of age is always visible, every status branch. */}
        {generatedAt && (
          <div className="text-xs text-zinc-500 shrink-0">
            {stale && <span className="text-amber-400">stale · </span>}
            as of <LocalTimestamp ts={generatedAt} stale={stale} />
          </div>
        )}
      </header>

      {loading && !children && (
        <div className="h-16 bg-zinc-700/30 rounded animate-pulse" />
      )}

      {/* ADR-0034 §5.1 — unverifiable renders UNKNOWN, never a confident value. */}
      {unknown && (
        <div className="border border-zinc-700 bg-zinc-800 rounded-md p-3 text-sm">
          <div className="font-semibold text-zinc-300">UNKNOWN</div>
          <div className="text-zinc-500">
            Can&apos;t confirm this is current
            {error && (
              <span className="font-mono break-all text-xs text-zinc-600"> — {error}</span>
            )}
          </div>
        </div>
      )}

      {!unknown && error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-300 rounded-md p-3 text-sm">
          <div className="font-semibold mb-1">Couldn&apos;t load {title.toLowerCase()}</div>
          <div className="font-mono break-all text-xs">{error}</div>
        </div>
      )}

      {!loading && !unknown && !error && empty && (
        <div className="text-sm text-zinc-500 italic">{emptyMessage || "Nothing here."}</div>
      )}

      {!unknown && !error && !empty && children}
    </section>
  );
}

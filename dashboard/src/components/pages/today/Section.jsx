import LocalTimestamp from "../../LocalTimestamp.jsx";

/**
 * Shared section wrapper for the Dashboard v2 Today page.
 *
 * Every section (OperatorDecisionQueue, StuckItems, RecentMerges,
 * NewTargetFindings, LessonsOvernight) has the same chrome — a header
 * row with a title + optional count badge, an explanatory subtitle, and
 * a content well with consistent loading / error / empty states. This
 * component captures that chrome once so the individual sections can
 * focus on their data shape.
 *
 * ## Trust-contract props (ADR-0034 §5, issue #4006)
 *
 * Three optional props extend the chrome for panels migrated onto the trust
 * contract. They default off, so the four other Today sections keep their
 * existing rendering until each migrates slice by slice:
 *
 *   - `generatedAt` — when passed (even as null), an always-visible "as of"
 *     provenance line renders in the header (rule 4), in every status branch.
 *     Null/invalid renders "as of —" (an honest absence), never a hidden gap.
 *   - `unknown`     — render an explicit UNKNOWN placeholder instead of a
 *     confident-looking value (failed fetch, unproven lookup, no timestamp).
 *   - `stale`       — render the retained/aged payload as context, demoted
 *     from current, with a small staleness note above it.
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
  unknown,
  stale,
  generatedAt,
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
        {/* ADR-0034 §5 rule 4: the as-of age is always visible. It lives in the
            header — not a status body — so it shows in every post-load branch
            (ready / empty / stale / unknown-from-unproven-lookup). A caller
            that passes generatedAt (even null) opts in; one that doesn't (the
            four not-yet-migrated sections) sees no change. */}
        {generatedAt !== undefined && (
          <div className="text-xs text-zinc-500 shrink-0 whitespace-nowrap">
            <LocalTimestamp ts={generatedAt} label="as of" />
          </div>
        )}
      </header>

      {loading && !children && (
        <div className="h-16 bg-zinc-700/30 rounded animate-pulse" />
      )}

      {unknown && (
        <div className="bg-amber-500/10 border border-amber-500/30 text-amber-300 rounded-md p-3 text-sm">
          <div className="font-semibold mb-1">UNKNOWN</div>
          <div className="text-xs">
            Can't verify this panel right now — the lookup didn't return an
            asserted result, so nothing here is shown in place of a value.
          </div>
          {error && <div className="font-mono break-all text-xs mt-1">{error}</div>}
        </div>
      )}

      {!unknown && error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-300 rounded-md p-3 text-sm">
          <div className="font-semibold mb-1">Couldn't load {title.toLowerCase()}</div>
          <div className="font-mono break-all text-xs">{error}</div>
        </div>
      )}

      {!loading && !unknown && !error && empty && (
        <div className="text-sm text-zinc-500 italic">{emptyMessage || "Nothing here."}</div>
      )}

      {!unknown && !error && !empty && children && (
        <>
          {stale && (
            <div className="bg-amber-500/5 border border-amber-500/20 text-amber-200/80 rounded-md p-2 text-xs mb-2">
              Stale — showing the last known data; a refresh failed or the payload is past its freshness budget.
            </div>
          )}
          {children}
        </>
      )}
    </section>
  );
}

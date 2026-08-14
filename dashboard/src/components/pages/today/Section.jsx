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
 * ADR-0034 §5.4 trust contract (issue #4006): the header ALWAYS renders an
 * "as of <generatedAt>" age, in every status branch, and the well gains an
 * explicit UNKNOWN branch (distinct from error and empty) plus a STALE marker
 * for retained-but-aged data. A panel that cannot assert its value renders
 * UNKNOWN in place of a confident-looking number or zero — never the empty-
 * state message, never a bare blank.
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
  /**
   * ADR-0034 §5 trust-contract flags (resolved by usePageItems' status):
   *   - unknown: value unverifiable — render the UNKNOWN placeholder.
   *   - stale:   payload aged out / refresh failed with retained data — render
   *              the retained children with a STALE marker.
   * Legacy panels that don't opt in leave these falsy and keep the existing
   * loading/error/empty behaviour unchanged.
   */
  unknown,
  stale,
  /** ISO generatedAt for the always-visible "as of" age (every branch). */
  generatedAt,
  children,
}) {
  return (
    <section id={id} className="bg-zinc-800/50 rounded-lg border border-zinc-700 p-6">
      <header className="flex items-baseline justify-between gap-4 mb-3">
        <div>
          <h2 className="text-sm uppercase tracking-wide text-zinc-400 mb-1">
            {title}
            {typeof count === "number" && !unknown && (
              <span className="ml-2 px-2 py-0.5 text-xs rounded bg-zinc-700/60 text-zinc-300">
                {count}
              </span>
            )}
          </h2>
          {subtitle && <p className="text-xs text-zinc-500">{subtitle}</p>}
        </div>
        {/* ADR-0034 §5.4: the as-of age is always visible for panels that
            supply a generatedAt. Rendered (not hidden behind a toggle) in every
            status branch once data is present; absent only before the first
            payload arrives, when no timestamp exists yet. */}
        {generatedAt ? (
          <LocalTimestamp
            ts={generatedAt}
            prefix="as of "
            className="text-xs text-zinc-500 shrink-0"
          />
        ) : null}
      </header>

      {unknown ? (
        // ADR-0034 §5.1: an unverifiable value renders UNKNOWN — not a
        // confident zero (empty), not a bare blank, not the red error banner.
        // The raw error message, if any, is shown as secondary detail so the
        // operator can see WHY it is unknown without the state reading as a
        // confident failure.
        <div className="rounded-md border border-zinc-700 bg-zinc-900/40 p-3 text-sm text-zinc-400">
          <div className="font-mono uppercase tracking-widest text-zinc-300">UNKNOWN</div>
          {error && <div className="font-mono break-all text-xs text-zinc-500 mt-1">{error}</div>}
        </div>
      ) : loading && !children ? (
        <div className="h-16 bg-zinc-700/30 rounded animate-pulse" />
      ) : stale ? (
        // Retained-but-aged data: render the children (the last known value)
        // with a STALE marker, never in the position a current value would
        // occupy unqualified (ADR-0034 §5.1).
        <div>
          <div className="text-xs text-amber-400/80 italic mb-2">
            stale — showing last known value
            {error && <span className="font-mono text-zinc-500 not-italic"> ({error})</span>}
          </div>
          {children}
        </div>
      ) : error ? (
        <div className="bg-red-500/10 border border-red-500/30 text-red-300 rounded-md p-3 text-sm">
          <div className="font-semibold mb-1">Couldn't load {title.toLowerCase()}</div>
          <div className="font-mono break-all text-xs">{error}</div>
        </div>
      ) : empty ? (
        <div className="text-sm text-zinc-500 italic">{emptyMessage || "Nothing here."}</div>
      ) : (
        children
      )}
    </section>
  );
}

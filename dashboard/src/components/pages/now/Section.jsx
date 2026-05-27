/**
 * Shared section wrapper for the Dashboard v2 Now page.
 *
 * Sibling of `components/pages/today/Section.jsx` — kept separate so each
 * page can evolve its chrome independently. The two stay visually close
 * for now; if they drift, a shared `components/pages/shared/` Module is the
 * right next step.
 */
export function Section({ title, subtitle, count, loading, error, empty, emptyMessage, children }) {
  return (
    <section className="bg-zinc-800/50 rounded-lg border border-zinc-700 p-6">
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
      </header>

      {loading && !children && (
        <div className="h-16 bg-zinc-700/30 rounded animate-pulse" />
      )}

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-300 rounded-md p-3 text-sm">
          <div className="font-semibold mb-1">Couldn't load {title.toLowerCase()}</div>
          <div className="font-mono break-all text-xs">{error}</div>
        </div>
      )}

      {!loading && !error && empty && (
        <div className="text-sm text-zinc-500 italic">{emptyMessage || "Nothing here."}</div>
      )}

      {!error && !empty && children}
    </section>
  );
}

/**
 * Shared section wrapper for the Dashboard v2 Outcomes page.
 *
 * Sibling of dashboard/src/components/v2/today/Section.jsx — same shape
 * with a `right` slot so the Outcomes page can render the per-section
 * "Last N days" label or delta chip in the header.
 */
export function Section({ title, subtitle, right, loading, error, empty, emptyMessage, children }) {
  return (
    <section className="bg-zinc-800/50 rounded-lg border border-zinc-700 p-6">
      <header className="flex items-baseline justify-between gap-4 mb-3">
        <div>
          <h2 className="text-sm uppercase tracking-wide text-zinc-400 mb-1">{title}</h2>
          {subtitle && <p className="text-xs text-zinc-500">{subtitle}</p>}
        </div>
        {right && <div className="text-xs text-zinc-400 shrink-0">{right}</div>}
      </header>

      {loading && !children && (
        <div className="h-24 bg-zinc-700/30 rounded animate-pulse" />
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

/**
 * Shared chrome for Explore tabs — title, optional subtitle, optional
 * action slot, and consistent loading / error / empty states. Mirrors the
 * Today page's `Section.jsx` but rendered as a full panel (no nesting under
 * a higher-level grid), so each tab gets its own page real estate.
 */
export function TabShell({
  title,
  subtitle,
  loading,
  error,
  empty,
  emptyMessage,
  actions,
  children,
}) {
  return (
    <section className="bg-zinc-800/50 rounded-lg border border-zinc-700 p-6">
      <header className="flex items-baseline justify-between gap-4 mb-3">
        <div>
          <h2 className="text-sm uppercase tracking-wide text-zinc-400 mb-1">{title}</h2>
          {subtitle && <p className="text-xs text-zinc-500">{subtitle}</p>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
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
        <div className="text-sm text-zinc-500 italic">{emptyMessage || "Nothing here yet."}</div>
      )}

      {!error && !empty && children}
    </section>
  );
}

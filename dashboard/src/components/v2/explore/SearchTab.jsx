import { useState } from "react";
import { apiFetch } from "../../../hooks/useApi.js";
import { TabShell } from "./TabShell.jsx";

/**
 * SearchTab — thin reshape of the existing `/api/openviking/search` proxy.
 * Lets the operator query the knowledge plane inline without leaving the
 * Explore hub. Results are rendered as a flat list of snippets; deeper
 * exploration still happens on the legacy `/search` page (linked from the
 * footer of this tab).
 */
export function SearchTab() {
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function runSearch(e) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setSubmittedQuery(q);
    setLoading(true);
    setError(null);
    try {
      const result = await apiFetch(
        `/openviking/search?q=${encodeURIComponent(q)}&limit=20`,
      );
      setData(result);
    } catch (err) {
      setError(err.message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  const results = data?.results ?? data?.hits ?? data?.items ?? [];
  const empty = !loading && !error && submittedQuery && results.length === 0;

  const subtitle = "Query the OpenViking knowledge plane (ADRs, docs, prior reports).";

  const actions = (
    <a
      href="/search"
      className="text-xs text-zinc-300 hover:text-amber-300 underline"
    >
      open full search →
    </a>
  );

  return (
    <TabShell
      title="Search"
      subtitle={subtitle}
      loading={loading}
      error={error}
      empty={empty}
      emptyMessage={`No knowledge plane results for "${submittedQuery}".`}
      actions={actions}
    >
      <form onSubmit={runSearch} className="mb-4 flex items-center gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search knowledge plane…"
          className="flex-1 text-sm bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-zinc-100"
          aria-label="Search query"
        />
        <button
          type="submit"
          disabled={!query.trim()}
          className="text-sm bg-amber-500/20 text-amber-200 border border-amber-500/30 rounded px-3 py-1.5 disabled:opacity-50"
        >
          Search
        </button>
      </form>

      {submittedQuery && !loading && !error && results.length > 0 && (
        <ul className="divide-y divide-zinc-700/50">
          {results.map((r, i) => (
            <li key={r.id || r.url || i} className="py-2">
              {r.title && (
                <div className="text-sm text-zinc-100 font-semibold truncate">{r.title}</div>
              )}
              {r.snippet && (
                <div className="text-xs text-zinc-400 line-clamp-2">{r.snippet}</div>
              )}
              {(r.path || r.url) && (
                <a
                  href={r.url || r.path}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[10px] text-zinc-500 hover:text-amber-300 font-mono break-all"
                >
                  {r.url || r.path}
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </TabShell>
  );
}

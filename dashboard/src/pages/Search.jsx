import { useState } from "react";
import { apiFetch } from "../hooks/useApi.js";

export default function Search() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function handleSearch(e) {
    e.preventDefault();
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch(`/openviking/search?q=${encodeURIComponent(query.trim())}`);
      setResults(data);
    } catch (err) {
      setError(err.message);
      setResults(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Knowledge Search</h1>

      <form onSubmit={handleSearch} className="flex gap-3">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search OpenViking knowledge base..."
          className="flex-1 bg-zinc-900 border border-zinc-700 rounded-lg px-4 py-2.5 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
        />
        <button
          type="submit"
          disabled={loading || !query.trim()}
          className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-sm rounded-lg transition-colors"
        >
          {loading ? "Searching..." : "Search"}
        </button>
      </form>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {results && (
        <div className="space-y-3">
          <p className="text-xs text-zinc-500">
            {Array.isArray(results.results || results) ? (results.results || results).length : 0} results
          </p>
          {(results.results || (Array.isArray(results) ? results : [])).map((result, i) => (
            <div key={i} className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
              <div className="flex items-start justify-between mb-2">
                <h3 className="text-sm font-medium text-white">
                  {result.title || result.path || result.name || `Result ${i + 1}`}
                </h3>
                {result.score != null && (
                  <span className="text-xs text-zinc-500 shrink-0 ml-2">
                    {(result.score * 100).toFixed(0)}% match
                  </span>
                )}
              </div>
              {result.content && (
                <p className="text-xs text-zinc-400 line-clamp-3 whitespace-pre-wrap">{result.content}</p>
              )}
              {result.snippet && (
                <p className="text-xs text-zinc-400 line-clamp-3 whitespace-pre-wrap">{result.snippet}</p>
              )}
              {result.path && (
                <p className="text-[10px] text-zinc-600 mt-2 font-mono">{result.path}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {!results && !error && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-12 text-center">
          <p className="text-sm text-zinc-600">Search the OpenViking knowledge base for vault content, reports, and learnings</p>
        </div>
      )}
    </div>
  );
}

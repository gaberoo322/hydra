import { useApi, apiFetch } from "../hooks/useApi.js";
import { useState } from "react";
import { useToast } from "../hooks/useToast.jsx";

export default function Queue() {
  const { data: queue, refresh: refreshQueue } = useApi("/queue", { poll: 10000 });
  const { data: research, refresh: refreshResearch } = useApi("/research/latest");
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [researching, setResearching] = useState(false);
  const toast = useToast();

  async function handleSubmit(e) {
    e.preventDefault();
    if (!reference.trim()) return;
    setSubmitting(true);
    try {
      await apiFetch("/queue", {
        method: "POST",
        body: JSON.stringify({ reference: reference.trim(), reason: reason.trim(), source: "dashboard" }),
      });
      setReference("");
      setReason("");
      toast("Added to queue");
      refreshQueue();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleStartResearch() {
    setResearching(true);
    try {
      const result = await apiFetch("/research/start", { method: "POST" });
      toast(`Research complete — ${result.opportunityCount ?? 0} opportunities found`);
      refreshResearch();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setResearching(false);
    }
  }

  const items = queue || [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Work Queue</h1>
        <button
          onClick={handleStartResearch}
          disabled={researching}
          className="text-xs px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded transition-colors"
        >
          {researching ? "Researching..." : "Start Research"}
        </button>
      </div>

      {/* Add to queue */}
      <form onSubmit={handleSubmit} className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
        <h2 className="text-sm font-semibold text-zinc-400 mb-3">Queue Work</h2>
        <div className="space-y-3">
          <input
            type="text"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="What to build or fix..."
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
          />
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why (optional)"
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
          />
          <button
            type="submit"
            disabled={submitting || !reference.trim()}
            className="text-xs px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded transition-colors"
          >
            {submitting ? "Adding..." : "Add to Queue"}
          </button>
        </div>
      </form>

      {/* Queue contents */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
        <h2 className="text-sm font-semibold text-zinc-400 mb-3">
          Queued Items ({items.length})
        </h2>
        <div className="space-y-2">
          {items.map((item, i) => (
            <div key={i} className="flex items-start justify-between bg-zinc-800/50 rounded px-3 py-2">
              <div>
                <p className="text-sm text-white">{item.reference || item}</p>
                {item.reason && <p className="text-xs text-zinc-500 mt-0.5">{item.reason}</p>}
              </div>
              {item.source && (
                <span className="text-[10px] text-zinc-600 shrink-0">{item.source}</span>
              )}
            </div>
          ))}
          {items.length === 0 && (
            <p className="text-sm text-zinc-600 py-2 text-center">Queue is empty</p>
          )}
        </div>
      </div>

      {/* Latest research */}
      {research && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
          <h2 className="text-sm font-semibold text-zinc-400 mb-3">Latest Research</h2>
          {research.opportunities?.length > 0 ? (
            <div className="space-y-2">
              {research.opportunities.slice(0, 10).map((opp, i) => (
                <div key={i} className="flex items-center justify-between text-sm bg-zinc-800/50 rounded px-3 py-2">
                  <span className="text-zinc-200">{opp.title || opp}</span>
                  {opp.score != null && (
                    <span className="text-xs text-zinc-500">{opp.score.toFixed(1)}</span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-zinc-600">No research results</p>
          )}
        </div>
      )}
    </div>
  );
}

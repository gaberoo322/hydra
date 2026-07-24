import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useApi } from "../hooks/useApi.js";
import MessageCard from "../components/dispatch/MessageCard.jsx";
import MetaStrip from "../components/dispatch/MetaStrip.jsx";

// Issue #695 — subagent transcript viewer.
//
// Renders the JSONL conversation of any active or recently-completed subagent
// dispatch at /dispatch/:dispatchId/transcript. The :dispatchId path param is
// the harness sessionId (the unified active-dispatch row's id for the subagent
// source). The page is deep-linkable: it reads everything it needs from the
// URL + a one-shot fetch, with no required client-side state.
//
// v1 render policy (per the gate-approved design concept for #695):
//   - user/assistant/system filter toggles
//   - tool_use blocks collapsed by default, expand shows input + (paired)
//     tool_result output
//   - thinking blocks collapsed by default
//   - user/assistant text rendered as (minimal, dependency-free) markdown
//   - NO raw-JSON view
//   - missing-JSONL → "transcript not available" with metadata visible

const PAGE_LIMIT = 200;

// ---------------------------------------------------------------------------
// Page
//
// The inline display components (Markdown, ThinkingBlock, ToolBlock,
// MessageCard, MetaStrip) were extracted into ../components/dispatch/ (#3593);
// this file is the routing + data-fetching shell.
// ---------------------------------------------------------------------------

const ALL_ROLES = ["user", "assistant", "system"];

export default function DispatchTranscript() {
  const { dispatchId } = useParams();
  const [offset, setOffset] = useState(0);
  const [roleFilter, setRoleFilter] = useState({ user: true, assistant: true, system: false });

  const { data, error, loading } = useApi(
    `/dispatches/${encodeURIComponent(dispatchId)}/transcript?offset=${offset}&limit=${PAGE_LIMIT}`,
  );

  const messages = Array.isArray(data?.messages) ? data.messages : [];
  const total = Number(data?.total ?? 0);
  const notAvailable = data?.transcriptStatus === "not-available";
  const is404 = error && /^404/.test(error);

  const visible = messages.filter((m) => roleFilter[m.role]);

  const header = (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <h1 className="text-2xl font-bold text-white">Dispatch transcript</h1>
        <Link to="/now" className="text-xs text-blue-400 hover:underline">← Back to Now</Link>
      </div>
      <p className="text-sm text-zinc-500 font-mono">{dispatchId}</p>
    </div>
  );

  if (loading && !data) {
    return (
      <div className="p-6 space-y-5">
        {header}
        <div className="text-zinc-500 text-sm">Loading…</div>
      </div>
    );
  }

  if (is404) {
    return (
      <div className="p-6 space-y-5">
        {header}
        <div className="border border-zinc-800 rounded-lg p-6 bg-zinc-900/50">
          <h2 className="text-base font-semibold text-zinc-200 mb-1">Dispatch not found</h2>
          <p className="text-sm text-zinc-500">
            No subagent dispatch is registered for this id. Subagent rows expire 24h after the session starts.
          </p>
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="p-6 space-y-5">
        {header}
        <div className="border border-zinc-800 rounded-lg p-6 bg-zinc-900/50">
          <h2 className="text-base font-semibold text-red-400 mb-1">Failed to load transcript</h2>
          <p className="text-sm text-zinc-500 font-mono">{error}</p>
        </div>
      </div>
    );
  }

  const meta = data?.sessionMetadata;

  return (
    <div className="p-6 space-y-5">
      {header}
      <MetaStrip meta={meta} />

      {notAvailable ? (
        <div className="border border-amber-700/40 rounded-lg p-6 bg-amber-900/10">
          <h2 className="text-base font-semibold text-amber-300 mb-1">Transcript not available</h2>
          <p className="text-sm text-zinc-400">
            This dispatch is registered, but its conversation transcript is not on disk
            (it may have been cleaned up, or the session never wrote one). The dispatch
            metadata above is all that remains.
          </p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] uppercase tracking-widest text-zinc-500 mr-1">show</span>
            {ALL_ROLES.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRoleFilter((prev) => ({ ...prev, [r]: !prev[r] }))}
                className={`text-[11px] px-2 py-0.5 rounded-full border ${roleFilter[r] ? "border-emerald-500/50 bg-emerald-900/20 text-emerald-300" : "border-zinc-700 text-zinc-400 hover:border-zinc-600"}`}
              >
                {r}
              </button>
            ))}
            <span className="ml-auto text-[11px] text-zinc-500">
              {visible.length} shown · {total} total
            </span>
          </div>

          <div className="space-y-2">
            {visible.length === 0 ? (
              <div className="text-sm text-zinc-500 italic">
                {messages.length === 0
                  ? "No messages on this page."
                  : "No messages match the current filter."}
              </div>
            ) : (
              visible.map((m, idx) => <MessageCard key={offset + idx} message={m} />)
            )}
          </div>

          {total > PAGE_LIMIT && (
            <div className="flex items-center justify-between pt-2 border-t border-zinc-800/60">
              <button
                type="button"
                disabled={offset === 0}
                onClick={() => setOffset((o) => Math.max(0, o - PAGE_LIMIT))}
                className="text-xs px-3 py-1.5 rounded border border-zinc-700 text-zinc-300 hover:border-zinc-500 disabled:opacity-40"
              >
                ← Newer page
              </button>
              <span className="text-[11px] text-zinc-500 font-mono">
                {offset + 1}–{Math.min(offset + PAGE_LIMIT, total)} of {total}
              </span>
              <button
                type="button"
                disabled={offset + PAGE_LIMIT >= total}
                onClick={() => setOffset((o) => o + PAGE_LIMIT)}
                className="text-xs px-3 py-1.5 rounded border border-zinc-700 text-zinc-300 hover:border-zinc-500 disabled:opacity-40"
              >
                Older page →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

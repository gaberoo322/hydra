import { useState, useEffect, useRef } from "react";
import { API_BASE } from "../lib/autopilot-format.js";

// Slice 3 of epic #496 (issue #499) — "Why did that crash?" log tail + systemd
// journal cluster. Extracted from dashboard/src/pages/Autopilot.jsx (issue
// #3589) into its own focused module together with the LogTailPanel +
// JournalPanel it composes. Behavior is identical to the inline originals.
//
// Two read-only surfaces over the autopilot's runtime logs:
//   - /api/autopilot/runs/:runId/log?tail=N  — tail of the nightly run log
//     (live for the current run, .prev for the immediately prior one).
//   - /api/autopilot/runs/:runId/journal     — systemd journal slice for the
//     run window. One-shot, not polled.
//
// Both return plain text. Panel is collapsed by default to avoid the noisy
// log dump in the operator's face during normal "is it alive?" checks; the
// journal section is a separate one-shot fetch behind its own button so we
// don't spam journalctl on every poll.

function LogTailPanel({ runId }) {
  const [expanded, setExpanded] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [source, setSource] = useState(null);
  const preRef = useRef(null);

  useEffect(() => {
    if (!expanded || !runId) return undefined;
    let cancelled = false;
    const fetchOnce = async () => {
      setLoading(true);
      try {
        const res = await fetch(`${API_BASE}/autopilot/runs/${encodeURIComponent(runId)}/log?tail=50`);
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          if (!cancelled) {
            setError(`${res.status}: ${body || res.statusText}`);
            setText("");
          }
          return;
        }
        const body = await res.text();
        if (cancelled) return;
        setSource(res.headers.get("x-autopilot-log-source"));
        setText(body);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err.message || String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchOnce();
    const id = setInterval(fetchOnce, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [expanded, runId]);

  // Auto-scroll to bottom when text grows.
  useEffect(() => {
    if (expanded && preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [expanded, text]);

  return (
    <div className="border border-zinc-800 rounded-md bg-zinc-900/30">
      <button
        type="button"
        className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left hover:bg-zinc-800/40 transition-colors"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex items-baseline gap-3 min-w-0">
          <span className="text-sm font-mono text-zinc-200">Log tail</span>
          <span className="text-xs text-zinc-500">
            {expanded ? `polling every 5s${source ? ` · source: ${source}` : ""}` : "Show last 50 log lines"}
          </span>
        </div>
        <span className="text-zinc-500 text-xs">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <div className="px-3 pb-3 space-y-2">
          {error && (
            <div className="text-xs text-red-400 font-mono px-1">{error}</div>
          )}
          <pre
            ref={preRef}
            className="text-[11px] font-mono text-zinc-300 bg-zinc-950/60 border border-zinc-800 rounded p-2 max-h-80 overflow-auto whitespace-pre-wrap break-words"
          >
            {text || (loading ? "loading…" : "(no log content)")}
          </pre>
        </div>
      )}
    </div>
  );
}

function JournalPanel({ runId }) {
  const [text, setText] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [timedOut, setTimedOut] = useState(false);

  const fetchJournal = async () => {
    setLoading(true);
    setError(null);
    setTruncated(false);
    setTimedOut(false);
    try {
      const res = await fetch(`${API_BASE}/autopilot/runs/${encodeURIComponent(runId)}/journal`);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        setError(`${res.status}: ${body || res.statusText}`);
        setText(null);
        return;
      }
      setTruncated(res.headers.get("x-autopilot-journal-truncated") === "true");
      setTimedOut(res.headers.get("x-autopilot-journal-timed-out") === "true");
      const body = await res.text();
      setText(body);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="border border-zinc-800 rounded-md bg-zinc-900/30">
      <div className="px-3 py-2 flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-3 min-w-0">
          <span className="text-sm font-mono text-zinc-200">systemd journal</span>
          <span className="text-xs text-zinc-500">point-in-time snapshot for this run's window</span>
        </div>
        <button
          type="button"
          onClick={fetchJournal}
          disabled={loading || !runId}
          className="text-[11px] px-2 py-1 rounded border border-zinc-700 hover:border-zinc-500 text-zinc-300 disabled:opacity-50"
        >
          {loading ? "loading…" : text !== null ? "Refresh" : "Open systemd journal"}
        </button>
      </div>
      {(text !== null || error) && (
        <div className="px-3 pb-3 space-y-2">
          {error && (
            <div className="text-xs text-red-400 font-mono px-1">{error}</div>
          )}
          {(truncated || timedOut) && (
            <div className="text-[11px] text-amber-400 px-1">
              {truncated && "output truncated at 1MB"}
              {truncated && timedOut ? " · " : ""}
              {timedOut && "journalctl exceeded 10s timeout"}
            </div>
          )}
          {text !== null && (
            <pre className="text-[11px] font-mono text-zinc-300 bg-zinc-950/60 border border-zinc-800 rounded p-2 max-h-96 overflow-auto whitespace-pre-wrap break-words">
              {text || "(no journal output for window)"}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export default function LogsSection({ runId }) {
  return (
    <div className="border border-zinc-800 rounded-lg p-5 bg-zinc-900/40 space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-base font-semibold text-zinc-100">Why did that crash?</h2>
        <span className="text-[10px] uppercase tracking-widest text-zinc-500">log tail + journal</span>
      </div>
      <JournalPanel runId={runId} />
      <LogTailPanel runId={runId} />
    </div>
  );
}

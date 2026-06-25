import { useEffect, useState } from "react";
import { formatTokens } from "./console-state.ts";

/**
 * RunDetailDrawer — right-side slide-over showing the full detail of one
 * autopilot run (issue #2410, parent #2408).
 *
 * Opened from a RunHistoryStrip cell. Fetches GET /autopilot/runs/:runId
 * (the per-run detail endpoint that already exists — returns
 * `{ run, turns }`) and renders the run's identity, lifecycle, and the
 * MERGED PR NUMBERS derived client-side from
 * `turns[].actions[].outcome.prNumber`. No new backend: PR numbers are NOT
 * added to the list digest projection (that would be a src/ Tier-3 change);
 * they come from this detail fetch only.
 *
 * Degrades gracefully: a loading or failed fetch renders an inline state
 * inside the slide-over and NEVER blank-screens /now — RunHistoryStrip and
 * the rest of NowConsole stay mounted regardless. Closing semantics mirror
 * RecRunJournalModal: ✕ button, ESC key, or backdrop click.
 */

const GH_PR_BASE = "https://github.com/gaberoo322/hydra/pull/";

function formatDuration(s) {
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 3600) return `${(n / 3600).toFixed(1)}h`;
  if (n >= 60) return `${Math.round(n / 60)}m`;
  return `${Math.round(n)}s`;
}

/**
 * Extract the merged PR numbers from a run-detail `turns` array. Mirrors the
 * exact join src/autopilot/run-projections.ts performs: a dispatch action
 * (`action.type === "dispatch"`) whose joined cycle outcome carries a
 * non-null `prNumber`. De-duplicated, in first-seen order. Defensive against
 * missing/partial shapes — a malformed turn never throws.
 */
function extractMergedPrs(turns) {
  if (!Array.isArray(turns)) return [];
  const seen = new Set();
  const out = [];
  for (const turn of turns) {
    const actions = Array.isArray(turn?.actions) ? turn.actions : [];
    for (const a of actions) {
      if (a && a.type === "dispatch" && a.outcome && a.outcome.prNumber != null) {
        const n = Number(a.outcome.prNumber);
        if (Number.isFinite(n) && n > 0 && !seen.has(n)) {
          seen.add(n);
          out.push(n);
        }
      }
    }
  }
  return out;
}

function Field({ label, children, testid }) {
  return (
    <div className="flex justify-between gap-3 py-1 border-b border-zinc-900">
      <span className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</span>
      <span className="text-[11px] font-mono text-zinc-200 text-right" data-testid={testid}>
        {children}
      </span>
    </div>
  );
}

export default function RunDetailDrawer({ runId, onClose }) {
  const [run, setRun] = useState(null);
  const [turns, setTurns] = useState([]);
  const [state, setState] = useState("loading"); // loading | ready | error
  const [errorMsg, setErrorMsg] = useState(null);

  // Fetch detail whenever the selected run changes.
  useEffect(() => {
    if (!runId) return undefined;
    let cancelled = false;
    setState("loading");
    setErrorMsg(null);
    fetch(`/api/autopilot/runs/${encodeURIComponent(runId)}`)
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((body) => {
        if (cancelled) return;
        setRun(body?.run ?? null);
        setTurns(Array.isArray(body?.turns) ? body.turns : []);
        setState("ready");
      })
      .catch((err) => {
        if (cancelled) return;
        setErrorMsg(err?.message || String(err));
        setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  // ESC to close.
  useEffect(() => {
    if (!runId) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [runId, onClose]);

  if (!runId) return null;

  const mergedPrs = extractMergedPrs(turns);
  // The detail view uses cumulative_tokens / elapsed_s; tolerate the list
  // digest's total_tokens / duration_s too in case either is present.
  const tokens = run?.cumulative_tokens ?? run?.total_tokens;
  const durationS = run?.elapsed_s ?? run?.duration_s;

  return (
    <div
      data-testid="run-detail-backdrop"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        justifyContent: "flex-end",
        zIndex: 100,
      }}
    >
      <div
        data-testid="run-detail-drawer"
        role="dialog"
        aria-label="Run detail"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#09090b",
          borderLeft: "1px solid #3f3f46",
          width: "min(440px, 92vw)",
          height: "100%",
          padding: 16,
          display: "flex",
          flexDirection: "column",
          color: "#d4d4d8",
        }}
      >
        <div className="flex items-center justify-between mb-3">
          <div className="text-xs uppercase tracking-wider text-zinc-400">
            Run detail
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close run detail"
            data-testid="run-detail-close"
            className="bg-transparent border-0 cursor-pointer text-zinc-500"
            style={{ fontSize: 14 }}
          >
            ✕
          </button>
        </div>

        <div className="overflow-y-auto flex-1">
          {state === "loading" ? (
            <p data-testid="run-detail-loading" className="text-[11px] text-zinc-500 italic">
              Loading run detail…
            </p>
          ) : state === "error" ? (
            <p data-testid="run-detail-error" className="text-[11px] text-rose-400">
              Could not load run detail{errorMsg ? ` (${errorMsg})` : ""}.
            </p>
          ) : (
            <>
              <Field label="Run" testid="run-detail-run-id">
                <span title={run?.run_id}>{String(run?.run_id ?? "—").slice(0, 16)}</span>
              </Field>
              <Field label="Status" testid="run-detail-status">{run?.status ?? "—"}</Field>
              <Field label="Trigger" testid="run-detail-trigger">{run?.trigger ?? "—"}</Field>
              <Field label="Term reason" testid="run-detail-term-reason">
                {run?.term_reason ?? "—"}
              </Field>
              <Field label="Duration" testid="run-detail-duration">
                {formatDuration(durationS)}
              </Field>
              <Field label="Turns" testid="run-detail-turns">{run?.turns ?? 0}</Field>
              <Field label="Dispatches" testid="run-detail-dispatches">
                {run?.dispatches ?? 0}
              </Field>
              <Field label="Tokens" testid="run-detail-tokens">{formatTokens(tokens)}</Field>
              <Field label="Exit code" testid="run-detail-exit-code">
                {run?.exit_code == null ? "—" : run.exit_code}
              </Field>

              <div className="mt-3">
                <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
                  Merged PRs
                </div>
                {mergedPrs.length === 0 ? (
                  <p data-testid="run-detail-no-prs" className="text-[11px] text-zinc-500 italic">
                    No merged PRs in this run.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-1.5" data-testid="run-detail-prs">
                    {mergedPrs.map((n) => (
                      <a
                        key={n}
                        href={`${GH_PR_BASE}${n}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[11px] font-mono text-sky-400 underline decoration-dotted"
                        data-testid={`run-detail-pr-${n}`}
                      >
                        #{n}
                      </a>
                    ))}
                  </div>
                )}
              </div>

              <div className="mt-3 flex gap-3">
                <a
                  href={`/api/autopilot/runs/${encodeURIComponent(run?.run_id ?? "")}/log`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[11px] text-zinc-400 underline decoration-dotted"
                  data-testid="run-detail-log-link"
                >
                  Log
                </a>
                <a
                  href={`/api/autopilot/runs/${encodeURIComponent(run?.run_id ?? "")}/journal`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[11px] text-zinc-400 underline decoration-dotted"
                  data-testid="run-detail-journal-link"
                >
                  Journal
                </a>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

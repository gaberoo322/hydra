import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, useServerConfirmedWrite } from "../../hooks/useApi.js";
import { usePageItems } from "../../hooks/usePageItems.js";
import { useUndoWindowHost, UndoToastStack } from "../../components/ActionAffordance.jsx";
import { triggerDisabled, undoWindowSeconds } from "../../lib/delayed-commit.ts";
import LocalTimestamp from "../../components/LocalTimestamp.jsx";

/**
 * RecommendationsPanel — the /now recommendation engine's active recs with
 * their two operator controls (issue #4634, design-concept a7e7fedb
 * INV-2/4/9/10/11; ADR-0034 §7, §9.1, §9.4).
 *
 * The ONE owner of GET /now/recommendations, both POST literals, the undo
 * host and the mute arm state — NowConsole.jsx only mounts it.
 *
 * Controls, page-local by design (INV-9): the `control:` registry namespace
 * these two routes would be filed under exists only in #4629's approved
 * concept, so this slice uses the SAME grammar as the attention feed's typed
 * dismiss (#4628) and leaves the registry entry to a tracked follow-up.
 *
 *   Dismiss (one per rec) — immediate-undo, realised as the ~5 s delayed
 *   commit: the panel hosts useUndoWindowHost + UndoToastStack; Undo cancels
 *   before ANY request is sent; expiry fires the POST. The row's control is
 *   disabled while its window is pending or its request is in flight
 *   (triggerDisabled over the host's shared in-flight set).
 *
 *   Mute <severity> (panel header, closed enum info | warn | critical — the
 *   route schema's vocabulary, exactly these three) — confirm-first: arm →
 *   "Confirm mute <severity>?" / Cancel with the consequence restated, firing
 *   through useServerConfirmedWrite.
 *
 * Both POST bodies carry the `run_id` THIS panel's GET returned (captured at
 * click / arm time) — never the literal "current" — so a run that rolls over
 * between read and click cannot land the write on the new run.
 *
 * Server-confirmed, never optimistic (INV-10, ADR-0034 §7): ✓ renders only
 * once the POST resolved AND the panel's re-read settled; a dismissed rec or
 * muted severity disappears ONLY through that re-read (the server's
 * filterActiveRecommendations policy). A failed POST renders a persistent ✗
 * line with the server message (on the row for dismiss, in the header for
 * mute); an accepted POST whose re-read failed renders
 * "✓ accepted · re-read FAILED — list may be stale".
 *
 * Trust (ADR-0034 §5): usePageItems, minutes budget (5 min), polled every
 * 30 s. Zero is asserted on `run_id`: null is the explicit "no autopilot run"
 * row; `items: []` WITH a run_id is an asserted empty.
 */

const FIVE_MIN_MS = 5 * 60 * 1000;

/** RecMuteClassBodySchema's closed severity enum — exactly these three. */
const SEVERITIES = ["info", "warn", "critical"];

const SEVERITY_CHIP = {
  info: "bg-sky-500/10 text-sky-300 border-sky-500/30",
  warn: "bg-amber-500/10 text-amber-300 border-amber-500/30",
  critical: "bg-red-500/10 text-red-300 border-red-500/30",
};

const DISMISS_CONSEQUENCE =
  "this recommendation leaves the list for this run; there is no un-dismiss route — Undo within the window cancels before anything is sent";

function muteConsequence(severity) {
  return `every ${severity} recommendation is hidden for the rest of this run (until the run record expires); there is no un-mute route`;
}

/** The undo-window id a rec's dismiss is armed under (one per rec). */
function dismissWindowId(rec) {
  return `dismiss-rec:${rec.id}`;
}

function recText(rec) {
  return rec?.message ?? rec?.title ?? rec?.summary ?? String(rec?.id ?? "recommendation");
}

function ResultLine({ result }) {
  if (!result) return null;
  return (
    <div
      role={result.ok ? "status" : "alert"}
      aria-live="polite"
      className={`break-all font-mono text-[11px] ${result.ok ? "text-emerald-300" : "text-red-300"}`}
    >
      {result.text}
    </div>
  );
}

export default function RecommendationsPanel() {
  const { items, data, status, error, loading, refresh } = usePageItems("/now/recommendations", {
    itemsKey: "items",
    freshnessMs: FIVE_MIN_MS,
    poll: 30_000,
  });
  const readRunId = typeof data?.run_id === "string" && data.run_id ? data.run_id : null;

  // ---- Re-read verdict (the #4628 AttentionFeed pattern) -------------------
  // A waiter is queued before refresh() starts; the effect resolves it once a
  // render shows the read settled — true when that read carried no error.
  const rereadWaiters = useRef([]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const waiters = rereadWaiters.current;
      rereadWaiters.current = [];
      for (const resolve of waiters) resolve(false);
    };
  }, []);
  useEffect(() => {
    if (loading || rereadWaiters.current.length === 0) return;
    const waiters = rereadWaiters.current;
    rereadWaiters.current = [];
    for (const resolve of waiters) resolve(error == null);
  }, [loading, error, data]);
  const refreshChecked = useCallback(() => {
    if (!mounted.current) return Promise.resolve(false);
    const settled = new Promise((resolve) => rereadWaiters.current.push(resolve));
    refresh();
    return settled;
  }, [refresh]);

  // ---- Dismiss: immediate-undo via the delayed-commit window --------------
  const undoHost = useUndoWindowHost();
  // Per-rec outcome lines, keyed by rec id. A rec still in the list shows its
  // line on its row; a rec the re-read removed shows it in the panel header.
  const [dismissResults, setDismissResults] = useState({});
  const recordDismiss = useCallback((rec, result) => {
    if (!mounted.current) return;
    setDismissResults((prev) => ({ ...prev, [rec.id]: { ...result, label: recText(rec) } }));
  }, []);

  const dismissRec = useCallback(
    (rec, runId) =>
      undoHost.track(dismissWindowId(rec), async () => {
        try {
          await apiFetch(`/now/recommendations/${encodeURIComponent(rec.id)}/dismiss`, {
            method: "POST",
            body: JSON.stringify({ run_id: runId }),
          });
        } catch (err) {
          /* intentional: the persistent inline ✗ line on the rec's row is the
             failure surface — visible until a later dismiss of it succeeds */
          recordDismiss(rec, { ok: false, text: `✗ dismiss failed — ${err?.message || String(err)}` });
          return;
        }
        const reread = await refreshChecked();
        recordDismiss(
          rec,
          reread
            ? { ok: true, text: "✓ dismissed — confirmed by re-read" }
            : { ok: true, text: "✓ accepted · re-read FAILED — list may be stale" },
        );
      }),
    [refreshChecked, recordDismiss, undoHost.track],
  );

  // Arm the window with the clicked rec AND the run_id this panel read
  // captured in the closure — expiry can never fire a stale pair.
  const onDismissStart = useCallback(
    (rec) => {
      if (!readRunId) return;
      const runId = readRunId;
      undoHost.start(
        dismissWindowId(rec),
        `Dismissing recommendation · ${undoWindowSeconds()} to undo`,
        () => dismissRec(rec, runId),
      );
    },
    [readRunId, undoHost.start, dismissRec],
  );

  // ---- Mute-class: confirm-first via the server-confirmed write hook ------
  const muteRereadOk = useRef(null);
  const refreshForMute = useCallback(async () => {
    muteRereadOk.current = await refreshChecked();
  }, [refreshChecked]);
  const { pending: mutePending, write: writeMute } = useServerConfirmedWrite(refreshForMute);
  const [muteArmed, setMuteArmed] = useState(null); // { severity, runId } | null
  const [muteResult, setMuteResult] = useState(null);

  const confirmMute = async () => {
    if (!muteArmed) return;
    const { severity, runId } = muteArmed;
    muteRereadOk.current = null;
    const res = await writeMute("/now/recommendations/mute-class", { run_id: runId, severity });
    if (!mounted.current) return;
    setMuteArmed(null);
    if (!res.ok) {
      setMuteResult({ ok: false, text: `✗ mute ${severity} failed — ${res.error}` });
    } else if (muteRereadOk.current) {
      setMuteResult({ ok: true, text: `✓ muted ${severity} — confirmed by re-read` });
    } else {
      setMuteResult({ ok: true, text: "✓ accepted · re-read FAILED — list may be stale" });
    }
  };

  const unknown = status === "loading" || status === "unknown";
  const stale = status === "stale";
  const noRun = !unknown && data?.run_id === null;
  const listed = new Set(items.map((r) => r.id));
  const goneResults = Object.entries(dismissResults).filter(([id]) => !listed.has(id));

  return (
    <section
      data-testid="recommendations-panel"
      className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 space-y-2"
    >
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h2 className="text-sm font-semibold text-zinc-200">
          Recommendations{" "}
          {!unknown && !noRun && <span className="text-zinc-500 font-normal">({items.length})</span>}
        </h2>
        <div className="text-xs text-zinc-500">
          {stale && <span className="text-amber-400">stale · </span>}
          as of <LocalTimestamp ts={data?.generatedAt} stale={stale} />
        </div>
      </div>

      {/* Mute-class controls — confirm-first, one per closed-enum severity. */}
      {!unknown && !noRun && (
        <div className="space-y-1">
          {muteArmed ? (
            <div className="flex flex-wrap items-baseline gap-2 text-xs" data-testid="mute-confirm">
              <button
                type="button"
                onClick={confirmMute}
                disabled={mutePending}
                className="rounded border border-red-500/40 px-2 py-0.5 text-red-300 hover:bg-red-500/10 disabled:opacity-40"
              >
                {mutePending ? `Muting ${muteArmed.severity}…` : `Confirm mute ${muteArmed.severity}?`}
              </button>
              <button
                type="button"
                onClick={() => setMuteArmed(null)}
                disabled={mutePending}
                className="text-zinc-400 underline hover:text-zinc-200 disabled:opacity-40"
              >
                Cancel
              </button>
              <span className="text-[11px] text-zinc-500">{muteConsequence(muteArmed.severity)}</span>
            </div>
          ) : (
            <div className="flex flex-wrap items-baseline gap-2 text-xs">
              <span className="text-zinc-500">mute:</span>
              {SEVERITIES.map((severity) => (
                <button
                  key={severity}
                  type="button"
                  onClick={() => {
                    setMuteResult(null);
                    setMuteArmed({ severity, runId: readRunId });
                  }}
                  disabled={mutePending || !readRunId}
                  title={muteConsequence(severity)}
                  className="rounded border border-zinc-700 px-2 py-0.5 text-zinc-400 hover:text-zinc-200 disabled:opacity-40"
                >
                  Mute {severity}…
                </button>
              ))}
            </div>
          )}
          <ResultLine result={muteResult} />
        </div>
      )}

      {/* Outcomes for recs the re-read already removed (their row is gone). */}
      {goneResults.map(([id, result]) => (
        <div key={id} className="text-[11px]">
          <span className="text-zinc-500 truncate">{result.label}: </span>
          <ResultLine result={result} />
        </div>
      ))}

      {unknown ? (
        <div
          data-testid="recommendations-unknown"
          className="border border-zinc-700 rounded-md px-3 py-3 text-sm text-zinc-400 bg-zinc-900/40"
        >
          UNKNOWN — recommendations read unproven.
          {error && <span className="block font-mono text-xs text-zinc-600 break-all">{error}</span>}
        </div>
      ) : noRun ? (
        <p data-testid="recommendations-no-run" className="text-xs text-zinc-500 italic">
          no autopilot run — nothing to recommend
        </p>
      ) : items.length === 0 ? (
        <p data-testid="recommendations-empty" className="text-xs text-zinc-500 italic">
          No active recommendations for run {readRunId}.
        </p>
      ) : (
        <ul className="divide-y divide-zinc-900">
          {items.map((rec) => {
            const windowId = dismissWindowId(rec);
            const disabled =
              !readRunId || triggerDisabled(undoHost.inFlight.has(windowId), undoHost.windows, windowId);
            return (
              <li key={rec.id} data-testid="recommendation-row" className="py-2 space-y-1">
                <div className="flex items-start gap-2">
                  <span
                    className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border shrink-0 ${
                      SEVERITY_CHIP[rec.severity] ?? "bg-zinc-700/40 text-zinc-400 border-zinc-600"
                    }`}
                  >
                    {rec.severity ?? "—"}
                  </span>
                  <span className="flex-1 min-w-0 text-sm text-zinc-200 break-words">{recText(rec)}</span>
                  <span className="text-[11px] text-zinc-500 shrink-0">
                    <LocalTimestamp ts={rec.created_at} />
                  </span>
                </div>
                <div className="flex flex-wrap items-baseline gap-2 pl-1 text-[11px]">
                  <button
                    type="button"
                    onClick={() => onDismissStart(rec)}
                    disabled={disabled}
                    title={DISMISS_CONSEQUENCE}
                    aria-label={`Dismiss recommendation "${recText(rec)}"`}
                    className="text-zinc-400 underline hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Dismiss
                  </button>
                  <span className="text-zinc-600">{DISMISS_CONSEQUENCE}</span>
                </div>
                <ResultLine result={dismissResults[rec.id]} />
              </li>
            );
          })}
        </ul>
      )}

      <UndoToastStack windows={undoHost.windows} onUndo={undoHost.undo} />
    </section>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { usePageItems } from "../../hooks/usePageItems.js";
import {
  ControlAffordance,
  UndoToastStack,
  UndoWindowContext,
  useCheckedRefresh,
  useOperatorActions,
  useUndoWindowHost,
} from "../../components/ActionAffordance.jsx";
import { resolveControlRoute } from "../../lib/health-verdicts.ts";
import {
  REC_SEVERITIES,
  chooseMute,
  muteChoiceMatchesRead,
  readRunIdOf,
  recDismissContext,
  recDismissVerdicts,
  recMuteContext,
  recMuteVerdicts,
} from "../../lib/now-verdicts.ts";
import LocalTimestamp from "../../components/LocalTimestamp.jsx";

/**
 * RecommendationsPanel — the /now recommendation engine's active recs with
 * their two operator controls (issue #4634, design-concept a7e7fedb
 * INV-2/4/9/10/11; ADR-0034 §7, §8.3, §9.1).
 *
 * The ONE owner of GET /now/recommendations, the undo host and the mute
 * choice — NowConsole.jsx only mounts it.
 *
 * Controls (issue #5152): both render through ControlAffordance from the
 * registry entries `control:now/rec-dismiss` and `control:now/rec-mute-class`
 * (src/operator-actions/registry.ts) — label, live ✓/✗ checklist and
 * consequence come from the registry; this file carries none of its own. The
 * two POST routes live in the registry too, so no route literal is spelled
 * here; the request bodies are IN_DASHBOARD_BODY's builders over the
 * `{runId, severity}` context this panel passes.
 *
 *   Dismiss (one per rec) — immediate-undo, realised as the ~5 s delayed
 *   commit: the panel hosts useUndoWindowHost + UndoToastStack and provides
 *   UndoWindowContext; the registry route's `{id}` segment is resolved per
 *   row to the rec id (resolveControlRoute), so each rec gets its OWN undo
 *   window and in-flight flag (`action:POST <resolved route>`). Undo cancels
 *   before ANY request is sent; expiry fires the closure captured at the
 *   click — that rec and that read's run_id.
 *
 *   Mute severity (panel header) — confirm-first. The picker (the closed enum
 *   info | warn | critical, the route schema's vocabulary — REC_SEVERITIES)
 *   only RECORDS the choice together with the run_id the read carried at that
 *   moment (chooseMute — the arm-time capture); the control's
 *   `severity-chosen` line stays ✗ until a severity is picked. The control is
 *   keyed by the choice, so changing it remounts the control — an armed
 *   Confirm never silently swaps to another severity.
 *
 * Both POST bodies carry the `run_id` THIS panel's GET returned — never the
 * schema's `current` alias — so a run that rolls over between read and click
 * cannot land the write on the new run.
 *
 * Server-confirmed, never optimistic (INV-10, ADR-0034 §7): the affordance
 * renders ✓ only once the POST resolved AND this panel's CHECKED re-read
 * (useCheckedRefresh over the usePageItems read) settled; a failed re-read
 * renders "re-read FAILED". A dismissed rec or muted severity disappears ONLY
 * through that re-read (the server's filterActiveRecommendations policy). A
 * dismissed rec's row unmounts on the re-read, so its lifted result is shown
 * in the panel header instead.
 *
 * Trust (ADR-0034 §5): usePageItems, minutes budget (5 min), polled every
 * 30 s. Zero is asserted on `run_id`: null is the explicit "no autopilot run"
 * row; `items: []` WITH a run_id is an asserted empty.
 */

const FIVE_MIN_MS = 5 * 60 * 1000;

const SEVERITY_CHIP = {
  info: "bg-sky-500/10 text-sky-300 border-sky-500/30",
  warn: "bg-amber-500/10 text-amber-300 border-amber-500/30",
  critical: "bg-red-500/10 text-red-300 border-red-500/30",
};

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

/** One rec row: its own route resolver, context and lifted-result callbacks,
 * so two rows never share a window, an in-flight flag or a result. */
function RecRow({ rec, registry, readRunId, onFired, onDismissStart, onDismissResult }) {
  const recId = rec?.id;
  const resolveRoute = useCallback((route) => resolveControlRoute(route, { id: recId }), [recId]);
  const onStart = useCallback(() => onDismissStart(rec), [onDismissStart, rec]);
  const onResult = useCallback((result) => onDismissResult(rec, result), [onDismissResult, rec]);
  return (
    <li data-testid="recommendation-row" className="py-2 space-y-1">
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
      <div className="pl-1">
        <ControlAffordance
          registry={registry}
          controlKey="control:now/rec-dismiss"
          testId={`rec-dismiss-${recId ?? "unknown"}`}
          verdicts={recDismissVerdicts(readRunId)}
          context={recDismissContext(readRunId)}
          resolveRoute={resolveRoute}
          onFired={onFired}
          onStart={onStart}
          onResult={onResult}
          rereadNoun="/now"
        />
      </div>
    </li>
  );
}

export default function RecommendationsPanel() {
  const read = usePageItems("/now/recommendations", {
    itemsKey: "items",
    freshnessMs: FIVE_MIN_MS,
    poll: 30_000,
  });
  const { items, data, status, error } = read;
  const readRunId = readRunIdOf(data);

  // One registry read (no poll — the registry changes only on deploy), and a
  // CHECKED re-read of this panel's own GET as every control's onFired.
  const registry = useOperatorActions();
  const refreshChecked = useCheckedRefresh(read);
  const undoHost = useUndoWindowHost();

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // ---- Dismiss: lifted per-rec results -------------------------------------
  // A listed rec shows its result on its own row (the affordance's line); a
  // rec the re-read removed has no row left, so its lifted result renders in
  // the panel header. Keyed by rec id.
  const [dismissResults, setDismissResults] = useState({});
  // Outcome lines belong to one run: when the read's run_id changes (a new
  // run started) the previous run's lines are dead — drop them.
  useEffect(() => {
    setDismissResults({});
  }, [readRunId]);
  const onDismissStart = useCallback((rec) => {
    if (!mounted.current) return;
    setDismissResults((prev) => {
      if (!(rec.id in prev)) return prev;
      const next = { ...prev };
      delete next[rec.id];
      return next;
    });
  }, []);
  const onDismissResult = useCallback((rec, result) => {
    if (!mounted.current) return;
    setDismissResults((prev) => ({ ...prev, [rec.id]: { ok: result.ok, text: result.text, label: recText(rec) } }));
  }, []);

  // ---- Mute severity: the picker records the choice ------------------------
  const [muteChoice, setMuteChoice] = useState(null); // MuteChoice | null
  const [muteBusy, setMuteBusy] = useState(false);
  // The lifted ✓ line of the last successful mute: the choice is cleared on
  // success (below), which remounts the control and drops its inline line, so
  // the panel keeps it. A failure keeps the choice, so its ✗ stays inline.
  const [muteDone, setMuteDone] = useState(null);
  // A choice belongs to the run it was picked on (PR #5158 review): when the
  // read's run_id changes, the choice and the old run's ✓ line are dead —
  // drop them, the same way dismissResults is dropped. recMuteVerdicts fails
  // a mismatched choice closed for the render before this effect lands.
  useEffect(() => {
    setMuteChoice((prev) => (muteChoiceMatchesRead(prev, readRunId) ? prev : null));
    setMuteDone(null);
  }, [readRunId]);
  const onMuteStart = useCallback(() => {
    if (!mounted.current) return;
    setMuteBusy(true);
    setMuteDone(null);
  }, []);
  const onMuteResult = useCallback((result) => {
    if (!mounted.current) return;
    setMuteBusy(false);
    // Success clears the choice: a second mute needs a fresh pick, pinned to
    // the then-current read.
    if (result?.ok) {
      setMuteChoice(null);
      setMuteDone({ ok: true, text: result.text });
    }
  }, []);

  const unknown = status === "loading" || status === "unknown";
  const stale = status === "stale";
  const noRun = !unknown && data?.run_id === null;
  const listed = new Set(items.map((r) => r.id));
  const goneResults = Object.entries(dismissResults).filter(([id]) => !listed.has(id));

  return (
    <UndoWindowContext.Provider value={undoHost}>
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

        {/* Mute severity — the picker records the choice; the registry control
            fires it (confirm-first). Keyed by the choice: a new pick remounts it. */}
        {!unknown && !noRun && (
          <div className="space-y-1" data-testid="rec-mute">
            <div className="flex flex-wrap items-baseline gap-2 text-xs" role="group" aria-label="severity to mute">
              <span className="text-zinc-500">severity:</span>
              {REC_SEVERITIES.map((severity) => {
                const chosen = muteChoice?.severity === severity;
                return (
                  <button
                    key={severity}
                    type="button"
                    data-testid={`rec-mute-pick-${severity}`}
                    aria-pressed={chosen}
                    onClick={() => {
                      setMuteDone(null);
                      setMuteChoice(chooseMute(severity, readRunId));
                    }}
                    disabled={muteBusy || !readRunId}
                    className={`rounded border px-2 py-0.5 disabled:opacity-40 ${
                      chosen
                        ? "border-zinc-400 bg-zinc-800 text-zinc-100"
                        : "border-zinc-700 text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    {severity}
                  </button>
                );
              })}
            </div>
            <div key={`rec-mute-${muteChoice?.severity ?? "none"}`}>
              <ControlAffordance
                registry={registry}
                controlKey="control:now/rec-mute-class"
                testId="rec-mute-class"
                verdicts={recMuteVerdicts(muteChoice, readRunId)}
                context={recMuteContext(muteChoice)}
                onFired={refreshChecked}
                onStart={onMuteStart}
                onResult={onMuteResult}
                rereadNoun="/now"
              />
            </div>
            <ResultLine result={muteDone} />
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
            {items.map((rec) => (
              <RecRow
                key={rec.id}
                rec={rec}
                registry={registry}
                readRunId={readRunId}
                onFired={refreshChecked}
                onDismissStart={onDismissStart}
                onDismissResult={onDismissResult}
              />
            ))}
          </ul>
        )}

        <UndoToastStack windows={undoHost.windows} onUndo={undoHost.undo} />
      </section>
    </UndoWindowContext.Provider>
  );
}

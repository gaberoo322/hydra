import { useEffect, useState } from "react";
import { apiFetch, useApi } from "../../hooks/useApi.js";
import {
  MUTE_CLASS_PATH,
  NO_PENDING_REMOVALS,
  RECS_PATH,
  RECS_POLL_MS,
  applyPendingRemovals,
  dismissBody,
  dismissPath,
  muteClassBody,
  normaliseRecsResponse,
  runLabel,
  severityColor,
  withDismissedId,
  withMutedSeverity,
} from "./recommendations-tab-state.ts";

/**
 * RecommendationsTab — Oak's third tab, lighting up the LLM-driven
 * recommendation list for the current autopilot run.
 *
 * Slice F of /now-pixel observability (#674, parent #667). The engine
 * (src/autopilot/recommendation-engine.ts) fires at most one Haiku call
 * per turn_end event and persists the result in
 * hydra:autopilot:recs:{run_id}. We poll `/api/now/recommendations` every
 * 5 seconds and render the unmuted, undismissed list newest-first.
 *
 * Affordances:
 *   - Per-rec ✕ button calls POST /api/now/recommendations/:id/dismiss
 *   - Right-click on a rec opens a one-item mute-class context menu
 *     that calls POST /api/now/recommendations/mute-class
 *   - "See full run journal" button opens the per-run history modal
 *     (`RecRunJournalModal`) listing every rec emitted this run, including
 *     ones that have since been dismissed or whose severity is muted.
 *
 * Issue #3706 made this file thin presentation: polling now routes through
 * the shared `useApi` hook (which honours VITE_API_BASE — the hand-rolled
 * fetch here did not), and every fold over the payload lives in
 * `recommendations-tab-state.ts`, pinned by
 * test/now-pixel-recommendations-tab-state.test.mts.
 */
export default function RecommendationsTab({ openJournal }) {
  const { data, error, refresh } = useApi(RECS_PATH, { poll: RECS_POLL_MS });
  // Operator actions the next poll has not yet reflected. Kept as an overlay
  // so the poll remains the single source of truth for the list itself.
  const [pending, setPending] = useState(NO_PENDING_REMOVALS);
  const [menu, setMenu] = useState(null); // { x, y, severity }

  const { items: serverItems, runId } = normaliseRecsResponse(data);
  const items = applyPendingRemovals(serverItems, pending);
  const loadFailed = error != null;

  // Close the right-click menu on any click outside.
  useEffect(() => {
    if (!menu) return;
    const off = () => setMenu(null);
    window.addEventListener("click", off);
    return () => window.removeEventListener("click", off);
  }, [menu]);

  // Plain functions, not useCallback: `runId` is derived from the poll on
  // every render, so a manual dependency list would be invalidated each time
  // anyway — and the React Compiler cannot preserve the memoization over it.
  async function handleDismiss(id) {
    setPending((prev) => withDismissedId(prev, id));
    try {
      await apiFetch(dismissPath(id), {
        method: "POST",
        body: JSON.stringify(dismissBody(runId)),
      });
    } catch (err) {
      console.error("[now-pixel] dismiss recommendation failed", { id, err });
    }
    refresh();
  }

  async function handleMute(severity) {
    setMenu(null);
    setPending((prev) => withMutedSeverity(prev, severity));
    try {
      await apiFetch(MUTE_CLASS_PATH, {
        method: "POST",
        body: JSON.stringify(muteClassBody(runId, severity)),
      });
    } catch (err) {
      console.error("[now-pixel] mute recommendation class failed", {
        severity,
        err,
      });
    }
    refresh();
  }

  return (
    <div className="flex flex-col" data-testid="oak-recs-tab">
      <div className="flex items-center justify-between mb-1">
        <div className="text-[9px] uppercase text-zinc-500">
          {runLabel(runId)}
        </div>
        <button
          type="button"
          onClick={openJournal}
          data-testid="oak-recs-journal-button"
          className="bg-transparent border border-zinc-700 rounded px-2 py-0.5 cursor-pointer"
          style={{ color: "#a1a1aa", fontSize: 9, textTransform: "uppercase" }}
          title="Show every recommendation emitted this run"
        >
          See full run journal
        </button>
      </div>
      <div
        className="overflow-y-auto"
        style={{ maxHeight: 360, minHeight: 120 }}
        data-testid="oak-recs-list"
      >
        {loadFailed ? (
          <p className="text-[10px] text-rose-400 italic">
            Couldn't reach the recommendations API.
          </p>
        ) : items.length === 0 ? (
          <p className="text-[10px] text-zinc-500 italic">
            No active recommendations.
          </p>
        ) : (
          <ul className="space-y-1">
            {items.map((r) => (
              <li
                key={r.id}
                className="text-[10px] leading-tight flex items-start gap-1"
                style={{
                  borderLeft: `3px solid ${severityColor(r.severity)}`,
                  paddingLeft: 6,
                  color: "#d4d4d8",
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, severity: r.severity });
                }}
                data-testid={`oak-rec-${r.id}`}
                data-severity={r.severity}
              >
                <span
                  style={{
                    color: severityColor(r.severity),
                    fontFamily: "monospace",
                    marginRight: 4,
                  }}
                >
                  [{r.severity}]
                </span>
                <span className="flex-1">{r.message}</span>
                <button
                  type="button"
                  onClick={() => handleDismiss(r.id)}
                  aria-label={`Dismiss ${r.id}`}
                  data-testid={`oak-rec-dismiss-${r.id}`}
                  className="bg-transparent border-0 cursor-pointer text-zinc-500"
                  style={{ fontSize: 10 }}
                  title="Dismiss this recommendation"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {menu && (
        <div
          data-testid="oak-recs-mute-menu"
          style={{
            position: "fixed",
            top: menu.y,
            left: menu.x,
            background: "#18181b",
            border: "1px solid #3f3f46",
            borderRadius: 4,
            padding: 4,
            zIndex: 50,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => handleMute(menu.severity)}
            data-testid={`oak-recs-mute-${menu.severity}`}
            className="bg-transparent border-0 cursor-pointer text-zinc-200"
            style={{ fontSize: 10, padding: "4px 8px" }}
          >
            Mute all "{menu.severity}" recs for this run
          </button>
        </div>
      )}
    </div>
  );
}

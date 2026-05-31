import { useEffect, useState, useCallback } from "react";

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
 */

const POLL_MS = 5000;
const RUN_ID_PARAM = "current";

function severityColor(sev) {
  switch (sev) {
    case "critical":
      return "#f87171"; // rose-400
    case "warn":
      return "#fbbf24"; // amber-400
    case "info":
    default:
      return "#7dd3fc"; // sky-300
  }
}

async function fetchActiveRecs() {
  try {
    const res = await fetch(
      `/api/now/recommendations?run_id=${encodeURIComponent(RUN_ID_PARAM)}`,
    );
    if (!res.ok) return { ok: false, status: res.status, items: [], runId: null };
    const body = await res.json();
    return {
      ok: true,
      status: 200,
      items: Array.isArray(body.items) ? body.items : [],
      runId: typeof body.run_id === "string" ? body.run_id : null,
    };
  } catch {
    return { ok: false, status: 0, items: [], runId: null };
  }
}

async function postDismiss(recId, runId) {
  try {
    await fetch(`/api/now/recommendations/${encodeURIComponent(recId)}/dismiss`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ run_id: runId ?? RUN_ID_PARAM }),
    });
  } catch {
    /* intentional: best-effort; next poll re-renders */
  }
}

async function postMuteClass(severity, runId) {
  try {
    await fetch(`/api/now/recommendations/mute-class`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ run_id: runId ?? RUN_ID_PARAM, severity }),
    });
  } catch {
    /* intentional */
  }
}

export default function RecommendationsTab({ openJournal }) {
  const [items, setItems] = useState([]);
  const [runId, setRunId] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [menu, setMenu] = useState(null); // { x, y, severity }

  const refresh = useCallback(async () => {
    const r = await fetchActiveRecs();
    setLoadFailed(!r.ok);
    setItems(r.items);
    setRunId(r.runId);
  }, []);

  useEffect(() => {
    let cancelled = false;
    refresh();
    const id = setInterval(() => {
      if (cancelled) return;
      refresh();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [refresh]);

  // Close the right-click menu on any click outside.
  useEffect(() => {
    if (!menu) return;
    const off = () => setMenu(null);
    window.addEventListener("click", off);
    return () => window.removeEventListener("click", off);
  }, [menu]);

  const handleDismiss = useCallback(
    async (id) => {
      setItems((prev) => prev.filter((r) => r.id !== id));
      await postDismiss(id, runId);
    },
    [runId],
  );

  const handleMute = useCallback(
    async (severity) => {
      setMenu(null);
      setItems((prev) => prev.filter((r) => r.severity !== severity));
      await postMuteClass(severity, runId);
    },
    [runId],
  );

  return (
    <div className="flex flex-col" data-testid="oak-recs-tab">
      <div className="flex items-center justify-between mb-1">
        <div className="text-[9px] uppercase text-zinc-500">
          {runId ? `run ${runId.slice(0, 8)}` : "no run"}
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

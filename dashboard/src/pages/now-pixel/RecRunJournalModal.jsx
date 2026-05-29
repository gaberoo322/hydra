import { useEffect, useState } from "react";

/**
 * RecRunJournalModal — "See full run journal" modal opened from
 * RecommendationsTab. Lists every recommendation emitted during the
 * current autopilot run, including ones that have been dismissed or whose
 * severity class is muted. The active tab shows the operator's curated
 * view; the journal shows the engine's full record so the operator can
 * audit what was filtered.
 *
 * Slice F of /now-pixel observability (#674).
 *
 * Data source: today the active-list endpoint already returns the
 * non-dismissed/non-muted slice; the journal supplements with
 * `include_filtered=true` so the route returns everything. The route
 * understands the flag in addition to the active-only default, mirroring
 * the active-only contract one-for-one when omitted.
 *
 * The modal is intentionally minimal — pixelated styling matches the rest
 * of /now-pixel. Closing semantics: ✕ button, ESC key, or clicking the
 * backdrop.
 */

async function fetchAllRecs() {
  try {
    const res = await fetch(
      `/api/now/recommendations?run_id=current&include_filtered=true`,
    );
    if (!res.ok) return { ok: false, items: [], runId: null };
    const body = await res.json();
    return {
      ok: true,
      items: Array.isArray(body.items) ? body.items : [],
      runId: typeof body.run_id === "string" ? body.run_id : null,
    };
  } catch {
    return { ok: false, items: [], runId: null };
  }
}

function severityColor(sev) {
  switch (sev) {
    case "critical":
      return "#f87171";
    case "warn":
      return "#fbbf24";
    case "info":
    default:
      return "#7dd3fc";
  }
}

export default function RecRunJournalModal({ open, onClose }) {
  const [items, setItems] = useState([]);
  const [runId, setRunId] = useState(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setLoaded(false);
    fetchAllRecs().then((r) => {
      if (cancelled) return;
      setItems(r.items);
      setRunId(r.runId);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // ESC to close.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      data-testid="oak-recs-journal-modal"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.7)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#09090b",
          border: "1px solid #3f3f46",
          borderRadius: 6,
          width: "min(640px, 90vw)",
          maxHeight: "80vh",
          padding: 16,
          display: "flex",
          flexDirection: "column",
          color: "#d4d4d8",
        }}
      >
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs uppercase tracking-wider text-zinc-400">
            Run journal {runId ? `· ${runId.slice(0, 12)}` : ""}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close journal"
            data-testid="oak-recs-journal-close"
            className="bg-transparent border-0 cursor-pointer text-zinc-500"
            style={{ fontSize: 14 }}
          >
            ✕
          </button>
        </div>
        <div className="overflow-y-auto flex-1" data-testid="oak-recs-journal-list">
          {!loaded ? (
            <p className="text-[10px] text-zinc-500 italic">Loading...</p>
          ) : items.length === 0 ? (
            <p className="text-[10px] text-zinc-500 italic">
              Oak hasn't emitted any recommendations yet this run.
            </p>
          ) : (
            <ul className="space-y-1">
              {items.map((r) => (
                <li
                  key={r.id}
                  className="text-[10px] leading-tight"
                  style={{
                    borderLeft: `3px solid ${severityColor(r.severity)}`,
                    paddingLeft: 6,
                  }}
                  data-testid={`oak-recs-journal-row-${r.id}`}
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
                  {r.message}
                  <span
                    style={{
                      color: "#71717a",
                      marginLeft: 8,
                      fontSize: 9,
                    }}
                    title={r.created_at}
                  >
                    {r.evidence_id ?? ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

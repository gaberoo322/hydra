import { useEffect, useRef } from "react";
import LocalTimestamp from "../../components/LocalTimestamp.jsx";

/**
 * PokedexModal — chronological timeline of milestone events for a single
 * battle card (one subagent task).
 *
 * Slice D of /now-observability (epic #667, issue #672). Pure presenter —
 * the entries list is derived in battle-card-state.ts. Click-outside and
 * Escape close the modal; the modal traps focus on the close button so a
 * keyboard operator can dismiss it without grabbing for the mouse.
 */

const CATEGORY_COLOR = {
  milestone: "#fbbf24", // amber-400 — code/state-changing
  io: "#60a5fa",        // blue-400  — external IO
  background: "#9ca3af",// zinc-400  — reads
  stop: "#f87171",      // red-400   — subagent_stop (any status)
  wait: "#facc15",      // yellow-400— slot_waiting_permission
  pr: "#34d399",        // emerald-400— pr_opened
};

export default function PokedexModal({ row, entries = [], onClose = () => {} }) {
  const closeBtnRef = useRef(null);

  useEffect(() => {
    closeBtnRef.current?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!row) return null;
  const runId = row.id;
  // /api/autopilot/runs/:id/log and /journal are the slice-A endpoints the
  // spec calls out — they may 404 today if slice A hasn't shipped. We
  // render the links regardless so they light up automatically once the
  // server-side routes land.
  const logUrl = `/api/autopilot/runs/${encodeURIComponent(runId)}/log`;
  const journalUrl = `/api/autopilot/runs/${encodeURIComponent(runId)}/journal`;

  return (
    <div
      data-testid="pokedex-modal"
      role="dialog"
      aria-label={`Pokedex for ${row.classLabel}`}
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.7)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="rounded-lg border border-zinc-700 bg-zinc-950 text-zinc-100 p-4"
        style={{
          width: "min(560px, 90vw)",
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <header className="flex items-center gap-3 mb-3">
          <img
            src={`/sprites/pokemon/${row.spriteFile}`}
            alt={row.classLabel}
            width={48}
            height={48}
            style={{ imageRendering: "pixelated" }}
          />
          <div className="flex-1 min-w-0">
            <div className="text-sm uppercase tracking-wide font-mono text-zinc-200 truncate">
              {row.classLabel}
            </div>
            <div className="text-[10px] text-zinc-500 font-mono truncate">
              task: {row.id}
            </div>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={onClose}
            aria-label="Close Pokedex"
            data-testid="pokedex-close"
            className="text-zinc-400 hover:text-zinc-100 border border-zinc-700 rounded px-2 py-1 text-xs"
          >
            ✕
          </button>
        </header>

        <div
          data-testid="pokedex-entries"
          className="overflow-y-auto flex-1 -mx-1 px-1"
          style={{ minHeight: 80 }}
        >
          {entries.length === 0 ? (
            <p className="text-xs text-zinc-500 italic">
              No milestone events recorded for this dispatch yet.
            </p>
          ) : (
            <ul className="space-y-1">
              {entries.map((e, idx) => (
                <li
                  key={`${e.ts}-${idx}`}
                  className="text-[11px] leading-tight flex gap-2"
                  style={{
                    borderLeft: `3px solid ${CATEGORY_COLOR[e.category] ?? "#52525b"}`,
                    paddingLeft: 6,
                  }}
                >
                  <LocalTimestamp
                    ts={e.ts}
                    className="text-zinc-500 font-mono w-16 shrink-0"
                  />
                  <span
                    className="font-mono uppercase text-[9px] w-20 shrink-0"
                    style={{ color: CATEGORY_COLOR[e.category] ?? "#a1a1aa" }}
                  >
                    {e.category}
                  </span>
                  <span className="text-zinc-200 break-all">{e.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <footer className="mt-3 pt-2 border-t border-zinc-800 flex gap-3 text-[10px] font-mono">
          <a
            href={logUrl}
            target="_blank"
            rel="noreferrer"
            className="text-sky-400 hover:underline"
            data-testid="pokedex-log-link"
          >
            run log →
          </a>
          <a
            href={journalUrl}
            target="_blank"
            rel="noreferrer"
            className="text-sky-400 hover:underline"
            data-testid="pokedex-journal-link"
          >
            journal →
          </a>
          {row.prRef && (
            <a
              href={
                row.prRef.startsWith("http")
                  ? row.prRef
                  : `https://github.com/${row.prRef.replace(/^#/, "")}`
              }
              target="_blank"
              rel="noreferrer"
              className="text-emerald-400 hover:underline ml-auto"
              data-testid="pokedex-pr-link"
            >
              PR {row.prRef} →
            </a>
          )}
        </footer>
      </div>
    </div>
  );
}

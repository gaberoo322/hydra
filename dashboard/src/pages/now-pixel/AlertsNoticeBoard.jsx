import { useState } from "react";
import { useApi } from "../../hooks/useApi.js";
import LocalTimestamp from "../../components/LocalTimestamp.jsx";

/**
 * AlertsNoticeBoard — red-flag stack pinned to the Autopilot Pavilion.
 *
 * Slice 5 of /now-pixel (#642, #647). Reads /api/now/alerts?sinceMinutes=
 * 60 every 30s and shows the count as a stack of flags; clicking expands
 * a popover with the full list.
 *
 * Auto-hides when alert count == 0 to keep the Pavilion uncluttered.
 */
const SEVERITY_PALETTE = {
  critical: "#ef4444",
  error: "#ef4444",
  warning: "#facc15",
  info: "#38bdf8",
};

export default function AlertsNoticeBoard() {
  const { data } = useApi("/now/alerts?sinceMinutes=60", { poll: 30_000 });
  const items = data?.items ?? [];
  const [open, setOpen] = useState(false);

  if (items.length === 0) return null; // empty/hidden per spec

  // Stack up to 5 flag glyphs; integer overflow rendered as +N.
  const flags = Math.min(items.length, 5);

  return (
    <div
      className="relative inline-block"
      data-testid="alerts-notice-board"
      data-count={items.length}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 px-2 py-1 rounded border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-xs text-zinc-300"
        aria-expanded={open}
        aria-label={`${items.length} alerts`}
      >
        <span style={{ position: "relative", width: 18 + 4 * flags, height: 14 }}>
          {Array.from({ length: flags }).map((_, i) => (
            <span
              key={i}
              style={{
                position: "absolute",
                left: i * 4,
                fontSize: 14,
                color: "#ef4444",
              }}
            >
              ⚑
            </span>
          ))}
        </span>
        <span>
          {items.length}
          {items.length > 5 ? "+" : ""}
        </span>
      </button>
      {open && (
        <div
          className="absolute z-10 mt-2 w-80 max-h-96 overflow-auto rounded-lg border border-zinc-700 bg-zinc-950 p-3 shadow-xl"
          style={{ right: 0 }}
          data-testid="alerts-popover"
        >
          <header className="mb-2 flex items-center justify-between">
            <h3 className="text-xs uppercase text-zinc-400">
              Alerts ({items.length})
            </h3>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-xs text-zinc-500 hover:text-zinc-300"
              aria-label="Close alerts"
            >
              ✕
            </button>
          </header>
          <ul className="space-y-2">
            {items.map((alert) => (
              <li
                key={alert.id}
                className="text-xs text-zinc-300"
                data-severity={alert.severity}
              >
                <div className="flex items-baseline gap-2">
                  <span
                    style={{
                      color:
                        SEVERITY_PALETTE[alert.severity] ??
                        SEVERITY_PALETTE.info,
                      fontWeight: "bold",
                      textTransform: "uppercase",
                      fontSize: 10,
                    }}
                  >
                    {alert.severity ?? "info"}
                  </span>
                  <LocalTimestamp ts={alert.timestamp} className="text-zinc-500 text-[10px]" />
                </div>
                <p className="mt-0.5 break-words">{alert.message}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

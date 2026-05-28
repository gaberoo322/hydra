import { useEffect, useState } from "react";
import { useApi } from "../../hooks/useApi.js";
import {
  classSpriteFile,
  CLASS_BUBBLE_COLOR,
  PIPELINE_CLASSES,
  SIGNAL_CLASSES,
} from "./sprite-map.ts";
import { formatRelativeTime, summariseTurns } from "./oak-tab-state.ts";

/**
 * TurnJournalTab — compact one-row-per-turn ledger inside the OakTownCrier
 * 3-tab panel.
 *
 * Slice B of the autopilot-observability epic (#669, parent #667).
 *
 * Each row collapses to ~24px and shows: turn #, relative time, sprite
 * icons for each dispatched class, and a one-line summary. Clicking a
 * row toggles an inline detail panel listing every dispatch_decision
 * with the reason string.
 *
 * Source: `runs/current.turns[]` (polled every 10s — same cadence as
 * HabitatGrid). Slice A's `turn_start` / `turn_end` WS events will
 * eventually feed this same shape sooner; the polling fallback means
 * the journal is correct even when WS frames are missed entirely.
 */
const KNOWN_CLASSES = new Set([...PIPELINE_CLASSES, ...SIGNAL_CLASSES]);

function classColor(cls) {
  return CLASS_BUBBLE_COLOR[cls] ?? "#9ca3af";
}

function classSprite(cls) {
  if (KNOWN_CLASSES.has(cls)) {
    try {
      return `/sprites/${classSpriteFile(cls, 0)}`;
    } catch {
      return null;
    }
  }
  return null;
}

function TurnRow({ row, expanded, onToggle, nowSec }) {
  const relTime = formatRelativeTime(row.epoch, nowSec);
  return (
    <li
      data-testid="turn-row"
      data-turn={row.turn_n ?? ""}
      data-expanded={expanded ? "true" : "false"}
    >
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left bg-transparent border-0 border-b border-zinc-900 cursor-pointer p-1 flex items-center gap-2"
        style={{ minHeight: 24 }}
        aria-expanded={expanded}
        aria-label={`Turn ${row.turn_n ?? "?"} ${expanded ? "collapse" : "expand"}`}
      >
        <span
          className="text-[10px] font-mono text-zinc-400"
          style={{ minWidth: 28 }}
        >
          #{row.turn_n ?? "?"}
        </span>
        <span
          className="text-[9px] text-zinc-500"
          style={{ minWidth: 48 }}
        >
          {relTime}
        </span>
        <span className="flex items-center gap-0.5" data-testid="turn-row-sprites">
          {row.dispatchedClasses.map((cls, i) => {
            const src = classSprite(cls);
            return src ? (
              <img
                key={`${cls}-${i}`}
                src={src}
                alt={cls}
                title={cls}
                style={{
                  width: 14,
                  height: 14,
                  imageRendering: "pixelated",
                }}
              />
            ) : (
              <span
                key={`${cls}-${i}`}
                title={cls}
                className="text-[9px] font-mono"
                style={{ color: classColor(cls) }}
              >
                {cls.slice(0, 2)}
              </span>
            );
          })}
        </span>
        <span className="flex-1 text-[10px] text-zinc-300 truncate">
          {row.summary}
        </span>
        <span
          className="text-[10px] text-zinc-500"
          aria-hidden
          style={{ width: 10 }}
        >
          {expanded ? "▾" : "▸"}
        </span>
      </button>
      {expanded && (
        <div
          data-testid="turn-row-detail"
          className="px-2 py-1 bg-zinc-900/40"
        >
          {row.dispatchDetails.length === 0 ? (
            <p className="text-[10px] text-zinc-500 italic">
              No dispatches this turn.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {row.dispatchDetails.map((d, i) => (
                <li
                  key={`${d.slot}-${i}`}
                  className="text-[10px] leading-tight"
                  style={{
                    borderLeft: `2px solid ${classColor(d.slot)}`,
                    paddingLeft: 6,
                    color: "#d4d4d8",
                  }}
                >
                  <span
                    style={{
                      color: classColor(d.slot),
                      fontFamily: "monospace",
                      marginRight: 4,
                    }}
                  >
                    {d.slot}
                  </span>
                  <span className="text-zinc-400">
                    {d.skill ? `(${d.skill}) ` : ""}
                  </span>
                  <span>{d.reason || "—"}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

export default function TurnJournalTab() {
  const { data } = useApi("/autopilot/runs/current", { poll: 10_000 });
  const [expandedId, setExpandedId] = useState(null);
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const t = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1_000);
    return () => clearInterval(t);
  }, []);

  const rows = summariseTurns(data?.turns);

  if (rows.length === 0) {
    return (
      <div
        data-testid="turn-journal-empty"
        className="text-[10px] text-zinc-500 italic px-1 py-2"
      >
        No turns recorded yet. Oak's waiting for the autopilot.
      </div>
    );
  }

  return (
    <ul
      data-testid="turn-journal-list"
      className="divide-y divide-zinc-900"
      style={{ maxHeight: 360, overflowY: "auto" }}
    >
      {rows.map((row) => (
        <TurnRow
          key={row.id}
          row={row}
          expanded={expandedId === row.id}
          onToggle={() =>
            setExpandedId((cur) => (cur === row.id ? null : row.id))
          }
          nowSec={nowSec}
        />
      ))}
    </ul>
  );
}

import { useEffect, useRef, useState } from "react";
import { Section } from "./Section.jsx";

const MAX_EVENTS = 100;

function formatTime(ts) {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return "";
  }
}

/**
 * LiveEventStream — collapsed by default per the PRD. Subscribes to the
 * existing useWebSocket hook (passed in via the page prop) and renders a
 * rolling buffer of the most recent N events. Cap at 100 entries so a
 * chatty stream can't grow the DOM unbounded.
 */
export function LiveEventStream({ ws }) {
  const [events, setEvents] = useState([]);
  const [expanded, setExpanded] = useState(false);
  const subRef = useRef(null);

  useEffect(() => {
    if (!ws || typeof ws.subscribe !== "function") return undefined;
    const unsub = ws.subscribe("*", (event) => {
      setEvents((prev) => {
        const next = [{ ...event, _receivedAt: new Date().toISOString() }, ...prev];
        return next.slice(0, MAX_EVENTS);
      });
    });
    subRef.current = unsub;
    return () => {
      try {
        unsub?.();
      } catch {
        /* intentional: unsub may fire on unmount of a stale ws */
      }
    };
  }, [ws]);

  return (
    <Section
      title="Live event stream"
      subtitle={`WebSocket · ${ws?.connected ? "connected" : "disconnected"} · last ${events.length}/${MAX_EVENTS}`}
      empty={!expanded && events.length === 0}
      emptyMessage="No events yet."
    >
      <div className="space-y-2">
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="text-xs px-2 py-1 rounded bg-zinc-700/40 hover:bg-zinc-700/60 text-zinc-200"
        >
          {expanded ? "Collapse" : `Expand (${events.length} buffered)`}
        </button>
        {expanded && (
          <ul className="divide-y divide-zinc-700/40 max-h-72 overflow-y-auto font-mono text-[11px]">
            {events.map((event, idx) => (
              <li key={`${event._receivedAt}-${idx}`} className="py-1 flex gap-2">
                <span className="text-zinc-500 shrink-0">{formatTime(event._receivedAt)}</span>
                <span className="text-amber-200 shrink-0">{event.type || "?"}</span>
                <span className="text-zinc-300 truncate" title={JSON.stringify(event)}>
                  {summariseEvent(event)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}

function summariseEvent(event) {
  if (!event || typeof event !== "object") return "";
  // Common-payload heuristics: prefer `message`, then `summary`, then JSON.
  if (typeof event.message === "string") return event.message;
  if (typeof event.summary === "string") return event.summary;
  // Drop the `_receivedAt` shim and `type` (already rendered) for the
  // fallback dump so the row stays readable.
  const { _receivedAt: _r, type: _t, ...rest } = event;
  try {
    return JSON.stringify(rest);
  } catch {
    return "";
  }
}

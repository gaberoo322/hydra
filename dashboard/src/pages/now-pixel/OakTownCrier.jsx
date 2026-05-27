import { useEffect, useRef, useState } from "react";
import { resolveBubbleColor } from "./sprite-map.ts";

/**
 * OakTownCrier — right-edge column of scrolling speech bubbles driven
 * by the live WebSocket event stream.
 *
 * Slice 5 of /now-pixel (#642, #647). Oak (Professor) sprite anchors the
 * column; clicking him collapses the bubbles. Collapse state persists
 * in localStorage so the operator's preference survives reloads.
 *
 * Bubbles:
 *  - Last 50 events from the WS subscription (wildcard "*")
 *  - Auto-scroll to newest; pauses on hover; resumes on un-hover
 *  - Per-class color via resolveBubbleColor (orch=blue/orange, target
 *    =green/amber, health=pink)
 *  - WS-disconnect badge when ws.connected is false
 */
const MAX_BUBBLES = 50;
const STORAGE_KEY = "hydra:now-pixel:oak-collapsed";

function isoToTime(ts) {
  try {
    return ts ? new Date(ts).toLocaleTimeString() : "";
  } catch {
    return "";
  }
}

function eventSummary(frame) {
  // Slot events from the bridge: { type:"slot-event", payload:{event, slot, status, ...} }
  if (frame?.type === "slot-event") {
    const p = frame.payload || {};
    if (p.event === "subagent_stop") {
      return {
        source: p.slot || p.subagent_type,
        text: `${p.slot ?? "slot"} ${p.status ?? "stopped"}${p.summary ? ` · ${p.summary}` : ""}`,
        kind: "stop",
      };
    }
    if (p.event === "slot_waiting_permission") {
      return {
        source: p.slot || p.subagent_type,
        text: `${p.slot ?? "slot"} waiting on permission${p.tool ? ` (${p.tool})` : ""}`,
        kind: "wait",
      };
    }
    return {
      source: p.slot || p.subagent_type,
      text: p.event || "slot event",
      kind: "slot",
    };
  }
  // Generic events surface as a one-line type + message.
  if (frame?.type === "connected") return null; // suppress the heartbeat hello
  const p = frame?.payload || {};
  const msg = p.message || p.text || p.summary || frame?.type || "event";
  return {
    source: p.source || p.subagent_type || frame?.type,
    text: msg.slice(0, 120),
    kind: "generic",
  };
}

export default function OakTownCrier({ ws }) {
  const [bubbles, setBubbles] = useState([]);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [hovered, setHovered] = useState(false);
  const scrollRef = useRef(null);
  const idRef = useRef(0);

  // Persist collapse state.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
    } catch {
      /* intentional: storage may be disabled */
    }
  }, [collapsed]);

  // WS subscription via wildcard so we hear every event the server emits.
  useEffect(() => {
    if (!ws || typeof ws.subscribe !== "function") return undefined;
    const off = ws.subscribe("*", (frame) => {
      const s = eventSummary(frame);
      if (!s) return;
      idRef.current += 1;
      const bubble = {
        id: idRef.current,
        ts: frame?.timestamp || new Date().toISOString(),
        color: resolveBubbleColor(s.source),
        source: s.source ?? "system",
        text: s.text,
        kind: s.kind,
      };
      setBubbles((prev) => {
        const next = [...prev, bubble];
        if (next.length > MAX_BUBBLES) next.splice(0, next.length - MAX_BUBBLES);
        return next;
      });
    });
    return () => off?.();
  }, [ws]);

  // Auto-scroll to newest unless the operator is hovering (paused).
  useEffect(() => {
    if (collapsed || hovered) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [bubbles, collapsed, hovered]);

  return (
    <aside
      className="rounded-lg border border-zinc-800 bg-zinc-950 p-3 flex flex-col"
      data-testid="oak-town-crier"
      data-collapsed={collapsed}
      style={{ minWidth: collapsed ? 80 : 240, maxWidth: 280 }}
    >
      <header className="flex flex-col items-center gap-1 mb-2">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? "Click Oak to expand the town crier" : "Click Oak to collapse the town crier"}
          aria-label={collapsed ? "Expand town crier" : "Collapse town crier"}
          className="bg-transparent border-0 cursor-pointer p-0"
        >
          <img
            src="/sprites/characters/oak.png"
            alt="Professor Oak"
            style={{
              width: 64,
              height: 64,
              imageRendering: "pixelated",
            }}
          />
        </button>
        <div className="text-[10px] uppercase tracking-wider text-zinc-500">
          Town crier
        </div>
        {ws && ws.connected === false && (
          <div
            className="text-[9px] uppercase text-rose-400 border border-rose-900 rounded px-1"
            data-testid="ws-disconnect-badge"
          >
            ws disconnected
          </div>
        )}
      </header>
      {!collapsed && (
        <div
          ref={scrollRef}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          className="overflow-y-auto"
          style={{ maxHeight: 360, minHeight: 120 }}
          data-testid="oak-bubbles"
        >
          {bubbles.length === 0 ? (
            <p className="text-[10px] text-zinc-500 italic">
              Oak's listening… no events yet.
            </p>
          ) : (
            <ul className="space-y-1">
              {bubbles.map((b) => (
                <li
                  key={b.id}
                  className="text-[10px] leading-tight"
                  style={{
                    borderLeft: `3px solid ${b.color}`,
                    paddingLeft: 6,
                    color: "#d4d4d8",
                  }}
                  title={`${b.source} · ${isoToTime(b.ts)}`}
                >
                  <span
                    style={{
                      color: b.color,
                      fontFamily: "monospace",
                      marginRight: 4,
                    }}
                  >
                    [{b.source}]
                  </span>
                  {b.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </aside>
  );
}

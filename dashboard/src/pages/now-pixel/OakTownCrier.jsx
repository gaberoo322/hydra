import { useEffect, useRef, useState } from "react";
import { resolveBubbleColor } from "./sprite-map.ts";
import TurnJournalTab from "./TurnJournalTab.jsx";
import {
  DEFAULT_OAK_TAB,
  isOakTabId,
  OAK_TAB_STORAGE_KEY,
  TAB_JOURNAL,
  TAB_LIVE,
  TAB_RECS,
} from "./oak-tab-state.ts";

/**
 * OakTownCrier — right-edge panel anchored on the Professor Oak sprite.
 *
 * Slice 5 of /now-pixel (#642, #647) shipped this as a single scrolling
 * speech-bubble column over a wildcard WebSocket subscription. Slice B of
 * the autopilot-observability epic (#669, parent #667) converts it into
 * a 3-mode tabbed panel while preserving the live-feed behaviour
 * byte-for-byte:
 *
 *   1. Live feed         — last 50 WS events as colored speech bubbles
 *   2. Turn journal      — compact one-row-per-autopilot-turn ledger
 *   3. Recommendations   — `Coming soon — Oak is studying` placeholder;
 *                          slice F (#674) wires the LLM rec engine here
 *
 * Tab selection persists in localStorage at `hydra:now-pixel:oak-tab`
 * alongside the existing collapse-state key.
 *
 * Clicking the Oak sprite still toggles the entire panel collapsed —
 * the tab strip is hidden in that state so the rail stays narrow.
 */
const MAX_BUBBLES = 50;
const COLLAPSE_STORAGE_KEY = "hydra:now-pixel:oak-collapsed";

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

function LiveFeedTab({ bubbles, scrollRef, onHover, onUnhover }) {
  return (
    <div
      ref={scrollRef}
      onMouseEnter={onHover}
      onMouseLeave={onUnhover}
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
  );
}

function RecommendationsPlaceholder() {
  return (
    <div
      data-testid="oak-recs-placeholder"
      className="text-[10px] text-zinc-500 italic px-1 py-6 text-center"
    >
      Coming soon — Oak is studying.
    </div>
  );
}

function TabButton({ id, current, label, onSelect }) {
  const active = current === id;
  return (
    <button
      type="button"
      onClick={() => onSelect(id)}
      data-testid={`oak-tab-${id}`}
      data-active={active ? "true" : "false"}
      aria-pressed={active}
      className="bg-transparent border-0 cursor-pointer text-[9px] uppercase tracking-wider px-1 py-0.5"
      style={{
        color: active ? "#fbbf24" : "#71717a",
        borderBottom: active ? "1px solid #fbbf24" : "1px solid transparent",
      }}
    >
      {label}
    </button>
  );
}

export default function OakTownCrier({ ws }) {
  const [bubbles, setBubbles] = useState([]);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [tab, setTab] = useState(() => {
    try {
      const stored = localStorage.getItem(OAK_TAB_STORAGE_KEY);
      return isOakTabId(stored) ? stored : DEFAULT_OAK_TAB;
    } catch {
      return DEFAULT_OAK_TAB;
    }
  });
  const [hovered, setHovered] = useState(false);
  const scrollRef = useRef(null);
  const idRef = useRef(0);

  // Persist collapse state.
  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_STORAGE_KEY, collapsed ? "1" : "0");
    } catch {
      /* intentional: storage may be disabled */
    }
  }, [collapsed]);

  // Persist tab selection.
  useEffect(() => {
    try {
      localStorage.setItem(OAK_TAB_STORAGE_KEY, tab);
    } catch {
      /* intentional: storage may be disabled */
    }
  }, [tab]);

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

  // Auto-scroll the live feed to newest unless the operator is hovering
  // (paused). Only runs when the live tab is the visible one.
  useEffect(() => {
    if (collapsed || hovered || tab !== TAB_LIVE) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [bubbles, collapsed, hovered, tab]);

  return (
    <aside
      className="rounded-lg border border-zinc-800 bg-zinc-950 p-3 flex flex-col"
      data-testid="oak-town-crier"
      data-collapsed={collapsed}
      data-tab={tab}
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
        <>
          <div
            className="flex items-center gap-2 mb-2 border-b border-zinc-900"
            role="tablist"
            data-testid="oak-tab-strip"
          >
            <TabButton id={TAB_LIVE} current={tab} label="Live feed" onSelect={setTab} />
            <TabButton id={TAB_JOURNAL} current={tab} label="Turn journal" onSelect={setTab} />
            <TabButton id={TAB_RECS} current={tab} label="Recs" onSelect={setTab} />
          </div>
          {tab === TAB_LIVE && (
            <LiveFeedTab
              bubbles={bubbles}
              scrollRef={scrollRef}
              onHover={() => setHovered(true)}
              onUnhover={() => setHovered(false)}
            />
          )}
          {tab === TAB_JOURNAL && <TurnJournalTab />}
          {tab === TAB_RECS && <RecommendationsPlaceholder />}
        </>
      )}
    </aside>
  );
}

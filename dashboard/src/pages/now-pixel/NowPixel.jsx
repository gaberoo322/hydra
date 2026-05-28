import { useEffect, useRef, useState } from "react";
import { useApi } from "../../hooks/useApi.js";
import { useSpriteAnimations } from "../../hooks/useSpriteAnimations.js";
import AutopilotPavilion from "./AutopilotPavilion.jsx";
import ActiveDispatchesStrip from "./ActiveDispatchesStrip.jsx";
import HabitatGrid from "./HabitatGrid.jsx";
import OakTownCrier from "./OakTownCrier.jsx";
import Attribution from "./Attribution.jsx";

/**
 * NowPixel — pixel-art habitat dashboard.
 *
 * Slice 7 PR1 (#642 / #649) — closes the last parity gap with the
 * classic /now: a small Coin Bag tile that hits /api/now/cost-burn so
 * the audit-now-parity.js script passes.
 *
 * NowPixel hosts the shared `hoveredSubagentId` from slice 6 so the
 * in-zone SubagentSprite and the ActiveDispatchesStrip highlight
 * together. The page is reachable at /now-pixel; slice 7 PR2 will swap
 * it to /now and rename the legacy view to /now-classic.
 */
function formatMoney(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "$0";
  if (n >= 100) return `$${Math.round(n)}`;
  return `$${n.toFixed(2)}`;
}

/**
 * CoinBag — daily token-burn tile. Polls `/api/now/cost-burn` every 30s
 * for the steady-state spend/budget figures, AND (issue #673) subscribes
 * to the `slot-event` WS stream for `budget_threshold` frames so the tile
 * can flash when the autopilot crosses a 50%/75%/90% threshold.
 *
 * The flash is a one-shot 1.2s animation on the 💰 emoji — long enough
 * to be noticed during a board-watch, short enough to not annoy. Driven
 * by a CSS class toggle (not by re-rendering every frame).
 */
function CoinBag({ ws }) {
  const { data } = useApi("/now/cost-burn", { poll: 30_000 });
  const spent = formatMoney(Number(data?.daySpent ?? 0));
  const budget = formatMoney(Number(data?.dailyBudget ?? 0));
  const headroom = Math.max(
    0,
    Math.min(100, Number(data?.headroomPct ?? 100)),
  );
  const color =
    headroom > 50 ? "#22c55e" : headroom > 25 ? "#facc15" : "#dc2626";
  const spark = Array.isArray(data?.lastHourSpark) ? data.lastHourSpark : [];
  const [r5h, r24h] = [Number(spark[0] ?? 0), Number(spark[1] ?? 0)];

  // Issue #673: one-shot flash on `budget_threshold` slot-events.
  const [flashing, setFlashing] = useState(false);
  const [lastThreshold, setLastThreshold] = useState(null);
  const flashTimerRef = useRef(null);
  useEffect(() => {
    if (!ws || typeof ws.subscribe !== "function") return undefined;
    const off = ws.subscribe("slot-event", (frame) => {
      const event = frame?.payload?.event;
      if (event !== "budget_threshold") return;
      const threshold = Number(frame?.payload?.threshold);
      if (Number.isFinite(threshold)) setLastThreshold(threshold);
      setFlashing(true);
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      flashTimerRef.current = setTimeout(() => {
        setFlashing(false);
        flashTimerRef.current = null;
      }, 1200);
    });
    return () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      off?.();
    };
  }, [ws]);

  return (
    <section
      className={
        "rounded-lg border border-zinc-800 bg-zinc-950 p-3 flex items-center gap-3 transition-shadow" +
        (flashing ? " ring-2 ring-amber-400 shadow-[0_0_24px_rgba(251,191,36,0.6)]" : "")
      }
      data-testid="coin-bag"
      data-flashing={flashing ? "1" : "0"}
      data-last-threshold={lastThreshold ?? ""}
    >
      <div
        style={{
          fontSize: 22,
          transform: flashing ? "scale(1.25)" : "scale(1)",
          transition: "transform 200ms",
        }}
        aria-hidden
      >
        💰
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[10px] uppercase tracking-wide text-zinc-500">
          Coin bag — daily burn
          {lastThreshold ? (
            <span className="ml-2 text-amber-300">
              budget {lastThreshold}% crossed
            </span>
          ) : null}
        </div>
        <div className="text-sm text-zinc-100 font-mono">
          {spent} <span className="text-zinc-500">/ {budget}</span>
          <span className="ml-3 text-zinc-500">5h </span>
          <span style={{ color }}>{formatMoney(r5h)}/h</span>
          <span className="ml-2 text-zinc-500">24h </span>
          <span className="text-zinc-300">{formatMoney(r24h)}/h</span>
        </div>
        <div
          style={{
            marginTop: 4,
            height: 4,
            width: "100%",
            background: "#1f1f23",
            borderRadius: 2,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${headroom}%`,
              height: "100%",
              background: color,
              transition: "width 200ms",
            }}
          />
        </div>
      </div>
    </section>
  );
}

export default function NowPixel({ ws }) {
  const anim = useSpriteAnimations(ws);
  const [hoveredSubagentId, setHoveredSubagentId] = useState(null);

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-bold">Now (Pixel View)</h1>
        <p className="text-sm text-zinc-400">
          Pokemon-habitat rendering of the live orchestrator. Preview build —
          coexists with classic /now until the atomic swap.
        </p>
      </header>
      <AutopilotPavilion />
      <CoinBag ws={ws} />
      <div className="flex gap-4 items-stretch">
        <div className="flex-1 min-w-0">
          <HabitatGrid
            anim={anim}
            hoveredSubagentId={hoveredSubagentId}
            onSubagentHover={setHoveredSubagentId}
          />
        </div>
        <OakTownCrier ws={ws} />
      </div>
      <ActiveDispatchesStrip
        hoveredSubagentId={hoveredSubagentId}
        onSubagentHover={setHoveredSubagentId}
      />
      <Attribution />
    </div>
  );
}

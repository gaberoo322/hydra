import { useEffect, useRef, useState } from "react";
import { useApi } from "../../hooks/useApi.js";
import { useSpriteAnimations } from "../../hooks/useSpriteAnimations.js";
import AutopilotPavilion from "./AutopilotPavilion.jsx";
import ActiveDispatchesStrip from "./ActiveDispatchesStrip.jsx";
import HabitatGrid from "./HabitatGrid.jsx";
import OakTownCrier from "./OakTownCrier.jsx";
import Attribution from "./Attribution.jsx";
import DispatchTween from "./DispatchTween.jsx";
import { shouldTweenFrame } from "./derive-dispatch-tween.ts";

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

function CoinBag() {
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
  return (
    <section
      className="rounded-lg border border-zinc-800 bg-zinc-950 p-3 flex items-center gap-3"
      data-testid="coin-bag"
    >
      <div style={{ fontSize: 22 }} aria-hidden>
        💰
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[10px] uppercase tracking-wide text-zinc-500">
          Coin bag — daily burn
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

  // Slice E of autopilot observability (#667, #670): wire up the
  // Pavilion → HabitatZone dispatch tween. We hold a ref to the
  // Pavilion sprite (origin point) and a Map of zone-class → element
  // (destination points). When a dispatch_decision slot-event lands
  // with outcome=dispatched, we read both rects at that moment (so a
  // resized window doesn't desync the tween) and hand them to
  // anim.fireTravel.
  //
  // Graceful degradation: if either rect is unresolvable (zone not yet
  // mounted, scope=orch-only hides the target column), tweenSpec()
  // falls back to an instant pop. Missed WS frames are picked up by
  // HabitatGrid's existing 10s /autopilot/runs/current poll — the
  // tween is cosmetic.
  const pavilionSpriteRef = useRef(null);
  const zoneRectsRef = useRef(new Map());

  useEffect(() => {
    if (!ws || typeof ws.subscribe !== "function") return undefined;
    const off = ws.subscribe("slot-event", (frame) => {
      const hit = shouldTweenFrame(frame);
      if (!hit) return;
      const pavilionEl = pavilionSpriteRef.current;
      const fromRect = pavilionEl?.getBoundingClientRect?.() ?? null;
      const zoneEl = zoneRectsRef.current?.get(hit.cls) ?? null;
      const toRect = zoneEl?.getBoundingClientRect?.() ?? null;
      anim.fireTravel(hit.cls, fromRect, toRect, {
        turnN: hit.turnN,
        tsEpoch: hit.tsEpoch,
      });
    });
    return () => {
      off?.();
    };
  }, [ws, anim]);

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-bold">Now (Pixel View)</h1>
        <p className="text-sm text-zinc-400">
          Pokemon-habitat rendering of the live orchestrator. Preview build —
          coexists with classic /now until the atomic swap.
        </p>
      </header>
      <AutopilotPavilion spriteRef={pavilionSpriteRef} />
      <CoinBag />
      <div className="flex gap-4 items-stretch">
        <div className="flex-1 min-w-0">
          <HabitatGrid
            anim={anim}
            hoveredSubagentId={hoveredSubagentId}
            onSubagentHover={setHoveredSubagentId}
            zoneRectsRef={zoneRectsRef}
          />
        </div>
        <OakTownCrier ws={ws} />
      </div>
      <ActiveDispatchesStrip
        hoveredSubagentId={hoveredSubagentId}
        onSubagentHover={setHoveredSubagentId}
      />
      <DispatchTween tweens={anim.tweens} />
      <Attribution />
    </div>
  );
}

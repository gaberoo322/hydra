import { useEffect, useRef, useState } from "react";
import { useApi } from "../../hooks/useApi.js";
import { useSpriteAnimations } from "../../hooks/useSpriteAnimations.js";
import AutopilotPavilion from "./AutopilotPavilion.jsx";
import BattleCardRow from "./BattleCardRow.jsx";
import HabitatGrid from "./HabitatGrid.jsx";
import OakTownCrier from "./OakTownCrier.jsx";
import Attribution from "./Attribution.jsx";
import DispatchTween from "./DispatchTween.jsx";
import { shouldTweenFrame } from "./derive-dispatch-tween.ts";

/**
 * NowPixel — pixel-art habitat dashboard.
 *
 * Slice 7 PR1 (#642 / #649) — closed the last parity gap with the
 * (now-retired) classic /now: a small Coin Bag tile that hits
 * /api/now/cost-burn. The classic view and its parity audit were
 * removed once the deprecation window closed (issue #664).
 *
 * NowPixel hosts the shared `hoveredSubagentId` from slice 6 so the
 * in-zone SubagentSprite and the BattleCardRow (slice D of the
 * /now-observability epic #667 / issue #672, which replaced the legacy
 * ActiveDispatchesStrip) highlight together. The page is reachable at
 * /now and the pixel Habitat is the canonical surface (the /now-classic
 * fallback was retired by issue #664 after slice 7 PR2 deprecated it).
 */
function formatTokens(n) {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

/**
 * CoinBag — hourly burn-rate tile. Polls `/api/now/cost-burn` every 30s for
 * the token-denominated 5h / 24h burn rate.
 *
 * The `budget_threshold` WS flash (issue #673) was removed in #703 along
 * with the dead budget-threshold bridge that emitted those frames — the
 * bridge polled a Redis key with no live writer and never fired.
 *
 * The USD spend / budget / headroom-bar half was retired in #885; the
 * structurally-$0 token-to-USD interface was honest-deleted in #1413. Under
 * the Claude Code subscription the orchestrator consumes tokens, not dollars,
 * so the tile now renders the token-per-hour rate the Subscription Usage
 * Tracker actually measures.
 */
function CoinBag() {
  const { data } = useApi("/now/cost-burn", { poll: 30_000 });
  const r5h = Number(data?.tokensPerHour5h ?? 0);
  const r24h = Number(data?.tokensPerHour24h ?? 0);

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
          Coin bag — hourly burn
        </div>
        <div className="text-sm text-zinc-100 font-mono">
          <span className="text-zinc-500">5h </span>
          <span className="text-zinc-300">{formatTokens(r5h)} tok/h</span>
          <span className="ml-2 text-zinc-500">24h </span>
          <span className="text-zinc-300">{formatTokens(r24h)} tok/h</span>
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
        <h2 className="text-lg font-semibold text-zinc-200">Habitat view</h2>
        <p className="text-sm text-zinc-400">
          Pokemon-habitat rendering of the live orchestrator — the alternate
          surface to the /now Console (toggle above, or deep-link
          <code className="text-zinc-300"> /now?view=habitat</code>).
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
      <BattleCardRow
        ws={ws}
        hoveredSubagentId={hoveredSubagentId}
        onSubagentHover={setHoveredSubagentId}
      />
      <DispatchTween tweens={anim.tweens} />
      <Attribution />
    </div>
  );
}

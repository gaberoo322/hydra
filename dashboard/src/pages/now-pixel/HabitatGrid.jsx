import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "../../hooks/useApi.js";
import HabitatZone from "./HabitatZone.jsx";
import Infirmary from "./Infirmary.jsx";
import {
  deriveZoneState,
  deriveCooldown,
  deriveThinking,
} from "./derive-sprite-state.ts";

/**
 * HabitatGrid — 2-column habitat layout for /now-pixel.
 *
 * Slice 6 of /now-pixel (#642, #648) — threads the autopilot run payload
 * (`runs/current`) down so each zone can render its subagent occupant
 * + HP bar + cooldown clock without an extra fetch.
 *
 * Hover-link: `hoveredSubagentId` / `onSubagentHover` come from NowPixel
 * so the in-zone sprite and the ActiveDispatchesStrip mirror highlight
 * together when one is hovered.
 *
 * Slice E of autopilot observability (#667, #670) accepts a
 * `zoneRectsRef` prop — a ref whose `.current` is a `Map<class, HTMLElement>`
 * that NowPixel reads to compute tween destination rects. We use a ref
 * (not state) because rect lookups are imperative: the WS frame
 * arrives, the parent calls `el.getBoundingClientRect()`, fires the
 * tween, and never re-renders on the rect itself.
 */
export default function HabitatGrid({
  anim = null,
  hoveredSubagentId = null,
  onSubagentHover = () => {},
  zoneRectsRef = null,
}) {
  const { data } = useApi("/autopilot/runs/current", { poll: 10_000 });

  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000);
    return () => clearInterval(t);
  }, []);

  const zoneState = deriveZoneState(data, now);
  const scope = zoneState.scope;

  // Pull out the latest slot snapshot so we can hand each zone its
  // subagent details (skill, task_id, partial_tokens).
  const lastTurn = data?.turns?.[data.turns.length - 1] ?? null;
  const slotsSnapshot = lastTurn?.slots_snapshot ?? {};
  const signalsSnapshot = lastTurn?.signals_snapshot ?? {};
  const hardMax =
    data?.limits?.subagent_hard_max_tokens ??
    data?.limits?.subagent_max_tokens ??
    800_000;

  const prevOccupancyRef = useRef({});
  useEffect(() => {
    if (!anim?.fireExcited) return;
    for (const [cls, status] of Object.entries(zoneState.zones)) {
      const wasActive = prevOccupancyRef.current[cls] === "active";
      if (status === "active" && !wasActive) {
        anim.fireExcited(cls);
      }
      prevOccupancyRef.current[cls] = status;
    }
  }, [zoneState.zones, anim]);

  // Thinking-state — slot occupied ≥30s with no partial_tokens delta.
  // We tick the same 1Hz `now` clock above for cooldowns so the
  // derivation re-runs cheaply on every second the page is open. The
  // tracker lives in a ref so the per-slot inactivity watermark
  // survives re-renders. Issue #660.
  const thinkingTrackerRef = useRef({});
  const prevThinkingRef = useRef({});
  useEffect(() => {
    if (!anim?.fireThinking) return;
    const { thinking, nextTracker } = deriveThinking(
      slotsSnapshot,
      now,
      thinkingTrackerRef.current,
    );
    thinkingTrackerRef.current = nextTracker;
    for (const [cls, isThinking] of Object.entries(thinking)) {
      const wasThinking = prevThinkingRef.current[cls] === true;
      if (isThinking && !wasThinking) {
        anim.fireThinking(cls);
      } else if (!isThinking && wasThinking) {
        // Only clear if the hook currently shows thinking — never
        // stomp on a hurt or one-shot that took over in the meantime.
        if (anim.animations?.[cls] === "thinking") {
          anim.clearAnimation(cls);
        }
      }
      prevThinkingRef.current[cls] = isThinking;
    }
  }, [slotsSnapshot, now, anim]);

  const orchPipelineClasses = [
    "dev_orch",
    "qa_orch",
    "research_orch",
    "design_concept_orch",
  ];
  const orchSignalClasses = ["sweep_orch", "discover_orch"];
  const targetPipelineClasses = ["dev_target", "qa_target", "research_target"];
  const targetSignalClasses = ["sweep_target", "discover_target"];

  const animFor = (cls) => anim?.animations?.[cls] ?? null;
  const subagentFor = (cls) => slotsSnapshot[cls] ?? null;
  const cooldownFor = (cls) =>
    deriveCooldown(cls, Number(signalsSnapshot[cls] ?? 0), now);

  const sharedZoneProps = {
    hoveredSubagentId,
    onSubagentHover,
    hardMax,
  };

  /**
   * Ref-callback factory: returns a callback that registers (or
   * unregisters when `el === null`) the zone's outer wrapper into the
   * shared `zoneRectsRef.current` Map. Using a per-class closure means
   * React calls our callback exactly when the wrapper mounts /
   * unmounts, so we never poll for rects.
   *
   * The factory is memoised inside `useCallback` so changing the
   * `hoveredSubagentId` prop doesn't tear down + re-register every
   * zone on every parent re-render.
   */
  const registerZoneRef = useCallback(
    (cls) => (el) => {
      if (!zoneRectsRef) return;
      if (!zoneRectsRef.current) zoneRectsRef.current = new Map();
      if (el) {
        zoneRectsRef.current.set(cls, el);
      } else {
        zoneRectsRef.current.delete(cls);
      }
    },
    [zoneRectsRef],
  );

  const wrapZone = (cls, node) => (
    <div key={cls} ref={registerZoneRef(cls)} data-zone-anchor={cls}>
      {node}
    </div>
  );

  return (
    <section
      className="rounded-lg border border-zinc-800 bg-zinc-950 p-4"
      data-testid="habitat-grid"
    >
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-sm uppercase tracking-wide text-zinc-400">
          Habitat zones
        </h2>
        <span className="text-xs text-zinc-500">
          scope: {scope} · run: {zoneState.runStatus ?? "—"}
        </span>
      </header>
      <div
        className="grid gap-3"
        style={{
          gridTemplateColumns: "1fr auto 1fr",
        }}
      >
        <div
          style={{
            opacity: scope === "target-only" ? 0.4 : 1,
            transition: "opacity 200ms",
          }}
        >
          <ColumnHeader>Orchestrator</ColumnHeader>
          <div className="grid grid-cols-3 gap-2">
            {orchPipelineClasses.map((cls) =>
              wrapZone(
                cls,
                <HabitatZone
                  key={cls}
                  className={cls}
                  status={zoneState.zones[cls]}
                  signalSeed={zoneState.signalSeeds[cls] ?? null}
                  animation={animFor(cls)}
                  subagent={subagentFor(cls)}
                  {...sharedZoneProps}
                />,
              ),
            )}
            {orchSignalClasses.map((cls) =>
              wrapZone(
                cls,
                <HabitatZone
                  key={cls}
                  className={cls}
                  status={zoneState.zones[cls]}
                  signalSeed={zoneState.signalSeeds[cls] ?? null}
                  animation={animFor(cls)}
                  cooldown={cooldownFor(cls)}
                  {...sharedZoneProps}
                />,
              ),
            )}
          </div>
        </div>

        <div className="flex flex-col items-center min-w-[130px] gap-2">
          {wrapZone(
            "health",
            <HabitatZone
              className="health"
              status={zoneState.zones.health}
              signalSeed={zoneState.signalSeeds.health}
              animation={animFor("health")}
              cooldown={cooldownFor("health")}
              {...sharedZoneProps}
            />,
          )}
          <Infirmary />
        </div>

        <div
          style={{
            opacity: scope === "orch-only" ? 0.4 : 1,
            transition: "opacity 200ms",
          }}
        >
          <ColumnHeader>Target</ColumnHeader>
          <div className="grid grid-cols-3 gap-2">
            {targetPipelineClasses.map((cls) =>
              wrapZone(
                cls,
                <HabitatZone
                  key={cls}
                  className={cls}
                  status={zoneState.zones[cls]}
                  signalSeed={zoneState.signalSeeds[cls] ?? null}
                  animation={animFor(cls)}
                  subagent={subagentFor(cls)}
                  {...sharedZoneProps}
                />,
              ),
            )}
            {targetSignalClasses.map((cls) =>
              wrapZone(
                cls,
                <HabitatZone
                  key={cls}
                  className={cls}
                  status={zoneState.zones[cls]}
                  signalSeed={zoneState.signalSeeds[cls] ?? null}
                  animation={animFor(cls)}
                  cooldown={cooldownFor(cls)}
                  {...sharedZoneProps}
                />,
              ),
            )}
            <HabitatZone
              className="design_concept_target"
              status="sleeping"
              placeholder="Phase D placeholder"
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function ColumnHeader({ children }) {
  return (
    <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2 text-center">
      {children}
    </div>
  );
}

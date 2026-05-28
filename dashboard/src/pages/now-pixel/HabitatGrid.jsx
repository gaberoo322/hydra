import { useEffect, useRef, useState } from "react";
import { useApi } from "../../hooks/useApi.js";
import HabitatZone from "./HabitatZone.jsx";
import Infirmary from "./Infirmary.jsx";
import { deriveZoneState, deriveCooldown } from "./derive-sprite-state.ts";

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
 */
export default function HabitatGrid({
  anim = null,
  hoveredSubagentId = null,
  onSubagentHover = () => {},
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

  // Reaping fade (issue #661): when a pipeline slot's subagent disappears
  // (slotsSnapshot[cls] goes from object → null), keep the LAST subagent
  // payload mounted for REAPING_DURATION_MS so <ReapingFade /> can render
  // the 800ms fade-out + status icon. Tracked in a ref because we don't
  // need re-renders for the bookkeeping itself — `anim.reaping` from the
  // hook drives the actual render.
  const prevSubagentsRef = useRef({});
  const reapingSubagentsRef = useRef({});
  useEffect(() => {
    if (!anim?.fireReaping) {
      // No animation harness wired up (e.g. tests) — just track prev
      // for the next pass so we don't trigger spurious transitions.
      prevSubagentsRef.current = { ...slotsSnapshot };
      return;
    }
    const allClasses = new Set([
      ...Object.keys(prevSubagentsRef.current),
      ...Object.keys(slotsSnapshot),
    ]);
    for (const cls of allClasses) {
      const prev = prevSubagentsRef.current[cls];
      const curr = slotsSnapshot[cls];
      if (prev && !curr) {
        // Occupied → null. Capture the last subagent payload for the
        // fade-out render, then trigger fireReaping with the status
        // remembered from the last subagent_stop slot-event.
        reapingSubagentsRef.current[cls] = prev;
        anim.fireReaping(cls);
      }
    }
    prevSubagentsRef.current = { ...slotsSnapshot };
  }, [slotsSnapshot, anim]);

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

  // Reaping (#661): expose the last subagent + its reap status when the
  // hook reports `cls` is mid-fade. HabitatZone wraps a SubagentSprite
  // in <ReapingFade /> using these props.
  const reapingFor = (cls) => {
    const status = anim?.reaping?.[cls];
    if (!status) return null;
    const subagent = reapingSubagentsRef.current[cls];
    if (!subagent) return null;
    return { subagent, status };
  };

  const sharedZoneProps = {
    hoveredSubagentId,
    onSubagentHover,
    hardMax,
  };

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
            {orchPipelineClasses.map((cls) => (
              <HabitatZone
                key={cls}
                className={cls}
                status={zoneState.zones[cls]}
                signalSeed={zoneState.signalSeeds[cls] ?? null}
                animation={animFor(cls)}
                subagent={subagentFor(cls)}
                reaping={reapingFor(cls)}
                {...sharedZoneProps}
              />
            ))}
            {orchSignalClasses.map((cls) => (
              <HabitatZone
                key={cls}
                className={cls}
                status={zoneState.zones[cls]}
                signalSeed={zoneState.signalSeeds[cls] ?? null}
                animation={animFor(cls)}
                cooldown={cooldownFor(cls)}
                {...sharedZoneProps}
              />
            ))}
          </div>
        </div>

        <div className="flex flex-col items-center min-w-[130px] gap-2">
          <HabitatZone
            className="health"
            status={zoneState.zones.health}
            signalSeed={zoneState.signalSeeds.health}
            animation={animFor("health")}
            cooldown={cooldownFor("health")}
            {...sharedZoneProps}
          />
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
            {targetPipelineClasses.map((cls) => (
              <HabitatZone
                key={cls}
                className={cls}
                status={zoneState.zones[cls]}
                signalSeed={zoneState.signalSeeds[cls] ?? null}
                animation={animFor(cls)}
                subagent={subagentFor(cls)}
                reaping={reapingFor(cls)}
                {...sharedZoneProps}
              />
            ))}
            {targetSignalClasses.map((cls) => (
              <HabitatZone
                key={cls}
                className={cls}
                status={zoneState.zones[cls]}
                signalSeed={zoneState.signalSeeds[cls] ?? null}
                animation={animFor(cls)}
                cooldown={cooldownFor(cls)}
                {...sharedZoneProps}
              />
            ))}
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

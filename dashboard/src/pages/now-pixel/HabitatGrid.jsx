import { useEffect, useRef, useState } from "react";
import { useApi } from "../../hooks/useApi.js";
import HabitatZone from "./HabitatZone.jsx";
import Infirmary from "./Infirmary.jsx";
import { deriveZoneState } from "./derive-sprite-state.ts";

/**
 * HabitatGrid — 2-column habitat layout for /now-pixel.
 *
 * Slice 3 (#645) introduced the layout. Slice 4 (#646) plugs in sprite
 * animations: cheering/hurt come in via the `anim` prop from the parent
 * (WS-driven, see useSpriteAnimations); excited is poll-driven here by
 * watching slots_snapshot for null → occupied transitions.
 *
 * `anim` is an opaque hook handle from useSpriteAnimations. We call
 * `anim.fireExcited(cls)` on each transition. If anim is missing (e.g.
 * the page is mounted without a WS hook in test), excited gating still
 * works — the rest of the animations just won't fire.
 */
export default function HabitatGrid({ anim = null }) {
  const { data } = useApi("/autopilot/runs/current", { poll: 10_000 });

  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000);
    return () => clearInterval(t);
  }, []);

  const zoneState = deriveZoneState(data, now);
  const scope = zoneState.scope;

  // Track previous occupancy per class so we can fire "excited" on
  // null → occupied transitions. The autopilot doesn't XADD a "slot
  // opened" event, so poll-derived is the only path.
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

  const orchClasses = [
    "dev_orch",
    "qa_orch",
    "research_orch",
    "design_concept_orch",
    "sweep_orch",
    "discover_orch",
  ];
  const targetClasses = [
    "dev_target",
    "qa_target",
    "research_target",
    "sweep_target",
    "discover_target",
  ];

  const animFor = (cls) => anim?.animations?.[cls] ?? null;

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
            {orchClasses.map((cls) => (
              <HabitatZone
                key={cls}
                className={cls}
                status={zoneState.zones[cls]}
                signalSeed={zoneState.signalSeeds[cls] ?? null}
                animation={animFor(cls)}
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
            {targetClasses.map((cls) => (
              <HabitatZone
                key={cls}
                className={cls}
                status={zoneState.zones[cls]}
                signalSeed={zoneState.signalSeeds[cls] ?? null}
                animation={animFor(cls)}
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

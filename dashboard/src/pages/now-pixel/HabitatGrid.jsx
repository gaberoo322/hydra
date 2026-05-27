import { useEffect, useState } from "react";
import { useApi } from "../../hooks/useApi.js";
import HabitatZone from "./HabitatZone.jsx";
import { deriveZoneState } from "./derive-sprite-state.ts";

/**
 * HabitatGrid — 2-column habitat layout for /now-pixel (slice 3 of
 * #642, #645).
 *
 * Layout:
 *   ┌───────────────┬─────────────┬───────────────┐
 *   │  Orch zones   │  Infirmary  │  Target zones │
 *   │  (5 classes)  │  + health   │  (6 classes)  │
 *   └───────────────┴─────────────┴───────────────┘
 *
 * Orch column carries: dev_orch, qa_orch, research_orch,
 * design_concept_orch (pipeline) + sweep_orch, discover_orch (signal).
 *
 * Target column carries: dev_target, qa_target, research_target
 * (pipeline) + sweep_target, discover_target (signal) + the
 * `design_concept_target` Phase-D placeholder tile.
 *
 * Center column is just `health` (scope-agnostic) plus the Infirmary
 * label; the real services-strip lands in slice 5 (#647).
 *
 * `limits.scope` controls dim-other-half: orch-only dims the target
 * column to 40%, target-only dims the orch column to 40%.
 */
export default function HabitatGrid() {
  const { data } = useApi("/autopilot/runs/current", { poll: 10_000 });

  // Tick local `now` once a second so signal cooldowns flip from active
  // → sleeping live without needing another API roundtrip. The
  // derivation function is pure so this stays cheap.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000);
    return () => clearInterval(t);
  }, []);

  const zoneState = deriveZoneState(data, now);
  const scope = zoneState.scope;

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
        {/* Orch column */}
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
              />
            ))}
          </div>
        </div>

        {/* Center column — Infirmary + health */}
        <div className="flex flex-col items-center min-w-[120px]">
          <ColumnHeader>Infirmary</ColumnHeader>
          <HabitatZone
            className="health"
            status={zoneState.zones.health}
            signalSeed={zoneState.signalSeeds.health}
          />
          <div className="text-[9px] text-zinc-600 mt-2 text-center max-w-[110px]">
            Services strip lands in slice 5
          </div>
        </div>

        {/* Target column */}
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
              />
            ))}
            {/* Phase-D placeholder per the slice spec — design_concept
                runs only on orch side today. */}
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

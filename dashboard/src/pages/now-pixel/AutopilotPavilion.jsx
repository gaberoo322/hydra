import { useEffect, useRef, useState } from "react";
import { useApi } from "../../hooks/useApi.js";
import { derivePavilionState } from "./derive-sprite-state.ts";

/**
 * AutopilotPavilion — blonde-mustache-Ash trainer sprite + run stats.
 *
 * Slice 2 of /now-pixel (#642, #644). Polls /api/now/autopilot-tick every
 * 5s (mirrors the legacy CurrentAutopilotTick polling cadence) and emits
 * a one-shot pulse animation on the sprite each time lastTickAt advances.
 *
 * Pulse mechanic: the sprite element gets a `pulse` CSS class for ~600ms
 * after each lastTickAt change. We use a class-toggle keyed to a counter
 * so React's reconciliation reliably restarts the CSS animation.
 */
export default function AutopilotPavilion() {
  const { data, error } = useApi("/now/autopilot-tick", { poll: 5_000 });
  const state = derivePavilionState(data);

  const [pulseKey, setPulseKey] = useState(0);
  const prevTickRef = useRef(state.lastTickAt);
  useEffect(() => {
    if (state.lastTickAt && state.lastTickAt !== prevTickRef.current) {
      prevTickRef.current = state.lastTickAt;
      setPulseKey((k) => k + 1);
    }
  }, [state.lastTickAt]);

  return (
    <section
      className="rounded-lg border border-zinc-800 bg-zinc-950 p-4"
      data-testid="autopilot-pavilion"
    >
      <header className="flex items-center justify-between gap-3 mb-3">
        <h2 className="text-sm uppercase tracking-wide text-zinc-400">
          Autopilot Pavilion
        </h2>
        <span className="text-xs text-zinc-500">
          {state.mode === "running"
            ? "trainer is on the job"
            : state.mode === "stopped"
              ? "trainer is asleep"
              : "trainer is waiting"}
        </span>
      </header>
      <div className="flex items-center gap-6">
        <div className="shrink-0">
          <img
            key={pulseKey}
            src="/sprites/characters/ash-blonde.png"
            alt="Autopilot trainer sprite"
            className={`ash-sprite ${pulseKey > 0 ? "ash-pulse" : ""}`}
            style={{
              width: 96,
              height: 96,
              imageRendering: "pixelated",
              filter: state.mode === "running" ? "none" : "grayscale(80%)",
            }}
          />
        </div>
        <div className="flex-1 min-w-0">
          {state.mode === "running" ? (
            <PavilionStats state={state} />
          ) : (
            <p className="text-sm text-zinc-400">
              {error ? `Error: ${error}` : state.emptyMessage}
            </p>
          )}
        </div>
      </div>
      {/*
       * Scoped CSS for the pulse animation. Inline <style> is intentional —
       * we don't want this leaking into other pages, and the dashboard
       * doesn't yet have a Tailwind animate-* plugin set up for one-shots.
       */}
      <style>{`
        .ash-sprite { transition: filter 200ms ease-out; }
        @keyframes ash-pulse-kf {
          0%   { transform: scale(1.0); filter: brightness(1.0); }
          30%  { transform: scale(1.1); filter: brightness(1.4); }
          100% { transform: scale(1.0); filter: brightness(1.0); }
        }
        .ash-pulse { animation: ash-pulse-kf 600ms ease-out; }
      `}</style>
    </section>
  );
}

function PavilionStats({ state }) {
  return (
    <div className="space-y-2">
      <div className="font-mono text-xs text-zinc-100 truncate">
        {state.runId}
        <span className="ml-2 text-zinc-500">trigger: {state.trigger}</span>
      </div>
      <div className="grid grid-cols-4 gap-3 text-sm">
        <Stat label="Elapsed" value={state.elapsedLabel} />
        <Stat label="Turns" value={state.turns} />
        <Stat label="Dispatches" value={state.dispatches} />
        <Stat label="Heartbeat" value={`${state.heartbeatAgeLabel} ago`} />
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="text-zinc-100 font-semibold">{value}</div>
    </div>
  );
}

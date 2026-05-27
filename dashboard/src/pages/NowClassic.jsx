import { ServiceStrip } from "../components/pages/now/ServiceStrip.jsx";
import { CurrentAutopilotTick } from "../components/pages/now/CurrentAutopilotTick.jsx";
import { ActiveDispatches } from "../components/pages/now/ActiveDispatches.jsx";
import { CostBurn } from "../components/pages/now/CostBurn.jsx";
import { LiveEventStream } from "../components/pages/now/LiveEventStream.jsx";
import { AlertsNow } from "../components/pages/now/AlertsNow.jsx";

/**
 * NowClassic — the pre-pixel /now layout, kept as a fallback after the
 * atomic swap (slice 7 PR2 of /now-pixel epic #642, #649).
 *
 * Deprecation: scheduled for removal **2026-06-10** (2 weeks after the
 * swap). A separate cleanup PR will delete this file and the
 * `/now-classic` route at that point, matching the dashboard-v2
 * precedent (PRD #615 / issue #621). The 2-week window is the same one
 * used for the v2 atomic swap.
 *
 * Layout (preserved as-was from the pre-swap /now):
 *   1. ServiceStrip            — pinned top, polls 15s
 *   2. CurrentAutopilotTick    — polls 5s
 *   3. ActiveDispatches        — polls 5s
 *   4. CostBurn                — polls 30s
 *   5. LiveEventStream         — WebSocket; collapsed by default
 *   6. AlertsNow               — polls 30s
 */
export default function NowClassic({ ws }) {
  return (
    <div className="space-y-4">
      <div
        className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200"
        data-testid="now-classic-deprecation-banner"
      >
        <strong className="font-semibold">Heads up:</strong> Classic /now is
        deprecated and will be removed on <strong>2026-06-10</strong>. The
        pixel-habitat view at <a
          href="/now"
          className="underline text-amber-100 hover:text-white"
        >/now</a> is the new home for live orchestrator visibility (epic
        {" "}<a
          href="https://github.com/gaberoo322/hydra/issues/642"
          className="underline"
          target="_blank"
          rel="noreferrer noopener"
        >#642</a>).
      </div>

      <ServiceStrip />

      <div>
        <h1 className="text-2xl font-bold">Now (classic)</h1>
        <p className="text-sm text-zinc-400">
          What Hydra is doing right this second — live tick, active dispatches,
          burn rate, events, alerts.
        </p>
      </div>

      <CurrentAutopilotTick />
      <ActiveDispatches />
      <CostBurn />
      <LiveEventStream ws={ws} />
      <AlertsNow />
    </div>
  );
}

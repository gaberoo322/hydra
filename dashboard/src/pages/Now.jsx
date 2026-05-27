import { ServiceStrip } from "../components/pages/now/ServiceStrip.jsx";
import { CurrentAutopilotTick } from "../components/pages/now/CurrentAutopilotTick.jsx";
import { ActiveDispatches } from "../components/pages/now/ActiveDispatches.jsx";
import { CostBurn } from "../components/pages/now/CostBurn.jsx";
import { LiveEventStream } from "../components/pages/now/LiveEventStream.jsx";
import { AlertsNow } from "../components/pages/now/AlertsNow.jsx";

/**
 * Dashboard v2 — `/now` page (issue #618, PRD #615).
 *
 * Layout (PRD #615):
 *   1. ServiceStrip            — pinned top, polls 15s
 *   2. CurrentAutopilotTick    — polls 5s
 *   3. ActiveDispatches        — polls 5s
 *   4. CostBurn                — polls 30s
 *   5. LiveEventStream         — WebSocket; collapsed by default
 *   6. AlertsNow               — polls 30s
 */
export default function Now({ ws }) {
  return (
    <div className="space-y-4">
      <ServiceStrip />

      <div>
        <h1 className="text-2xl font-bold">Now</h1>
        <p className="text-sm text-zinc-400">
          What Hydra is doing right this second — live tick, active dispatches, burn rate, events, alerts.
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

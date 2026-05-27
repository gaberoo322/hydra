import { ServiceStrip } from "../../components/v2/now/ServiceStrip.jsx";
import { CurrentAutopilotTick } from "../../components/v2/now/CurrentAutopilotTick.jsx";
import { ActiveDispatches } from "../../components/v2/now/ActiveDispatches.jsx";
import { CostBurn } from "../../components/v2/now/CostBurn.jsx";
import { LiveEventStream } from "../../components/v2/now/LiveEventStream.jsx";
import { AlertsNow } from "../../components/v2/now/AlertsNow.jsx";

/**
 * Dashboard v2 — `/v2/now` page (issue #618, PRD #615).
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

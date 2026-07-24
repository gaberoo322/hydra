/**
 * Autopilot operator-control-flag routes — emergency-brake + pause.
 *
 *   GET/POST /autopilot/emergency-brake — operator-only merge brake (#744)
 *   GET/POST /autopilot/paused          — operator-only durable pause (#988)
 *
 * Split out of the combined `autopilot.ts` router (#2034). These two flags are
 * the stable, operator-only control surface; they touch their own Redis
 * accessors (`src/redis/emergency-brake.ts`, `src/redis/autopilot-pause.ts`)
 * directly — distinct from the lifecycle domain Module — and POST /paused emits
 * a best-effort notification on the event bus.
 *
 * This router IS the sole write path for both flags. The autopilot
 * (decide.py / collect-state.sh / pace-gate.sh) only READS them; there is no
 * engage/disengage *action type*, so the autopilot has no structural way to set
 * or clear either flag.
 */

import { Router } from "express";
import { STREAMS } from "../event-bus-stream-keys.ts";
import {
  EmergencyBrakeBodySchema,
  AutopilotPauseBodySchema,
} from "../autopilot/control-schemas.ts";
import {
  getEmergencyBrake,
  setEmergencyBrake,
  clearEmergencyBrake,
} from "../redis/emergency-brake.ts";
import {
  getAutopilotPaused,
  setAutopilotPaused,
  clearAutopilotPaused,
} from "../redis/autopilot-pause.ts";
import type { PublishableBus } from "../event-bus-seams.ts";
import { logger } from "../logger.ts";
import { isolateAggregator } from "./route-helpers.ts";

/**
 * @param eventBus - optional; when provided, pause/resume emit a
 *   `hydra:notifications` event (issue #988 AC#5). The router stays usable
 *   without it (tests construct it bare) — a missing bus degrades to a no-op
 *   publish, never a throw.
 */
export function createAutopilotControlRouter(eventBus?: PublishableBus) {
  const router = Router();

  // Best-effort bus publish — never throws into a route handler. AC#5 wants a
  // pause/resume event, but the flag write is the source of truth; a publish
  // failure (or absent bus in a test) must not fail the operator's POST.
  async function publishPauseEvent(type: string, payload: unknown): Promise<void> {
    if (!eventBus || typeof eventBus.publish !== "function") return;
    try {
      await eventBus.publish(STREAMS.NOTIFICATIONS, {
        type,
        source: "autopilot-pause",
        payload,
      });
    } catch (err: any) {
      logger.error({ type, err }, "[autopilot] pause event publish failed");
    }
  }

  // -------------------------------------------------------------------------
  // Emergency brake (issue #744) — the operator-only emergency brake.
  //
  // Pulling the brake pauses ALL auto-merge regardless of tier/depth and routes
  // open PRs to /hydra-review; releasing it resumes ADR-0015 depth-gated merge.
  // -------------------------------------------------------------------------

  // GET /autopilot/emergency-brake — read current brake state.
  router.get("/autopilot/emergency-brake", async (_req, res) =>
    // Issue #909 / ADR-0027 eighth sweep: the 500 envelope + pino `err`-field
    // log live in the isolateAggregator seam (route-helpers.ts) once.
    isolateAggregator(res, "autopilot/emergency-brake", () => getEmergencyBrake()),
  );

  // POST /autopilot/emergency-brake — engage/disengage. Operator-only.
  router.post("/autopilot/emergency-brake", async (req, res) => {
    const parsed = EmergencyBrakeBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ code: "schema-validation-failed", issues: parsed.error.issues });
    }
    return isolateAggregator(res, "autopilot/emergency-brake", async () => {
      if (parsed.data.engaged) {
        return setEmergencyBrake(parsed.data.engagedBy ?? "operator");
      }
      await clearEmergencyBrake();
      return { engaged: false };
    });
  });

  // -------------------------------------------------------------------------
  // Autopilot pause (issue #988) — the operator-only durable autopilot pause.
  //
  // Setting it pauses launch+dispatch with a DRAIN (in-flight subagents finish
  // their atomic unit); clearing it resumes. INDEPENDENT of the emergency-brake
  // (merge-only) — the two flags compose.
  // -------------------------------------------------------------------------

  // GET /autopilot/paused — read current pause state.
  router.get("/autopilot/paused", async (_req, res) =>
    isolateAggregator(res, "autopilot/paused", () => getAutopilotPaused()),
  );

  // POST /autopilot/paused — pause/resume. Operator-only.
  router.post("/autopilot/paused", async (req, res) => {
    const parsed = AutopilotPauseBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ code: "schema-validation-failed", issues: parsed.error.issues });
    }
    return isolateAggregator(res, "autopilot/paused", async () => {
      if (parsed.data.paused) {
        const state = await setAutopilotPaused();
        await publishPauseEvent("autopilot-paused", { paused: true, since: state.since });
        return state;
      }
      await clearAutopilotPaused();
      await publishPauseEvent("autopilot-resumed", { paused: false });
      return { paused: false };
    });
  });

  return router;
}

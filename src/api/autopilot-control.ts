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
      console.error(`[autopilot] pause event publish failed: ${err?.message || err}`);
    }
  }

  // -------------------------------------------------------------------------
  // Emergency brake (issue #744) — the operator-only emergency brake.
  //
  // Pulling the brake pauses ALL auto-merge regardless of tier/depth and routes
  // open PRs to /hydra-review; releasing it resumes ADR-0015 depth-gated merge.
  // -------------------------------------------------------------------------

  // GET /autopilot/emergency-brake — read current brake state.
  router.get("/autopilot/emergency-brake", async (_req, res) => {
    try {
      const state = await getEmergencyBrake();
      return res.json(state);
    } catch (err: any) {
      console.error(`[autopilot] emergency-brake read failed: ${err?.message || err}`);
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // POST /autopilot/emergency-brake — engage/disengage. Operator-only.
  router.post("/autopilot/emergency-brake", async (req, res) => {
    const parsed = EmergencyBrakeBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ code: "schema-validation-failed", issues: parsed.error.issues });
    }
    try {
      if (parsed.data.engaged) {
        const state = await setEmergencyBrake(parsed.data.engagedBy ?? "operator");
        return res.json(state);
      }
      await clearEmergencyBrake();
      return res.json({ engaged: false });
    } catch (err: any) {
      console.error(`[autopilot] emergency-brake write failed: ${err?.message || err}`);
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // Autopilot pause (issue #988) — the operator-only durable autopilot pause.
  //
  // Setting it pauses launch+dispatch with a DRAIN (in-flight subagents finish
  // their atomic unit); clearing it resumes. INDEPENDENT of the emergency-brake
  // (merge-only) — the two flags compose.
  // -------------------------------------------------------------------------

  // GET /autopilot/paused — read current pause state.
  router.get("/autopilot/paused", async (_req, res) => {
    try {
      const state = await getAutopilotPaused();
      return res.json(state);
    } catch (err: any) {
      console.error(`[autopilot] paused read failed: ${err?.message || err}`);
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // POST /autopilot/paused — pause/resume. Operator-only.
  router.post("/autopilot/paused", async (req, res) => {
    const parsed = AutopilotPauseBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ code: "schema-validation-failed", issues: parsed.error.issues });
    }
    try {
      if (parsed.data.paused) {
        const state = await setAutopilotPaused();
        await publishPauseEvent("autopilot-paused", { paused: true, since: state.since });
        return res.json(state);
      }
      await clearAutopilotPaused();
      await publishPauseEvent("autopilot-resumed", { paused: false });
      return res.json({ paused: false });
    } catch (err: any) {
      console.error(`[autopilot] paused write failed: ${err?.message || err}`);
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  return router;
}

/**
 * Usage HTTP routes — thin adapter over `src/cost/usage-tracker.ts`.
 *
 * The Subscription Usage Tracker projection — token counts, calibrated
 * percentages, pacing verdict, emergency-stop flag. The actual scanning
 * + math lives in the tracker module; this route just translates the
 * snapshot to JSON and surfaces a `?force=1` cache-bust knob for the
 * dashboard to invalidate the 60s in-process memoize.
 *
 * Future PR wires `emergencyStop` / `pacingState` into the autopilot
 * tick. PR A ships the read-only endpoint so the operator can compare
 * the tracker's numbers against `/usage` and calibrate the env vars
 * before any dispatch behavior changes.
 */

import { Router } from "express";
import { z } from "zod";
import { getUsage, projectEligibility, overlayPauseEligibility } from "../cost/index.ts";
import { getAutopilotPaused } from "../redis/autopilot-pause.ts";
import { booleanFlag } from "../schemas/common.ts";

/**
 * Query schema for the `?force=1` cache-bust knob shared by both usage read
 * routes (ADR-0022). The common booleanFlag helper preserves the legacy
 * `force === "1" || force === "true"` semantics (and additionally accepts the
 * canonical `yes`/`on` truthy forms); absent => false.
 */
const ForceQuerySchema = z.object({ force: booleanFlag() });

export function createUsageRouter() {
  const router = Router();

  router.get("/usage", async (req, res) => {
    const force = ForceQuerySchema.parse(req.query).force;
    try {
      const snapshot = await getUsage({ force });
      return res.json(snapshot);
    } catch (err: any) {
      console.error(`[usage] /api/usage failed: ${err?.message || err}`);
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  /**
   * GET /api/usage/eligibility — autopilot dispatch verdict.
   *
   * Consumed by `scripts/autopilot/collect-state.sh` once per turn; the
   * playbook merges the response under `state.usage_eligibility` so
   * `decide.py` can gate dispatches without re-fetching. `?force=1`
   * bypasses the 60s tracker cache for the underlying snapshot.
   *
   * Issue #988: the operator-only **Autopilot pause** flag is overlaid here,
   * at the route seam. `projectEligibility` stays a pure function of the
   * snapshot; the Redis pause read happens in this caller and is folded onto
   * the verdict via `overlayPauseEligibility` (paused => allow=false +
   * reasons.paused=true). Both readers consume this single projection: the
   * launcher (`pace-gate.sh` reads `.reasons.paused`) and the brain (decide.py
   * rides the `allow=false` drain path). The pause read fails SAFE — a Redis
   * error degrades to not-paused so it can never wedge the loop off.
   */
  router.get("/usage/eligibility", async (req, res) => {
    const force = ForceQuerySchema.parse(req.query).force;
    try {
      const snapshot = await getUsage({ force });
      let paused = false;
      try {
        paused = (await getAutopilotPaused()).paused;
      } catch (err: any) {
        // Fail-safe to running: a pause-flag read error must not block the
        // eligibility projection. Logged so the bad read is visible.
        console.error(
          `[usage] /api/usage/eligibility pause read failed (treating as not paused): ${err?.message || err}`,
        );
      }
      return res.json(overlayPauseEligibility(projectEligibility(snapshot), paused));
    } catch (err: any) {
      console.error(`[usage] /api/usage/eligibility failed: ${err?.message || err}`);
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  return router;
}

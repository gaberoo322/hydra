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
import { getUsage, projectEligibility } from "../cost/index.ts";

export function createUsageRouter() {
  const router = Router();

  router.get("/usage", async (req, res) => {
    const force = req.query.force === "1" || req.query.force === "true";
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
   */
  router.get("/usage/eligibility", async (req, res) => {
    const force = req.query.force === "1" || req.query.force === "true";
    try {
      const snapshot = await getUsage({ force });
      return res.json(projectEligibility(snapshot));
    } catch (err: any) {
      console.error(`[usage] /api/usage/eligibility failed: ${err?.message || err}`);
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  return router;
}

import { Router } from "express";
import { loadProjectGoals } from "../project-goals.ts";
import { logger } from "../logger.ts";

/**
 * Project goals routes.
 *
 * Extracted from api/misc.ts as part of issue #268. `GET /goals/summary` was
 * retired under ADR-0024 §3 (issue #4638): zero callers.
 */
export function createGoalsRouter() {
  const router = Router();

  // GET /goals — Current project goals
  //
  // Not an isolateAggregator route: the success path writes a 404 when no
  // goals file exists, which the seam (JSON-at-200 of produce's return)
  // can't express.
  router.get("/goals", async (req, res) => {
    try {
      const goals = await loadProjectGoals();
      if (!goals) {
        res.status(404).json({ error: "No goals file found. Create config/direction/goals.md." });
      } else {
        res.json(goals);
      }
    } catch (err: any) {
      logger.error({ routeLabel: "api/goals", err }, "[api/goals] read failed");
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

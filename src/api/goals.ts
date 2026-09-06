import { Router } from "express";
import { loadProjectGoals, summarizeGoalsForPrompt } from "../project-goals.ts";
import { logger } from "../logger.ts";

/**
 * Project goals routes.
 *
 * Extracted from api/misc.ts as part of issue #268.
 *
 * Neither route is an isolateAggregator route (issue #4402): `/goals` writes a
 * 404 from inside the try and `/goals/summary` sends text/plain, neither of
 * which the seam (JSON-at-200 of produce's return) can express. Both catches
 * adopt the pino `err`-field seam (ADR-0027) instead of staying silent.
 */
export function createGoalsRouter() {
  const router = Router();

  // GET /goals — Current project goals
  //
  // Not an isolateAggregator route: 404 branch inside the try.
  router.get("/goals", async (req, res) => {
    try {
      const goals = await loadProjectGoals();
      if (!goals) {
        res.status(404).json({ error: "No goals file found. Create config/direction/goals.md." });
      } else {
        res.json(goals);
      }
    } catch (err: any) {
      logger.error({ routeLabel: "api/goals", err }, "[api/goals] load failed");
      res.status(500).json({ error: err.message });
    }
  });

  // GET /goals/summary — Goals formatted for prompts
  //
  // Not an isolateAggregator route: text/plain success path.
  router.get("/goals/summary", async (req, res) => {
    try {
      const goals = await loadProjectGoals();
      const summary = summarizeGoalsForPrompt(goals);
      res.type("text/plain").send(summary);
    } catch (err: any) {
      logger.error({ routeLabel: "api/goals/summary", err }, "[api/goals] summary failed");
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

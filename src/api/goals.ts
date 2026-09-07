import { Router } from "express";
import { loadProjectGoals, summarizeGoalsForPrompt } from "../project-goals.ts";
import { logger } from "../logger.ts";

/**
 * Project goals routes.
 *
 * Extracted from api/misc.ts as part of issue #268.
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

  // GET /goals/summary — Goals formatted for prompts
  //
  // Not an isolateAggregator route: the success path is a text/plain send,
  // not JSON, which the seam's `res.json(produce())` can't express.
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

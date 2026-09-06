import { Router } from "express";
import { logger } from "../logger.ts";
import { loadProjectGoals, summarizeGoalsForPrompt } from "../project-goals.ts";

/**
 * Project goals routes.
 *
 * Extracted from api/misc.ts as part of issue #268.
 */
export function createGoalsRouter() {
  const router = Router();

  // GET /goals — Current project goals
  //
  // Not an isolateAggregator route (issue #4402): the await-dependent 404 for
  // a missing goals file can't be expressed through the seam (JSON-at-200 of
  // produce's return).
  router.get("/goals", async (_req, res) => {
    try {
      const goals = await loadProjectGoals();
      if (!goals) {
        res.status(404).json({ error: "No goals file found. Create config/direction/goals.md." });
      } else {
        res.json(goals);
      }
    } catch (err: any) {
      logger.error({ err }, "[api/goals] GET /goals failed");
      res.status(500).json({ error: err.message });
    }
  });

  // GET /goals/summary — Goals formatted for prompts
  //
  // Not an isolateAggregator route (issue #4402): the success path is a
  // text/plain send, which the seam (which JSONs produce's return) can't
  // express.
  router.get("/goals/summary", async (_req, res) => {
    try {
      const goals = await loadProjectGoals();
      const summary = summarizeGoalsForPrompt(goals);
      res.type("text/plain").send(summary);
    } catch (err: any) {
      logger.error({ err }, "[api/goals] GET /goals/summary failed");
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

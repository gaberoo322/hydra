import { Router } from "express";
import { loadProjectGoals, summarizeGoalsForPrompt } from "../project-goals.ts";

/**
 * Project goals routes.
 *
 * Extracted from api/misc.ts as part of issue #268.
 */
export function createGoalsRouter() {
  const router = Router();

  // GET /goals — Current project goals
  router.get("/goals", async (req, res) => {
    try {
      const goals = await loadProjectGoals();
      if (!goals) {
        res.status(404).json({ error: "No goals file found. Create config/direction/goals.md." });
      } else {
        res.json(goals);
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /goals/summary — Goals formatted for prompts
  router.get("/goals/summary", async (req, res) => {
    try {
      const goals = await loadProjectGoals();
      const summary = summarizeGoalsForPrompt(goals);
      res.type("text/plain").send(summary);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

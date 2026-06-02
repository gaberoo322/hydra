import { Router } from "express";
import { setResearchForceOnce } from "../redis/scheduler.ts";

export function createResearchRouter(eventBus: any) {
  const router = Router();

  // POST /research/start — Run a research cycle.
  //
  // The in-process research loop was removed in #342 and its no-op shim
  // (`runResearchLoop`) was deleted in #706 (scheduler fold PR-1/4). Research
  // is driven by the /hydra-target-research skill, not by this HTTP route.
  // The endpoint is preserved as a deterministic "disabled" responder so
  // existing callers get the same structured skip the shim used to return.
  router.post("/research/start", async (req, res) => {
    res.json({
      researchId: null,
      skipped: true,
      reason: "research-loop disabled in #342; use /hydra-target-research",
      opportunityCount: 0,
      autoQueued: 0,
      summary: undefined,
      topOpportunities: [],
      duration: undefined,
      cost: 0,
    });
  });

  // POST /research/force — Force one research cycle on next scheduler tick (bypasses throttle)
  router.post("/research/force", async (req, res) => {
    try {
      await setResearchForceOnce();
      res.json({ ok: true, message: "Research force flag set — next scheduler tick will run research bypassing all throttles" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

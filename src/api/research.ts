import { Router } from "express";
import { getLatestResearch, listResearchReports, vetoOpportunity } from "../research-loop.ts";
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

  // GET /research/latest — Most recent research report
  router.get("/research/latest", async (req, res) => {
    try {
      const report = await getLatestResearch();
      if (!report) {
        res.status(404).json({ error: "No research reports found. Run POST /research/start first." });
      } else {
        res.json(report);
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /research/history — List recent research reports (metadata)
  router.get("/research/history", async (req, res) => {
    try {
    // @ts-expect-error — migrate to proper types
      const count = parseInt(req.query.count) || 10;
      const reports = await listResearchReports(count);
      res.json(reports);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
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

  // POST /research/veto — Remove a research-recommended item from the queue
  router.post("/research/veto", async (req, res) => {
    try {
      const { title } = req.body || {};
      if (!title) {
        return res.status(400).json({ error: "Missing 'title' — which opportunity to veto?" });
      }
      const result = await vetoOpportunity(title);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

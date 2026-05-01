import { Router } from "express";
import { runResearchLoop, getLatestResearch, listResearchReports, vetoOpportunity } from "../research-loop.ts";

export function createResearchRouter(eventBus: any) {
  const router = Router();

  // POST /research/start — Run a research cycle
  router.post("/research/start", async (req, res) => {
    try {
      const opts: Record<string, any> = {};
      if (req.body?.focusOverride) opts.focusOverride = req.body.focusOverride;
      const result = await runResearchLoop(eventBus, opts);
    // @ts-expect-error — migrate to proper types
      if (result.error) {
        res.status(400).json(result);
      } else {
        res.json({
          researchId: result.researchId,
    // @ts-expect-error — migrate to proper types
          opportunityCount: result.opportunityCount,
    // @ts-expect-error — migrate to proper types
          autoQueued: result.autoQueued,
    // @ts-expect-error — migrate to proper types
          summary: result.synthesis?.summary,
    // @ts-expect-error — migrate to proper types
          topOpportunities: (result.synthesis?.opportunities || []).slice(0, 5).map(o => ({
            rank: o.rank,
            title: o.title,
            adjustedScore: o.adjustedScore,
            confidence: o.confidence,
            autoQueue: o.autoQueue,
            category: o.category,
          })),
    // @ts-expect-error — migrate to proper types
          duration: result.duration?.totalHuman,
    // @ts-expect-error — migrate to proper types
          cost: result.cost?.totalUsd,
        });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
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

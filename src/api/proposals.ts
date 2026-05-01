import { Router } from "express";
import { listProposals, approveProposal, rejectProposal, runMetaAnalysis } from "../proposals.ts";

export function createProposalsRouter(eventBus: any) {
  const router = Router();

  // GET /proposals — List proposals
  router.get("/proposals", async (req, res) => {
    const status = req.query.status;
    res.json(await listProposals(status));
  });

  // POST /proposals/:id/approve — Approve a proposal
  router.post("/proposals/:id/approve", async (req, res) => {
    const proposalId = req.params.id;
    const result = await approveProposal(proposalId, eventBus);
    if (result.error) {
      res.status(404).json(result);
    } else {
      res.json(result);
    }
  });

  // POST /proposals/:id/reject — Reject a proposal
  router.post("/proposals/:id/reject", async (req, res) => {
    const proposalId = req.params.id;
    const reason = req.body?.reason;
    const result = await rejectProposal(proposalId, reason, eventBus);
    if (result.error) {
      res.status(404).json(result);
    } else {
      res.json(result);
    }
  });

  // POST /meta/analyze — Manually trigger Meta analysis
  router.post("/meta/analyze", async (req, res) => {
    try {
      const result = await runMetaAnalysis(eventBus, { correlationId: "manual" });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

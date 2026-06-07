// ---------------------------------------------------------------------------
// /api/anchor — Candidate Feed visibility endpoint
// ---------------------------------------------------------------------------
//
// Issue #424 / ADR-0016. Exposes the Candidate Feed (ranked, scored work
// candidates with 0-1 confidence scores) so the `decide.py` decision brain can
// decide what to work on. Read-only — does NOT mutate Redis (no work-queue
// consumption, no Kanban claim).
//
// All enumeration + scoring + eligibility lives behind one deep module,
// `src/anchor-candidates.ts` (`getCandidateFeed`). This route is thin: parse
// query → `getCandidateFeed` → add `generated_at` → `res.json`.

import { Router } from "express";
import { getCandidateFeed } from "../anchor-candidates.ts";
import { AnchorCandidatesQuerySchema } from "../schemas/anchor.ts";

export function createAnchorRouter() {
  const router = Router();

  // GET /api/anchor/candidates?limit=N&excludeInFlight=true|false&excludeMerged=true|false
  router.get("/anchor/candidates", async (req, res) => {
    try {
      // ADR-0022: read query params through the Schemas seam. `limit` collapses
      // to DEFAULT_LIMIT (10, clamped 1..50) on absent/garbage input — the same
      // window getCandidateFeed applies. The two exclusion flags default true
      // (issues #640 / #882: exclude in-flight + already-merged candidates;
      // callers pass `=false` for the raw view).
      const { count: limit, excludeInFlight, excludeMerged } =
        AnchorCandidatesQuerySchema.parse(req.query);

      const feed = await getCandidateFeed({ limit, excludeInFlight, excludeMerged });

      res.json({
        ...feed,
        generated_at: new Date().toISOString(),
      });
    } catch (err: any) {
      console.error(`[AnchorAPI] /anchor/candidates failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

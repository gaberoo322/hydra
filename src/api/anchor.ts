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

export function createAnchorRouter() {
  const router = Router();

  // GET /api/anchor/candidates?limit=N&excludeInFlight=true|false&excludeMerged=true|false
  router.get("/anchor/candidates", async (req, res) => {
    try {
      const requestedLimit = parseInt(String(req.query.limit ?? ""), 10);
      const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
        ? requestedLimit
        : undefined;
      // Issue #640 — exclude inProgress items with a fresh `pr-<n>` claim by
      // default (the safer behaviour for decide.py / dev_target dispatch);
      // callers that need the raw view pass excludeInFlight=false.
      const excludeInFlight =
        String(req.query.excludeInFlight ?? "true").toLowerCase() !== "false";
      // Issue #882 — also exclude candidates whose work already MERGED with no
      // open PR (the in-flight window only hides fresh open-PR claims). On by
      // default; callers that need the raw view pass excludeMerged=false.
      const excludeMerged =
        String(req.query.excludeMerged ?? "true").toLowerCase() !== "false";

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

import { Router } from "express";
// Issue #954: the dashboard search proxy no longer hand-rolls its own
// `/search/find` fetch (a second, divergent search path that dropped the
// timeout, metrics, and fallback). It calls `trackedOvSearch` — the canonical
// reader — so there is exactly ONE search implementation in src/, carrying the
// OpenViking Request Adapter's transport discipline plus this reader's metrics
// and zero-result fallback.
import { getOvSearchMetrics, trackedOvSearch } from "../knowledge-base/ov-search.ts";
import { getCoverageStats } from "../knowledge-base/indexer.ts";
import { OpenVikingSearchQuerySchema } from "../schemas/openviking.ts";

/**
 * OpenViking proxy + knowledge metrics routes.
 *
 * Extracted from api/misc.ts as part of issue #268 (mirrors the learning.ts
 * split from #219). Issue #954 collapsed the divergent inline search fetch into
 * the canonical `trackedOvSearch` reader.
 */
export function createOpenVikingRouter() {
  const router = Router();

  // GET /openviking/search — Proxy search to OpenViking via the canonical reader.
  router.get("/openviking/search", async (req, res) => {
    // ADR-0022 slice 3: read `q` + `limit` through the Schemas seam. `q` is a
    // REQUIRED non-empty string, so this route owns its bespoke 400 (inline
    // safeParse) rather than a default-on-garbage read. `limit` collapses bad
    // input to 10 (the legacy `parseInt(...) || 10`).
    const parsed = OpenVikingSearchQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: "Missing query parameter 'q'" });
    }
    const { q, limit } = parsed.data;

    // trackedOvSearch never throws — it routes through the OpenViking Request
    // Adapter (timeout + error classification) and folds every failure to an
    // empty `{ resources, memories }`. The proxy surfaces that shape; an OV
    // outage now degrades to an empty result with logged metrics rather than a
    // 502, matching how every other caller of the reader behaves.
    const { resources, memories } = await trackedOvSearch(q, limit);
    res.json({ result: { resources, memories } });
  });

  // GET /openviking-stats — OV search quality metrics (in-memory, resets on restart)
  router.get("/openviking-stats", (_req, res) => {
    res.json(getOvSearchMetrics());
  });

  // GET /learning/coverage — Knowledge index coverage (issue #210).
  // Reports indexed source/doc counts so operators can detect a regression
  // where the indexer is silently failing.
  router.get("/learning/coverage", (_req, res) => {
    res.json(getCoverageStats());
  });

  return router;
}

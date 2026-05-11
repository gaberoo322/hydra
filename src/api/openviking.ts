import { Router } from "express";
import { getOvSearchMetrics, getCoverageStats } from "../learning.ts";
// Issue #231: shared OV connection config — the previous local default literal
// for OPENVIKING_API_KEY in misc.ts was the WRONG key (returned 401), so the
// dashboard search proxy silently broke whenever the env var was absent.
import { OPENVIKING_URL, OPENVIKING_API_KEY } from "../learning/ov-config.ts";

/**
 * OpenViking proxy + knowledge metrics routes.
 *
 * Extracted from api/misc.ts as part of issue #268 (mirrors the learning.ts
 * split from #219). Pure move — no behavior changes.
 */
export function createOpenVikingRouter() {
  const router = Router();

  // GET /openviking/search — Proxy search to OpenViking
  router.get("/openviking/search", async (req, res) => {
    const query = req.query.q;
    if (!query) {
      return res.status(400).json({ error: "Missing query parameter 'q'" });
    }

    try {
      const ovUrl = OPENVIKING_URL;
      const ovKey = OPENVIKING_API_KEY;
      const response = await fetch(`${ovUrl}/api/v1/search/find`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Api-Key": ovKey },
    // @ts-expect-error — migrate to proper types
        body: JSON.stringify({ query, limit: parseInt(req.query.limit) || 10 }),
      });
      const data = await response.json();
      res.json(data);
    } catch (err: any) {
      res.status(502).json({ error: `OpenViking unavailable: ${err.message}` });
    }
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

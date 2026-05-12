import { Router } from "express";
import { getPlanCacheStatsFull, invalidatePlanCache } from "../plan-cache.ts";

/**
 * Plan cache routes.
 *
 * Extracted from api/misc.ts as part of issue #268.
 *
 * /plan-cache/stats now surfaces three views (issue #325):
 *   - lifetime:    Redis-persisted counters across restarts
 *   - last24h:     today + yesterday UTC per-day counters
 *   - thisProcess: in-memory counters since this Node process booted
 * Each view includes a `hitRate` (hits / (hits+misses), 3-dp, 0 when none).
 */
export function createPlanCacheRouter() {
  const router = Router();

  router.get("/plan-cache/stats", async (req, res) => {
    try {
      const stats = await getPlanCacheStatsFull();
      res.json(stats);
    } catch (err: any) {
      console.error(`[api/plan-cache] stats failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/plan-cache/invalidate", async (req, res) => {
    const count = await invalidatePlanCache();
    res.json({ invalidated: count });
  });

  return router;
}

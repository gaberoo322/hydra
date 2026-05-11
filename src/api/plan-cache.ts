import { Router } from "express";
import { getPlanCacheStats, invalidatePlanCache } from "../plan-cache.ts";

/**
 * Plan cache routes.
 *
 * Extracted from api/misc.ts as part of issue #268.
 */
export function createPlanCacheRouter() {
  const router = Router();

  router.get("/plan-cache/stats", async (req, res) => {
    res.json(getPlanCacheStats());
  });

  router.post("/plan-cache/invalidate", async (req, res) => {
    const count = await invalidatePlanCache();
    res.json({ invalidated: count });
  });

  return router;
}

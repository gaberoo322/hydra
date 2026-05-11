import { Router } from "express";
import { getActiveHoldbacks, getRecentHoldbacks } from "../holdback.ts";

/**
 * GET /holdback — Tier-2 outcome holdback watcher state (issue #244).
 *
 * Returns active holdbacks (currently being watched) and recent holdbacks
 * (passed / reverted / cap-reached). Dashboard renders these as a panel
 * so operators can see "what self-modifications is Hydra still on probation
 * for?" without forensic Redis access.
 *
 * Issue #268 split misc.ts into focused sub-routers; #244 follows the same
 * pattern — each new orphan-operational route gets its own factory.
 */
export function createHoldbackRouter() {
  const router = Router();

  router.get("/holdback", async (_req, res) => {
    try {
      const [active, recent] = await Promise.all([
        getActiveHoldbacks(),
        getRecentHoldbacks(20),
      ]);
      res.json({ active, recent });
    } catch (err: any) {
      console.error(`[holdback-api] unexpected error: ${err?.message || String(err)}`);
      res.status(500).json({ active: [], recent: [], errors: [err?.message || String(err)] });
    }
  });

  return router;
}

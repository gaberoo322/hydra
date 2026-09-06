import { Router } from "express";
import {
  acquireMergeLock,
  getMergeLockHolder,
  releaseMergeLock,
} from "../redis/cycle-tracking.ts";
import { aggregatorRouteNoQuery } from "./route-helpers.ts";
import { logger } from "../logger.ts";

/**
 * Merge lock routes.
 *
 * Extracted from api/misc.ts as part of issue #268. The merge lock is a
 * short-lived Redis lock (60s TTL) that serializes merges across Codex and
 * Claude Code cycles — see CLAUDE.md "Merge lock contention".
 */
export function createMergeLockRouter() {
  const router = Router();

  // Not an isolateAggregator route: the contended path answers 409
  // `{ locked, holder }` from inside the try, which the seam (JSON-at-200 of
  // produce's return) can't express. The catch adopts the pino `err`-field
  // seam (ADR-0027) instead.
  router.post("/merge/lock", async (req, res) => {
    try {
      const { cycleId } = req.body || {};
      const acquired = await acquireMergeLock(cycleId || "unknown", 60);
      if (!acquired) {
        const holder = await getMergeLockHolder();
        return res.status(409).json({ locked: true, holder });
      }
      res.json({ acquired: true });
    } catch (err: any) {
      logger.error({ routeLabel: "api/merge/lock", err }, "[api/merge-lock] acquire failed");
      res.status(500).json({ error: err.message });
    }
  });

  // Issue #4402: the never-throw 500 isolation + its pino `err`-field log line
  // come from the `aggregatorRouteNoQuery` seam (route-helpers.ts, #909).
  router.post(
    "/merge/unlock",
    aggregatorRouteNoQuery("api/merge/unlock", async () => {
      await releaseMergeLock();
      return { released: true };
    }),
  );

  return router;
}

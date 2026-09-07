import { Router } from "express";
import {
  acquireMergeLock,
  getMergeLockHolder,
  releaseMergeLock,
} from "../redis/cycle-tracking.ts";
import { isolateAggregator } from "./route-helpers.ts";
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

  // Not an isolateAggregator route: the success path writes a 409 when the
  // lock is already held, which the seam (JSON-at-200 of produce's return)
  // can't express.
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
      logger.error({ routeLabel: "api/merge/lock", err }, "[api/merge-lock] lock failed");
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/merge/unlock", async (_req, res) =>
    isolateAggregator(res, "api/merge/unlock", async () => {
      await releaseMergeLock();
      return { released: true };
    }),
  );

  return router;
}

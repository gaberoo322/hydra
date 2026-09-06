import { Router } from "express";
import {
  acquireMergeLock,
  getMergeLockHolder,
  releaseMergeLock,
} from "../redis/cycle-tracking.ts";
import { isolateAggregator } from "./route-helpers.ts";

/**
 * Merge lock routes.
 *
 * Extracted from api/misc.ts as part of issue #268. The merge lock is a
 * short-lived Redis lock (60s TTL) that serializes merges across Codex and
 * Claude Code cycles — see CLAUDE.md "Merge lock contention".
 */
export function createMergeLockRouter() {
  const router = Router();

  // POST /merge/lock is NOT an isolateAggregator route (issue #4402): the
  // await-dependent 409 (lock already held, `{ locked, holder }`) can't be
  // expressed through the seam (JSON-at-200 of produce's return).
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
      res.status(500).json({ error: err.message });
    }
  });

  // Issue #4402: never-throw-500 isolation via isolateAggregator
  // (route-helpers.ts, #909).
  router.post("/merge/unlock", async (_req, res) =>
    isolateAggregator(res, "api/merge/unlock", async () => {
      await releaseMergeLock();
      return { released: true };
    }),
  );

  return router;
}

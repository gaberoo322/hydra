import { Router } from "express";
import {
  acquireMergeLock,
  getMergeLockHolder,
  releaseMergeLock,
} from "../redis/cycle-tracking.ts";

/**
 * Merge lock routes.
 *
 * Extracted from api/misc.ts as part of issue #268. The merge lock is a
 * short-lived Redis lock (60s TTL) that serializes merges across Codex and
 * Claude Code cycles — see CLAUDE.md "Merge lock contention".
 */
export function createMergeLockRouter() {
  const router = Router();

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

  router.post("/merge/unlock", async (_req, res) => {
    try {
      await releaseMergeLock();
      res.json({ released: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

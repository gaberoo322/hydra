import { Router } from "express";

/**
 * GET /holdback — Tier-2 outcome holdback watcher state (issue #244).
 *
 * The Tier-2 Outcome Holdback watcher lived in `src/holdback.ts`, which
 * was removed in PR-3 (issue #383) along with the in-process control
 * loop that owned the watch/revert lifecycle. Autopilot subagents run
 * the equivalent regression check at PR-merge time now (see
 * `hydra-qa` + the rollback workflow), so the dashboard panel no longer
 * has a feed to render.
 *
 * The route is preserved as a stub returning empty arrays so the dashboard
 * widget doesn't 404. Tracked for removal in PR-4 (docs + dashboard cleanup).
 */
export function createHoldbackRouter() {
  const router = Router();

  router.get("/holdback", async (_req, res) => {
    res.json({ active: [], recent: [] });
  });

  return router;
}

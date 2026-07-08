import { Router } from "express";
import { runHousekeeping } from "../scheduler/housekeeping.ts";
import type { PublishableBus } from "../event-bus-seams.ts";

/**
 * Maintenance sub-router (issue #723 — scheduler fold PR-3/4).
 *
 * Exposes the time-boxed housekeeping chores (formerly riding on the
 * 2-minute scheduler tick) as an idempotent endpoint that an hourly
 * `hydra-housekeeping.timer` triggers. Running them through the live
 * orchestrator process reuses the in-process `eventBus` + dynamic imports
 * instead of reconstructing them in a standalone job.
 *
 * The endpoint is safe to call hourly (or more often): each chore keeps its
 * own internal time-guard, so a second immediate call skips the guarded
 * chores. The `{ ran, skipped }` summary makes that observable.
 */
export function createMaintenanceRouter(eventBus: PublishableBus) {
  const router = Router();

  // POST /maintenance/housekeeping — run the housekeeping chores.
  // Idempotent: each chore's internal time-guard means repeated calls within
  // a window are no-ops (reflected in the `skipped` array of the summary).
  router.post("/maintenance/housekeeping", async (req, res) => {
    try {
      const summary = await runHousekeeping(eventBus);
      res.json({ ok: true, ...summary });
    } catch (err: any) {
      // runHousekeeping is itself defensive (per-chore try/catch), but guard
      // the route too so an unexpected throw becomes a 500 with context rather
      // than an unhandled rejection.
      console.error(`[Maintenance] housekeeping run failed: ${err?.message || err}`);
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  return router;
}

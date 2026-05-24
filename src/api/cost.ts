import { Router } from "express";
import {
  getReconciliationHistory,
  reconcileDailyCosts,
  MAX_HISTORY_DAYS,
} from "../cost/reconciliation.ts";

/**
 * GET /cost/reconciliation — Codex-log vs Hydra-accounting cost reconciliation
 * (issue #296).
 *
 * Returns the last N days (default & max MAX_HISTORY_DAYS) of stored
 * reconciliation records, newest first.
 *
 * Optional query params:
 *   - `limit` — number of days, 1..MAX_HISTORY_DAYS (default MAX_HISTORY_DAYS)
 *   - `run`   — when set to a YYYY-MM-DD value, runs a fresh reconciliation
 *               for that date instead of reading from history. Useful for
 *               operator forensic on-demand runs before the scheduler hook
 *               lands (deferred to a follow-up issue per the PR scope).
 *
 * Returns the same JSON shape on success and failure (`error` populated on
 * failure) so dashboards can render a consistent panel.
 */
export function createCostRouter() {
  const router = Router();

  router.get("/cost/reconciliation", async (req, res) => {
    try {
      const runDate = typeof req.query.run === "string" ? req.query.run : null;
      if (runDate) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(runDate)) {
          return res.status(400).json({
            history: [],
            error: `invalid run= date (expected YYYY-MM-DD): ${runDate}`,
          });
        }
        const result = await reconcileDailyCosts(runDate);
        return res.json({ history: [result], ran: runDate });
      }
      const rawLimit = req.query.limit;
      const limit = typeof rawLimit === "string" ? parseInt(rawLimit, 10) : MAX_HISTORY_DAYS;
      const history = await getReconciliationHistory(
        Number.isFinite(limit) && limit > 0 ? limit : MAX_HISTORY_DAYS,
      );
      res.json({ history });
    } catch (err: any) {
      console.error(`[cost-api] unexpected error: ${err?.message || String(err)}`);
      res.status(500).json({ history: [], error: err?.message || String(err) });
    }
  });

  return router;
}

import { Router } from "express";
import {
  getStatsRollup,
  MAX_ROLLUP_WINDOW_DAYS,
  SCOUT_METRICS,
} from "../scout/stats.ts";
import { getScoutLastCalendarWalk } from "../redis/scout.ts";
import {
  listDispatchAudits,
  planAlertDispatches,
} from "../scout/alert-listener.ts";
import {
  ScoutDispatchesQuerySchema,
  ScoutStatsQuerySchema,
} from "../schemas/scout.ts";

/**
 * Tool-scout API surface (issue #485, Phase B).
 *
 * Exposes a "last N days" rollup of scout activity so operators can
 * answer "what did the scout do this week?" without reading Redis by
 * hand. The endpoint is read-only — all writes go through the scout
 * skill (Phase A) / autopilot dispatch (Phase B).
 */
export function createScoutRouter() {
  const router = Router();

  // GET /scout/stats?window=7 — per-category per-metric counts over the
  // last `window` days (default 7, max 14). Returns:
  //
  //   {
  //     window: 7,
  //     since: "2026-05-13T00:00:00.000Z",
  //     until: "2026-05-19T23:59:59.999Z",
  //     lastCalendarWalkAt: "2026-05-13T08:00:00Z" | null,
  //     categories: {
  //       "typed-schemas": { candidates: 7, filtered: 4, filed: 2, dropped: 1, rejected: 2 },
  //       ...
  //     },
  //     totals: { candidates: N, filtered: N, filed: N, dropped: N, rejected: N }
  //   }
  router.get("/scout/stats", async (req, res) => {
    try {
      // ADR-0022: read `window` through the Schemas seam (absent/garbage → 7),
      // then clamp to the rollup ceiling. The clamp stays in the route because
      // the legacy behaviour clamps an over-range value (Math.min) rather than
      // rejecting it to the default — see ScoutStatsQuerySchema.
      const window = Math.min(
        MAX_ROLLUP_WINDOW_DAYS,
        ScoutStatsQuerySchema.parse(req.query).window,
      );
      const now = new Date();
      const categories = await getStatsRollup(window, now);

      const totals: Record<string, number> = {};
      for (const m of SCOUT_METRICS) totals[m] = 0;
      for (const bucket of Object.values(categories)) {
        for (const m of SCOUT_METRICS) totals[m] += bucket[m] ?? 0;
      }

      const since = new Date(now.getTime() - (window - 1) * 24 * 60 * 60 * 1000);
      since.setUTCHours(0, 0, 0, 0);

      const lastWalk = await getScoutLastCalendarWalk();

      res.json({
        window,
        since: since.toISOString(),
        until: now.toISOString(),
        lastCalendarWalkAt: lastWalk,
        categories,
        totals,
      });
    } catch (err) {
      console.error("/api/scout/stats failed:", err);
      res.status(500).json({ error: "scout-stats failed" });
    }
  });

  // GET /scout/dispatches?limit=N — Phase C (issue #486) audit trail of
  // every scout invocation (calendar + alert). Newest-first. Returns:
  //
  //   {
  //     limit: 50,
  //     entries: [
  //       { triggeredBy, category, dispatchedAt, cost, outcome, detail },
  //       ...
  //     ]
  //   }
  //
  // Lets operators answer "did the test_decline alert last Tuesday
  // actually trigger a scout, and what came out of it?" without
  // dredging the Redis stream by hand.
  router.get("/scout/dispatches", async (req, res) => {
    try {
      // ADR-0022: read `limit` through the Schemas seam (default 50 on garbage).
      const { limit } = ScoutDispatchesQuerySchema.parse(req.query);
      const entries = await listDispatchAudits(limit);
      res.json({ limit, entries });
    } catch (err) {
      console.error("/api/scout/dispatches failed:", err);
      res.status(500).json({ error: "scout-dispatches failed" });
    }
  });

  // GET /scout/alert-plan — Phase C (issue #486) read-only preview of what
  // the alert listener WOULD dispatch right now. The autopilot consumes
  // this via collect-state.sh; operators can hit it directly to debug
  // why a known alert pattern didn't fire a scout. Doesn't advance the
  // cursor or stamp any cooldown — purely diagnostic.
  router.get("/scout/alert-plan", async (_req, res) => {
    try {
      const plan = await planAlertDispatches();
      res.json(plan);
    } catch (err) {
      console.error("/api/scout/alert-plan failed:", err);
      res.status(500).json({ error: "scout-alert-plan failed" });
    }
  });

  return router;
}

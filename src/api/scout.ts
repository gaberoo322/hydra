import { Router } from "express";
import {
  getStatsRollup,
  MAX_ROLLUP_WINDOW_DAYS,
  SCOUT_METRICS,
} from "../scout/stats.ts";
import { getString } from "../redis/kv.ts";
import { redisKeys } from "../redis-keys.ts";

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
      const rawWindow = parseInt(String(req.query.window ?? ""), 10);
      const window = Number.isFinite(rawWindow) && rawWindow > 0
        ? Math.min(MAX_ROLLUP_WINDOW_DAYS, rawWindow)
        : 7;
      const now = new Date();
      const categories = await getStatsRollup(window, now);

      const totals: Record<string, number> = {};
      for (const m of SCOUT_METRICS) totals[m] = 0;
      for (const bucket of Object.values(categories)) {
        for (const m of SCOUT_METRICS) totals[m] += bucket[m] ?? 0;
      }

      const since = new Date(now.getTime() - (window - 1) * 24 * 60 * 60 * 1000);
      since.setUTCHours(0, 0, 0, 0);

      const lastWalk = await getString(redisKeys.scoutLastCalendarWalk());

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

  return router;
}

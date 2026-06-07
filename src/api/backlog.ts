import { Router } from "express";
import { loadBacklog, getBacklogCounts, getItemsByParent } from "../backlog/reads.ts";
import { addToBacklog, updateItem } from "../backlog/items.ts";
import { moveItemToLane, deleteItem } from "../backlog/lanes.ts";
import { isWipLimitReached } from "../backlog/wip.ts";
import { claimNextQueuedItem } from "../backlog/claims.ts";
import { getStaleClaims, reapStaleClaims } from "../backlog/reaper.ts";
import {
  getClaimsReapedLifetime,
  getClaimsReapedDay,
  getClaimsReapedLast,
} from "../redis/backlog.ts";
import { z } from "zod";

/**
 * Query schema for `GET /backlog/stale-claims?maxAgeMs=N` (ADR-0022).
 *
 * `maxAgeMs` is an OPTIONAL positive-integer override; an absent, non-numeric,
 * zero, or negative value collapses to `undefined` so the caller falls back to
 * the env/default threshold — preserving the legacy
 * `Number.isFinite(rawMax) && rawMax > 0 ? rawMax : envMax` semantics without a
 * behaviour-changing 400. Non-strict so it ignores any other query params.
 */
const StaleClaimsQuerySchema = z.object({
  maxAgeMs: z
    .coerce.number()
    .int()
    .positive()
    .optional()
    // Any failure (absent, NaN from a non-numeric string, zero/negative)
    // collapses to undefined so the caller applies its env/default fallback.
    .catch(undefined),
});

export function createBacklogRouter() {
  const router = Router();

  // GET /backlog — Full Kanban backlog with all lanes
  router.get("/backlog", async (req, res) => {
    try {
      const lanes = await loadBacklog();
      const counts = await getBacklogCounts();
      res.json({ ...lanes, counts });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /backlog/counts — Just the counts per lane (includes WIP limit status)
  router.get("/backlog/counts", async (req, res) => {
    try {
      const counts = await getBacklogCounts();
      const wip = await isWipLimitReached();
      res.json({ ...counts, wip });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /backlog — Manually add an item to the backlog
  router.post("/backlog", async (req, res) => {
    try {
      const { title, category, priority, description, labels, estimate, parentId } = req.body || {};
      if (!title) return res.status(400).json({ error: "Missing 'title'" });
      const result = await addToBacklog({
        title, category: category || "uncategorized", source: "operator",
        priority, description, labels, estimate, parentId,
      });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PATCH /backlog/:id — Update item fields
  router.patch("/backlog/:id", async (req, res) => {
    try {
      const result = await updateItem(req.params.id, req.body || {});
      if (!result.ok) return res.status(404).json(result);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PATCH /backlog/:id/move — Move item between lanes
  //
  // Issue #640: also forwards an optional `claimedBy` field so callers can
  // tag a kanban item with a PR-number marker (e.g. `pr-27`) at PR-open
  // time. The candidates API uses this marker to hide the just-shipped
  // anchor from decide.py until the PR merges.
  router.patch("/backlog/:id/move", async (req, res) => {
    try {
      const { lane, claimedBy } = req.body || {};
      if (!lane) return res.status(400).json({ error: "Missing 'lane'" });
      const opts = claimedBy !== undefined ? { claimedBy } : {};
      const result = await moveItemToLane(req.params.id, lane, opts);
      if (!result.ok) return res.status(404).json(result);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /backlog/:id/approve — Move item from triage to backlog
  router.post("/backlog/:id/approve", async (req, res) => {
    try {
      const result = await moveItemToLane(req.params.id, "backlog");
      if (!result.ok) return res.status(404).json(result);
      res.json({ ...result, approved: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /backlog/:id/children — List child items for a parent
  router.get("/backlog/:id/children", async (req, res) => {
    try {
      const children = await getItemsByParent(req.params.id);
      res.json(children);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /backlog/:id — Remove an item
  router.delete("/backlog/:id", async (req, res) => {
    try {
      const result = await deleteItem(req.params.id);
      if (!result.ok) return res.status(404).json(result);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /backlog/stale-claims — preview of inProgress items, with each claim's
  // current age, and which are over the configured `maxAgeMs` threshold (issue
  // #374). Optional `?maxAgeMs=N` overrides the default for diagnostic queries.
  router.get("/backlog/stale-claims", async (req, res) => {
    try {
      // ADR-0022: read `maxAgeMs` through the Schemas seam. The schema yields a
      // positive integer or undefined; undefined falls back to env/default.
      const rawMax = StaleClaimsQuerySchema.safeParse(req.query).data?.maxAgeMs;
      const envMax = parseInt(process.env.HYDRA_CLAIM_MAX_AGE_MS ?? "") || 2 * 60 * 60 * 1000;
      const maxAgeMs = rawMax ?? envMax;
      const { all, stale, maxAgeMs: usedMax } = await getStaleClaims({ maxAgeMs });
      const lifetime = await getClaimsReapedLifetime();
      const isoDate = new Date().toISOString().split("T")[0];
      const day = await getClaimsReapedDay(isoDate);
      const last = await getClaimsReapedLast();
      res.json({
        maxAgeMs: usedMax,
        inProgress: all,
        stale,
        metrics: {
          claimsReapedLifetime: lifetime ? parseInt(lifetime, 10) : 0,
          claimsReapedToday: day ? parseInt(day, 10) : 0,
          lastReapedAt: last,
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /backlog/stale-claims/reap — operator-triggered reaper run.
  router.post("/backlog/stale-claims/reap", async (req, res) => {
    try {
      const body = req.body || {};
      const envMax = parseInt(process.env.HYDRA_CLAIM_MAX_AGE_MS ?? "") || 2 * 60 * 60 * 1000;
      const maxAgeMs = typeof body.maxAgeMs === "number" && body.maxAgeMs > 0 ? body.maxAgeMs : envMax;
      const result = await reapStaleClaims({ maxAgeMs });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Atomic claim of next queued backlog item
  router.post("/backlog/claim", async (req, res) => {
    try {
      const { claimedBy } = req.body || {};
      const result = await claimNextQueuedItem(claimedBy || "claude");
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

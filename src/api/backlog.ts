import { Router } from "express";
import { loadBacklog, getBacklogCounts, getItemsByParent } from "../backlog/reads.ts";
import { addToBacklog, updateItem } from "../backlog/items.ts";
import { moveItemToLane, deleteItem } from "../backlog/lanes.ts";
import { isWipLimitReached } from "../backlog/wip.ts";
import { claimNextQueuedItem } from "../backlog/claims.ts";
import { getStaleClaims, reapStaleClaims } from "../backlog/reaper.ts";
import { auditLaneIndices } from "../backlog/index-reconciler.ts";
import {
  getClaimsReapedLifetime,
  getClaimsReapedDay,
  getClaimsReapedLast,
} from "../redis/backlog.ts";
import { z } from "zod";
import { BacklogClaimBodySchema } from "../schemas/backlog.ts";
import { aggregatorRouteNoQuery } from "./route-helpers.ts";

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
  //
  // Issue #1863: never-throw-500 isolation via the aggregatorRouteNoQuery seam
  // (route-helpers.ts, #909).
  router.get(
    "/backlog",
    aggregatorRouteNoQuery("api/backlog", async () => {
      const lanes = await loadBacklog();
      const counts = await getBacklogCounts();
      return { ...lanes, counts };
    }),
  );

  // GET /backlog/counts — Just the counts per lane (includes WIP limit status)
  //
  // Issue #1863: never-throw-500 isolation via aggregatorRouteNoQuery (#909).
  router.get(
    "/backlog/counts",
    aggregatorRouteNoQuery("api/backlog/counts", async () => {
      const counts = await getBacklogCounts();
      const wip = await isWipLimitReached();
      return { ...counts, wip };
    }),
  );

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
  //
  // Issue #1863: never-throw-500 isolation via aggregatorRouteNoQuery (#909).
  // The `:id` path param is read off `req`.
  router.get(
    "/backlog/:id/children",
    aggregatorRouteNoQuery("api/backlog/children", (req) =>
      getItemsByParent(req.params.id),
    ),
  );

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
  //
  // Issue #1863: never-throw-500 isolation via aggregatorRouteNoQuery (#909).
  // `maxAgeMs` keeps its soft-parse (positive-int-or-undefined, no 400) inside
  // `produce`, per the common.ts guidance for lenient read routes.
  router.get(
    "/backlog/stale-claims",
    aggregatorRouteNoQuery("api/backlog/stale-claims", async (req) => {
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
      return {
        maxAgeMs: usedMax,
        inProgress: all,
        stale,
        metrics: {
          claimsReapedLifetime: lifetime ? parseInt(lifetime, 10) : 0,
          claimsReapedToday: day ? parseInt(day, 10) : 0,
          lastReapedAt: last,
        },
      };
    }),
  );

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

  // GET /backlog/audit — Read-only diagnostic of the items hash vs. the lane
  // sorted-set indices (issue #2056). Surfaces exactly the divergences the
  // startup/housekeeping reconciler would repair — hash items missing from
  // their lane zset, orphan zset members, and un-laned items — WITHOUT mutating
  // anything. Backed by the same `getAllBacklogItems()` hash-scan accessor.
  //
  // Issue #1863: never-throw-500 isolation via aggregatorRouteNoQuery (#909).
  router.get(
    "/backlog/audit",
    aggregatorRouteNoQuery("api/backlog/audit", () => auditLaneIndices()),
  );

  // POST /backlog/claim — Atomic claim of a queued backlog item.
  //
  // Issue #1682: the body validates through the Schemas seam and honours an
  // optional `itemId` for targeted claims. Absent `itemId` keeps the pop-head
  // behavior (including 200 + {claimed:false, reason} for wip-limit/empty/
  // race). Targeted-claim failures map to HTTP status here — and ONLY here:
  // not-found → 404 (no such item), not-queued → 409 (exists, wrong lane).
  router.post("/backlog/claim", async (req, res) => {
    try {
      const parsed = BacklogClaimBodySchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          code: "schema-validation-failed",
          issues: parsed.error.issues,
        });
      }
      const { claimedBy, itemId } = parsed.data;
      const result = await claimNextQueuedItem(claimedBy || "claude", itemId);
      if (!result.claimed && result.reason === "not-found") return res.status(404).json(result);
      if (!result.claimed && result.reason === "not-queued") return res.status(409).json(result);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

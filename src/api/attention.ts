/**
 * Attention-feed HTTP surface (issue #4007, ADR-0034 §4).
 *
 * A sibling top-level router (mirroring `src/api/alerts.ts`,
 * `src/api/builder-health.ts`) — deliberately NOT mounted inside
 * `src/api/today-page.ts`, which the issue lists under Files out of scope:
 * the attention feed is the `/` page's primary surface and deserves its own
 * seam rather than widening an already-large router.
 *
 *   GET  /attention/feed        — crossed thresholds as one heterogeneous
 *                                 list, with the ADR-0034 §5.2
                                 asserted-emptiness evidence.
 *   POST /attention/:id/dismiss — dismiss one item with a reason (validated
 *                                 through src/schemas/attention.ts).
 *   GET  /attention/counts      — per-threshold surfaced/dismissed counts
 *                                 (the falsifiable-calibration read).
 */

import { Router } from "express";
import { aggregatorRouteNoQuery, schemaValidationError } from "./route-helpers.ts";
import {
  DismissAttentionRequestSchema,
  type AttentionCountsResponse,
  type AttentionFeedResponse,
} from "../schemas/attention.ts";
import {
  getAttentionFeed,
  type AttentionFeedDeps,
} from "../attention.ts";
import {
  dismissAttentionItem,
  readAttentionCounts,
} from "../redis/attention.ts";
import { logger } from "../logger.ts";

export interface AttentionRouterDeps extends AttentionFeedDeps {
  /** Override the dismiss write. Tests inject a stub. */
  dismissItem?: (id: string, signal: "blocked-on-human" | "breakage" | "repetition") => Promise<boolean>;
  /** Override the calibration-count read. Tests inject a stub. */
  readCounts?: () => Promise<AttentionCountsResponse["counts"]>;
}

export function createAttentionRouter(deps: AttentionRouterDeps = {}) {
  const router = Router();
  const dismiss = deps.dismissItem ?? dismissAttentionItem;
  const readCounts = deps.readCounts ?? readAttentionCounts;

  // -------------------------------------------------------------------------
  // GET /attention/feed
  // -------------------------------------------------------------------------
  router.get(
    "/attention/feed",
    aggregatorRouteNoQuery(
      "api/attention/feed",
      async (): Promise<AttentionFeedResponse> => {
        // Forward the asserted-emptiness evidence (scanned / sourcesOk) so
        // the client can distinguish a genuine all-clear from a silent
        // sub-fetch failure — the route cannot infer it (the composer never
        // throws).
        const feed = await getAttentionFeed(deps);
        return {
          items: feed.items,
          scanned: feed.scanned,
          sourcesOk: feed.sourcesOk,
          generatedAt: new Date().toISOString(),
        };
      },
    ),
  );

  // -------------------------------------------------------------------------
  // POST /attention/:id/dismiss
  // -------------------------------------------------------------------------
  // ADR-0034 §7: dismiss is an "immediate, with undo"-tier action — fires on
  // click, no confirm step. Not an aggregatorRouteNoQuery route: the body
  // validation owns the 400 and the success path is a plain JSON 200.
  router.post("/attention/:id/dismiss", async (req, res) => {
    try {
      const parsed = DismissAttentionRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json(schemaValidationError(parsed.error));
      }
      // `recorded` is false on a repeat dismissal of the same item id — the
      // per-threshold counter only counts the first one (no double-counting
      // a line from double-clicks).
      const recorded = await dismiss(req.params.id, parsed.data.signal);
      return res.json({ ok: true, recorded });
    } catch (err: any) {
      logger.error(
        { itemId: req.params.id, err },
        "[api/attention] dismiss failed",
      );
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // GET /attention/counts
  // -------------------------------------------------------------------------
  router.get(
    "/attention/counts",
    aggregatorRouteNoQuery(
      "api/attention/counts",
      async (): Promise<AttentionCountsResponse> => ({
        counts: await readCounts(),
        generatedAt: new Date().toISOString(),
      }),
    ),
  );

  return router;
}

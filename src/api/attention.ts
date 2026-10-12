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
 *   POST /attention/:id/dismiss — dismiss one episode with a TYPED reason +
 *                                 admission-line key (validated through
 *                                 src/schemas/attention.ts; ADR-0034 §8.4).
 *   GET  /attention/counts      — per-line rolling-30d calibration verdicts
 *                                 (the falsifiable-calibration read, §8.4).
 */

import { Router } from "express";
import { aggregatorRouteNoQuery, isolateAggregator, schemaValidationError } from "./route-helpers.ts";
import {
  DismissAttentionRequestSchema,
  type AttentionCountsResponse,
  type AttentionDismissReason,
  type AttentionFeedResponse,
} from "../schemas/attention.ts";
import {
  getAttentionFeed,
  type AttentionFeedDeps,
} from "../attention.ts";
import { CALIBRATION_WINDOW_DAYS } from "../attention-calibration.ts";
import {
  dismissAttentionItem,
  readCalibrationLines,
} from "../redis/attention.ts";

export interface AttentionRouterDeps extends AttentionFeedDeps {
  /** Override the dismiss write. Tests inject a stub. */
  dismissItem?: (
    id: string,
    key: string,
    reason: AttentionDismissReason,
  ) => Promise<boolean>;
  /** Override the per-line calibration read. Tests inject a stub. */
  readCounts?: () => Promise<AttentionCountsResponse["lines"]>;
}

export function createAttentionRouter(deps: AttentionRouterDeps = {}) {
  const router = Router();
  const dismiss = deps.dismissItem ?? dismissAttentionItem;
  const readCounts = deps.readCounts ?? readCalibrationLines;

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
          buckets: feed.buckets,
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
  // ADR-0034 §7/§8.4: dismiss is an "immediate, with undo"-tier action — one
  // click, no confirm step, with a TYPED reason carried beside the admission
  // line `key`. Not an aggregatorRouteNoQuery route: the body validation owns
  // the 400 and the success path is a plain JSON 200.
  router.post("/attention/:id/dismiss", async (req, res) => {
    const parsed = DismissAttentionRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json(schemaValidationError(parsed.error));
    }
    return isolateAggregator(res, "api/attention/dismiss", async () => {
      // `recorded` is false on a repeat dismissal of the same episode — the
      // per-line counter and the audit stream only see the first one (no
      // double-counting a line from double-clicks).
      const recorded = await dismiss(req.params.id, parsed.data.key, parsed.data.reason);
      return { ok: true, recorded };
    });
  });

  // -------------------------------------------------------------------------
  // GET /attention/counts
  // -------------------------------------------------------------------------
  router.get(
    "/attention/counts",
    aggregatorRouteNoQuery(
      "api/attention/counts",
      async (): Promise<AttentionCountsResponse> => ({
        windowDays: CALIBRATION_WINDOW_DAYS,
        generatedAt: new Date().toISOString(),
        lines: await readCounts(),
      }),
    ),
  );

  return router;
}

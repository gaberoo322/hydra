/**
 * Dashboard v2 — Now page recommendation write-path HTTP surface.
 *
 * Extracted from `src/api/now-page.ts` (issue #1323) so the recommendation
 * read+write lifecycle lives apart from the uniform dashboard read-aggregator
 * routes. As of issue #3570 the domain logic (recommendation retrieval,
 * severity-based muting, dismissal tracking) lives in the pure aggregator leaf
 * `src/aggregators/now-recommendations.ts`; the three routes here are now thin
 * adapters — each validates its input, resolves the default deps, calls one
 * aggregator entrypoint, and serialises the typed result under the shared
 * `route-helpers.ts` never-throw 500 isolation:
 *
 *   GET  /now/recommendations              — active (non-dismissed, non-muted) recs
 *   POST /now/recommendations/:id/dismiss  — dismiss a single rec
 *   POST /now/recommendations/mute-class   — mute a severity class
 *
 * The router is mounted prefix-less from `src/api.ts` (exactly like
 * `createNowPageRouter()`), so Express registers the same literal `/now/*`
 * paths and dashboard clients see no URL change. The `Rec*` query/body schemas
 * are local-only (consumed by this router alone) and stay inline here, mirroring
 * how `now-page.ts` previously inlined them — they are NOT promoted to
 * `src/schemas/now-page.ts`.
 */

import { Router } from "express";
import { z } from "zod";

import * as defaultRecsRedis from "../redis/recommendations.ts";
import { RUN_TTL_SECONDS } from "../autopilot/sweep-reader.ts";
import { getCurrentRun as defaultGetCurrentRun } from "../autopilot/run-reads.ts";
import { schemaValidationError, isolateAggregator } from "./route-helpers.ts";
import {
  getActiveRecommendations,
  dismissRecommendationForRun,
  muteSeverityClassForRun,
  type NowRecommendationsDeps,
  type RecommendationsReaderDeps,
  type CurrentRunIdReader,
} from "../aggregators/now-recommendations.ts";

// Re-export the aggregator's pure helpers + deps types from their historical
// home so existing importers (tests, callers) keep resolving them here.
export {
  resolveRunId,
  filterActiveRecommendations,
} from "../aggregators/now-recommendations.ts";
export type {
  RecommendationsReaderDeps,
  CurrentRunIdReader,
} from "../aggregators/now-recommendations.ts";

// ---------------------------------------------------------------------------
// Recommendations sub-router schemas (issue #674)
// ---------------------------------------------------------------------------

const RecListQuerySchema = z
  .object({
    run_id: z
      .string({ message: "run_id must be a string" })
      .trim()
      .min(1, { message: "run_id must be non-empty" })
      .default("current"),
  })
  .strict();

const RecMuteClassBodySchema = z
  .object({
    run_id: z
      .string({ message: "run_id must be a string" })
      .trim()
      .min(1, { message: "run_id must be non-empty" })
      .default("current"),
    severity: z.enum(["info", "warn", "critical"], {
      message: "severity must be one of info|warn|critical",
    }),
  })
  .strict();

const RecDismissBodySchema = z
  .object({
    run_id: z
      .string({ message: "run_id must be a string" })
      .trim()
      .min(1, { message: "run_id must be non-empty" })
      .default("current"),
  })
  .strict();

// ---------------------------------------------------------------------------
// Router factory deps
// ---------------------------------------------------------------------------

export interface NowRecommendationsRouterDeps {
  /**
   * Reader returning the current run_id (most-recent run), for
   * `?run_id=current` resolution. Defaults to a thin call into
   * autopilot/runs.ts.
   */
  readCurrentRunId?: CurrentRunIdReader;
  /**
   * Recommendations Redis facade — defaults to the typed accessor
   * module. Tests inject an in-memory stub.
   */
  recsRedis?: RecommendationsReaderDeps;
  /** Clock — defaults to `() => new Date()`. */
  now?: () => Date;
}

export function createNowRecommendationsRouter(
  deps: NowRecommendationsRouterDeps = {},
) {
  const router = Router();
  const aggregatorDeps: NowRecommendationsDeps = {
    recsRedis: deps.recsRedis ?? defaultRecsRedis,
    readCurrentRunId: deps.readCurrentRunId ?? defaultReadCurrentRunId,
    now: deps.now ?? (() => new Date()),
    ttlSeconds: RUN_TTL_SECONDS,
  };

  // -------------------------------------------------------------------------
  // GET /now/recommendations — active (non-dismissed, non-muted-class) recs
  // -------------------------------------------------------------------------
  router.get("/now/recommendations", async (req, res) => {
    const parsed = RecListQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return res.status(400).json(schemaValidationError(parsed.error));
    }
    return isolateAggregator(res, "now/recommendations", () =>
      getActiveRecommendations(parsed.data.run_id, aggregatorDeps),
    );
  });

  // -------------------------------------------------------------------------
  // POST /now/recommendations/:id/dismiss
  // -------------------------------------------------------------------------
  router.post("/now/recommendations/:id/dismiss", async (req, res) => {
    const recId = String(req.params.id || "").trim();
    if (!recId) {
      return res.status(400).json({
        code: "schema-validation-failed",
        issues: [{ message: "rec id must be non-empty" }],
      });
    }
    const parsed = RecDismissBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json(schemaValidationError(parsed.error));
    }
    return isolateAggregator(res, "now/recommendations/dismiss", async () => {
      const result = await dismissRecommendationForRun(
        parsed.data.run_id,
        recId,
        aggregatorDeps,
      );
      if (result.kind === "run_missing") {
        res.status(404);
        return { error: "no current run" };
      }
      return {
        run_id: result.run_id,
        rec_id: result.rec_id,
        dismissed: result.dismissed,
      };
    });
  });

  // -------------------------------------------------------------------------
  // POST /now/recommendations/mute-class
  // -------------------------------------------------------------------------
  router.post("/now/recommendations/mute-class", async (req, res) => {
    const parsed = RecMuteClassBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json(schemaValidationError(parsed.error));
    }
    return isolateAggregator(res, "now/recommendations/mute-class", async () => {
      const result = await muteSeverityClassForRun(
        parsed.data.run_id,
        parsed.data.severity,
        aggregatorDeps,
      );
      if (result.kind === "run_missing") {
        res.status(404);
        return { error: "no current run" };
      }
      return {
        run_id: result.run_id,
        severity: result.severity,
        muted: result.muted,
      };
    });
  });

  return router;
}

// ---------------------------------------------------------------------------
// Default wiring
// ---------------------------------------------------------------------------

async function defaultReadCurrentRunId(): Promise<string | null> {
  const result = await defaultGetCurrentRun();
  if (!result.ok) return null;
  const view = result.view as Record<string, unknown>;
  const id = typeof view.run_id === "string" ? view.run_id : "";
  return id || null;
}

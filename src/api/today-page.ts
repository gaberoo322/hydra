/**
 * Dashboard v2 — Today page HTTP surface (issues #616, #617, PRD #615).
 *
 * Slice 1 shipped `/v2/today/summary` — the overnight banner.
 * Slice 2 adds the remaining five sections, each a thin adapter over a
 * dedicated aggregator under `src/aggregators/`:
 *
 *   GET /api/v2/today/summary             — overnight banner (slice 1)
 *   GET /api/v2/today/decision-queue      — operator-decision unified queue
 *   GET /api/v2/today/stuck               — stuck issues + PRs with failed CI
 *   GET /api/v2/today/merges              — recent merged PRs (newest first)
 *   GET /api/v2/today/findings            — un-routed target-backlog findings
 *   GET /api/v2/today/lessons-overnight   — friction promotion candidates + meta-friction
 *
 * Every route follows the same shape: parse the query through a zod
 * schema, return `schema-validation-failed` on bad input, delegate to the
 * pure aggregator otherwise. Each aggregator is overridable via the
 * `deps` factory parameter so tests can stub without subprocesses or
 * Redis.
 */

import { Router } from "express";
import { aggregatorRoute, aggregatorRouteNoQuery } from "./route-helpers.ts";
import {
  OvernightSummaryQuerySchema,
  RecentMergesQuerySchema,
  WindowedQuerySchema,
  type OvernightSummaryResponse,
  type DecisionQueueResponse,
  type StuckItemsResponse,
  type RecentMergesResponse,
  type FindingsResponse,
  type LessonsOvernightResponse,
} from "../schemas/today-page.ts";
import {
  getOvernightSummary,
  type OvernightSummaryDeps,
} from "../aggregators/overnight-summary.ts";
import {
  getDecisionQueue,
  type DecisionQueueDeps,
  type DecisionItem,
} from "../aggregators/decision-queue.ts";
import {
  getStuckItems,
  type StuckItemsDeps,
  type StuckItems,
} from "../aggregators/stuck-items.ts";
import {
  getRecentMerges,
  type RecentMergesDeps,
  type MergeItem,
} from "../aggregators/recent-merges.ts";
import {
  getNewTargetFindings,
  type TargetFindingsDeps,
  type Finding,
} from "../aggregators/target-backlog-findings.ts";
import {
  getOvernightLessons,
  type LessonsOvernightDeps,
  type OvernightLessons,
} from "../aggregators/lessons-overnight.ts";

export interface TodayPageRouterDeps {
  /**
   * Aggregator overrides — used by tests to stub the underlying data
   * sources without seeding Redis or spawning subprocesses. Production
   * callers pass nothing and the real aggregators run.
   */
  getOvernightSummary?: (
    windowHours: number,
    deps?: OvernightSummaryDeps,
  ) => Promise<OvernightSummaryResponse>;
  getDecisionQueue?: (deps?: DecisionQueueDeps) => Promise<DecisionItem[]>;
  getStuckItems?: (deps?: StuckItemsDeps) => Promise<StuckItems>;
  getRecentMerges?: (
    limit: number,
    deps?: RecentMergesDeps,
  ) => Promise<MergeItem[]>;
  getNewTargetFindings?: (
    windowHours: number,
    deps?: TargetFindingsDeps,
  ) => Promise<Finding[]>;
  getOvernightLessons?: (
    windowHours: number,
    deps?: LessonsOvernightDeps,
  ) => Promise<OvernightLessons>;
}

export function createTodayPageRouter(deps: TodayPageRouterDeps = {}) {
  const router = Router();
  const aggregateOvernight = deps.getOvernightSummary ?? getOvernightSummary;
  const aggregateDecisionQueue = deps.getDecisionQueue ?? getDecisionQueue;
  const aggregateStuck = deps.getStuckItems ?? getStuckItems;
  const aggregateMerges = deps.getRecentMerges ?? getRecentMerges;
  const aggregateFindings = deps.getNewTargetFindings ?? getNewTargetFindings;
  const aggregateLessons = deps.getOvernightLessons ?? getOvernightLessons;

  // -------------------------------------------------------------------------
  // GET /v2/today/summary — slice 1
  // -------------------------------------------------------------------------
  router.get(
    "/today/summary",
    aggregatorRoute(
      OvernightSummaryQuerySchema,
      "v2/today/summary",
      (data): Promise<OvernightSummaryResponse> =>
        aggregateOvernight(data.windowHours),
    ),
  );

  // -------------------------------------------------------------------------
  // GET /v2/today/decision-queue — slice 2
  // -------------------------------------------------------------------------
  router.get(
    "/today/decision-queue",
    aggregatorRouteNoQuery(
      "v2/today/decision-queue",
      async (): Promise<DecisionQueueResponse> => ({
        items: await aggregateDecisionQueue(),
        generatedAt: new Date().toISOString(),
      }),
    ),
  );

  // -------------------------------------------------------------------------
  // GET /v2/today/stuck — slice 2
  // -------------------------------------------------------------------------
  router.get(
    "/today/stuck",
    aggregatorRouteNoQuery(
      "v2/today/stuck",
      (): Promise<StuckItemsResponse> => aggregateStuck(),
    ),
  );

  // -------------------------------------------------------------------------
  // GET /v2/today/merges — slice 2
  // -------------------------------------------------------------------------
  router.get(
    "/today/merges",
    aggregatorRoute(
      RecentMergesQuerySchema,
      "v2/today/merges",
      async (data): Promise<RecentMergesResponse> => ({
        items: await aggregateMerges(data.limit),
        limit: data.limit,
        generatedAt: new Date().toISOString(),
      }),
    ),
  );

  // -------------------------------------------------------------------------
  // GET /v2/today/findings — slice 2
  // -------------------------------------------------------------------------
  router.get(
    "/today/findings",
    aggregatorRoute(
      WindowedQuerySchema,
      "v2/today/findings",
      async (data): Promise<FindingsResponse> => ({
        items: await aggregateFindings(data.windowHours),
        windowHours: data.windowHours,
        generatedAt: new Date().toISOString(),
      }),
    ),
  );

  // -------------------------------------------------------------------------
  // GET /v2/today/lessons-overnight — slice 2
  // -------------------------------------------------------------------------
  router.get(
    "/today/lessons-overnight",
    aggregatorRoute(
      WindowedQuerySchema,
      "v2/today/lessons-overnight",
      (data): Promise<LessonsOvernightResponse> =>
        aggregateLessons(data.windowHours),
    ),
  );

  return router;
}

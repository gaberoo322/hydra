/**
 * Dashboard v2 — Explore page HTTP surface (issue #620, PRD #615).
 *
 * Five endpoints, one per new aggregator. Each follows the slice-1/2
 * pattern: parse query through a zod schema, return
 * `schema-validation-failed` on bad input, delegate to the pure
 * aggregator otherwise. Every aggregator is overridable via the `deps`
 * factory parameter so tests can stub without subprocesses, Redis, or
 * the network.
 *
 * The Architecture and Search tabs reuse the existing routers
 * (`/api/architecture` and `/api/openviking/search`) — no new endpoint
 * needed here.
 */

import { Router } from "express";
import { aggregatorRoute, aggregatorRouteNoQuery } from "./route-helpers.ts";
import {
  BehaviorGalleryQuerySchema,
  BacklogFlowQuerySchema,
  LessonsExplorerQuerySchema,
  type FrictionPatternsResponse,
  type BehaviorGalleryResponse,
  type BacklogFlowResponse,
  type LessonsExplorerResponse,
  type AnomalyDetectorResponse,
} from "../schemas/explore-page.ts";
import {
  getFrictionPatterns,
  type FrictionPatternsDeps,
  type FrictionPatternsSnapshot,
} from "../aggregators/friction-patterns.ts";
import {
  getBehaviorGallery,
  type BehaviorGalleryDeps,
  type BehaviorFilters,
  type BehaviorRow,
} from "../aggregators/behavior-gallery.ts";
import {
  getBacklogFlow,
  type BacklogFlowDeps,
  type BacklogFlow,
} from "../aggregators/backlog-flow.ts";
import {
  getLessonsExplorer,
  type LessonsExplorerDeps,
  type LessonsExplorerFilters,
  type LessonsExplorerSnapshot,
} from "../aggregators/lessons-explorer.ts";
import {
  getAnomalies,
  type AnomalyDetectorDeps,
  type AnomalyDetectorSnapshot,
} from "../aggregators/anomaly-detector.ts";

export interface ExplorePageRouterDeps {
  getFrictionPatterns?: (
    deps?: FrictionPatternsDeps,
  ) => Promise<FrictionPatternsSnapshot>;
  getBehaviorGallery?: (
    limit: number,
    filters?: BehaviorFilters,
    deps?: BehaviorGalleryDeps,
  ) => Promise<BehaviorRow[]>;
  getBacklogFlow?: (
    windowDays: number,
    deps?: BacklogFlowDeps,
  ) => Promise<BacklogFlow>;
  getLessonsExplorer?: (
    filters?: LessonsExplorerFilters,
    deps?: LessonsExplorerDeps,
  ) => Promise<LessonsExplorerSnapshot>;
  getAnomalies?: (
    deps?: AnomalyDetectorDeps,
  ) => Promise<AnomalyDetectorSnapshot>;
}

export function createExplorePageRouter(deps: ExplorePageRouterDeps = {}) {
  const router = Router();
  const aggregateFriction = deps.getFrictionPatterns ?? getFrictionPatterns;
  const aggregateBehavior = deps.getBehaviorGallery ?? getBehaviorGallery;
  const aggregateFlow = deps.getBacklogFlow ?? getBacklogFlow;
  const aggregateLessons = deps.getLessonsExplorer ?? getLessonsExplorer;
  const aggregateAnomalies = deps.getAnomalies ?? getAnomalies;

  // -------------------------------------------------------------------------
  // GET /v2/explore/friction
  // -------------------------------------------------------------------------
  router.get(
    "/explore/friction",
    aggregatorRouteNoQuery(
      "v2/explore/friction",
      (): Promise<FrictionPatternsResponse> => aggregateFriction(),
    ),
  );

  // -------------------------------------------------------------------------
  // GET /v2/explore/behavior?limit=&class=&outcome=
  // -------------------------------------------------------------------------
  router.get(
    "/explore/behavior",
    aggregatorRoute(
      BehaviorGalleryQuerySchema,
      "v2/explore/behavior",
      async (data): Promise<BehaviorGalleryResponse> => {
        const { limit, class: classFilter, outcome } = data;
        const filters: BehaviorFilters = {};
        if (classFilter) filters.class = classFilter;
        if (outcome) filters.outcome = outcome;
        const items = await aggregateBehavior(limit, filters);
        return {
          items,
          limit,
          filters: {
            class: classFilter ?? null,
            outcome: outcome ?? null,
          },
          generatedAt: new Date().toISOString(),
        };
      },
    ),
  );

  // -------------------------------------------------------------------------
  // GET /v2/explore/flow?window=7d
  // -------------------------------------------------------------------------
  router.get(
    "/explore/flow",
    aggregatorRoute(
      BacklogFlowQuerySchema,
      "v2/explore/flow",
      (data): Promise<BacklogFlowResponse> =>
        aggregateFlow(Number(data.window.slice(0, -1))),
    ),
  );

  // -------------------------------------------------------------------------
  // GET /v2/explore/lessons?skill=
  // -------------------------------------------------------------------------
  router.get(
    "/explore/lessons",
    aggregatorRoute(
      LessonsExplorerQuerySchema,
      "v2/explore/lessons",
      (data): Promise<LessonsExplorerResponse> => {
        const filters: LessonsExplorerFilters = {};
        if (data.skill) filters.skill = data.skill;
        return aggregateLessons(filters);
      },
    ),
  );

  // -------------------------------------------------------------------------
  // GET /v2/explore/anomalies
  // -------------------------------------------------------------------------
  router.get(
    "/explore/anomalies",
    aggregatorRouteNoQuery(
      "v2/explore/anomalies",
      (): Promise<AnomalyDetectorResponse> => aggregateAnomalies(),
    ),
  );

  return router;
}

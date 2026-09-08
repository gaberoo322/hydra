/**
 * Dashboard v2 — Explore page HTTP surface (issue #620, PRD #615).
 *
 * Three endpoints, one per live aggregator. Each follows the slice-1/2
 * pattern: parse query through a zod schema, return
 * `schema-validation-failed` on bad input, delegate to the pure
 * aggregator otherwise. Every aggregator is overridable via the `deps`
 * factory parameter so tests can stub without subprocesses, Redis, or
 * the network.
 *
 * The Architecture tab reuses the existing `/api/architecture` router — no new
 * endpoint needed here. (The Search tab's `/api/openviking/search` was deleted
 * with the knowledge plane, ADR-0033.) The `anomalies` and `flow` routes were
 * removed as orphaned dead code (issue #4356) — their frontend tabs were
 * deleted in #4012/#4256 but the backend routes were missed since knip only
 * sees same-language imports.
 */

import { Router } from "express";
import { aggregatorRoute, aggregatorRouteNoQuery } from "./route-helpers.ts";
import {
  BehaviorGalleryQuerySchema,
  LessonsExplorerQuerySchema,
  type FrictionPatternsResponse,
  type BehaviorGalleryResponse,
  type LessonsExplorerResponse,
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
  getLessonsExplorer,
  type LessonsExplorerDeps,
  type LessonsExplorerFilters,
  type LessonsExplorerSnapshot,
} from "../aggregators/lessons-explorer.ts";

export interface ExplorePageRouterDeps {
  getFrictionPatterns?: (
    deps?: FrictionPatternsDeps,
  ) => Promise<FrictionPatternsSnapshot>;
  getBehaviorGallery?: (
    limit: number,
    filters?: BehaviorFilters,
    deps?: BehaviorGalleryDeps,
  ) => Promise<BehaviorRow[]>;
  getLessonsExplorer?: (
    filters?: LessonsExplorerFilters,
    deps?: LessonsExplorerDeps,
  ) => Promise<LessonsExplorerSnapshot>;
}

export function createExplorePageRouter(deps: ExplorePageRouterDeps = {}) {
  const router = Router();
  const aggregateFriction = deps.getFrictionPatterns ?? getFrictionPatterns;
  const aggregateBehavior = deps.getBehaviorGallery ?? getBehaviorGallery;
  const aggregateLessons = deps.getLessonsExplorer ?? getLessonsExplorer;

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

  return router;
}

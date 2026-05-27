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
  getFrictionPatterns?: (deps?: FrictionPatternsDeps) => Promise<FrictionPatternsSnapshot>;
  getBehaviorGallery?: (
    limit: number,
    filters?: BehaviorFilters,
    deps?: BehaviorGalleryDeps,
  ) => Promise<BehaviorRow[]>;
  getBacklogFlow?: (windowDays: number, deps?: BacklogFlowDeps) => Promise<BacklogFlow>;
  getLessonsExplorer?: (
    filters?: LessonsExplorerFilters,
    deps?: LessonsExplorerDeps,
  ) => Promise<LessonsExplorerSnapshot>;
  getAnomalies?: (deps?: AnomalyDetectorDeps) => Promise<AnomalyDetectorSnapshot>;
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
  router.get("/explore/friction", async (_req, res) => {
    try {
      const snapshot = await aggregateFriction();
      const body: FrictionPatternsResponse = snapshot;
      return res.json(body);
    } catch (err: any) {
      console.error(
        `[v2/explore/friction] aggregator threw despite never-throw contract: ${err?.message || err}`,
      );
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // GET /v2/explore/behavior?limit=&class=&outcome=
  // -------------------------------------------------------------------------
  router.get("/explore/behavior", async (req, res) => {
    const parsed = BehaviorGalleryQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        code: "schema-validation-failed",
        issues: parsed.error.issues,
      });
    }
    const { limit, class: classFilter, outcome } = parsed.data;
    try {
      const filters: BehaviorFilters = {};
      if (classFilter) filters.class = classFilter;
      if (outcome) filters.outcome = outcome;
      const items = await aggregateBehavior(limit, filters);
      const body: BehaviorGalleryResponse = {
        items,
        limit,
        filters: {
          class: classFilter ?? null,
          outcome: outcome ?? null,
        },
        generatedAt: new Date().toISOString(),
      };
      return res.json(body);
    } catch (err: any) {
      console.error(
        `[v2/explore/behavior] aggregator threw despite never-throw contract: ${err?.message || err}`,
      );
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // GET /v2/explore/flow?window=7d
  // -------------------------------------------------------------------------
  router.get("/explore/flow", async (req, res) => {
    const parsed = BacklogFlowQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        code: "schema-validation-failed",
        issues: parsed.error.issues,
      });
    }
    const days = Number(parsed.data.window.slice(0, -1));
    try {
      const flow = await aggregateFlow(days);
      const body: BacklogFlowResponse = flow;
      return res.json(body);
    } catch (err: any) {
      console.error(
        `[v2/explore/flow] aggregator threw despite never-throw contract: ${err?.message || err}`,
      );
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // GET /v2/explore/lessons?skill=
  // -------------------------------------------------------------------------
  router.get("/explore/lessons", async (req, res) => {
    const parsed = LessonsExplorerQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        code: "schema-validation-failed",
        issues: parsed.error.issues,
      });
    }
    try {
      const filters: LessonsExplorerFilters = {};
      if (parsed.data.skill) filters.skill = parsed.data.skill;
      const snapshot = await aggregateLessons(filters);
      const body: LessonsExplorerResponse = snapshot;
      return res.json(body);
    } catch (err: any) {
      console.error(
        `[v2/explore/lessons] aggregator threw despite never-throw contract: ${err?.message || err}`,
      );
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // GET /v2/explore/anomalies
  // -------------------------------------------------------------------------
  router.get("/explore/anomalies", async (_req, res) => {
    try {
      const snapshot = await aggregateAnomalies();
      const body: AnomalyDetectorResponse = snapshot;
      return res.json(body);
    } catch (err: any) {
      console.error(
        `[v2/explore/anomalies] aggregator threw despite never-throw contract: ${err?.message || err}`,
      );
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  return router;
}

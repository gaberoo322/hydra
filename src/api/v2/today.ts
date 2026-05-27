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
} from "../../schemas/v2/today.ts";
import {
  getOvernightSummary,
  type OvernightSummaryDeps,
} from "../../aggregators/overnight-summary.ts";
import {
  getDecisionQueue,
  type DecisionQueueDeps,
  type DecisionItem,
} from "../../aggregators/decision-queue.ts";
import {
  getStuckItems,
  type StuckItemsDeps,
  type StuckItems,
} from "../../aggregators/stuck-items.ts";
import {
  getRecentMerges,
  type RecentMergesDeps,
  type MergeItem,
} from "../../aggregators/recent-merges.ts";
import {
  getNewTargetFindings,
  type TargetFindingsDeps,
  type Finding,
} from "../../aggregators/target-backlog-findings.ts";
import {
  getOvernightLessons,
  type LessonsOvernightDeps,
  type OvernightLessons,
} from "../../aggregators/lessons-overnight.ts";

export interface V2TodayRouterDeps {
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

export function createV2TodayRouter(deps: V2TodayRouterDeps = {}) {
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
  router.get("/v2/today/summary", async (req, res) => {
    const parsed = OvernightSummaryQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        code: "schema-validation-failed",
        issues: parsed.error.issues,
      });
    }

    try {
      const summary = await aggregateOvernight(parsed.data.windowHours);
      return res.json(summary);
    } catch (err: any) {
      console.error(
        `[v2/today/summary] aggregator threw despite never-throw contract: ${err?.message || err}`,
      );
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // GET /v2/today/decision-queue — slice 2
  // -------------------------------------------------------------------------
  router.get("/v2/today/decision-queue", async (_req, res) => {
    try {
      const items = await aggregateDecisionQueue();
      const body: DecisionQueueResponse = {
        items,
        generatedAt: new Date().toISOString(),
      };
      return res.json(body);
    } catch (err: any) {
      console.error(
        `[v2/today/decision-queue] aggregator threw despite never-throw contract: ${err?.message || err}`,
      );
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // GET /v2/today/stuck — slice 2
  // -------------------------------------------------------------------------
  router.get("/v2/today/stuck", async (_req, res) => {
    try {
      const items = await aggregateStuck();
      const body: StuckItemsResponse = items;
      return res.json(body);
    } catch (err: any) {
      console.error(
        `[v2/today/stuck] aggregator threw despite never-throw contract: ${err?.message || err}`,
      );
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // GET /v2/today/merges — slice 2
  // -------------------------------------------------------------------------
  router.get("/v2/today/merges", async (req, res) => {
    const parsed = RecentMergesQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        code: "schema-validation-failed",
        issues: parsed.error.issues,
      });
    }

    try {
      const items = await aggregateMerges(parsed.data.limit);
      const body: RecentMergesResponse = {
        items,
        limit: parsed.data.limit,
        generatedAt: new Date().toISOString(),
      };
      return res.json(body);
    } catch (err: any) {
      console.error(
        `[v2/today/merges] aggregator threw despite never-throw contract: ${err?.message || err}`,
      );
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // GET /v2/today/findings — slice 2
  // -------------------------------------------------------------------------
  router.get("/v2/today/findings", async (req, res) => {
    const parsed = WindowedQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        code: "schema-validation-failed",
        issues: parsed.error.issues,
      });
    }

    try {
      const items = await aggregateFindings(parsed.data.windowHours);
      const body: FindingsResponse = {
        items,
        windowHours: parsed.data.windowHours,
        generatedAt: new Date().toISOString(),
      };
      return res.json(body);
    } catch (err: any) {
      console.error(
        `[v2/today/findings] aggregator threw despite never-throw contract: ${err?.message || err}`,
      );
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // GET /v2/today/lessons-overnight — slice 2
  // -------------------------------------------------------------------------
  router.get("/v2/today/lessons-overnight", async (req, res) => {
    const parsed = WindowedQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        code: "schema-validation-failed",
        issues: parsed.error.issues,
      });
    }

    try {
      const lessons = await aggregateLessons(parsed.data.windowHours);
      const body: LessonsOvernightResponse = lessons;
      return res.json(body);
    } catch (err: any) {
      console.error(
        `[v2/today/lessons-overnight] aggregator threw despite never-throw contract: ${err?.message || err}`,
      );
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  return router;
}

/**
 * Dashboard v2 — Outcomes page HTTP surface (issue #619, PRD #615 slice 4).
 *
 * Four 7-day trend endpoints, each a thin adapter over a dedicated
 * aggregator under `src/aggregators/`:
 *
 *   GET /api/v2/outcomes/trends       — outcome-trends.ts
 *   GET /api/v2/outcomes/calibration  — calibration-trend.ts
 *   GET /api/v2/outcomes/lessons      — lessons-trend.ts
 *   GET /api/v2/outcomes/quota        — subscription-quota-trend.ts
 *
 * All four share the `WindowedDaysQuerySchema` query — `?window=7d` style.
 * Each route follows the same shape: parse the query through zod, return
 * `schema-validation-failed` on bad input, delegate to the pure aggregator
 * otherwise. Aggregators are overridable via the `deps` factory parameter
 * so tests can stub without subprocesses or Redis.
 *
 * NB: the page deliberately does NOT reference `/api/stuckness` or any
 * stuckness-detector surface — that subsystem was retired by ADR-0010 and
 * the issue spec explicitly forbids re-creating it.
 */

import { Router } from "express";
import {
  WindowedDaysQuerySchema,
  type OutcomeTrendsResponse,
  type CalibrationTrendResponse,
  type LessonsTrendResponse,
  type QuotaTrendResponse,
} from "../../schemas/v2/outcomes.ts";
import {
  getOutcomeTrends,
  type OutcomeTrendsDeps,
} from "../../aggregators/outcome-trends.ts";
import {
  getCalibrationTrend,
  type CalibrationTrendDeps,
} from "../../aggregators/calibration-trend.ts";
import {
  getLessonsTrend,
  type LessonsTrendDeps,
} from "../../aggregators/lessons-trend.ts";
import {
  getQuotaTrend,
  type QuotaTrendDeps,
} from "../../aggregators/subscription-quota-trend.ts";

export interface V2OutcomesRouterDeps {
  /**
   * Aggregator overrides — tests stub the underlying data sources without
   * seeding Redis or spawning subprocesses. Production callers pass
   * nothing and the real aggregators run.
   */
  getOutcomeTrends?: (
    windowDays: number,
    deps?: OutcomeTrendsDeps,
  ) => Promise<OutcomeTrendsResponse>;
  getCalibrationTrend?: (
    windowDays: number,
    deps?: CalibrationTrendDeps,
  ) => Promise<CalibrationTrendResponse>;
  getLessonsTrend?: (
    windowDays: number,
    deps?: LessonsTrendDeps,
  ) => Promise<LessonsTrendResponse>;
  getQuotaTrend?: (
    windowDays: number,
    deps?: QuotaTrendDeps,
  ) => Promise<QuotaTrendResponse>;
}

export function createV2OutcomesRouter(deps: V2OutcomesRouterDeps = {}) {
  const router = Router();
  const aggregateTrends = deps.getOutcomeTrends ?? getOutcomeTrends;
  const aggregateCalibration = deps.getCalibrationTrend ?? getCalibrationTrend;
  const aggregateLessons = deps.getLessonsTrend ?? getLessonsTrend;
  const aggregateQuota = deps.getQuotaTrend ?? getQuotaTrend;

  // -------------------------------------------------------------------------
  // GET /v2/outcomes/trends
  // -------------------------------------------------------------------------
  router.get("/v2/outcomes/trends", async (req, res) => {
    const parsed = WindowedDaysQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        code: "schema-validation-failed",
        issues: parsed.error.issues,
      });
    }

    try {
      const body = await aggregateTrends(parsed.data.window);
      return res.json(body);
    } catch (err: any) {
      console.error(
        `[v2/outcomes/trends] aggregator threw despite never-throw contract: ${err?.message || err}`,
      );
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // GET /v2/outcomes/calibration
  // -------------------------------------------------------------------------
  router.get("/v2/outcomes/calibration", async (req, res) => {
    const parsed = WindowedDaysQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        code: "schema-validation-failed",
        issues: parsed.error.issues,
      });
    }

    try {
      const body = await aggregateCalibration(parsed.data.window);
      return res.json(body);
    } catch (err: any) {
      console.error(
        `[v2/outcomes/calibration] aggregator threw despite never-throw contract: ${err?.message || err}`,
      );
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // GET /v2/outcomes/lessons
  // -------------------------------------------------------------------------
  router.get("/v2/outcomes/lessons", async (req, res) => {
    const parsed = WindowedDaysQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        code: "schema-validation-failed",
        issues: parsed.error.issues,
      });
    }

    try {
      const body = await aggregateLessons(parsed.data.window);
      return res.json(body);
    } catch (err: any) {
      console.error(
        `[v2/outcomes/lessons] aggregator threw despite never-throw contract: ${err?.message || err}`,
      );
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // GET /v2/outcomes/quota
  // -------------------------------------------------------------------------
  router.get("/v2/outcomes/quota", async (req, res) => {
    const parsed = WindowedDaysQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        code: "schema-validation-failed",
        issues: parsed.error.issues,
      });
    }

    try {
      const body = await aggregateQuota(parsed.data.window);
      return res.json(body);
    } catch (err: any) {
      console.error(
        `[v2/outcomes/quota] aggregator threw despite never-throw contract: ${err?.message || err}`,
      );
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  return router;
}

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
import { aggregatorRoute } from "./route-helpers.ts";
import {
  WindowedDaysQuerySchema,
  type OutcomeTrendsResponse,
  type CalibrationTrendResponse,
  type LessonsTrendResponse,
  type QuotaTrendResponse,
} from "../schemas/outcomes-page.ts";
import {
  getOutcomeTrends,
  type OutcomeTrendsDeps,
} from "../aggregators/outcome-trends.ts";
import {
  getCalibrationTrend,
  type CalibrationTrendDeps,
} from "../aggregators/calibration-trend.ts";
import {
  getLessonsTrend,
  type LessonsTrendDeps,
} from "../aggregators/lessons-trend.ts";
import {
  getQuotaTrend,
  type QuotaTrendDeps,
} from "../aggregators/subscription-quota-trend.ts";

export interface OutcomesPageRouterDeps {
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

export function createOutcomesPageRouter(deps: OutcomesPageRouterDeps = {}) {
  const router = Router();
  const aggregateTrends = deps.getOutcomeTrends ?? getOutcomeTrends;
  const aggregateCalibration = deps.getCalibrationTrend ?? getCalibrationTrend;
  const aggregateLessons = deps.getLessonsTrend ?? getLessonsTrend;
  const aggregateQuota = deps.getQuotaTrend ?? getQuotaTrend;

  // -------------------------------------------------------------------------
  // GET /v2/outcomes/trends
  // -------------------------------------------------------------------------
  router.get(
    "/outcomes/trends",
    aggregatorRoute(WindowedDaysQuerySchema, "v2/outcomes/trends", (data) =>
      aggregateTrends(data.window),
    ),
  );

  // -------------------------------------------------------------------------
  // GET /v2/outcomes/calibration
  // -------------------------------------------------------------------------
  router.get(
    "/outcomes/calibration",
    aggregatorRoute(
      WindowedDaysQuerySchema,
      "v2/outcomes/calibration",
      (data) => aggregateCalibration(data.window),
    ),
  );

  // -------------------------------------------------------------------------
  // GET /v2/outcomes/lessons
  // -------------------------------------------------------------------------
  router.get(
    "/outcomes/lessons",
    aggregatorRoute(WindowedDaysQuerySchema, "v2/outcomes/lessons", (data) =>
      aggregateLessons(data.window),
    ),
  );

  // -------------------------------------------------------------------------
  // GET /v2/outcomes/quota
  // -------------------------------------------------------------------------
  router.get(
    "/outcomes/quota",
    aggregatorRoute(WindowedDaysQuerySchema, "v2/outcomes/quota", (data) =>
      aggregateQuota(data.window),
    ),
  );

  return router;
}

/**
 * Builder-Health Scorecard HTTP surface (issue #732).
 *
 * The builder-side counterpart to the Outcomes surface. Three routes:
 *
 *   GET  /api/builder-health                  — the full scorecard
 *   POST /api/builder-health/scope-violation  — CI scope-check gate increments
 *                                               the day-bucketed counter
 *   POST /api/builder-health/dispatch-pr      — a dispatched subagent stamps
 *                                               the dispatch->PR link on PR-open
 *
 * The GET route delegates to the pure `getBuilderHealthScorecard` aggregator
 * (overridable via the `deps` factory parameter so tests can stub without
 * Redis or `gh`). The two POSTs are the only writers of the scorecard's two
 * new persisted signals; every GET-side metric is otherwise composed
 * read-only. Query + body validation flows through `src/schemas/builder-health.ts`.
 */

import { Router } from "express";

import {
  getBuilderHealthScorecard,
  type BuilderHealthDeps,
  type BuilderHealthScorecard,
} from "../aggregators/builder-health.ts";
import { incrScopeViolation } from "../redis/scope-violations.ts";
import { recordDispatchPr } from "../autopilot/runs.ts";
import {
  BuilderHealthQuerySchema,
  ScopeViolationBodySchema,
  DispatchPrBodySchema,
} from "../schemas/builder-health.ts";

export interface BuilderHealthRouterDeps {
  /** Override the scorecard aggregator — tests stub the underlying sources. */
  getBuilderHealthScorecard?: (deps?: BuilderHealthDeps) => Promise<BuilderHealthScorecard>;
  /** Override the scope-violation counter writer. */
  incrScopeViolation?: (date: string, by?: number) => Promise<number>;
  /** Override the dispatch->PR link writer. */
  recordDispatchPr?: typeof recordDispatchPr;
}

function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

export function createBuilderHealthRouter(deps: BuilderHealthRouterDeps = {}) {
  const router = Router();
  const scorecard = deps.getBuilderHealthScorecard ?? getBuilderHealthScorecard;
  const incrViolation = deps.incrScopeViolation ?? incrScopeViolation;
  const recordPr = deps.recordDispatchPr ?? recordDispatchPr;

  // GET /builder-health — the full scorecard.
  router.get("/builder-health", async (req, res) => {
    const parsed = BuilderHealthQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        code: "schema-validation-failed",
        issues: parsed.error.issues,
      });
    }
    try {
      const result = await scorecard({
        prWindow: parsed.data.prWindow,
        windowDays: parsed.data.windowDays,
      });
      res.json(result);
    } catch (err: any) {
      // The aggregator never throws by contract; this is belt-and-braces.
      console.error(`[builder-health] scorecard failed: ${err?.message || err}`);
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // POST /builder-health/scope-violation — CI scope-check gate writer.
  router.post("/builder-health/scope-violation", async (req, res) => {
    const parsed = ScopeViolationBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        code: "schema-validation-failed",
        issues: parsed.error.issues,
      });
    }
    try {
      const date = parsed.data.date ?? utcToday();
      const total = await incrViolation(date, parsed.data.count ?? 1);
      res.json({ ok: true, date, total });
    } catch (err: any) {
      console.error(`[builder-health] scope-violation incr failed: ${err?.message || err}`);
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // POST /builder-health/dispatch-pr — dispatch->PR link writer.
  router.post("/builder-health/dispatch-pr", async (req, res) => {
    const parsed = DispatchPrBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        code: "schema-validation-failed",
        issues: parsed.error.issues,
      });
    }
    const result = await recordPr(parsed.data);
    if (!result.ok) {
      const status = result.code === "invalid" ? 400 : 500;
      return res.status(status).json({ error: result.detail, code: result.code });
    }
    res.json({ ok: true, prNumber: result.prNumber, openedAtMs: result.openedAtMs });
  });

  return router;
}

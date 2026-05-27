/**
 * Dashboard v2 — Today page HTTP surface (issue #616, PRD #615).
 *
 * Slice 1 ships ONE endpoint: `GET /api/v2/today/summary`. It's a thin
 * adapter over `src/aggregators/overnight-summary.ts` — the route owns
 * (a) parsing the query with the zod schema and (b) returning the
 * structured `schema-validation-failed` envelope on bad input. The
 * aggregator owns everything else.
 *
 * Future slices will mount sibling routes here for the other Today
 * sections (decision-queue, stuck-items, etc.).
 */

import { Router } from "express";
import {
  OvernightSummaryQuerySchema,
  type OvernightSummaryResponse,
} from "../../schemas/v2/today.ts";
import {
  getOvernightSummary,
  type OvernightSummaryDeps,
} from "../../aggregators/overnight-summary.ts";

export interface V2TodayRouterDeps {
  /**
   * Aggregator override — used by tests to stub the underlying data
   * sources without seeding Redis or spawning subprocesses. Production
   * callers pass nothing and the real aggregator runs.
   */
  getOvernightSummary?: (
    windowHours: number,
    deps?: OvernightSummaryDeps,
  ) => Promise<OvernightSummaryResponse>;
}

export function createV2TodayRouter(deps: V2TodayRouterDeps = {}) {
  const router = Router();
  const aggregate = deps.getOvernightSummary ?? getOvernightSummary;

  router.get("/v2/today/summary", async (req, res) => {
    const parsed = OvernightSummaryQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        code: "schema-validation-failed",
        issues: parsed.error.issues,
      });
    }

    try {
      const summary = await aggregate(parsed.data.windowHours);
      return res.json(summary);
    } catch (err: any) {
      // The aggregator's contract is "never throws" — if we land here
      // something is genuinely off (e.g. dep injection misconfigured in
      // a test). Surface a 500 with the message instead of 400 so the
      // dashboard can distinguish bad-input from server-side trouble.
      console.error(
        `[v2/today/summary] aggregator threw despite never-throw contract: ${err?.message || err}`,
      );
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  return router;
}

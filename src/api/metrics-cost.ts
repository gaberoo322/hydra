import { Router } from "express";
import { getMetricsTrend } from "../metrics/trend.ts";
import { getCostByOutcome } from "../metrics/aggregate.ts";
import {
  getCostByClass,
  getRollingCostByClass,
  getCostPerMergedPr,
  getClassCostEfficiency,
  DEFAULT_COST_PER_MERGED_PR_WINDOW_DAYS,
  getDailyTokenCounter,
  todayDateString,
} from "../cost/index.ts";
import { countQuerySchema } from "../schemas/common.ts";
import { aggregatorRouteNoQuery } from "./route-helpers.ts";
import { z } from "zod";

/**
 * Cost-accounting READ seam for the metrics domain (architecture-scan #3495).
 *
 * Split out of `src/api/metrics.ts` — which becomes a pure cycle-performance
 * read surface — so that "where does the orchestrator serve cost-per-PR
 * metrics?" points at a file whose name is a true description of its body,
 * rather than the tail of a 458-line file mixing cycle abandonment rates,
 * grounding-duration percentiles, and instrumentation ring buffers. This is the
 * symmetric READ sibling of the already-extracted `api/metrics-tokens.ts` WRITE
 * seam (issue #3322).
 *
 * The five cost-accounting GET routes (`/metrics/cost`, `/metrics/cost-by-class`,
 * `/metrics/cost-per-merged-pr`, `/metrics/cost-efficiency`,
 * `/metrics/cost-by-outcome`) share two query schemas (`CostQuerySchema`,
 * `CostPerMergedPrQuerySchema`) and one composition seam (`src/cost/index.ts`)
 * not shared by the cycle-performance routes. The composition — resolve the
 * merged-PR count from the cycle trend, inject it into a Cost-module pure
 * function — lives HERE (not in `src/cost/`) so the Cost module stays free of a
 * `src/metrics/` import: the single-public-Interface + no-cross-import invariant.
 *
 * This router mounts at the same `/api` base as `createMetricsRouter` in
 * `src/api.ts`, so every URL path (`GET /metrics/cost`, `/metrics/cost-by-class`,
 * …) resolves byte-identically after the split. The route paths, query schemas,
 * never-throw-500 isolation, and HTTP response shapes are preserved verbatim.
 */

/**
 * Query schema for `GET /metrics/cost?date=YYYY-MM-DD` (ADR-0022 slice 1).
 * `date` is optional; an absent or non-string value defers to the caller's
 * `todayDateString()` fallback. Non-strict so it ignores any unknown params.
 */
const CostQuerySchema = z.object({
  date: z.string().trim().min(1).optional(),
});

/**
 * Query schema for `GET /metrics/cost-per-merged-pr?days=N&count=M` (issue #2807).
 * `days` is the trailing UTC-day window the token total is summed over
 * (defaults to the module's 30-day default); `count` is the recent-cycle window
 * the merged-PR count is derived from. Both optional; non-strict so unknown
 * params are ignored. `days` is coerced from the string query param and clamped
 * to a sane 1..90 range so a hostile value can't fan out an unbounded number of
 * per-day Redis reads.
 */
const CostPerMergedPrQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).optional(),
});

export function createMetricsCostRouter() {
  const router = Router();

  // GET /metrics/cost — Daily token counter (issue #394, #704).
  //
  // After #383 deleted codex-runner.ts, the legacy `recordSpend()` writer
  // stopped feeding `hydra:scheduler:daily-spend` for code-writing work, #703
  // removed the last remaining writers (the dead budget-threshold bridge +
  // `setDailySpendRaw`), and #704 stripped the dollar-conversion machinery
  // entirely (`HYDRA_TOKEN_USD_RATE` was structurally $0; no live dollar cap
  // existed). This endpoint now surfaces the per-day / per-skill token counts
  // populated by autopilot subagents (writers post to /metrics/tokens).
  //
  // Issue #1863: never-throw-500 isolation via aggregatorRouteNoQuery (#909).
  router.get(
    "/metrics/cost",
    aggregatorRouteNoQuery("api/metrics/cost", (req) => {
      // ADR-0022 slice 1: read `date` through the Schemas seam. An absent or
      // empty value defers to today's date string.
      const parsedDate = CostQuerySchema.safeParse(req.query).data?.date;
      const date = parsedDate || todayDateString();
      return getDailyTokenCounter(date);
    }),
  );

  // GET /metrics/cost-by-class — Per-class token attribution (issue #1439).
  //
  // Folds the per-skill daily token surrogate into the autopilot dispatch
  // classes (research / dev-orch / dev-target / qa / cleanup / retro / other)
  // so the operator can see "QA is now 25% of daily spend" or "research
  // spiked today". The per-skill data already carries the class signal via
  // the skill name — no new Redis write path.
  //
  // Window semantics (issue #2427): with NO `?date=`, the default operator
  // "today" view is a rolling ~24h UTC window (yesterday + today's buckets) so
  // a read taken just after UTC midnight cannot show a false 0% for a class
  // that demonstrably ran earlier in the operator's local day — the false
  // "decide.py isn't dispatching" alarm this issue was filed for. An explicit
  // `?date=YYYY-MM-DD` still reads exactly that single UTC calendar day.
  //
  // Issue #1863: never-throw-500 isolation via aggregatorRouteNoQuery (#909).
  router.get(
    "/metrics/cost-by-class",
    aggregatorRouteNoQuery("api/metrics/cost-by-class", (req) => {
      const parsedDate = CostQuerySchema.safeParse(req.query).data?.date;
      // Explicit date → single-day read; default → rolling trailing-24h window.
      return parsedDate ? getCostByClass(parsedDate) : getRollingCostByClass();
    }),
  );

  // GET /metrics/cost-per-merged-pr — Derived cost-per-merged-PR ratio (issue #2807).
  //
  // Answers "how many subagent tokens does the system spend per merged PR?" —
  // the cost/outcome unit-economics number the architecture review (2026-07-02
  // Rec #5) flagged as missing. A PURE DERIVED read (design-concept 99ef93a0):
  //   - token total: summed from the per-day surrogate buckets over a trailing
  //     `days`-day UTC window (default 30), via the Cost module's
  //     `getCostPerMergedPr`.
  //   - merged-PR count: derived HERE from the existing cycle-metrics merged
  //     feed (a cycle counts as a merged PR when its `tasksMerged > 0`, mirroring
  //     `getAggregateStats`'s mergedRate), then injected into the Cost module.
  // No new token-recording writer, no USD/dollar surface — the ratio is derived
  // over totals the surrogate + cycle-metrics feed already record.
  //
  // Composition lives here (not in src/cost/) so the Cost module stays free of a
  // src/metrics/ import — the single-public-Interface + no-cross-import invariant.
  //
  // Issue #1863: never-throw-500 isolation via aggregatorRouteNoQuery (#909).
  router.get(
    "/metrics/cost-per-merged-pr",
    aggregatorRouteNoQuery("api/metrics/cost-per-merged-pr", async (req) => {
      const days =
        CostPerMergedPrQuerySchema.safeParse(req.query).data?.days ??
        DEFAULT_COST_PER_MERGED_PR_WINDOW_DAYS;
      // Merged-PR count over the recent cycle window (cycle-metrics carries a
      // 7-day TTL, so this is a recent-window count; `count` bounds the read).
      const count = countQuerySchema(200).safeParse(req.query).data?.count ?? 200;
      const trend = await getMetricsTrend(count);
      const mergedPrCount = trend.filter((m) => (m?.tasksMerged ?? 0) > 0).length;
      return getCostPerMergedPr(mergedPrCount, days);
    }),
  );

  // GET /metrics/cost-efficiency — Per-class cost efficiency: the QA-cost-dominance audit read (issue #2971).
  //
  // The discover finding #2971 flagged QA as ~38% of daily tokens and asked
  // whether validation scope is appropriately scoped. This route answers that
  // with the FALSIFIABLE number the raw share hides: QA tokens PER MERGED PR
  // (surfaced at `.qa.tokensPerMergedPr`), plus the same per-merge ratio for
  // every sibling class under `byClass` so QA is judged against a comparative
  // baseline rather than in isolation. A high raw share is expected of a class
  // whose work scales with dev output (QA does); the per-merge cost is what
  // tells an over-scoped class apart from a merely busy one.
  //
  // A PURE DERIVED read (design-concept 4d98ab3d, invariant 6): it composes the
  // per-class token rollup (rolling trailing-24h UTC window, issue #2427 window
  // semantics) with a merged-PR count derived HERE from the cycle-metrics merged
  // feed (a cycle counts as a merged PR when `tasksMerged > 0`, mirroring
  // getAggregateStats + the sibling /metrics/cost-per-merged-pr route), then
  // folds them through the Cost module's pure projectClassCostEfficiency. No new
  // token-recording writer, no USD/dollar surface, no gating — the per-class
  // buckets still sum to the daily total (invariants 1–5).
  //
  // Composition lives here (not in src/cost/) so the Cost module stays free of a
  // src/metrics/ import — the single-public-Interface + no-cross-import invariant.
  //
  // Issue #1863: never-throw-500 isolation via aggregatorRouteNoQuery (#909).
  router.get(
    "/metrics/cost-efficiency",
    aggregatorRouteNoQuery("api/metrics/cost-efficiency", async (req) => {
      const count = countQuerySchema(200).safeParse(req.query).data?.count ?? 200;
      const trend = await getMetricsTrend(count);
      const mergedPrCount = trend.filter((m) => (m?.tasksMerged ?? 0) > 0).length;
      return getClassCostEfficiency(mergedPrCount);
    }),
  );

  // GET /metrics/cost-by-outcome — Token cost split by cycle outcome (issue #3024).
  //
  // Answers "what is the token cost of empty cycles vs failed retries vs
  // successful merges?" — the cost/outcome GRANULARITY #3024 asked for, the
  // per-outcome sibling of /metrics/cost-per-merged-pr's single ratio.
  //
  // A PURE DERIVED read (design-concept c1644ee7): NO new `outcomeType` writer.
  // Unlike the cost-per-merged-pr / cost-efficiency routes, no merged count is
  // injected — BOTH the outcome (from tasksMerged/tasksFailed/tasksAbandoned/
  // tasksAttempted) AND the per-cycle `tokenCost` are already joined into every
  // trend row, so the whole split derives from the trend alone. The three-way
  // split reuses the exact predicates of the merge-rate / empty-rate gauges
  // (computeRollingMergeRateFromTrend / computeEmptyRateFromTrend) so it can
  // never disagree with them. Cost is TOKENS, never USD (the dollar plane was
  // retired, #1651). Additive — the default /metrics payload is unchanged.
  //
  // Issue #1863: never-throw-500 isolation via aggregatorRouteNoQuery (#909).
  router.get(
    "/metrics/cost-by-outcome",
    aggregatorRouteNoQuery("api/metrics/cost-by-outcome", async (req) => {
      const count = countQuerySchema(200).safeParse(req.query).data?.count ?? 200;
      return getCostByOutcome(count);
    }),
  );

  return router;
}

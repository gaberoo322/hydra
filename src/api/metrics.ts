import { Router } from "express";
import { getMetricsTrend } from "../metrics/trend.ts";
import { projectGroundingDuration } from "../metrics/grounding.ts";
import { getAbandonmentBreakdown } from "../metrics/abandonment.ts";
import {
  getAggregateStats,
  getCumulativeAccomplishments,
  projectAnchorDistribution,
} from "../metrics/aggregate.ts";
import { recordCycleMetrics } from "../metrics/record.ts";
import { CycleRecordBodySchema } from "../autopilot/schemas.ts";
import { classifyAnchorType } from "../autopilot/cycle-close.ts";
import { getQualityGateTrend } from "../metrics/quality-gates.ts";
import { getInstrumentationSnapshot } from "../metrics/instrumentation.ts";
import { getWorkQueueLen } from "../redis/work-queue.ts";
import {
  getCostByClass,
  getRollingCostByClass,
  getCostPerMergedPr,
  DEFAULT_COST_PER_MERGED_PR_WINDOW_DAYS,
  getDailyTokenCounter,
  recordSubagentTokens,
  todayDateString,
} from "../cost/index.ts";
import { countQuerySchema } from "../schemas/common.ts";
import { aggregatorRouteNoQuery } from "./route-helpers.ts";
import { z } from "zod";

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

export function createMetricsRouter() {
  const router = Router();

  // GET /summary — Human-readable system summary
  router.get("/summary", async (req, res) => {
    try {
      const stats = await getAggregateStats(20);
      const acc = await getCumulativeAccomplishments(20);
      const queueLen = await getWorkQueueLen();

      const lines = [
        `Hydra V2 — ${stats.cycles} cycles completed`,
        `Merged: ${stats.mergedRate}% | Failed: ${stats.failedRate}% | Regressed: ${stats.regressionRate}%`,
        `Avg cycle: ${stats.avgDurationHuman}`,
        `Work queue: ${queueLen} item(s)`,
        "",
        "Accomplished:",
        ...acc.map((a) => `  - ${a.title} (tests ${a.tests})`),
      ];

      res.type("text/plain").send(lines.join("\n"));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /metrics — Recent cycle metrics
  //
  // Issue #1863: never-throw-500 isolation via the aggregatorRouteNoQuery seam
  // (route-helpers.ts, #909). `count` keeps its soft-parse (default-on-garbage,
  // no 400) inside `produce`.
  router.get(
    "/metrics",
    aggregatorRouteNoQuery("api/metrics", async (req) => {
      // ADR-0022: read `count` through the Schemas seam (safeParse on req.query).
      // countQuerySchema collapses bad/absent input to the default, so this
      // safeParse never fails — but it keeps the read on the one query pattern.
      const count = countQuerySchema(20).safeParse(req.query).data?.count ?? 20;
      const trend = await getMetricsTrend(count);
      const stats = await getAggregateStats(count);
      // Issue #1439: per-class cost attribution. Folded from the per-skill
      // token surrogate over a rolling trailing-24h UTC window (issue #2427 —
      // a single-UTC-day "today" read just after midnight shows a false 0% for
      // classes that ran earlier in the operator's local day) so operators can
      // answer "what fraction of spend does research vs dev vs QA consume?".
      // Best-effort — a Redis hiccup yields an empty breakdown rather than
      // failing /metrics.
      let costByClass: Awaited<ReturnType<typeof getCostByClass>> | null = null;
      try {
        costByClass = await getRollingCostByClass();
      } catch (costErr: any) {
        console.error(`[api/metrics] costByClass projection failed: ${costErr?.message || costErr}`);
      }
      return { stats, trend, costByClass };
    }),
  );

  // GET /metrics/abandonment — Aggregated abandonment causes from recent cycles (issue #195)
  //
  // Issue #1863: never-throw-500 isolation via aggregatorRouteNoQuery (#909).
  router.get(
    "/metrics/abandonment",
    aggregatorRouteNoQuery("api/metrics/abandonment", (req) => {
      const count = countQuerySchema(50).safeParse(req.query).data?.count ?? 50;
      return getAbandonmentBreakdown(count);
    }),
  );

  // GET /metrics/quality-gates — Mutation kill-rate + JIT trend (issue #212)
  router.get("/metrics/quality-gates", async (req, res) => {
    try {
      // ADR-0022 slice 1: this route keeps its bespoke "never 500" 200-empty
      // fallback (below), so it reads `count` via an inline safeParse rather
      // than aggregatorRoute (whose hard 500 would regress the documented AC).
      const count = countQuerySchema(50).safeParse(req.query).data?.count ?? 50;
      const result = await getQualityGateTrend(count);
      res.json(result);
    } catch (err: any) {
      // AC: never 500 on this endpoint — empty state instead
      console.error(`[api/metrics] /metrics/quality-gates failed: ${err.message}`);
      res.status(200).json({
        trend: [],
        summary: {
          cycles: 0,
          cyclesWithMutationData: 0,
          avgKillRate: null,
          killRateP50: null,
          killRateP95: null,
          gateBlockCount: 0,
          totalJitTestsAdded: 0,
        },
        error: err.message,
      });
    }
  });

  // GET /metrics/anchor-distribution — Per-priority view of who served what
  // over the recent window (issue #377). Aggregates cycle metrics for `served`
  // by anchorType. The reframe / prior-failure lanes and their starvation
  // gauges were retired in ADR-0016 (no live writer), so this surface now
  // covers only the live priority lanes. Read-only and best-effort.
  //
  // Issue #1863: never-throw-500 isolation via aggregatorRouteNoQuery (#909).
  // The inner `.catch` on the trend read stays (it's a best-effort
  // degrade-to-empty, not the route's failure isolation).
  router.get(
    "/metrics/anchor-distribution",
    aggregatorRouteNoQuery("api/metrics/anchor-distribution", async (req) => {
      const count = countQuerySchema(50).safeParse(req.query).data?.count ?? 50;

      const trend = await getMetricsTrend(count).catch((err: any) => {
        console.error(`[api/metrics] anchor-distribution: trend read failed: ${err.message}`);
        return [];
      });

      // Aggregation lives in src/metrics/aggregate.ts; this route is a thin
      // delegate (issue #2126).
      return projectAnchorDistribution(trend);
    }),
  );

  // GET /metrics/grounding-duration — p50/p95 + incremental vs full bucket
  //
  // Issue #341: incremental grounding/verification can cut a 14-min cycle to
  // ~10 min by running only tests whose transitive import closure intersects
  // the changed files. This endpoint exposes the grounding/verification
  // duration trend, bucketed by groundingMode ("incremental" | "full" | ""),
  // so the rollout's effect can be measured per-cycle without scraping the
  // raw metrics index.
  //
  // Until selectAffectedTests is wired into the verification path (env-gated:
  // HYDRA_INCREMENTAL_GROUNDING=true), all cycles will report mode="full" or
  // an empty mode field — bucket distribution makes that visible.
  //
  // Issue #1863: never-throw-500 isolation via aggregatorRouteNoQuery (#909).
  router.get(
    "/metrics/grounding-duration",
    aggregatorRouteNoQuery("api/metrics/grounding-duration", async (req) => {
      const count = countQuerySchema(50).safeParse(req.query).data?.count ?? 50;
      const trend = await getMetricsTrend(count);

      // Percentile + bucketing math lives in src/metrics/grounding.ts; this
      // route is a thin delegate (issue #2126; relocated out of trend.ts #2614).
      return projectGroundingDuration(trend);
    }),
  );

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

  // GET /metrics/instrumentation — Per-label hot-path latency percentiles (issue #2353).
  //
  // Surfaces the in-process timing ring buffers populated by `time(label, fn)`
  // (src/metrics/instrumentation.ts) on the orchestrator's decision-loop hot
  // paths (candidate-feed selection, lane transitions, …). Observability-only
  // (ADR-0012): it reports p50/p95/p99 latency; it never alerts or branches
  // behaviour on a threshold. When HYDRA_PERF_INSTRUMENT is unset/falsy the
  // hot paths record nothing, so `enabled:false` with an empty `labels` array
  // is the expected default-production response.
  //
  // Issue #1863: never-throw-500 isolation via aggregatorRouteNoQuery (#909).
  router.get(
    "/metrics/instrumentation",
    aggregatorRouteNoQuery("api/metrics/instrumentation", async () => {
      return getInstrumentationSnapshot();
    }),
  );

  // POST /metrics/tokens — Autopilot reap-time write hook (issue #394).
  //
  // The autopilot's reap.py POSTs here once it has authoritative
  // `total_tokens` for a completed subagent. Payload shape:
  //
  //   { skill: "hydra-dev", tokens: 12345, cycleId?: "<task_id>", date?: "<YYYY-MM-DD>" }
  //
  // Best-effort: returns 200 with the updated counters on success, 4xx on
  // shape errors. A 5xx is logged but the autopilot's `dispatch.sh` already
  // tolerates a non-2xx via the existing `|| { echo non-fatal }` pattern.
  router.post("/metrics/tokens", async (req, res) => {
    try {
      const body = req.body || {};
      const skill = typeof body.skill === "string" ? body.skill.trim() : "";
      if (!skill) {
        return res.status(400).json({ error: "Missing 'skill' (string)" });
      }
      const tokens = typeof body.tokens === "number"
        ? body.tokens
        : (typeof body.tokens === "string" ? parseInt(body.tokens, 10) : NaN);
      if (!Number.isFinite(tokens) || tokens < 0) {
        return res.status(400).json({ error: "Missing or invalid 'tokens' (non-negative number)" });
      }
      const opts: { date?: string; cycleId?: string } = {};
      if (typeof body.date === "string" && body.date) opts.date = body.date;
      if (typeof body.cycleId === "string" && body.cycleId) opts.cycleId = body.cycleId;

      const result = await recordSubagentTokens(skill, tokens, opts);
      res.json({ ok: true, ...result });
    } catch (err: any) {
      console.error(`[api/metrics] /metrics/tokens failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /metrics/record — Record cycle metrics from external sources.
  // Validates through CycleRecordBodySchema (the same loose-object contract the
  // sibling POST /autopilot/cycle-record uses) per the CLAUDE.md § HTTP
  // validation convention: on a schema miss, return 400 with the machine-
  // readable {code:"schema-validation-failed", issues} shape (issue #2636).
  router.post("/metrics/record", async (req, res) => {
    try {
      const parsed = CycleRecordBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({
          code: "schema-validation-failed",
          issues: parsed.error.issues,
        });
      }
      // `parsed.data` is a CycleRecordBody (loose object): its `cycleId` is a
      // validated non-empty string; the remaining fields are the ad-hoc metrics
      // this endpoint forwards verbatim. recordCycleMetrics accepts any
      // stringifiable field via CycleMetricsInput's `[key: string]: unknown`
      // index signature, so the rest passes through as a Record<string, unknown>
      // (the union number|string field types on CycleRecordBody are a superset
      // of what the writer flattens — it String()s every value regardless).
      const { cycleId, ...metrics } = parsed.data;
      // Issue #2803: classify anchorType EXPLICITLY, mirroring the sibling
      // recordCycle() write path (src/autopilot/cycle-close.ts). This direct
      // write bypasses recordCycle, so without this call an absent/empty
      // anchorType is written through verbatim and then bucketed as "unknown"
      // by the aggregator (src/metrics/aggregate.ts) — ~30% of cycles landed
      // "unclassified". classifyAnchorType always returns a non-empty string
      // (the caller's trimmed value, a cycleId-slot inference, or the
      // "unclassified" sentinel), so every /metrics/record write now classifies
      // consistently with the recordCycle path.
      await recordCycleMetrics(cycleId, {
        ...(metrics as Record<string, unknown>),
        anchorType: classifyAnchorType(cycleId, metrics.anchorType),
      });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

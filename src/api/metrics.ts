import { Router } from "express";
import { getMetricsTrend, projectGroundingDuration } from "../metrics/trend.ts";
import {
  getAggregateStats,
  getCumulativeAccomplishments,
  projectAnchorDistribution,
} from "../metrics/aggregate.ts";
import { recordCycleMetrics } from "../metrics/record.ts";
import { getQualityGateTrend } from "../metrics/quality-gates.ts";
import { getInstrumentationSnapshot } from "../metrics/instrumentation.ts";
import { getWorkQueueLen } from "../redis/work-queue.ts";
import {
  getCostByClass,
  getRollingCostByClass,
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
 * Abandonment-reason categorization + rollup (issue #195).
 *
 * The categorizer is the pure half (testable on fixture strings) and
 * `getAbandonmentBreakdown` is the composition over the trend. Both folded
 * in from `src/metrics/abandonment.ts` (issue #2382) — this router is the
 * only production caller, so the breakdown lives alongside its route.
 */

/**
 * Categorize an `abandonReason` string into a stable bucket.
 *
 * Strategy: split on first `:` if present (e.g., "Planner noWork: codebase-clean" → "Planner noWork").
 * Otherwise take the first 4 words. Trim and collapse whitespace. Return "Unknown" for empty input.
 *
 * Pure function — deterministic, no side effects.
 */
export function categorizeAbandonReason(reason: string | undefined | null): string {
  if (!reason || typeof reason !== "string") return "Unknown";
  const trimmed = reason.trim();
  if (!trimmed) return "Unknown";

  const colonIdx = trimmed.indexOf(":");
  const head = colonIdx >= 0 ? trimmed.slice(0, colonIdx) : trimmed;
  const words = head.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "Unknown";
  return words.slice(0, 4).join(" ");
}

/**
 * Aggregate abandonment causes from the last N cycles.
 *
 * Returns:
 *   - totalCycles: number of cycles considered
 *   - totalAbandoned: cycles with a non-empty `abandonReason`
 *   - abandonRate: percent (0-100, integer)
 *   - byCategory: descending array of { category, count, pct, sampleReasons[] }
 *
 * Categories are derived via `categorizeAbandonReason`. Sample reasons preserve
 * up to 3 distinct raw reasons per category for operator context.
 */
export async function getAbandonmentBreakdown(count = 50) {
  const trend = await getMetricsTrend(count);
  const totalCycles = trend.length;

  type Bucket = { category: string; count: number; sampleReasons: string[] };
  const buckets = new Map<string, Bucket>();
  let totalAbandoned = 0;

  for (const m of trend) {
    const reason = typeof m.abandonReason === "string" ? m.abandonReason.trim() : "";
    if (!reason) continue;
    totalAbandoned++;
    const category = categorizeAbandonReason(reason);
    let b = buckets.get(category);
    if (!b) {
      b = { category, count: 0, sampleReasons: [] };
      buckets.set(category, b);
    }
    b.count++;
    if (b.sampleReasons.length < 3 && !b.sampleReasons.includes(reason)) {
      b.sampleReasons.push(reason);
    }
  }

  const byCategory = Array.from(buckets.values())
    .map((b) => ({
      category: b.category,
      count: b.count,
      pct: totalAbandoned > 0 ? Math.round((b.count / totalAbandoned) * 100) : 0,
      sampleReasons: b.sampleReasons,
    }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));

  return {
    totalCycles,
    totalAbandoned,
    abandonRate: totalCycles > 0 ? Math.round((totalAbandoned / totalCycles) * 100) : 0,
    byCategory,
  };
}

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

      // Percentile + bucketing math lives in src/metrics/trend.ts; this route
      // is a thin delegate (issue #2126).
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

  // POST /metrics/record — Record cycle metrics from external sources
  router.post("/metrics/record", async (req, res) => {
    try {
      const { cycleId, ...metrics } = req.body || {};
      if (!cycleId) {
        return res.status(400).json({ error: "Missing cycleId" });
      }
      await recordCycleMetrics(cycleId, metrics);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

import { Router } from "express";
import { getMetricsTrend } from "../metrics/trend.ts";
import { getAggregateStats, getCumulativeAccomplishments, getCostByClass } from "../metrics/aggregate.ts";
import { recordCycleMetrics } from "../metrics/record.ts";
import { getAbandonmentBreakdown } from "../metrics/abandonment.ts";
import { getQualityGateTrend } from "../metrics/quality-gates.ts";
import { getWorkQueueLen } from "../redis/work-queue.ts";
import {
  getDailyTokenCounter,
  recordSubagentTokens,
  todayDateString,
} from "../cost/index.ts";
import { countQuerySchema } from "../schemas/common.ts";
import { z } from "zod";

/**
 * Query schema for `GET /metrics/cost?date=YYYY-MM-DD` (ADR-0022 slice 1).
 * `date` is optional; an absent or non-string value defers to the caller's
 * `todayDateString()` fallback. Non-strict so it ignores any unknown params.
 */
const CostQuerySchema = z.object({
  date: z.string().trim().min(1).optional(),
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
  router.get("/metrics", async (req, res) => {
    try {
      // ADR-0022: read `count` through the Schemas seam (safeParse on req.query).
      // countQuerySchema collapses bad/absent input to the default, so this
      // safeParse never fails — but it keeps the read on the one query pattern.
      const count = countQuerySchema(20).safeParse(req.query).data?.count ?? 20;
      const trend = await getMetricsTrend(count);
      const stats = await getAggregateStats(count);
      // Issue #1439: per-class cost attribution. Folded from the per-skill
      // daily token surrogate (today UTC) so operators can answer "what
      // fraction of spend does research vs dev vs QA consume?". Best-effort —
      // a Redis hiccup yields an empty breakdown rather than failing /metrics.
      let costByClass: Awaited<ReturnType<typeof getCostByClass>> | null = null;
      try {
        costByClass = await getCostByClass();
      } catch (costErr: any) {
        console.error(`[api/metrics] costByClass projection failed: ${costErr?.message || costErr}`);
      }
      res.json({ stats, trend, costByClass });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /metrics/abandonment — Aggregated abandonment causes from recent cycles (issue #195)
  router.get("/metrics/abandonment", async (req, res) => {
    try {
      const count = countQuerySchema(50).safeParse(req.query).data?.count ?? 50;
      const breakdown = await getAbandonmentBreakdown(count);
      res.json(breakdown);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

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
  router.get("/metrics/anchor-distribution", async (req, res) => {
    try {
      const count = countQuerySchema(50).safeParse(req.query).data?.count ?? 50;

      const trend = await getMetricsTrend(count).catch((err: any) => {
        console.error(`[api/metrics] anchor-distribution: trend read failed: ${err.message}`);
        return [];
      });

      // Bucket cycles by anchorType — counts cycles only (no cost; the USD
      // attribution plane was retired in #1651).
      const served: Record<string, number> = {};
      for (const m of trend) {
        const type = (m.anchorType && String(m.anchorType).trim()) || "unknown";
        served[type] = (served[type] || 0) + 1;
      }

      // Per-priority rollup over the live lanes only. `served` is the count
      // from the rolling window.
      const distribution = [
        {
          priority: "kanban",
          served: served["kanban"] || 0,
          candidatesAvailable: null,
          suppressedReason: null,
        },
        {
          priority: "failing-test",
          served: served["failing-test"] || 0,
          candidatesAvailable: null,
          suppressedReason: null,
        },
        {
          priority: "work-queue",
          served: served["work-queue"] || served["research"] || served["user-request"] || 0,
          candidatesAvailable: null,
          suppressedReason: null,
        },
        {
          priority: "codebase-health",
          served: served["health"] || served["codebase-health"] || 0,
          candidatesAvailable: null,
          suppressedReason: null,
        },
        {
          priority: "priorities-doc",
          served: served["doc"] || served["priorities-doc"] || 0,
          candidatesAvailable: null,
          suppressedReason: null,
        },
      ];

      res.json({
        windowCycles: trend.length,
        distribution,
        // Raw served-bucket dict for clients that want a quick map.
        servedByAnchorType: served,
      });
    } catch (err: any) {
      console.error(`[api/metrics] /metrics/anchor-distribution failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

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
  router.get("/metrics/grounding-duration", async (req, res) => {
    try {
      const count = countQuerySchema(50).safeParse(req.query).data?.count ?? 50;
      const trend = await getMetricsTrend(count);

      const samples = trend.map((m: any) => ({
        cycleId: m.cycleId,
        groundingMode: typeof m.groundingMode === "string" ? m.groundingMode : "",
        groundingDurationMs: typeof m.groundingDurationMs === "number" ? m.groundingDurationMs : 0,
        verificationDurationMs: typeof m.verificationDurationMs === "number" ? m.verificationDurationMs : 0,
        // testsSelected: how many tests the incremental selector actually ran
        // (undefined for full-suite runs). Surfaced for rollout-vs-baseline
        // comparison without forcing callers to do bucket math.
        testsSelected: typeof m.incrementalTestsSelected === "number" ? m.incrementalTestsSelected : null,
      }));

      const percentile = (arr: number[], p: number): number | null => {
        if (arr.length === 0) return null;
        const sorted = [...arr].sort((a, b) => a - b);
        const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
        return sorted[idx];
      };

      const bucket = (mode: string) => {
        const subset = samples.filter((s) => s.groundingMode === mode);
        const ground = subset.map((s) => s.groundingDurationMs).filter((x) => x > 0);
        const verify = subset.map((s) => s.verificationDurationMs).filter((x) => x > 0);
        return {
          cycles: subset.length,
          grounding: {
            p50: percentile(ground, 0.5),
            p95: percentile(ground, 0.95),
            mean: ground.length > 0 ? Math.round(ground.reduce((a, b) => a + b, 0) / ground.length) : null,
          },
          verification: {
            p50: percentile(verify, 0.5),
            p95: percentile(verify, 0.95),
            mean: verify.length > 0 ? Math.round(verify.reduce((a, b) => a + b, 0) / verify.length) : null,
          },
        };
      };

      const buckets = {
        incremental: bucket("incremental"),
        full: bucket("full"),
        unlabelled: bucket(""),
      };

      res.json({
        sampleSize: samples.length,
        buckets,
        recent: samples.slice(0, 20),
      });
    } catch (err: any) {
      console.error(`[api/metrics] /metrics/grounding-duration failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /metrics/cost — Daily token counter (issue #394, #704).
  //
  // After #383 deleted codex-runner.ts, the legacy `recordSpend()` writer
  // stopped feeding `hydra:scheduler:daily-spend` for code-writing work, #703
  // removed the last remaining writers (the dead budget-threshold bridge +
  // `setDailySpendRaw`), and #704 stripped the dollar-conversion machinery
  // entirely (`HYDRA_TOKEN_USD_RATE` was structurally $0; no live dollar cap
  // existed). This endpoint now surfaces the per-day / per-skill token counts
  // populated by autopilot subagents (writers post to /metrics/tokens).
  router.get("/metrics/cost", async (req, res) => {
    try {
      // ADR-0022 slice 1: read `date` through the Schemas seam. An absent or
      // empty value defers to today's date string.
      const parsedDate = CostQuerySchema.safeParse(req.query).data?.date;
      const date = parsedDate || todayDateString();
      const snapshot = await getDailyTokenCounter(date);
      res.json(snapshot);
    } catch (err: any) {
      console.error(`[api/metrics] /metrics/cost failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /metrics/cost-by-class — Per-class token attribution (issue #1439).
  //
  // Folds the per-skill daily token surrogate into the autopilot dispatch
  // classes (research / dev-orch / dev-target / qa / cleanup / retro / other)
  // so the operator can see "QA is now 25% of daily spend" or "research
  // spiked today". The per-skill data already carries the class signal via
  // the skill name — no new Redis write path. `?date=YYYY-MM-DD` optional.
  router.get("/metrics/cost-by-class", async (req, res) => {
    try {
      const parsedDate = CostQuerySchema.safeParse(req.query).data?.date;
      const date = parsedDate || todayDateString();
      const breakdown = await getCostByClass(date);
      res.json(breakdown);
    } catch (err: any) {
      console.error(`[api/metrics] /metrics/cost-by-class failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

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

import { Router } from "express";
import { getMetricsTrend, getAggregateStats, recordCycleMetrics, getAbandonmentBreakdown, getQualityGateTrend } from "../metrics.ts";
import { redisKeys } from "../redis-keys.ts";
import { getWorkQueueLen, listLen, getCycleCosts, getCycleAgentRuns } from "../redis-adapter.ts";
import { aggregateCostAttribution, type AgentRun, type CycleSummary } from "../cost-attribution.ts";
import { getSpecStarvationStats } from "../anchor-selection/spec-starvation.ts";

export function createMetricsRouter() {
  const router = Router();

  // GET /summary — Human-readable system summary
  router.get("/summary", async (req, res) => {
    try {
      const { getAggregateStats: gas, getCumulativeAccomplishments: gca } = await import("../metrics.ts");
      const stats = await gas(20);
      const acc = await gca(20);
      const queueLen = await getWorkQueueLen();
      const priorFails = await listLen(redisKeys.anchorPriorFailures());

      const lines = [
        `Hydra V2 — ${stats.cycles} cycles completed`,
        `Merged: ${stats.mergedRate}% | Failed: ${stats.failedRate}% | Regressed: ${stats.regressionRate}%`,
        `Avg cycle: ${stats.avgDurationHuman}`,
        `Work queue: ${queueLen} item(s) | Prior failures: ${priorFails}`,
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
    // @ts-expect-error — migrate to proper types
      const count = parseInt(req.query.count) || 20;
      const trend = await getMetricsTrend(count);
      const stats = await getAggregateStats(count);
      res.json({ stats, trend });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /spending — Token consumption and dollar costs from Redis
  router.get("/spending", async (req, res) => {
    try {
    // @ts-expect-error — migrate to proper types
      const count = parseInt(req.query.count) || 20;
      const trend = await getMetricsTrend(count);

      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let totalCostUsd = 0;
      let totalAgentTimeMs = 0;
      const perCycle = [];

      for (const m of trend) {
        const costs = await getCycleCosts(m.cycleId);
        const input = parseInt(costs.inputTokens) || 0;
        const output = parseInt(costs.outputTokens) || 0;
        const costMicro = parseInt(costs.costMicrodollars) || 0;
        const costUsd = costMicro / 1_000_000;

        totalInputTokens += input;
        totalOutputTokens += output;
        totalCostUsd += costUsd;
        totalAgentTimeMs += m.totalDurationMs || 0;

        perCycle.push({
          cycleId: m.cycleId,
          inputTokens: input,
          outputTokens: output,
          costUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
          durationMs: m.totalDurationMs || 0,
          task: m.taskTitle,
        });
      }

      res.json({
        recentCycles: trend.length,
        totalInputTokens,
        totalOutputTokens,
        totalTokens: totalInputTokens + totalOutputTokens,
        totalCostUsd: Math.round(totalCostUsd * 100) / 100,
        totalAgentTimeMs,
        totalAgentTimeHuman: `${Math.round(totalAgentTimeMs / 1000)}s`,
        avgCostPerCycle: trend.length > 0
          ? Math.round((totalCostUsd / trend.length) * 100) / 100
          : 0,
        perCycle,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /metrics/abandonment — Aggregated abandonment causes from recent cycles (issue #195)
  router.get("/metrics/abandonment", async (req, res) => {
    try {
      // @ts-expect-error — req.query.count is a string at runtime
      const count = parseInt(req.query.count) || 50;
      const breakdown = await getAbandonmentBreakdown(count);
      res.json(breakdown);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /metrics/quality-gates — Mutation kill-rate + JIT trend (issue #212)
  router.get("/metrics/quality-gates", async (req, res) => {
    try {
      // @ts-expect-error — req.query.count is a string at runtime
      const count = parseInt(req.query.count) || 50;
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

  // GET /metrics/cost-attribution — Per-role / tier / anchor / complexity cost breakdown (issue #271)
  router.get("/metrics/cost-attribution", async (req, res) => {
    try {
      // @ts-expect-error — req.query.count is a string at runtime
      const count = parseInt(req.query.count) || 50;
      const trend = await getMetricsTrend(count);

      const cycles: CycleSummary[] = [];
      for (const m of trend) {
        const rawRuns = await getCycleAgentRuns(m.cycleId);
        const agentRuns: AgentRun[] = [];
        for (const raw of rawRuns) {
          try {
            agentRuns.push(JSON.parse(raw));
          } catch { /* intentional: skip corrupt agent-run entries */ }
        }
        cycles.push({
          cycleId: m.cycleId,
          taskTitle: m.taskTitle,
          anchorType: m.anchorType,
          complexity: m.complexity,
          tasksMerged: m.tasksMerged,
          tasksFailed: m.tasksFailed,
          tasksAbandoned: m.tasksAbandoned,
          plannerModel: m.plannerModel,
          executorModel: m.executorModel,
          agentRuns,
        });
      }

      const result = aggregateCostAttribution(cycles);
      res.json(result);
    } catch (err: any) {
      console.error(`[api/metrics] /metrics/cost-attribution failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /metrics/spec-starvation — Why active specs are/aren't being served (issue #301)
  router.get("/metrics/spec-starvation", async (_req, res) => {
    try {
      const stats = await getSpecStarvationStats();
      res.json(stats);
    } catch (err: any) {
      console.error(`[api/metrics] /metrics/spec-starvation failed: ${err.message}`);
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

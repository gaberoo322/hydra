import { Router } from "express";
import { getMetricsTrend, getAggregateStats, recordCycleMetrics, getAbandonmentBreakdown, getQualityGateTrend } from "../metrics.ts";
import { redisKeys } from "../redis-keys.ts";
import { getWorkQueueLen, listLen, getCycleCosts, getCycleAgentRuns } from "../redis-adapter.ts";
import { aggregateCostAttribution, type AgentRun, type CycleSummary } from "../cost-attribution.ts";
import { getSpecStarvationStats } from "../anchor-selection/spec-starvation.ts";
import { getCapacityFloorsSnapshot } from "../anchor-selection/capacity-floors.ts";

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

  // GET /metrics/capacity-floors — Unified capacity-floor view (issue #321).
  // Surfaces every declared floor (self-improvement, specs, …) with its
  // target share, realised share over the rolling window, and per-floor
  // gauges. /metrics/spec-starvation stays as the legacy single-floor view.
  router.get("/metrics/capacity-floors", async (_req, res) => {
    try {
      const snapshot = await getCapacityFloorsSnapshot();
      res.json(snapshot);
    } catch (err: any) {
      console.error(`[api/metrics] /metrics/capacity-floors failed: ${err.message}`);
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
      // @ts-expect-error — req.query.count is a string at runtime
      const count = parseInt(req.query.count) || 50;
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

  // GET /metrics/fixer — Fixer eligibility / outcome breakdown over the
  // rolling window (issue #376). Answers: how often is the fixer eligible
  // but skipped, and why? Surfaces {eligibleCycles, ranCycles, recoveredCycles,
  // skipReasons:{...}, notEligibleReasons:{...}} so we can verify the widened
  // classifier is actually pulling cycles through to the fixer.
  router.get("/metrics/fixer", async (req, res) => {
    try {
      // @ts-expect-error — req.query.count is a string at runtime
      const count = parseInt(req.query.count) || 50;
      const trend = await getMetricsTrend(count);

      // Buckets — kept aligned with the fixerOutcome value space defined in
      // src/verification.ts VerificationResult.fixerOutcome.
      let eligibleCycles = 0;     // verification failed AND fixer was eligible (ran-* OR skipped:*)
      let ranCycles = 0;          // fixer actually invoked (ran-recovered OR ran-failed)
      let recoveredCycles = 0;    // fixer resolved the failure
      const skipReasons: Record<string, number> = {};
      const notEligibleReasons: Record<string, number> = {};
      let noFailureCycles = 0;    // verification passed first try
      let missingOutcomeCycles = 0; // legacy cycles before fixerOutcome was emitted

      for (const m of trend) {
        const outcome = typeof m.fixerOutcome === "string" ? m.fixerOutcome : "";
        if (!outcome) { missingOutcomeCycles++; continue; }

        if (outcome === "no-failure") {
          noFailureCycles++;
          continue;
        }
        if (outcome === "ran-recovered") {
          eligibleCycles++;
          ranCycles++;
          recoveredCycles++;
          continue;
        }
        if (outcome === "ran-failed") {
          eligibleCycles++;
          ranCycles++;
          continue;
        }
        if (outcome.startsWith("skipped:")) {
          eligibleCycles++;
          const reason = outcome.slice("skipped:".length) || "unknown";
          skipReasons[reason] = (skipReasons[reason] || 0) + 1;
          continue;
        }
        if (outcome.startsWith("not-eligible:")) {
          const gate = outcome.slice("not-eligible:".length) || "unknown";
          notEligibleReasons[gate] = (notEligibleReasons[gate] || 0) + 1;
          continue;
        }
        // Unknown outcome string — surface in a catch-all bucket rather than
        // silently dropping (the issue specifically calls out silent zeros).
        notEligibleReasons[`unknown:${outcome}`] = (notEligibleReasons[`unknown:${outcome}`] || 0) + 1;
      }

      const recoveryRate = ranCycles > 0
        ? Math.round((recoveredCycles / ranCycles) * 100) / 100
        : null;
      const eligibleRunRate = eligibleCycles > 0
        ? Math.round((ranCycles / eligibleCycles) * 100) / 100
        : null;

      res.json({
        windowSize: trend.length,
        eligibleCycles,
        ranCycles,
        recoveredCycles,
        recoveryRate,           // recoveredCycles / ranCycles
        eligibleRunRate,        // ranCycles / eligibleCycles (sanity: should be 1.0)
        skipReasons,            // {category: count} — what classifier rejected
        notEligibleReasons,     // {gate: count} — which downstream gate fired
        noFailureCycles,        // verification passed first try
        missingOutcomeCycles,   // legacy cycles before #376 — should decay to 0
      });
    } catch (err: any) {
      console.error(`[api/metrics] /metrics/fixer failed: ${err.message}`);
      // AC: never 500 on this endpoint — empty state instead so the dashboard
      // can render an honest "no data" rather than a broken card.
      res.status(200).json({
        windowSize: 0,
        eligibleCycles: 0,
        ranCycles: 0,
        recoveredCycles: 0,
        recoveryRate: null,
        eligibleRunRate: null,
        skipReasons: {},
        notEligibleReasons: {},
        noFailureCycles: 0,
        missingOutcomeCycles: 0,
        error: err.message,
      });
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

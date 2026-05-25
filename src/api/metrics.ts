import { Router } from "express";
import { getMetricsTrend } from "../metrics/trend.ts";
import { getAggregateStats, getCumulativeAccomplishments } from "../metrics/aggregate.ts";
import { recordCycleMetrics } from "../metrics/record.ts";
import { getAbandonmentBreakdown } from "../metrics/abandonment.ts";
import { getQualityGateTrend } from "../metrics/quality-gates.ts";
import { loadCycleSummaries, loadCycleSpending } from "../metrics/cycle-summary.ts";
import { getWorkQueueLen } from "../redis/work-queue.ts";
import { getPriorFailuresLen, getReframeQueueLength } from "../redis/anchors.ts";
import {
  aggregateCostAttribution,
  getDailySpendSurrogate,
  recordSubagentTokens,
  todayDateString,
} from "../cost/index.ts";
import { getCapacityFloorsSnapshot } from "../anchor-selection/capacity-floors.ts";
import { getReframeStarvationStats } from "../anchor-selection/reframe.ts";

/**
 * Pick the highest-count reason from a starvation-reasons hash, skipping
 * keys in `exclude` (typically "force_floor" since it's bookkeeping, not
 * a real pass-over). Returns null when no reasons recorded.
 */
function topReason(reasons: Record<string, number>, exclude: string[] = []): string | null {
  const excludeSet = new Set(exclude);
  let best: { name: string; count: number } | null = null;
  for (const [name, count] of Object.entries(reasons || {})) {
    if (excludeSet.has(name)) continue;
    if (!Number.isFinite(count) || count <= 0) continue;
    if (!best || count > best.count) {
      best = { name, count };
    }
  }
  return best ? best.name : null;
}

export function createMetricsRouter() {
  const router = Router();

  // GET /summary — Human-readable system summary
  router.get("/summary", async (req, res) => {
    try {
      const stats = await getAggregateStats(20);
      const acc = await getCumulativeAccomplishments(20);
      const queueLen = await getWorkQueueLen();
      const priorFails = await getPriorFailuresLen();

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
      const report = await loadCycleSpending(count);
      res.json(report);
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
      const cycles = await loadCycleSummaries(count);
      const result = aggregateCostAttribution(cycles);
      res.json(result);
    } catch (err: any) {
      console.error(`[api/metrics] /metrics/cost-attribution failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /metrics/capacity-floors — Unified capacity-floor view (issue #321).
  // Surfaces every declared floor (self-improvement) with its target share,
  // realised share over the rolling window, and per-floor gauges. The
  // legacy /metrics/spec-starvation surface was retired in issue #513.
  router.get("/metrics/capacity-floors", async (_req, res) => {
    try {
      const snapshot = await getCapacityFloorsSnapshot();
      res.json(snapshot);
    } catch (err: any) {
      console.error(`[api/metrics] /metrics/capacity-floors failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /metrics/reframe-starvation — Why the reframe lane is/isn't being
  // served (issue #377). Mirrors /metrics/spec-starvation. Surfaces the
  // running cycles-since-served gauge, last-served timestamp, per-reason
  // pass-over counts, and the configured floor cadence.
  router.get("/metrics/reframe-starvation", async (_req, res) => {
    try {
      const stats = await getReframeStarvationStats();
      res.json(stats);
    } catch (err: any) {
      console.error(`[api/metrics] /metrics/reframe-starvation failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /metrics/anchor-distribution — Per-priority view of who served what
  // and who was passed over (issue #377). Aggregates cycle metrics from the
  // recent window for `served`, joins with the reframe-starvation reasons
  // hash for `suppressedReason`, and surfaces `candidatesAvailable` from
  // the live reframe-queue length. The endpoint is intentionally read-only
  // and best-effort — every sub-read is wrapped so a single Redis hiccup
  // doesn't fail the whole response.
  router.get("/metrics/anchor-distribution", async (req, res) => {
    try {
      // @ts-expect-error — req.query.count is a string at runtime
      const count = parseInt(req.query.count) || 50;

      const [trend, reframeStats, reframeQueueLen] = await Promise.all([
        getMetricsTrend(count).catch((err: any) => {
          console.error(`[api/metrics] anchor-distribution: trend read failed: ${err.message}`);
          return [];
        }),
        getReframeStarvationStats().catch((err: any) => {
          console.error(`[api/metrics] anchor-distribution: reframe stats failed: ${err.message}`);
          return null;
        }),
        getReframeQueueLength().catch((err: any) => {
          console.error(`[api/metrics] anchor-distribution: reframe queue len failed: ${err.message}`);
          return 0;
        }),
      ]);

      // Bucket cycles by anchorType. Mirrors the byAnchorType shape in
      // src/cost/attribution.ts but counts cycles only (no cost).
      const served: Record<string, number> = {};
      for (const m of trend) {
        const type = (m.anchorType && String(m.anchorType).trim()) || "unknown";
        served[type] = (served[type] || 0) + 1;
      }

      // Per-priority rollup. Names match the priority chain in select.ts;
      // values are { served, candidatesAvailable, suppressedReason }.
      // `served` is the count from the rolling window. `candidatesAvailable`
      // is the live queue depth where we have one; otherwise null.
      // `suppressedReason` is the most-common pass-over reason for that
      // priority, drawn from the relevant starvation-reasons hash.
      const distribution = [
        {
          priority: "kanban",
          served: served["kanban"] || 0,
          candidatesAvailable: null,
          // Kanban is the natural-priority winner — no starvation gauge.
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
          priority: "reframe",
          served: served["reframe"] || 0,
          candidatesAvailable: reframeQueueLen,
          suppressedReason: reframeStats
            ? topReason(reframeStats.reasons, ["force_floor"])
            : null,
          cyclesSinceServed: reframeStats?.cyclesSinceServed ?? null,
          floorN: reframeStats?.floorN ?? null,
        },
        {
          priority: "prior-failure",
          served: served["prior-failure"] || 0,
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

  // GET /metrics/cost — Daily spend surrogate (issue #394).
  //
  // After #383 deleted codex-runner.ts, the legacy `recordSpend()` writer
  // stopped feeding `hydra:scheduler:daily-spend` for code-writing work.
  // This endpoint surfaces the token-based surrogate populated by autopilot
  // subagents (writers post to /metrics/tokens, scheduler.ts still writes
  // research-loop spend to the legacy key for back-compat). The `source`
  // field tells the dashboard which writer(s) contributed so the operator
  // can tell real billed spend from surrogate inflation.
  router.get("/metrics/cost", async (req, res) => {
    try {
      const dateRaw = req.query.date;
      const date = (typeof dateRaw === "string" && dateRaw)
        ? dateRaw
        : todayDateString();
      const snapshot = await getDailySpendSurrogate(date);
      res.json(snapshot);
    } catch (err: any) {
      console.error(`[api/metrics] /metrics/cost failed: ${err.message}`);
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

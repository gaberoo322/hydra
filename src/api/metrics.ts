import { Router } from "express";
import { getMetricsTrend } from "../metrics/trend.ts";
import { projectGroundingDuration } from "../metrics/grounding.ts";
import { getAbandonmentBreakdown } from "../metrics/abandonment.ts";
import {
  getAggregateStats,
  getCumulativeAccomplishments,
  getUnclassifiedAnchors,
} from "../metrics/aggregate.ts";
import { projectAnchorDistribution } from "../metrics/stats-projection.ts";
import { getQualityGateTrend } from "../metrics/quality-gates.ts";
import { getInstrumentationSnapshot } from "../metrics/instrumentation.ts";
import { getCascadeTelemetry } from "../redis/cascade-telemetry.ts";
import {
  getCostByClass,
  getRollingCostByClass,
  tokensForSession,
} from "../cost/index.ts";
import { countQuerySchema } from "../schemas/common.ts";
import { aggregatorRouteNoQuery, isolateAggregator, schemaValidationError } from "./route-helpers.ts";
import { logger } from "../logger.ts";
import { z } from "zod";

/**
 * Query schema for `GET /metrics/session-tokens?session=<sessionId>` (issue
 * #3250). `session` is the dispatch's transcript sessionId (a UUID) — the join
 * key reap.py holds at completion time. Required + non-empty; a malformed or
 * non-UUID id is not a validation error here (the underlying `tokensForSession`
 * returns 0 for it — the honest "unknown" sentinel).
 */
const SessionTokensQuerySchema = z.object({
  session: z.string().trim().min(1),
});

export function createMetricsRouter() {
  const router = Router();

  // GET /summary — Human-readable system summary.
  //
  // Not an isolateAggregator route: the success path is a text/plain send, not a
  // JSON body, so the seam (which JSONs its produce result) does not fit. ADR-0027
  // eighth sweep: the catch adopts the pino `err`-field seam instead.
  router.get("/summary", async (req, res) => {
    try {
      const stats = await getAggregateStats(20);
      const acc = await getCumulativeAccomplishments(20);

      const lines = [
        `Hydra V2 — ${stats.cycles} cycles completed`,
        `Merged: ${stats.mergedRate}% | Failed: ${stats.failedRate}% | Regressed: ${stats.regressionRate}%`,
        `Avg cycle: ${stats.avgDurationHuman}`,
        "",
        "Accomplished:",
        ...acc.map((a) => `  - ${a.title} (tests ${a.tests})`),
      ];

      res.type("text/plain").send(lines.join("\n"));
    } catch (err: any) {
      logger.error({ err }, "[api/metrics] /summary failed");
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
        logger.error({ err: costErr }, "[api/metrics] costByClass projection failed");
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
      // AC: never 500 on this endpoint — empty state instead. Not an
      // isolateAggregator route (its 500 would regress this 200-empty fallback);
      // ADR-0027 eighth sweep: the catch adopts the pino `err`-field seam.
      logger.error({ err }, "[api/metrics] /metrics/quality-gates failed");
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
        logger.error({ err }, "[api/metrics] anchor-distribution: trend read failed");
        return [];
      });

      // Aggregation lives in src/metrics/aggregate.ts; this route is a thin
      // delegate (issue #2126).
      return projectAnchorDistribution(trend);
    }),
  );

  // GET /metrics/unclassified — Attribution metadata for cycles still stuck in
  // the `unclassified` anchorType bucket (issue #3443).
  //
  // Issue #3403 (PR #3406) shipped the instrumentation that captures each
  // unclassified cycle's metadata (cycleId, prNumber, anchorReference,
  // taskTitle) so the residue that survives the classifier
  // (src/autopilot/anchor-type.ts, after skill-name / slot / unambiguous-prefix
  // inference) is ATTRIBUTABLE rather than an opaque count. `getUnclassifiedAnchors`
  // was exported but never wired to a consumer — the discovery playbook's
  // >10%-unclassified architectural-review trigger needs the offending cycleIds
  // to root-cause the gap, so this endpoint exposes them.
  //
  // A thin delegate to the src/metrics/aggregate.ts aggregator (ADR-0016
  // Locality) — the anchorType-filter + rate math is NOT re-implemented here,
  // mirroring the /metrics/anchor-distribution → projectAnchorDistribution split.
  // Payload is the aggregator's body RAW: `{ windowCycles, unclassified:
  // [{cycleId, prNumber?, anchorReference?, taskTitle?}], rate }` — no envelope.
  //
  // Issue #1863: never-throw-500 isolation via aggregatorRouteNoQuery (#909).
  router.get(
    "/metrics/unclassified",
    aggregatorRouteNoQuery("api/metrics/unclassified", (req) => {
      const count = countQuerySchema(50).safeParse(req.query).data?.count ?? 50;
      return getUnclassifiedAnchors(count);
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

  // GET /metrics/cascade-routing — Cascade-routing escalation telemetry (issue #3284).
  //
  // Surfaces the cascade-routing observability the feature shipped without
  // (PR #3274): how often decide.py's `_rule_escalation` re-dispatched a
  // cheap-tier class at a stronger model (`cascade_routing_escalation`), how
  // often the Subscription-Usage-Tracker hard stop threw an otherwise-eligible
  // escalation away (`cascade_routing_blocked`), a per-class + per-trigger
  // breakdown, the REALISED token cost delta (summed from the escalated
  // dispatches' ACTUAL recorded tokens on the #2942 outcome plane — NOT a static
  // per-model estimate; design-concept invariant 7), and the post-escalation
  // merge rate (`postEscalationMergeRate`; invariant 8). Answers architecture-
  // review rec #6's "is cascading paying off, or is the gate too restrictive?".
  //
  // A pure read over two planes joined at read time: the durable bounded ring
  // (src/redis/cascade-telemetry.ts) the slot-events bridge feeds for the counts,
  // and listDispatchOutcomes (#2942) for the actual-token cost + merge rate.
  // `count` bounds the ring window (default the full ring). Read-only, additive —
  // no new write path here.
  //
  // Issue #1863: never-throw-500 isolation via aggregatorRouteNoQuery (#909).
  router.get(
    "/metrics/cascade-routing",
    aggregatorRouteNoQuery("api/metrics/cascade-routing", (req) => {
      const count = countQuerySchema(500).safeParse(req.query).data?.count ?? 500;
      return getCascadeTelemetry(count);
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

  // GET /metrics/session-tokens?session=<sessionId> — per-dispatch token
  // recovery (issue #3250). Backs the autopilot's `cumulative_tokens` fix: the
  // SubagentStop hook does not expose the subagent's token usage, so the primary
  // reap path lands 0. reap.py calls THIS route with the completing dispatch's
  // sessionId to recover the REAL count from that session's JSONL transcript
  // (via the `tokensForSession` transcript-scan seam) whenever the hook floor is
  // 0. A read-only surface: no Redis write, no ledger mutation.
  //
  // Response: 200 `{ session, tokens }` — `tokens` is 0 for an unresolvable /
  // non-UUID session (the honest "unknown" sentinel; never a fabricated
  // nonzero). Never throws: the aggregator isolation returns 500 on the
  // structurally-impossible case, which reap.py already tolerates best-effort.
  router.get("/metrics/session-tokens", (req, res) => {
    const parsed = SessionTokensQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return res.status(400).json(schemaValidationError(parsed.error));
    }
    const { session } = parsed.data;
    return isolateAggregator(res, "api/metrics/session-tokens", async () => {
      const tokens = await tokensForSession(session);
      return { session, tokens };
    });
  });

  // NOTE: POST /metrics/record was relocated to the autopilot lifecycle WRITE
  // router (src/api/autopilot-lifecycle.ts) in issue #3220. It is a cycle-close
  // write — the structural twin of POST /autopilot/cycle-record — so it belongs
  // on the lifecycle write surface, not this read-aggregator router. The URL
  // path is byte-identical (both routers mount at the same base in src/api.ts).
  //
  // NOTE: POST /metrics/tokens was relocated to the metrics token-write seam
  // (src/api/metrics-tokens.ts, createMetricsTokensRouter) in issue #3322 — the
  // last write route on this file. The URL path is byte-identical (both routers
  // mount at the same /api base in src/api.ts). This router is now a PURE READ
  // surface: every route on it is a GET aggregation. GET /metrics/session-tokens
  // stays here — it is a read, not a write (design-concept issue-3322,
  // invariant 4).
  //
  // NOTE: the five cost-accounting reads (GET /metrics/cost, /metrics/cost-by-class,
  // /metrics/cost-per-merged-pr, /metrics/cost-efficiency, /metrics/cost-by-outcome)
  // were relocated to the cost-accounting READ seam (src/api/metrics-cost.ts,
  // createMetricsCostRouter) in issue #3495 — the symmetric read sibling of the
  // metrics-tokens.ts write seam. They share two query schemas (CostQuerySchema,
  // CostPerMergedPrQuerySchema) and the src/cost/index.ts composition seam not
  // shared by these cycle-performance routes. URL paths are byte-identical (both
  // routers mount at the same /api base in src/api.ts). This file is now a pure
  // cycle-performance read surface. GET /metrics/session-tokens stays here — it is
  // a per-dispatch token *recovery* read, not a cost-accounting aggregation, and
  // its `tokensForSession` transcript-scan seam is disjoint from the cost module.

  return router;
}

import { Router } from "express";
import { recordSubagentTokens } from "../cost/index.ts";
import { SubagentTokensBodySchema } from "../schemas/metrics.ts";
import { isolateAggregator, schemaValidationError } from "./route-helpers.ts";

/**
 * Token-recording WRITE seam for the metrics domain (architecture-scan #3322).
 *
 * Split out of `src/api/metrics.ts` — which is now a pure read-aggregation
 * surface — so that "where does the orchestrator record per-skill token usage?"
 * points at a file whose name is a true description of its body, not the tail of
 * a 465-line observability-reads file. The route path, request schema, Redis
 * write op, never-throw-500 isolation, and HTTP response shapes are preserved
 * byte-for-byte: this router mounts at the same `/api` base as
 * `createMetricsRouter` in `src/api.ts`, so `POST /metrics/tokens` resolves
 * identically after the split (design-concept issue-3322, invariant 1).
 *
 * The write route does its own inline `SubagentTokensBodySchema.safeParse`
 * (correctly bypassing the read-only `aggregatorRoute` seam — a bad body is a
 * recording error, not an aggregator exception) and delegates the never-throw
 * isolation to `isolateAggregator`. Extracting it makes the surrounding read
 * router's invariant ("every route here is a read") explicit rather than implied.
 */
export function createMetricsTokensRouter() {
  const router = Router();

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
  //
  // Issue #3074 (architecture-scan deepening): the body validation routes
  // THROUGH the Schemas seam (`SubagentTokensBodySchema.safeParse`) instead of
  // hand-rolled `typeof`/`parseInt` branches, and returns the canonical
  // 400 `{code:"schema-validation-failed", issues}` envelope on a bad payload —
  // matching the sibling `POST /metrics/record` handler and CLAUDE.md's HTTP
  // validation rule. The string→number coercion and the optional-field policy
  // are named Zod predicates in the schema, not inline handler branches. The
  // never-throw 500 isolation is delegated to the `isolateAggregator` seam
  // (route-helpers.ts, #909), also matching the sibling write handler.
  //
  // Issue #3322 (architecture-scan deepening): relocated here from
  // `src/api/metrics.ts` so the token-recording write concern owns a file whose
  // name describes it. Behavior is unchanged — path, schema, Redis write, and
  // response shapes are preserved verbatim.
  router.post("/metrics/tokens", async (req, res) => {
    const parsed = SubagentTokensBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json(schemaValidationError(parsed.error));
    }
    const { skill, tokens, date, cycleId } = parsed.data;
    const opts: { date?: string; cycleId?: string } = {};
    if (date) opts.date = date;
    if (cycleId) opts.cycleId = cycleId;

    return isolateAggregator(res, "api/metrics/tokens", async () => {
      const result = await recordSubagentTokens(skill, tokens, opts);
      return { ok: true, ...result };
    });
  });

  return router;
}

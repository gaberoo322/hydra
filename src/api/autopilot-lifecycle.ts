/**
 * Autopilot lifecycle WRITE routes — the run/turn/cycle mutation surface.
 *
 *   POST /autopilot/cycle-record       — one per code-writing subagent dispatch
 *   POST /metrics/record               — inline merge-time cycle-close write (#3220)
 *   POST /autopilot/reflection-record  — reap-side reflection writer (#1119)
 *   POST /autopilot/run-start          — bootstrap.sh end-of-Phase-0
 *   POST /autopilot/run-end            — term-check.py
 *   POST /autopilot/turn               — heartbeat.py
 *
 * Split out of the combined `autopilot.ts` router (#2034). These POSTs are the
 * **Autopilot Run** + **Autopilot Turn** lifecycle's only HTTP write path; they
 * track the `bootstrap.sh` / heartbeat / reap protocol and all flow through the
 * lifecycle domain Module (`src/autopilot/runs.ts`). Each handler:
 *
 *   1. parses the body (zod, via `src/autopilot/schemas.ts`)
 *   2. calls the domain Module
 *   3. translates the result-object back into HTTP
 *
 * Every state mutation flows through the Module — there is no direct Redis
 * access in this file. That keeps the lifecycle's idempotency invariants in one
 * place to enforce and one place to test.
 *
 * `POST /metrics/record` (issue #3220, architecture-scan deepening) was
 * relocated here out of the `src/api/metrics.ts` read-aggregator router: it is a
 * cycle-close WRITE structurally identical to `POST /autopilot/cycle-record`
 * (same `CycleRecordBodySchema` → `recordCycle` coordinator → identical
 * result-to-HTTP translation), differing only in caller — `hydra-target-build`
 * POSTs `/metrics/record` at inline merge time, `reap.py` POSTs
 * `/autopilot/cycle-record`. Co-locating both write paths concentrates the full
 * cycle-close write surface in one file and leaves `metrics.ts` a pure read
 * surface. The URL path `/metrics/record` is byte-identical — both routers mount
 * at the same base in `src/api.ts`, so the Express mount point is unchanged and
 * the `hydra raw POST /metrics/record` caller is unaffected.
 */

import { Router } from "express";
import {
  CycleRecordBodySchema,
  RunStartBodySchema,
  RunEndBodySchema,
  TurnBodySchema,
  ReflectionRecordBodySchema,
} from "../autopilot/schemas.ts";
import {
  recordReflectionOutcome,
  startRun,
  endRun,
  recordTurn,
} from "../autopilot/runs.ts";
// `recordCycle` (the cross-domain cycle-close coordinator) moved to the sibling
// `cycle-close.ts` in issue #2768 — the call site is unchanged (it passes no
// deps arg and relies on the module default deps); only the import path moves.
import { recordCycle } from "../autopilot/cycle-close.ts";
import { schemaValidationError } from "./route-helpers.ts";

export function createAutopilotLifecycleRouter() {
  const router = Router();

  // -------------------------------------------------------------------------
  // POST /autopilot/cycle-record — one per code-writing subagent dispatch.
  // -------------------------------------------------------------------------
  router.post("/autopilot/cycle-record", async (req, res) => {
    const parsed = CycleRecordBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json(schemaValidationError(parsed.error));
    }
    const result = await recordCycle(parsed.data);
    if (!result.ok) {
      const status = result.code === "redis" ? 500 : 400;
      return res.status(status).json({ error: result.detail || result.code });
    }
    return res.json({
      ok: true,
      cycleId: result.cycleId,
      status: result.status,
      bucketed: result.bucketed,
      deduped: result.deduped,
      // Issue #2063: surface whether a duplicate post enriched the existing
      // record with filesChanged/prNumber (the merged-path follow-up write).
      enriched: result.enriched,
    });
  });

  // -------------------------------------------------------------------------
  // POST /metrics/record — inline merge-time cycle-close write (relocated here
  // from the metrics read-aggregator router in issue #3220).
  //
  // The sole live caller is the hydra-target-build merge-flow doc-fragment,
  // which POSTs at inline merge time via `hydra raw POST /metrics/record`. It is
  // the structural twin of the sibling POST /autopilot/cycle-record above: both
  // validate through the IDENTICAL CycleRecordBodySchema and both route THROUGH
  // the `recordCycle()` coordinator (src/autopilot/cycle-close.ts), so a cycle
  // recorded here gets the FULL deep record — the `hydra:cycle:<id>` hash,
  // `hydra:cycle:index` ZSET membership, the per-status scheduler counters, the
  // dispatch-outcome row, AND the metrics-hash feed — visible to
  // getMetricsTrend, buildClassScoreboard, and assembleRetroBundle (issue #3048
  // restored that sole-writer invariant for this previously-shallow path).
  //
  // reap.py ALSO fires POST /autopilot/cycle-record for the same cycleId, so
  // whichever write lands first records the cycle deeply and the second lands as
  // recordCycle's dedup/enrich arm (deduped:true, bucketed:null) — no scheduler
  // counter is double-incremented.
  //
  // Response contract (CLAUDE.md § HTTP validation): 200 {ok:true} on success,
  // 400 {code:"schema-validation-failed", issues} on a schema miss (issue
  // #2636). recordCycle returns a result object (never throws); a result.ok:false
  // maps to 500 (code:redis) / 400 exactly like the sibling handler above.
  // -------------------------------------------------------------------------
  router.post("/metrics/record", async (req, res) => {
    try {
      const parsed = CycleRecordBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({
          code: "schema-validation-failed",
          issues: parsed.error.issues,
        });
      }
      const result = await recordCycle(parsed.data);
      if (!result.ok) {
        const status = result.code === "redis" ? 500 : 400;
        return res.status(status).json({ error: result.detail || result.code });
      }
      // Preserve the {ok:true} response contract while surfacing the
      // coordinator's dedup/enrich/bucket signal (matching the sibling
      // /autopilot/cycle-record handler) so a redundant post on an
      // already-recorded cycleId is observably a dedup, not a silent 200.
      res.json({
        ok: true,
        cycleId: result.cycleId,
        status: result.status,
        bucketed: result.bucketed,
        deduped: result.deduped,
        enriched: result.enriched,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // -------------------------------------------------------------------------
  // POST /autopilot/reflection-record — reap-side reflection writer (#1119).
  //
  // The WRITE-gap fix for the severed episodic-reflection learning loop. The
  // reap path (`scripts/autopilot/reap.py::_fire_reflection_record`) POSTs a
  // classified NON-MERGED failure here so the per-anchor reflection store
  // becomes non-empty, restoring the #841 live injection path that
  // hydra-dev/target read at planning time (the #193 retry-correctness
  // invariant). A merged PR records NO reflection — reflections are
  // prior-FAILURE narratives. The wrapper never throws; a Redis error answers
  // 500, which the best-effort reap POST swallows.
  // -------------------------------------------------------------------------
  router.post("/autopilot/reflection-record", async (req, res) => {
    const parsed = ReflectionRecordBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        code: "schema-validation-failed",
        issues: parsed.error.issues,
      });
    }
    const result = await recordReflectionOutcome(parsed.data);
    if (!result.ok) {
      const status = result.code === "redis" ? 500 : 400;
      return res.status(status).json({ error: result.detail || result.code });
    }
    return res.json({
      ok: true,
      anchorRef: result.anchorRef,
      outcome: result.outcome,
    });
  });

  // -------------------------------------------------------------------------
  // POST /autopilot/run-start — bootstrap.sh end-of-Phase-0.
  // -------------------------------------------------------------------------
  router.post("/autopilot/run-start", async (req, res) => {
    const parsed = RunStartBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json(schemaValidationError(parsed.error));
    }
    const result = await startRun(parsed.data);
    if (!result.ok) {
      const status = result.code === "redis" ? 500 : 400;
      return res.status(status).json({ error: result.detail || result.code });
    }
    return res.json({ ok: true, run_id: result.run_id, deduped: result.deduped });
  });

  // -------------------------------------------------------------------------
  // POST /autopilot/run-end — term-check.py.
  // -------------------------------------------------------------------------
  router.post("/autopilot/run-end", async (req, res) => {
    const parsed = RunEndBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        error: "Missing run_id",
        issues: parsed.error.issues,
      });
    }
    const result = await endRun(parsed.data);
    if (!result.ok) {
      const status = result.code === "not-found" ? 404 : result.code === "redis" ? 500 : 400;
      return res.status(status).json({ error: result.detail || result.code });
    }
    return res.json({
      ok: true,
      run_id: result.run_id,
      status: result.status,
      term_reason: result.term_reason,
      deduped: result.deduped,
    });
  });

  // -------------------------------------------------------------------------
  // POST /autopilot/turn — heartbeat.py.
  // -------------------------------------------------------------------------
  router.post("/autopilot/turn", async (req, res) => {
    const parsed = TurnBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      // Preserve the legacy two error messages so existing tests pin on them.
      const firstIssue = parsed.error.issues[0];
      const path = firstIssue?.path?.[0];
      const error =
        path === "run_id"
          ? "Missing run_id"
          : path === "turn_n"
            ? "Missing or invalid turn_n"
            : "schema-validation-failed";
      return res.status(400).json({ error, issues: parsed.error.issues });
    }
    const result = await recordTurn(parsed.data);
    if (!result.ok) {
      const status = result.code === "not-found" ? 404 : result.code === "redis" ? 500 : 400;
      return res.status(status).json({ error: result.detail || result.code });
    }
    return res.json({
      ok: true,
      run_id: result.run_id,
      turn_n: result.turn_n,
      deduped: result.deduped,
      dispatch_count: result.dispatch_count,
    });
  });

  return router;
}

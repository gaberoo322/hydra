/**
 * Autopilot lifecycle WRITE routes — the run/turn/cycle mutation surface.
 *
 *   POST /autopilot/cycle-record       — one per code-writing subagent dispatch
 *   POST /autopilot/reflection-record  — reap-side reflection writer (#1119)
 *   POST /autopilot/run-start          — bootstrap.sh end-of-Phase-0
 *   POST /autopilot/run-end            — term-check.py
 *   POST /autopilot/turn               — heartbeat.py
 *
 * Split out of the combined `autopilot.ts` router (#2034). These five POSTs
 * are the **Autopilot Run** + **Autopilot Turn** lifecycle's only HTTP write
 * path; they track the `bootstrap.sh` / heartbeat / reap protocol and all flow
 * through the lifecycle domain Module (`src/autopilot/runs.ts`). Each handler:
 *
 *   1. parses the body (zod, via `src/autopilot/schemas.ts`)
 *   2. calls the domain Module
 *   3. translates the result-object back into HTTP
 *
 * Every state mutation flows through the Module — there is no direct Redis
 * access in this file. That keeps the lifecycle's idempotency invariants in one
 * place to enforce and one place to test.
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
  recordCycle,
  recordReflectionOutcome,
  startRun,
  endRun,
  recordTurn,
} from "../autopilot/runs.ts";

export function createAutopilotLifecycleRouter() {
  const router = Router();

  // -------------------------------------------------------------------------
  // POST /autopilot/cycle-record — one per code-writing subagent dispatch.
  // -------------------------------------------------------------------------
  router.post("/autopilot/cycle-record", async (req, res) => {
    const parsed = CycleRecordBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        error: "Missing cycleId",
        issues: parsed.error.issues,
      });
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
    });
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
      return res.status(400).json({
        error: "Missing run_id",
        issues: parsed.error.issues,
      });
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

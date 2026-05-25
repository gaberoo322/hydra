/**
 * Autopilot HTTP routes — thin adapters over `src/autopilot/`.
 *
 * The orchestrator-side **Autopilot Run** + **Autopilot Turn** lifecycle
 * lives in `src/autopilot/runs.ts`. The log + journal helpers live in
 * `src/autopilot/log.ts`. Body shapes are validated via
 * `src/autopilot/schemas.ts`. This router is now a stack of route
 * handlers that:
 *
 *   1. parse the body / query params (zod for POST bodies)
 *   2. call the domain Module
 *   3. translate the result-object back into HTTP
 *
 * Every state mutation flows through the Module — there is no direct
 * Redis access in this file. That keeps the lifecycle's idempotency
 * invariants (one place to enforce; one place to test) and lets the
 * dashboard endpoints share the same projection helpers the writers use.
 */

import { Router } from "express";
import {
  CycleRecordBodySchema,
  RunStartBodySchema,
  RunEndBodySchema,
  TurnBodySchema,
} from "../autopilot/schemas.ts";
import {
  recordCycle,
  startRun,
  endRun,
  recordTurn,
  getCurrentRun,
  getRun,
  getRunRow,
  listRuns,
  clampInt,
  fetchTurnsWithJoins,
} from "../autopilot/runs.ts";
import {
  readLogTail,
  readJournalSlice,
  LOG_TAIL_DEFAULT,
  LOG_TAIL_MAX,
  runJournalctl,
  sanitizeIso,
} from "../autopilot/log.ts";

/**
 * Re-exported for `test/autopilot-logs.test.mts` (drives `journalctl`
 * via the `HYDRA_AUTOPILOT_JOURNAL_CMD` mock) and for `src/api/agents.ts`
 * (consumes `fetchTurnsWithJoins` to attach turn detail to agent runs).
 * New code should import from `src/autopilot/log.ts` or
 * `src/autopilot/runs.ts` directly.
 */
export { runJournalctl, fetchTurnsWithJoins, sanitizeIso };

export function createAutopilotRouter() {
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

  // -------------------------------------------------------------------------
  // GET /autopilot/runs — history table.
  // -------------------------------------------------------------------------
  router.get("/autopilot/runs", async (req, res) => {
    const limitRaw = req.query.limit;
    const limit = clampInt(limitRaw === undefined ? 14 : Number(limitRaw), 1, 50, 14);
    const result = await listRuns(limit);
    if (!result.ok) {
      return res.status(500).json({ error: result.detail || result.code });
    }
    return res.json({ runs: result.runs });
  });

  // -------------------------------------------------------------------------
  // GET /autopilot/runs/current — header strip.
  // -------------------------------------------------------------------------
  router.get("/autopilot/runs/current", async (_req, res) => {
    const result = await getCurrentRun();
    if (!result.ok) {
      const status = result.code === "not-found" ? 404 : 500;
      return res.status(status).json({ error: result.detail || result.code });
    }
    return res.json(result.view);
  });

  // -------------------------------------------------------------------------
  // GET /autopilot/runs/:runId/log — log tail.
  // -------------------------------------------------------------------------
  router.get("/autopilot/runs/:runId/log", async (req, res) => {
    const runId = String(req.params.runId || "").trim();
    if (!runId) {
      return res.status(400).json({ error: "Missing runId" });
    }
    const runRowResult = await getRunRow(runId);
    if (!runRowResult.ok) {
      const status = runRowResult.code === "not-found" ? 404 : 500;
      return res.status(status).json({ error: runRowResult.detail || runRowResult.code });
    }

    const tailRaw = req.query.tail;
    const tailParsed = tailRaw === undefined ? LOG_TAIL_DEFAULT : Number(tailRaw);
    if (!Number.isInteger(tailParsed) || tailParsed < 1 || tailParsed > LOG_TAIL_MAX) {
      return res.status(400).json({
        error: `invalid tail: must be integer in [1, ${LOG_TAIL_MAX}]`,
      });
    }

    try {
      const logResult = await readLogTail({ runId, row: runRowResult.row, tail: tailParsed });
      if (!logResult.ok) {
        return res.status(404).json({ error: "log no longer available — rotated" });
      }
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.setHeader("x-autopilot-log-source", logResult.source);
      return res.status(200).send(logResult.text);
    } catch (err: any) {
      console.error(`[autopilot] runs/:runId/log failed: ${err?.message || err}`);
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // GET /autopilot/runs/:runId/journal — systemd journal slice.
  // -------------------------------------------------------------------------
  router.get("/autopilot/runs/:runId/journal", async (req, res) => {
    const runId = String(req.params.runId || "").trim();
    if (!runId) {
      return res.status(400).json({ error: "Missing runId" });
    }
    const runRowResult = await getRunRow(runId);
    if (!runRowResult.ok) {
      const status = runRowResult.code === "not-found" ? 404 : 500;
      return res.status(status).json({ error: runRowResult.detail || runRowResult.code });
    }

    try {
      const journalResult = await readJournalSlice({ row: runRowResult.row });
      if (!journalResult.ok) {
        return res.status(500).json({ error: "run hash missing valid started timestamp" });
      }
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.setHeader("x-autopilot-journal-unit", journalResult.unit);
      if (journalResult.truncated) res.setHeader("x-autopilot-journal-truncated", "true");
      if (journalResult.timedOut) res.setHeader("x-autopilot-journal-timed-out", "true");
      return res.status(200).send(journalResult.text);
    } catch (err: any) {
      console.error(`[autopilot] runs/:runId/journal failed: ${err?.message || err}`);
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // GET /autopilot/runs/:runId — full detail.
  // -------------------------------------------------------------------------
  router.get("/autopilot/runs/:runId", async (req, res) => {
    const runId = String(req.params.runId || "").trim();
    if (!runId) {
      return res.status(400).json({ error: "Missing runId" });
    }
    // Express has already routed `/runs/current` to its handler; this only
    // catches truly malformed paths.
    if (runId === "current") {
      return res.status(400).json({ error: "use GET /autopilot/runs/current" });
    }

    const result = await getRun(runId);
    if (!result.ok) {
      const status = result.code === "not-found" ? 404 : 500;
      return res.status(status).json({ error: result.detail || result.code });
    }
    return res.json({ run: result.run, turns: result.turns });
  });

  return router;
}

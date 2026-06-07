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
import { z } from "zod";
import { STREAMS } from "../event-bus.ts";
import {
  CycleRecordBodySchema,
  RunStartBodySchema,
  RunEndBodySchema,
  TurnBodySchema,
  EmergencyBrakeBodySchema,
  AutopilotPauseBodySchema,
  ReflectionRecordBodySchema,
} from "../autopilot/schemas.ts";
import {
  getEmergencyBrake,
  setEmergencyBrake,
  clearEmergencyBrake,
} from "../redis/emergency-brake.ts";
import {
  getAutopilotPaused,
  setAutopilotPaused,
  clearAutopilotPaused,
} from "../redis/autopilot-pause.ts";
import {
  recordCycle,
  recordReflectionOutcome,
  startRun,
  endRun,
  recordTurn,
  getCurrentRun,
  getRun,
  getRunRow,
  listRuns,
  fetchTurnsWithJoins,
} from "../autopilot/runs.ts";
import { assembleRetroBundle } from "../autopilot/retro-bundle.ts";
import { RetroBundleParamsSchema, RecentRetrosQuerySchema } from "../schemas/retro.ts";
import { listRecentRetroArtifacts } from "../redis/retro.ts";
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

/**
 * Query schema for `GET /autopilot/runs?limit=N` (ADR-0022). Coerces the wire
 * string to an integer, clamps to [1, 50], and collapses bad/absent/out-of-range
 * input to the default 14 — preserving the prior `clampInt(.., 1, 50, 14)`
 * leniency without a behaviour-changing 400. Non-strict so it ignores any other
 * query params.
 */
const RunsLimitQuerySchema = z.object({
  // Mirror clampInt(n, 1, 50, 14) exactly: a non-finite / non-integer value
  // (absent param, "abc", "1.5") falls back to 14; an in-range or out-of-range
  // INTEGER clamps into [1, 50] (so limit=0 → 1, limit=999 → 50) rather than
  // collapsing to the default.
  limit: z
    .unknown()
    .transform((raw) => {
      const n = typeof raw === "number" ? raw : Number(raw);
      if (raw === undefined || raw === null || raw === "") return 14;
      if (!Number.isFinite(n) || !Number.isInteger(n)) return 14;
      if (n < 1) return 1;
      if (n > 50) return 50;
      return n;
    }),
});

/**
 * @param eventBus - optional; when provided, pause/resume emit a
 *   `hydra:notifications` event (issue #988 AC#5). The router stays usable
 *   without it (tests construct it bare) — a missing bus degrades to a no-op
 *   publish, never a throw.
 */
export function createAutopilotRouter(eventBus?: any) {
  const router = Router();

  // Best-effort bus publish — never throws into a route handler. AC#5 wants a
  // pause/resume event, but the flag write is the source of truth; a publish
  // failure (or absent bus in a test) must not fail the operator's POST.
  async function publishPauseEvent(type: string, payload: unknown): Promise<void> {
    if (!eventBus || typeof eventBus.publish !== "function") return;
    try {
      await eventBus.publish(STREAMS.NOTIFICATIONS, {
        type,
        source: "autopilot-pause",
        payload,
      });
    } catch (err: any) {
      console.error(`[autopilot] pause event publish failed: ${err?.message || err}`);
    }
  }

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

  // -------------------------------------------------------------------------
  // GET /autopilot/runs — history table.
  // -------------------------------------------------------------------------
  router.get("/autopilot/runs", async (req, res) => {
    // ADR-0022: read `limit` through the Schemas seam. This mirrors the prior
    // clampInt(.., 1, 50, 14) — bad/absent/out-of-range input collapses to the
    // default 14, valid input clamps into [1, 50].
    const limit = RunsLimitQuerySchema.safeParse(req.query).data?.limit ?? 14;
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

    // ADR-0022: read `tail` through the Schemas seam. This route keeps its
    // bespoke hard-400 on out-of-range input, so it safeParses inline (strict
    // integer in [1, LOG_TAIL_MAX], default LOG_TAIL_DEFAULT) and owns the
    // response — matching the common.ts guidance for routes with bespoke
    // error handling.
    const tailResult = z
      .object({
        tail: z.coerce
          .number()
          .int()
          .min(1)
          .max(LOG_TAIL_MAX)
          .default(LOG_TAIL_DEFAULT),
      })
      .safeParse(req.query);
    if (!tailResult.success) {
      return res.status(400).json({
        error: `invalid tail: must be integer in [1, ${LOG_TAIL_MAX}]`,
      });
    }
    const tailParsed = tailResult.data.tail;

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
  // GET /autopilot/runs/:runId/retro — run-tree retro bundle (issue #918).
  //
  // Read-only, never-throw assembler over the run's lifecycle data. The
  // domain library (`autopilot/retro-bundle.ts`) returns a partial bundle
  // with a populated `errors[]` rather than throwing on a sub-source
  // failure, so this route always answers 200 with the (possibly partial)
  // bundle once the run_id validates. A bad run_id is a 400.
  // -------------------------------------------------------------------------
  router.get("/autopilot/runs/:runId/retro", async (req, res) => {
    const parsed = RetroBundleParamsSchema.safeParse({ run_id: req.params.runId });
    if (!parsed.success) {
      return res
        .status(400)
        .json({ code: "schema-validation-failed", issues: parsed.error.issues });
    }
    const bundle = await assembleRetroBundle(parsed.data.run_id);
    return res.json(bundle);
  });

  // -------------------------------------------------------------------------
  // GET /autopilot/retros — recent PERSISTED retro artifacts (issue #921).
  //
  // The durable, auditable record of what each retrospective concluded and
  // acted on, newest-first. Feeds the dashboard Retro panel. The accessor
  // (`redis/retro.listRecentRetroArtifacts`) honours the never-throw contract
  // — a Redis failure yields `[]`, never a throw — so this route always
  // answers 200 with the (possibly empty) list once the query validates. A bad
  // `limit` is a 400 via the schema seam.
  // -------------------------------------------------------------------------
  router.get("/autopilot/retros", async (req, res) => {
    const parsed = RecentRetrosQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ code: "schema-validation-failed", issues: parsed.error.issues });
    }
    const artifacts = await listRecentRetroArtifacts(parsed.data.limit);
    return res.json({ artifacts });
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

  // -------------------------------------------------------------------------
  // Emergency brake (issue #744) — the operator-only emergency brake.
  //
  // This router IS the sole write path for the brake flag. The autopilot
  // (decide.py / collect-state.sh) only READS it (via /health and a state
  // collector line); there is no engage/disengage *action type*, so the
  // autopilot has no structural way to set or clear the brake. Pulling the
  // brake pauses ALL auto-merge regardless of tier/depth and routes open PRs
  // to /hydra-review; releasing it resumes ADR-0015 depth-gated merge.
  // -------------------------------------------------------------------------

  // GET /autopilot/emergency-brake — read current brake state.
  router.get("/autopilot/emergency-brake", async (_req, res) => {
    try {
      const state = await getEmergencyBrake();
      return res.json(state);
    } catch (err: any) {
      console.error(`[autopilot] emergency-brake read failed: ${err?.message || err}`);
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // POST /autopilot/emergency-brake — engage/disengage. Operator-only.
  router.post("/autopilot/emergency-brake", async (req, res) => {
    const parsed = EmergencyBrakeBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ code: "schema-validation-failed", issues: parsed.error.issues });
    }
    try {
      if (parsed.data.engaged) {
        const state = await setEmergencyBrake(parsed.data.engagedBy ?? "operator");
        return res.json(state);
      }
      await clearEmergencyBrake();
      return res.json({ engaged: false });
    } catch (err: any) {
      console.error(`[autopilot] emergency-brake write failed: ${err?.message || err}`);
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // Autopilot pause (issue #988) — the operator-only durable autopilot pause.
  //
  // This router IS the sole write path for the pause flag. The autopilot
  // (decide.py / collect-state.sh / pace-gate.sh) only READS it (folded into
  // /api/usage/eligibility); there is no engage/disengage *action type*, so
  // the autopilot has no structural way to set or clear it. Setting it pauses
  // launch+dispatch with a DRAIN (in-flight subagents finish their atomic
  // unit); clearing it resumes. INDEPENDENT of the emergency-brake (merge-
  // only) — the two flags compose.
  // -------------------------------------------------------------------------

  // GET /autopilot/paused — read current pause state.
  router.get("/autopilot/paused", async (_req, res) => {
    try {
      const state = await getAutopilotPaused();
      return res.json(state);
    } catch (err: any) {
      console.error(`[autopilot] paused read failed: ${err?.message || err}`);
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // POST /autopilot/paused — pause/resume. Operator-only.
  router.post("/autopilot/paused", async (req, res) => {
    const parsed = AutopilotPauseBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ code: "schema-validation-failed", issues: parsed.error.issues });
    }
    try {
      if (parsed.data.paused) {
        const state = await setAutopilotPaused();
        await publishPauseEvent("autopilot-paused", { paused: true, since: state.since });
        return res.json(state);
      }
      await clearAutopilotPaused();
      await publishPauseEvent("autopilot-resumed", { paused: false });
      return res.json({ paused: false });
    } catch (err: any) {
      console.error(`[autopilot] paused write failed: ${err?.message || err}`);
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  return router;
}

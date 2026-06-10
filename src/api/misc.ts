import { Router } from "express";
import { z } from "zod";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { sendDigestNow, sendDailyHeartbeatNow } from "../digest.ts";
import { classifyChange } from "../tier-classifier.ts";

/**
 * Query schema for `GET /tier?files=a,b,c` (ADR-0022).
 *
 * `files` must be PRESENT (string or repeated-param array) but may be empty —
 * the legacy read only 400s when the param is absent (undefined/null), and an
 * empty value classifies the empty change set. The schema requires presence
 * (any string or string[]) and the handler splits/trims the CSV into the file
 * list, exactly mirroring the legacy `Array.isArray(raw) ? raw.flatMap(...) :
 * String(raw).split(",")` normalisation. The route owns its bespoke 400 via an
 * inline safeParse. Non-strict — ignores unknown params.
 */
const TierQuerySchema = z.object({
  files: z.union([z.string(), z.array(z.string())]),
});

/**
 * Residual "misc" routes that don't fit elsewhere.
 *
 * Issue #268 split this file — see api/openviking.ts, api/goals.ts,
 * api/events.ts, api/config.ts, api/alerts.ts,
 * api/reflections.ts, api/merge-lock.ts. What remains here are operational
 * routes without a natural domain home: kill switch, digest
 * trigger, tier classifier, and agent-memory CRUD.
 *
 * New routes should prefer a domain-specific sub-router. Only land here if
 * the route is genuinely orphan-operational.
 */
export function createMiscRouter(_eventBus: any) {
  const router = Router();

  const HYDRA_ROOT = process.env.HYDRA_ROOT || resolve(process.env.HOME, "hydra");
  const KILL_FILE = resolve(HYDRA_ROOT, ".kill");

  // POST /kill — Emergency stop. Writes the kill file that health.ts and
  // service-strip.ts poll (~/hydra/.kill). The in-process control loop was
  // removed in #383; the dead killCycle() call was stripped in #701.
  router.post("/kill", async (req, res) => {
    writeFileSync(KILL_FILE, new Date().toISOString());
    res.json({ killed: true, killFile: KILL_FILE });
  });

  // GET /tier?files=a,b,c — Modification tier classification (issue #243,
  // ADR-0004 work-order step 3). Used by autopilot/dashboard to know
  // which merge policy applies to a proposed change.
  router.get("/tier", (req, res) => {
    // ADR-0022: read `files` through the Schemas seam. Required-present (string
    // or array) but may be empty; the route owns its bespoke 400 on absence.
    const parsed = TierQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: "Missing query parameter 'files' (comma-separated)" });
    }
    const raw = parsed.data.files;
    const list = Array.isArray(raw) ? raw.flatMap(s => String(s).split(",")) : String(raw).split(",");
    const files = list.map(s => s.trim()).filter(s => s.length > 0);
    const result = classifyChange(files);
    res.json(result);
  });

  // POST /digest/send — Manually trigger a digest summary now
  router.post("/digest/send", async (req, res) => {
    try {
      await sendDigestNow();
      res.json({ sent: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /digest/heartbeat — Manually trigger the daily heartbeat now. Lets the
  // operator verify Telegram delivery on demand (and is the endpoint a daily
  // systemd timer can hit if wall-clock-aligned delivery is wanted).
  router.post("/digest/heartbeat", async (req, res) => {
    try {
      await sendDailyHeartbeatNow();
      res.json({ sent: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // Agent memory
  // -----------------------------------------------------------------------

  router.post("/memory/:agent/pattern", async (req, res) => {
    try {
      const agentName = req.params.agent;
      const { category, action, example, cycleId, severity } = req.body || {};
      if (!category || !action) {
        return res.status(400).json({ error: "Missing category or action" });
      }
      // Issue #823 — recordPattern dispatches the escalation internally
      // (record-then-escalate, best-effort). No separate escalateIfNeeded call
      // or escalation.ts import needed here.
      const { recordPattern } = await import("../pattern-memory/agent-memory.ts");
      // Issue #843 — surface the Escalation Outcome so a systematic gh/auth
      // outage is observable on the caller side instead of a silent { ok: true }.
      const result = await recordPattern(agentName, category, {
        severity: severity || "prevent",
        action,
        example: example || "",
        cycleId: cycleId || `claude-${Date.now()}`,
      });
      res.json({ ok: true, escalation: result.escalationResult ?? null });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/memory/:agent", async (req, res) => {
    try {
      const { loadAgentMemory } = await import("../pattern-memory/agent-memory.ts");
      const memory = await loadAgentMemory(req.params.agent);
      res.type("text/plain").send(memory);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /memory/subagent-lesson (issue #392) — lesson-capture hook for
  // autopilot-dispatched subagents (hydra-dev / hydra-qa / hydra-target-build).
  // After codex-runner is deleted by issue #383, this is the *only*
  // post-cycle writer to hydra:memory:{agent}:patterns. The endpoint is
  // intentionally a thin wrapper around captureSubagentLesson() so the
  // existing 3-hit auto-promotion pipeline continues to apply unchanged.
  router.post("/memory/subagent-lesson", async (req, res) => {
    try {
      const { skill, outcome, cue, context, action, severity, cycleId } = req.body || {};
      const { captureSubagentLesson, isValidSkill, isValidOutcome } =
        await import("../pattern-memory/subagent-capture.ts");

      if (!isValidSkill(skill)) {
        return res.status(400).json({
          error: `Invalid or missing 'skill' — expected a skill whose dispatch class carries a learningAgent in the Dispatch-Class Taxonomy (scripts/autopilot/classes.json)`,
        });
      }
      if (!isValidOutcome(outcome)) {
        return res.status(400).json({
          error: `Invalid or missing 'outcome' — expected qa-fail | verification-failure | no-diff | rollback`,
        });
      }
      if (typeof cue !== "string" || cue.trim().length === 0) {
        return res.status(400).json({ error: "Missing 'cue' (non-empty string)" });
      }

      const result = await captureSubagentLesson({
        skill,
        outcome,
        cue,
        context: typeof context === "string" ? context : "",
        action: typeof action === "string" ? action : undefined,
        severity: severity === "reinforce" ? "reinforce" : "prevent",
        cycleId: typeof cycleId === "string" ? cycleId : undefined,
      });
      res.json({ ok: true, ...result });
    } catch (err: any) {
      console.error(`[api/memory/subagent-lesson] failed:`, err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /memory/subagent-friction (issue #512) — soft-friction capture for
  // autopilot-dispatched subagents. Distinct from /memory/subagent-lesson
  // (which captures hard failures). Friction items land in
  // hydra:friction:{skill}:patterns and don't promote to to-{agent}.md, but
  // they do fire the GitHub-issue escalation hook on threshold-cross so
  // chronic friction becomes tracked work.
  router.post("/memory/subagent-friction", async (req, res) => {
    try {
      const { skill, cue, workaround, context, cycleId } = req.body || {};
      const { captureSubagentFriction, isValidSkill } = await import(
        "../pattern-memory/subagent-capture.ts"
      );

      if (!isValidSkill(skill)) {
        return res.status(400).json({
          error: `Invalid or missing 'skill' — expected a skill whose dispatch class carries a learningAgent in the Dispatch-Class Taxonomy (scripts/autopilot/classes.json)`,
        });
      }
      if (typeof cue !== "string" || cue.trim().length === 0) {
        return res.status(400).json({ error: "Missing 'cue' (non-empty string)" });
      }
      if (typeof workaround !== "string" || workaround.trim().length === 0) {
        return res.status(400).json({ error: "Missing 'workaround' (non-empty string)" });
      }

      const result = await captureSubagentFriction({
        skill,
        cue,
        workaround,
        context: typeof context === "string" ? context : "",
        cycleId: typeof cycleId === "string" ? cycleId : undefined,
      });
      res.json({ ok: true, ...result });
    } catch (err: any) {
      console.error(`[api/memory/subagent-friction] failed:`, err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

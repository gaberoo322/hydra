import { Router } from "express";
import { recordPattern, loadAgentMemory } from "../pattern-memory/agent-memory.ts";
import {
  captureSubagentLesson,
  captureSubagentFriction,
  isValidSkill,
  isValidOutcome,
} from "../pattern-memory/subagent-capture.ts";
import {
  PatternBodySchema,
  SubagentLessonBodySchema,
  SubagentFrictionBodySchema,
} from "../schemas/pattern-memory.ts";

/**
 * Pattern Memory write router (issue #2280).
 *
 * The `/memory/*` write cluster was split out of `src/api/learning.ts`, whose
 * file name signalled the Learning-reads cluster but bundled these unrelated
 * Pattern Memory writes too. A developer hunting "where do the pattern-memory
 * write routes live?" now finds them in a file named for the domain it writes.
 *
 * These routes are LIVE in production: hydra-dev, hydra-qa, and
 * hydra-target-build POST `/memory/subagent-lesson` and `/memory/subagent-friction`;
 * hydra-incident POSTs `/memory/:agent/pattern`. The URL surface is byte-identical
 * to before the split — only the source file owning each route changed.
 *
 * (Routes migrated from api/misc.ts in issue #2181, then from api/learning.ts
 * in issue #2280.)
 */
export function createPatternMemoryRouter() {
  const router = Router();

  // POST /memory/:agent/pattern — record a pattern for an agent.
  // Issue #823: recordPattern dispatches escalation internally (best-effort).
  // Issue #843: escalationResult is surfaced on the response so callers can
  // observe systematic gh/auth outages instead of getting a silent {ok:true}.
  router.post("/memory/:agent/pattern", async (req, res) => {
    const parsed = PatternBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        code: "schema-validation-failed",
        issues: parsed.error.issues,
      });
    }
    try {
      const { category, action, example, cycleId, severity } = parsed.data;
      const result = await recordPattern(req.params.agent, category, {
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

  // GET /memory/:agent — load the formatted agent memory string.
  router.get("/memory/:agent", async (req, res) => {
    try {
      const memory = await loadAgentMemory(req.params.agent);
      res.type("text/plain").send(memory);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /memory/subagent-lesson (issue #392) — lesson-capture hook for
  // autopilot-dispatched subagents (hydra-dev / hydra-qa / hydra-target-build).
  // This is the only post-cycle writer to hydra:memory:{agent}:patterns.
  router.post("/memory/subagent-lesson", async (req, res) => {
    const parsed = SubagentLessonBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        code: "schema-validation-failed",
        issues: parsed.error.issues,
      });
    }
    const { skill, outcome, cue, context, action, severity, cycleId } = parsed.data;
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
    try {
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
  // hydra:friction:{skill}:patterns and fire the GitHub-issue escalation hook
  // on threshold-cross so chronic friction becomes tracked work.
  router.post("/memory/subagent-friction", async (req, res) => {
    const parsed = SubagentFrictionBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        code: "schema-validation-failed",
        issues: parsed.error.issues,
      });
    }
    const { skill, cue, workaround, context, cycleId } = parsed.data;
    if (!isValidSkill(skill)) {
      return res.status(400).json({
        error: `Invalid or missing 'skill' — expected a skill whose dispatch class carries a learningAgent in the Dispatch-Class Taxonomy (scripts/autopilot/classes.json)`,
      });
    }
    try {
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

import { Router } from "express";
import { recordPattern, loadAgentMemory } from "../pattern-memory/agent-memory.ts";
import { listFrictionPatterns } from "../pattern-memory/agent-memory.ts";
import {
  getIneffectivePromotedPatterns,
  getRuleActionLog,
} from "../pattern-memory/rule-effectiveness.ts";
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
import { RuleActionLogQuerySchema } from "../schemas/learning.ts";

// The friction-patterns diagnostic aggregates over the same skills the
// subagent-capture write routes above accept (issue #3006, relocated with the
// three pattern-memory read diagnostics out of src/api/learning.ts).
const FRICTION_SKILLS = ["hydra-dev", "hydra-target-build", "hydra-qa"] as const;

/**
 * Pattern Memory router (issue #2280; read-side diagnostics added #3006).
 *
 * The `/memory/*` write cluster was split out of `src/api/learning.ts`, whose
 * file name signalled the Learning-reads cluster but bundled these unrelated
 * Pattern Memory writes too. A developer hunting "where do the pattern-memory
 * write routes live?" now finds them in a file named for the domain it writes.
 *
 * Issue #3006: the READ-side pattern-memory diagnostics that previously lived in
 * `src/api/learning.ts` — `GET /learning/ineffective-rules`,
 * `GET /learning/rule-action-log`, `GET /learning/friction-patterns` — moved
 * here so the pattern-memory write + read surface lives together in the file
 * named for the domain it serves. They read from `pattern-memory/*` (the same
 * domain the write routes touch), so a reader asking "how does pattern-memory
 * diagnostics work?" finds the whole surface in one place. The URL paths are
 * unchanged (still `/api/learning/*`) — only the owning file boundary moved.
 *
 * These routes are LIVE in production: hydra-dev, hydra-qa, and
 * hydra-target-build POST `/memory/subagent-lesson` and `/memory/subagent-friction`;
 * hydra-incident POSTs `/memory/:agent/pattern`. The URL surface is byte-identical
 * to before the split — only the source file owning each route changed.
 *
 * (Routes migrated from api/misc.ts in issue #2181, then from api/learning.ts
 * in issue #2280; read diagnostics migrated from api/learning.ts in #3006.)
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

  // =========================================================================
  // Read-side pattern-memory diagnostics (issue #3006 — relocated from
  // src/api/learning.ts). These three GET routes read from the pattern-memory
  // domain (`rule-effectiveness.ts`, `agent-memory.ts`) — the same domain the
  // write routes above touch — so they belong beside those writes rather than in
  // the catch-all learning router. URL paths are unchanged (`/api/learning/*`).
  // =========================================================================

  /**
   * GET /learning/ineffective-rules — patterns that were auto-promoted to a
   * feedback file but keep firing at the same (or higher) rate post-promotion.
   *
   * Issue #289: promotion is supposed to durably change agent behavior, but the
   * observed reality is `scope-creep` at 231 hits and `verification-failure` at
   * 438 hits long after promotion. This endpoint surfaces those rules so an
   * operator (or a prompt-evolution agent — see #7) can rewrite or split them
   * into more specific sub-patterns.
   *
   * Response:
   *   {
   *     planner:  IneffectivePromotedPattern[],
   *     executor: IneffectivePromotedPattern[],
   *     skeptic:  IneffectivePromotedPattern[],
   *     totalIneffective: number,
   *   }
   *
   * Each entry includes pre/post firing rates, promotion date, and the ratio
   * between them so reviewers can prioritise the worst offenders.
   *
   * UNIT CLARIFICATION (issue #2950): the `preRate`/`postRate`/`rateRatio` fields
   * on each entry are cue-FIRING rates — friction-cue firings per day recorded via
   * Pattern Memory's `recordPattern` — NOT merge/QA/build failure rates. A
   * flat-or-rising postRate flags a promoted rule whose text is not preventing the
   * friction it describes; promotion is correlated with, not causal of, a rate
   * rise (issue #2933 was falsified on exactly this misread). Do not read this
   * endpoint as evidence that a promotion "caused" more failures.
   */
  router.get("/learning/ineffective-rules", async (_req, res) => {
    try {
      const [planner, executor, skeptic] = await Promise.all([
        getIneffectivePromotedPatterns("planner"),
        getIneffectivePromotedPatterns("executor"),
        getIneffectivePromotedPatterns("skeptic"),
      ]);
      const totalIneffective = planner.length + executor.length + skeptic.length;
      res.json({ planner, executor, skeptic, totalIneffective });
    } catch (err: any) {
      console.error(`[pattern-memory-api] ineffective-rules failed: ${err?.message || String(err)}`);
      res.status(500).json({
        planner: [],
        executor: [],
        skeptic: [],
        totalIneffective: 0,
        errors: [err?.message || String(err)],
      });
    }
  });

  /**
   * GET /learning/rule-action-log — audit trail of auto-demote / alert
   * actions taken by the daily effectiveness check (issue #365). Newest
   * first; capped at RULE_ACTION_LOG_CAP entries.
   *
   * Query param `limit` (default 50, max 200).
   */
  router.get("/learning/rule-action-log", async (req, res) => {
    try {
      // ADR-0022: read `limit` through the Schemas seam (safeParse on the whole
      // req.query). The schema reuses countQuerySchema's coercion, which
      // collapses bad/absent/out-of-range input to the default (50) and clamps
      // to [1, 200] — exactly the legacy `parseInt(...) || 50` + clamp.
      const limit = RuleActionLogQuerySchema.safeParse(req.query).data?.limit ?? 50;
      const entries = await getRuleActionLog(limit);
      res.json({ entries, count: entries.length });
    } catch (err: any) {
      console.error(`[pattern-memory-api] rule-action-log failed: ${err?.message || String(err)}`);
      res.status(500).json({ entries: [], count: 0, errors: [err?.message || String(err)] });
    }
  });

  /**
   * GET /learning/friction-patterns — observability surface for the soft
   * friction items captured from subagent runs (issue #512). Returns the
   * aggregated friction patterns keyed by skill, mirroring the shape of
   * `/learning/ineffective-rules` for symmetry.
   */
  router.get("/learning/friction-patterns", async (_req, res) => {
    try {
      const out: Record<string, unknown[]> = {};
      let total = 0;
      for (const skill of FRICTION_SKILLS) {
        const patterns = await listFrictionPatterns(skill);
        out[skill] = patterns;
        total += patterns.length;
      }
      res.json({ ...out, totalPatterns: total });
    } catch (err: any) {
      console.error(`[pattern-memory-api] friction-patterns failed: ${err?.message || String(err)}`);
      res.status(500).json({
        totalPatterns: 0,
        errors: [err?.message || String(err)],
      });
    }
  });

  return router;
}

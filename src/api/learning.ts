import { Router } from "express";
import { listFrictionPatterns } from "../pattern-memory/agent-memory.ts";
import {
  getIneffectivePromotedPatterns,
  getRuleActionLog,
} from "../pattern-memory/rule-effectiveness.ts";
import { getContext } from "../learning.ts";
import { RuleActionLogQuerySchema, ContextTraceQuerySchema } from "../schemas/learning.ts";

const FRICTION_SKILLS = ["hydra-dev", "hydra-target-build", "hydra-qa"] as const;

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
 */
export function createLearningRouter() {
  const router = Router();

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
      console.error(`[learning-api] ineffective-rules failed: ${err?.message || String(err)}`);
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
      console.error(`[learning-api] rule-action-log failed: ${err?.message || String(err)}`);
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
      console.error(`[learning-api] friction-patterns failed: ${err?.message || String(err)}`);
      res.status(500).json({
        totalPatterns: 0,
        errors: [err?.message || String(err)],
      });
    }
  });

  /**
   * GET /learning/context-trace — diagnostic view of `getContext()`'s
   * COMPOSITION. Answers "what learning context *would* `getContext()`
   * assemble for this agent+anchor, and why is it shallow?" without the
   * operator having to grep server logs.
   *
   * IMPORTANT — composition, NOT a dispatched prompt (issue #841 honesty
   * re-scope): on today's architecture there is no in-process planner that
   * dispatches `getContext()`'s output. `getContext()` (and its sole live
   * caller, the dead-in-production `buildPlannerContext`) compose a prompt
   * string that no subagent receives. A block reporting `status: "hit"` here
   * therefore means "this source *would* contribute content if this prompt
   * were dispatched" — it does NOT prove a subagent actually received it.
   *
   * The LIVE reflection-injection path is `GET /api/reflections?anchor=&files=`,
   * which the dispatch skills (`hydra-dev`, `hydra-target-build`) fetch at
   * planning time and weave into the real implementation prompt. Use that
   * endpoint — not this trace — to verify reflections reach a retry dispatch.
   * This trace remains a useful composition-level diagnostic (which sources
   * have data for an anchor), but reading it as proof-of-delivery is the
   * false-positive #841 documents.
   *
   * Query params (required):
   *   agent     — agent name (e.g. "planner")
   *   reference — anchor reference string
   *   type      — anchor type (e.g. "codebase-health")
   *
   * Optional:
   *   files — comma-separated file path hint for the by-file index
   *
   * Response:
   *   {
   *     blocks: [
   *       { source, status: "hit" | "miss" | "error",
   *         contentBytes: number, itemCount: number, error?: string }
   *     ],
   *     promptBytes: number,   // size of the COMPOSED (not dispatched) prompt
   *   }
   *
   * Issue #804: `itemCount` (additive) is the structured count of items the
   * block contributed (reflections / OV memories / pattern groups) — sourced
   * from data, not regex-parsed from the rendered prompt. The new
   * `knowledge-base` source also appears here automatically (the trace maps
   * over whatever sources getContext composes).
   *
   * `content` itself is omitted — the trace is for diagnostics, not for
   * exfiltrating prompts. Operators can still read prompts through normal
   * cycle inspection endpoints.
   */
  router.get("/learning/context-trace", async (req, res) => {
    // ADR-0022: read query through the Schemas seam. This route owns a bespoke
    // 400 ("agent, reference, and type are required"), so it safeParses inline
    // and keeps its own response rather than going through aggregatorRoute.
    const parsed = ContextTraceQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "agent, reference, and type query params are required" });
      return;
    }
    const { agent, reference, type } = parsed.data;
    const filesParam = parsed.data.files ?? "";
    const files = filesParam
      ? filesParam.split(",").map(s => s.trim()).filter(Boolean)
      : undefined;

    try {
      const ctx = await getContext(agent, { type, reference, files });
      res.json({
        blocks: ctx.blocks.map(b => ({
          source: b.source,
          status: b.status,
          contentBytes: b.content.length,
          itemCount: b.itemCount,
          ...(b.error ? { error: b.error } : {}),
        })),
        promptBytes: ctx.toPrompt().length,
      });
    } catch (err: any) {
      console.error(`[learning-api] context-trace failed: ${err?.message || String(err)}`);
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  return router;
}

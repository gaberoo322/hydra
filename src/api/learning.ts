import { Router } from "express";
import {
  getIneffectivePromotedPatterns,
  getRuleActionLog,
  listFrictionPatterns,
} from "../learning/agent-memory.ts";

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
      const limitRaw = parseInt(String(req.query.limit ?? "50"), 10);
      const limit = Number.isFinite(limitRaw) ? Math.min(200, Math.max(1, limitRaw)) : 50;
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

  return router;
}

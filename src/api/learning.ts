import { Router } from "express";
import { getIneffectivePromotedPatterns } from "../learning/agent-memory.ts";

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

  return router;
}

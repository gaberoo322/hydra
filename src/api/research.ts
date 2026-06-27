import { Router } from "express";

export function createResearchRouter() {
  const router = Router();

  // POST /research/start — Run a research cycle.
  //
  // The in-process research loop was removed in #342 and its no-op shim
  // (`runResearchLoop`) was deleted in #706 (scheduler fold PR-1/4). Research
  // is driven by the /hydra-target-research skill, not by this HTTP route.
  // The endpoint is preserved as a deterministic "disabled" responder so
  // existing callers get the same structured skip the shim used to return.
  router.post("/research/start", async (req, res) => {
    res.json({
      researchId: null,
      skipped: true,
      reason: "research-loop disabled in #342; use /hydra-target-research",
      opportunityCount: 0,
      autoQueued: 0,
      summary: undefined,
      topOpportunities: [],
      duration: undefined,
      cost: 0,
    });
  });

  // POST /research/force was retired in #2489 (Option A). It wrote a Redis
  // one-shot flag (`setResearchForceOnce` → `hydra:scheduler:research-force-once`)
  // whose only consumer, `consumeResearchForceOnce`, was deleted in #706
  // (scheduler fold PR-1/4, ADR-0006) along with the in-process research loop.
  // The write end then had no reader: callers got a `{ ok: true }` success for
  // an action with zero effect, and the flag silently expired after its 1h TTL.
  // Forcing a research cycle is now an autopilot-brain concern — see
  // `scripts/autopilot/decide.py` (`_research_force_allowed`/`_research_force_stamp`,
  // the daily research-force cap) and the work-queue priority lever
  // (POST /api/queue). The legacy HTTP endpoint, its writer, and its Redis key
  // were removed rather than rebuilt across the Python boundary.

  return router;
}

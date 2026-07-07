/**
 * Per-class yield scoreboard + shadow-mode dampener HTTP surface (issue #2943).
 *
 *   GET /api/autopilot/class-stats
 *     → { scoreboard: ClassScoreboard, shadow: ShadowDampenerPlan, generatedAt }
 *
 * The READ-ONLY view the autopilot turn consumes. `collect-state.sh` reads this
 * one surface via `hydra raw GET /autopilot/class-stats`, stitches it into
 * `state.class_stats`, and `decide.py` logs the shadow-mode multipliers it WOULD
 * apply — actuating NOTHING (the #2943 byte-identical-dispatch invariant).
 *
 * Invariants (from the design concept for issue-2943):
 *
 *   - **Read-only.** The route registers only `GET /autopilot/class-stats`, does
 *     no dispatch, no revert. It DOES write one cache snapshot
 *     (`putClassScoreboard`) as a side benefit so a stalled refresher can serve a
 *     recent board — but never mutates the underlying spine / dispatch records.
 *     The factory takes no `eventBus`.
 *
 *   - **Consumes the spine + dispatch records read-only.** `buildClassScoreboard`
 *     reads `listDispatchOutcomes` (#2942) + `getObservations` and fits the pure
 *     estimator; `src/outcome-attribution/estimator.ts` and
 *     `src/redis/attribution-ledger.ts` are consumed but not modified.
 *
 *   - **Class-appropriate yield.** dev classes carry merge-rate + tokens/merge;
 *     producer classes carry the spine β (respecting identifiability flags);
 *     everything else is `not-scored`. Never raw merge-rate for a producer.
 *
 *   - **Never throws to the client.** `buildClassScoreboard` degrades to an empty
 *     scoreboard on a Redis-read failure (never throws); a defensive catch still
 *     guards the handler so Express never returns a bodyless 500.
 */

import { Router } from "express";
import {
  buildClassScoreboard,
  shadowDampener,
  type ClassScoreboard,
} from "../autopilot/class-stats.ts";
import { putClassScoreboard } from "../redis/class-stats.ts";

/** The one dependency the handler needs: the scoreboard composer (tests stub). */
type BuildScoreboard = typeof buildClassScoreboard;

/**
 * @param buildScoreboard Optional composer override (tests inject a fake that
 *   returns a canned scoreboard without a live Redis).
 * @param persist Optional snapshot writer override (tests pass a no-op).
 */
export function createAutopilotClassStatsRouter(
  buildScoreboard: BuildScoreboard = buildClassScoreboard,
  persist: (s: ClassScoreboard) => Promise<unknown> = putClassScoreboard,
) {
  const router = Router();

  router.get("/autopilot/class-stats", async (_req, res) => {
    try {
      const scoreboard = await buildScoreboard();
      const shadow = shadowDampener(scoreboard);
      // Best-effort cache write — a failure here must not fail the read.
      await persist(scoreboard).catch((err: any) => {
        console.error(
          `[autopilot/class-stats] snapshot persist failed (non-fatal): ${err?.message || err}`,
        );
      });
      res.json({
        scoreboard,
        shadow,
        generatedAt: new Date(scoreboard.computedAt).toISOString(),
      });
    } catch (err: any) {
      // Defensive — buildClassScoreboard degrades rather than throwing, so this
      // guard just guarantees Express never returns a bodyless 500.
      console.error(
        `[autopilot/class-stats] unexpected error: ${err?.message || String(err)}`,
      );
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  return router;
}

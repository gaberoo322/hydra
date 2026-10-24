/**
 * Per-class yield scoreboard + shadow-mode dampener HTTP surface (issue #2943).
 *
 *   GET /api/autopilot/class-stats
 *     → { scoreboard: ClassScoreboard, shadow: ShadowDampenerPlan, generatedAt }
 *
 * The READ-ONLY view the autopilot turn consumes. The Turn Snapshot reads this
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
 *   - **Weighted-Quota Cost Axis (issue #3548).** Each `ClassStat` additionally
 *     carries `weightedQuota` — the model-weighted, cacheRead-inclusive quota
 *     burn attributed to the class's skill, computed by `buildClassScoreboard`
 *     via the SAME `weightedQuotaBurn` fold + `quotaWeightCalibrated` gate that
 *     backs `/api/usage`'s `weightedBurn7d`. Serialized here as-is (an additive
 *     field); best-effort → `null` on a usage-read failure, never a fabricated 0.
 *
 *   - **Weighted-quota-per-merge for dev classes (issue #3549).** Dev-role rows
 *     also carry `weightedQuotaPerMerge` = `weightedQuota / mergedCount` — the
 *     true subscription cost per shipped PR. The output-based `tokensPerMerge` is
 *     PRESERVED unchanged alongside it, so the weighted and raw-output figures are
 *     never confused. Both serialize verbatim through the row (additive fields);
 *     `weightedQuotaPerMerge` is `null` (never 0) when there are no merges or
 *     `weightedQuota` is null.
 *
 *   - **Never throws to the client.** `buildClassScoreboard` degrades to an empty
 *     scoreboard on a Redis-read failure (never throws); a defensive catch still
 *     guards the handler so Express never returns a bodyless 500.
 *
 *   - **10-minute in-process memo (issue #4637, ADR-0034 §9.2).** The /builder
 *     yield view polls this route; recomputing the scoreboard per request is
 *     wasted Redis + fit work for a view with a 1-day freshness budget. The memo
 *     lives in the factory's closure (`{ body, computedAt, inflight }`) with an
 *     injectable `now()`:
 *       - two requests inside the window call `buildScoreboard` ONCE and return
 *         the identical memoised body — including its original `generatedAt`
 *         (never a fresh timestamp stamped onto a cached body);
 *       - a request at/after the window recomputes;
 *       - concurrent cold requests share ONE in-flight promise;
 *       - `persist` runs once per recompute (never on a hit);
 *       - a recompute that THROWS is not memoised (the next request retries).
 *     The response shape `{ scoreboard, shadow, generatedAt }` is unchanged, so
 *     the Turn Snapshot passthrough collector reads the same body it always did.
 *
 *   - **A degraded board is never memoised (issue #5161).** When
 *     `scoreboard.degraded === true` (a Redis / estimator read failed) the body is
 *     served but not pinned; the next request recomputes.
 */

import { Router } from "express";
import { buildClassScoreboard } from "../autopilot/class-stats.ts";
import {
  shadowDampener,
  type ClassScoreboard,
} from "../autopilot/class-stats-math.ts";
import { putClassScoreboard } from "../redis/class-stats.ts";
import { isolateAggregator } from "./route-helpers.ts";
import { logger } from "../logger.ts";

/** The one dependency the handler needs: the scoreboard composer (tests stub). */
type BuildScoreboard = typeof buildClassScoreboard;

/** The memo window (issue #4637): 10 minutes. */
export const CLASS_STATS_MEMO_MS = 10 * 60 * 1000;

/** The route body — unchanged shape (the Turn Snapshot passthrough reads it). */
interface ClassStatsBody {
  scoreboard: ClassScoreboard;
  shadow: ReturnType<typeof shadowDampener>;
  generatedAt: string;
}

/**
 * @param buildScoreboard Optional composer override (tests inject a fake that
 *   returns a canned scoreboard without a live Redis).
 * @param persist Optional snapshot writer override (tests pass a no-op).
 * @param now Optional clock override (epoch ms) for the 10-minute memo window
 *   (tests inject a controllable clock).
 */
export function createAutopilotClassStatsRouter(
  buildScoreboard: BuildScoreboard = buildClassScoreboard,
  persist: (s: ClassScoreboard) => Promise<unknown> = putClassScoreboard,
  now: () => number = Date.now,
) {
  const router = Router();

  // Closure-scoped memo (issue #4637): one per router instance, so each test's
  // factory call starts cold and the live service holds exactly one.
  let memo: { body: ClassStatsBody; computedAt: number } | null = null;
  let inflight: Promise<ClassStatsBody> | null = null;

  async function recompute(): Promise<ClassStatsBody> {
    const scoreboard = await buildScoreboard();
    const shadow = shadowDampener(scoreboard);
    // Best-effort cache write — a failure here must not fail the read.
    await persist(scoreboard).catch((err: any) => {
      logger.error(
        { routeLabel: "api/autopilot/class-stats", err },
        "[autopilot/class-stats] snapshot persist failed (non-fatal)",
      );
    });
    return {
      scoreboard,
      shadow,
      generatedAt: new Date(scoreboard.computedAt).toISOString(),
    };
  }

  function memoisedBody(): Promise<ClassStatsBody> {
    if (memo !== null && now() - memo.computedAt < CLASS_STATS_MEMO_MS) {
      return Promise.resolve(memo.body);
    }
    if (inflight === null) {
      inflight = recompute()
        .then((body) => {
          // A degraded board (failed Redis/estimator read) is never pinned for
          // 10 minutes (issue #5161): the next request recomputes.
          if (body.scoreboard.degraded !== true) {
            memo = { body, computedAt: now() };
          }
          return body;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  }

  router.get("/autopilot/class-stats", async (_req, res) =>
    // Defensive — buildClassScoreboard degrades rather than throwing, so this
    // isolation just guarantees Express never returns a bodyless 500. A
    // rejected recompute is not memoised (the next request retries).
    isolateAggregator(res, "api/autopilot/class-stats", memoisedBody),
  );

  return router;
}

/**
 * Redis-backed composer for the per-class yield scoreboard + shadow-mode dampener
 * (issue #2943, follow-on to the Outcome Attribution Spine epic #2628 and the
 * per-dispatch outcome record #2942).
 *
 * The PURE scoreboard math ({@link computeClassScoreboard}, {@link shadowDampener},
 * {@link classRole}, and the tuning constants + result types) lives in the
 * sibling zero-IO leaf `class-stats-math.ts` (extracted by #3047). This file is
 * only the side-effecting orchestration: it fans out to `listDispatchOutcomes`
 * (#2942) and `getObservations`, fits the estimator, then hands the read inputs
 * to the pure `computeClassScoreboard`. It imports DOWN from the leaf.
 *
 * `decide.py` NEVER calls this: the scoreboard is computed orchestrator-side and
 * injected into `state.json` via `collect-state.sh`; decide.py stays a pure
 * function of `state.json` (the #2943 byte-identical-dispatch invariant).
 *
 * `src/outcome-attribution/estimator.ts` and `src/redis/attribution-ledger.ts`
 * are CONSUMED read-only here — this module mutates neither.
 */

import {
  listDispatchOutcomes,
  type DispatchOutcomeRecord,
} from "../redis/dispatch-outcomes.ts";
import {
  getObservations as defaultGetObservations,
  type LoadObservationsResult,
} from "../redis/attribution-ledger.ts";
import {
  estimateMarginalEffects,
  type AttributionEstimate,
} from "../outcome-attribution/estimator.ts";
import { computeClassScoreboard, CLASS_STATS_WINDOW_MS } from "./class-stats-math.ts";
import type { ClassScoreboard } from "./class-stats-math.ts";

// ---------------------------------------------------------------------------
// Composer — the Redis reads (the API view calls this)
// ---------------------------------------------------------------------------

/** The two seam reads the composer needs (injectable for tests). */
export interface ClassScoreboardDeps {
  listRecords: (opts: { sinceMs: number }) => ReturnType<typeof listDispatchOutcomes>;
  loadObservations: () => Promise<LoadObservationsResult>;
}

const defaultDeps: ClassScoreboardDeps = {
  listRecords: listDispatchOutcomes,
  loadObservations: defaultGetObservations,
};

/**
 * Read the per-dispatch records + spine observations and compute the scoreboard.
 * Best-effort: a Redis-read failure degrades to an EMPTY input (every class
 * reports `insufficient-sample`) rather than throwing — the read-only view and
 * the shadow path must never wedge the autopilot turn. Never throws.
 *
 * @param opts.now Decision clock (epoch ms). Defaults to `Date.now()`.
 * @param opts.deps Seam-read overrides (tests inject fakes).
 */
export async function buildClassScoreboard(
  opts: {
    now?: number;
    minSample?: number;
    windowMs?: number;
    deps?: ClassScoreboardDeps;
  } = {},
): Promise<ClassScoreboard> {
  const now = opts.now ?? Date.now();
  const windowMs = opts.windowMs ?? CLASS_STATS_WINDOW_MS;
  const deps = opts.deps ?? defaultDeps;

  let records: DispatchOutcomeRecord[] = [];
  try {
    const listed = await deps.listRecords({ sinceMs: now - windowMs });
    if (listed.ok === true) records = listed.records;
    else {
      console.error(`[class-stats] listDispatchOutcomes failed: ${listed.error}`);
    }
  } catch (err: any) {
    /* intentional: a read failure degrades to an empty scoreboard (all
       insufficient-sample), never throws — the shadow path must not wedge. */
    console.error(
      `[class-stats] listDispatchOutcomes threw: ${err?.message || String(err)}`,
    );
  }

  let estimate: AttributionEstimate = { metrics: [] };
  try {
    const loaded = await deps.loadObservations();
    if (loaded.ok === true) estimate = estimateMarginalEffects(loaded.observations);
    else {
      console.error(`[class-stats] getObservations failed: ${loaded.error}`);
    }
  } catch (err: any) {
    /* intentional: an estimator/read failure degrades to no β (producer classes
       fall to insufficient-sample), never throws. */
    console.error(
      `[class-stats] estimate threw: ${err?.message || String(err)}`,
    );
  }

  return computeClassScoreboard(records, estimate, {
    now,
    minSample: opts.minSample,
    windowMs,
  });
}

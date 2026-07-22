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
} from "../outcome-attribution/index.ts";
import { computeClassScoreboard, CLASS_STATS_WINDOW_MS } from "./class-stats-math.ts";
import type { ClassScoreboard, WeightedQuotaInputs } from "./class-stats-math.ts";
import { DISPATCH_CLASSES } from "../taxonomy/classes.ts";
// The Cost module seam for the Weighted-Quota Cost Axis (issue #3548). This
// composer is ALREADY the I/O tier (it reads `listDispatchOutcomes` +
// `getObservations`), so adding the 60s-cached `getUsage()` read here — NOT in
// the pure leaf — preserves the leaf's zero-IO contract. `getUsage` runs the
// cached `assembleSnapshot`; the eligibility route already calls it every turn,
// so the transcript scan is amortized per turn. The env-config readers resolve
// the SAME calibration gate `assembleSnapshot` uses, so the scoreboard's weights
// match `/api/usage` exactly (one calibration surface, two consumers).
import {
  getUsage,
  getCacheReadWeight,
  getQuotaWeightOpus,
  getQuotaWeightSonnet,
  getQuotaWeightHaiku,
  type UsageSnapshot,
} from "../cost/index.ts";

// ---------------------------------------------------------------------------
// Composer — the Redis reads (the API view calls this)
// ---------------------------------------------------------------------------

/** The seam reads the composer needs (injectable for tests). */
export interface ClassScoreboardDeps {
  listRecords: (opts: { sinceMs: number }) => ReturnType<typeof listDispatchOutcomes>;
  loadObservations: () => Promise<LoadObservationsResult>;
  /**
   * Reads the 60s-cached usage snapshot for the Weighted-Quota Cost Axis (issue
   * #3548). Defaults to the Cost module's `getUsage()`. Injected by tests to pin
   * `bySkillByModel` (or to assert the degrade-to-null path on a read failure)
   * without a live transcript scan.
   */
  loadUsage: () => Promise<UsageSnapshot>;
}

const defaultDeps: ClassScoreboardDeps = {
  listRecords: listDispatchOutcomes,
  loadObservations: defaultGetObservations,
  loadUsage: getUsage,
};

/**
 * Resolve the Weighted-Quota Cost Axis inputs (issue #3548) from the cached usage
 * snapshot. Maps each dispatch-class name → its taxonomy skill and pulls that
 * skill's per-family breakdown out of `snapshot.bySkillByModel`; a class whose
 * skill produced zero in-window tokens is simply ABSENT from `byClassBreakdown`
 * (→ its `weightedQuota` is null, never a fabricated 0). Applies the IDENTICAL
 * `quotaWeightCalibrated` gate the usage snapshot uses — env weights when all
 * three are positive, else `{opus:1,sonnet:1,haiku:1}` identity — so the
 * scoreboard weights burn exactly like `/api/usage`. Pure over the snapshot +
 * the resolved env scalars; no I/O of its own.
 */
function resolveWeightedQuotaInputs(snapshot: UsageSnapshot): WeightedQuotaInputs {
  const byClassBreakdown: WeightedQuotaInputs["byClassBreakdown"] = {};
  for (const row of DISPATCH_CLASSES) {
    const breakdown = snapshot.bySkillByModel[row.skill];
    // Only classes whose skill produced in-window tokens carry a breakdown;
    // absent → weightedQuota null downstream (never a fabricated 0).
    if (breakdown !== undefined) byClassBreakdown[row.name] = breakdown;
  }
  const weights = {
    opus: getQuotaWeightOpus(),
    sonnet: getQuotaWeightSonnet(),
    haiku: getQuotaWeightHaiku(),
  };
  // SAME calibration gate as snapshot-assembly.ts:641/657 — one calibration
  // surface, two consumers. In prod today these env vars are unset, so the model
  // axis is dormant (identity weights) while the cacheRead axis stays active.
  const quotaWeightCalibrated = weights.opus > 0 && weights.sonnet > 0 && weights.haiku > 0;
  const burnWeights = quotaWeightCalibrated ? weights : { opus: 1, sonnet: 1, haiku: 1 };
  return {
    byClassBreakdown,
    cacheReadWeight: getCacheReadWeight(),
    burnWeights,
  };
}

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

  // Weighted-Quota Cost Axis inputs (issue #3548). Best-effort: a usage-read
  // failure degrades `weightedQuota` to null on EVERY class (empty
  // `byClassBreakdown` → breakdown absent → null) while PRESERVING the yield
  // verdict each class already has — the axis never throws and never fabricates a
  // cost number from absent data (mirrors the empty-scoreboard degradation on a
  // Redis-read failure above). We always inject inputs (never `undefined`), so a
  // failure yields explicit `null`s rather than an absent field.
  let weightedQuota: WeightedQuotaInputs = {
    byClassBreakdown: {},
    cacheReadWeight: getCacheReadWeight(),
    burnWeights: { opus: 1, sonnet: 1, haiku: 1 },
  };
  try {
    const snapshot = await deps.loadUsage();
    weightedQuota = resolveWeightedQuotaInputs(snapshot);
  } catch (err: any) {
    /* intentional: a usage-read failure degrades weightedQuota to null on every
       class (empty breakdown), never throws — the yield axis is untouched. */
    console.error(
      `[class-stats] getUsage threw (weightedQuota degrades to null): ${err?.message || String(err)}`,
    );
  }

  return computeClassScoreboard(records, estimate, {
    now,
    minSample: opts.minSample,
    windowMs,
    weightedQuota,
  });
}

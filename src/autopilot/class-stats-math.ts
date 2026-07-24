/**
 * Pure scoreboard math for the per-class yield scoreboard + shadow-mode dampener
 * (issue #2943, follow-on to the Outcome Attribution Spine epic #2628 and the
 * per-dispatch outcome record #2942). Extracted into this zero-IO leaf by the
 * architecture-scan deepening #3047 (mirrors the metrics/trend.ts extraction
 * #3038 and the pattern-store.ts extraction #2987).
 *
 * # What this closes
 *
 * `decide.py` is stateless for LEARNING: it re-decides every run from cooldowns
 * + current candidate scores and never reads how a class has actually PERFORMED
 * across runs. A class that has empirically merged nothing for a week still
 * dispatches on cadence. This module computes the cross-run signal that a future
 * live mode could use to down-weight an unproductive class — but v1 actuates
 * NOTHING (see the shadow-mode contract below).
 *
 * # Two hazards this design is shaped around (grill 2026-07-06)
 *
 *   1. **Merge-rate is a Goodhart trap.** research / discover / scout / retro are
 *      DESIGNED to have ~0 direct merge rate — they produce issues/knowledge, not
 *      PRs. Suppressing "low-merge" classes would starve the funnel that feeds the
 *      high-merge dev classes. So the scoreboard uses a **class-appropriate yield
 *      metric**, never raw merge-rate: dev classes are scored on merged-PR rate +
 *      tokens-per-merge; producer classes are scored on the spine's
 *      downstream-merge attribution (the estimator's marginal effect β_c), NEVER
 *      merges of their own.
 *
 *   2. **Actuating on an unvalidated + self-concealing signal is dangerous.** A
 *      wrongly-suppressed class stops running, so it produces no fresh evidence it
 *      was suppressed in error — the failure hides itself. So v1 runs in **shadow
 *      mode**: it computes the cadence multiplier it WOULD apply and logs it, and
 *      changes NO dispatch behavior. The flip to live is a separate, explicit
 *      acceptance gate (documented in the issue; NOT in this change).
 *
 * # Purity + seam boundary
 *
 * Everything in this leaf ({@link computeClassScoreboard}, {@link shadowDampener},
 * {@link classRole}, and the tuning constants) is PURE — deterministic functions
 * of already-read inputs, no I/O, never throws. The Redis reads live in the
 * sibling composer `class-stats.ts` (`buildClassScoreboard`), which imports DOWN
 * from this leaf. `decide.py` NEVER calls any of this: the scoreboard is computed
 * orchestrator-side and injected into `state.json` via `collect-state.sh`;
 * decide.py stays a pure function of `state.json` (the #2943 byte-identical-
 * dispatch invariant).
 *
 * `src/outcome-attribution/estimator.ts` is CONSUMED read-only here (only its
 * `AttributionEstimate` type + the identifiability flags on its effects).
 */

import type { DispatchOutcomeRecord } from "../redis/dispatch-outcomes.ts";
import type { AttributionEstimate } from "../outcome-attribution/index.ts";
import { bucketCycleStatus } from "./cycle-status.ts";
import { DISPATCH_CLASSES } from "../taxonomy/classes.ts";
// The Cost module's shipped weighted-quota fold + its per-family breakdown types
// (issue #3548). This leaf REUSES `weightedQuotaBurn` — the same fold backing
// `/api/usage`'s `weightedBurn7d` — so the scoreboard's Weighted-Quota Cost Axis
// carries ONE weighting definition, never a second divergent formula (CONTEXT.md
// single-definition-of-Quota-Weight rule). The fold is a pure Σ over already-read
// scalars, so calling it adds no I/O: the leaf stays a zero-IO deterministic
// function of its args. The per-class breakdown + resolved weights are PASSED IN
// by the composer, exactly as `records`/`estimate`/`now` already are.
import { weightedQuotaBurn } from "../cost/index.ts";
import type { ModelFamily, TokenBreakdown } from "../cost/token-math.ts";

// ---------------------------------------------------------------------------
// Tunables (named constants, not magic literals — mirrors the estimator's
// env-overridable discipline; these govern the scoreboard verdict + dampener).
// ---------------------------------------------------------------------------

/** Rolling scoring window: 7 days (the issue's fixed window). */
export const CLASS_STATS_WINDOW_MS = 7 * 24 * 3600 * 1000;

/**
 * Min-sample floor: a class needs at least this many in-window dispatches before
 * ANY verdict is emitted. Below it the class reports `insufficient-sample` and
 * its dampener multiplier is forced to 1.0 (null-vs-zero discipline: "not enough
 * data" is never collapsed into "no effect"). The issue specifies ~8.
 */
export const CLASS_STATS_MIN_SAMPLE = 8;

/**
 * Dampener bounds — the SOFT, NEVER-ZERO multiplier a future live mode would
 * apply to a class's cooldown. `1.0` = no change; the ceiling is a bounded
 * slow-down (2x cooldown), never a hard suppression. A dampened class still
 * runs, just less often — so it keeps producing the fresh evidence that a
 * suppression was warranted (the self-concealing-failure hazard).
 */
export const DAMPENER_MIN_MULTIPLIER = 1.0;
export const DAMPENER_MAX_MULTIPLIER = 2.0;

/**
 * Re-probe interval: a dampener a future live mode applies is TIME-BOXED — after
 * this many hours it is lifted back to 1.0 so the class re-probes at full cadence
 * and produces fresh evidence, regardless of the still-stale scoreboard. Encoded
 * + tested here even though inert in v1 (the issue's soft+time-boxed AC).
 */
const DAMPENER_REPROBE_HOURS = 24;

/**
 * Yield thresholds that would (in a future live mode) mark a class
 * under-performing enough to dampen. Dev: a merged-PR rate at/below this is a
 * weak class. Producer: a spine β at/below this (a non-positive marginal effect)
 * is a weak class. These are DELIBERATELY conservative — v1 never acts on them.
 */
export const DEV_WEAK_MERGE_RATE = 0.1;
const PRODUCER_WEAK_BETA = 0;

/**
 * Read a non-negative finite number from `process.env`, else the fallback.
 * Mirrors the estimator's `numFromEnv` discipline (`estimator.ts`): the read
 * happens ONCE at module load to seed a `const`, so the pure per-call functions
 * still do NO I/O — they close over an already-resolved scalar, exactly as
 * {@link DEV_WEAK_MERGE_RATE} is a resolved literal.
 */
function numFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Weighted-quota-per-merge (issue #3550) at/above which a dev class that has an
 * otherwise-**healthy** merge rate is marked `cost-ineffective` instead of
 * `healthy` — the Weighted-Quota Cost Axis (issue #3548) verdict. This surfaces
 * an Opus-over-huge-context dev class that ships PRs but at an extreme
 * subscription cost per shipped PR.
 *
 * DELIBERATELY conservative + env-tunable (`HYDRA_CLASS_STATS_WEAK_COST_PER_MERGE`),
 * mirroring {@link DEV_WEAK_MERGE_RATE}'s named-constant discipline — never a
 * magic literal. The default (2M weighted tokens per merge) sits far above a
 * normal dev merge's weighted cost, so with today's dormant identity burn
 * weights it fires only for a genuinely extreme class.
 *
 * STRICTLY reporting-only: this verdict changes what the scoreboard REPORTS,
 * never what {@link shadowDampener} actuates — a `cost-ineffective` class keeps
 * the `1.0` multiplier of a healthy class (the #2943 byte-identical-dispatch
 * invariant). Only `underperforming` dampens.
 */
export const DEV_WEAK_COST_PER_MERGE = numFromEnv(
  "HYDRA_CLASS_STATS_WEAK_COST_PER_MERGE",
  2_000_000,
);

// ---------------------------------------------------------------------------
// Class role — which yield metric is appropriate for a given class
// ---------------------------------------------------------------------------

/**
 * The yield-metric family a class is scored under:
 *
 *   - `dev`      — code-writing classes that open PRs (dev_orch / dev_target).
 *                  Scored on merged-PR rate + tokens-per-merge (the direct
 *                  outcome the class is designed to produce).
 *   - `producer` — issue/knowledge producers (research / discover / scout /
 *                  retro / architecture / cleanup). ~0 direct merge rate BY
 *                  DESIGN, so scored on the spine's downstream-merge attribution
 *                  (the estimator β_c), NEVER merges of their own.
 *   - `other`    — everything else (qa, health, sweep, design-concept, …): no
 *                  class-appropriate yield defined, so never dampened. Reported
 *                  for completeness with `verdict: "not-scored"`.
 */
export type ClassRole = "dev" | "producer" | "other";

/**
 * Dev classes are exactly the taxonomy rows whose `learningAgent` is `executor`
 * (they open PRs; their verification failures train the executor memory).
 */
const DEV_CLASS_NAMES: ReadonlySet<string> = new Set(
  DISPATCH_CLASSES.filter((r) => r.learningAgent === "executor").map((r) => r.name),
);

/**
 * Producer classes are the issue/knowledge FILERS: the research / cleanup / retro
 * cost-family classes that stamp findings rather than open PRs. Derived from the
 * taxonomy `costClass` column so adding a producer class picks it up
 * automatically. `qa` and `other`-cost classes are excluded — they are neither
 * dev nor producer.
 */
const PRODUCER_COST_CLASSES: ReadonlySet<string> = new Set([
  "research",
  "cleanup",
  "retro",
]);

const PRODUCER_CLASS_NAMES: ReadonlySet<string> = new Set(
  DISPATCH_CLASSES.filter((r) => PRODUCER_COST_CLASSES.has(r.costClass)).map(
    (r) => r.name,
  ),
);

/** Classify a class name into its yield-metric role. Unknown → `other`. */
export function classRole(className: string): ClassRole {
  if (DEV_CLASS_NAMES.has(className)) return "dev";
  if (PRODUCER_CLASS_NAMES.has(className)) return "producer";
  return "other";
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** The verdict for a single class over the window. */
type ClassVerdict =
  /** Enough sample + a healthy yield — full cadence recommended. */
  | "healthy"
  /**
   * DEV role only: a healthy merge rate but an EXTREME weighted-quota cost per
   * shipped PR (`weightedQuotaPerMerge >= DEV_WEAK_COST_PER_MERGE`). The class
   * ships, so it is not `underperforming`, but it does so at a cost the
   * Weighted-Quota Cost Axis (issue #3550) flags as ineffective — an
   * Opus-over-huge-context class. STRICTLY reporting-only: this verdict never
   * dampens the class (the {@link shadowDampener} multiplier stays `1.0`, the
   * #2943 byte-identical-dispatch invariant). Only reachable when the composer
   * injected usage inputs AND a merge exists to divide by; a null/undefined
   * `weightedQuotaPerMerge` never yields this verdict (null-vs-zero discipline).
   */
  | "cost-ineffective"
  /** Enough sample but a weak yield — a future live mode would dampen. */
  | "underperforming"
  /** Below the min-sample floor — NO verdict; multiplier forced to 1.0. */
  | "insufficient-sample"
  /** A class with no class-appropriate yield metric (qa / health / …). */
  | "not-scored";

/** One row of the per-class scoreboard. */
export interface ClassStat {
  /** Dispatch-class name (`dev_orch`, `research_orch`, …). */
  className: string;
  /** Which yield-metric family this class is scored under. */
  role: ClassRole;
  /** Total in-window dispatches (records with a parseable class). */
  dispatches: number;
  /** DEV role: merged-PR count over the window. Null for non-dev roles. */
  mergedCount: number | null;
  /** DEV role: merged-PR rate (`mergedCount / dispatches`). Null otherwise. */
  mergeRate: number | null;
  /**
   * DEV role: the **output-based** cost-per-merge — total raw output tokens
   * across merged dispatches divided by mergedCount. Null when non-dev OR no
   * merges (undefined, not 0).
   *
   * IMPORTANT (issue #3549): this is the OUTPUT-BASED figure and is preserved
   * verbatim so dashboards and prior comparisons keep their meaning. It counts
   * raw tokens the class emitted, NOT the model-weighted, cacheRead-inclusive
   * subscription cost — that is the separate {@link weightedQuotaPerMerge} axis.
   * The two are never conflated: `tokensPerMerge` stays the raw-output measure,
   * `weightedQuotaPerMerge` is the true weighted-quota cost-per-shipped-PR.
   */
  tokensPerMerge: number | null;
  /**
   * DEV role: the **weighted-quota-per-merge** figure (issue #3549) — the true
   * subscription cost per shipped PR: the class's Weighted-Quota Cost Axis
   * ({@link weightedQuota}, ticket #3548) divided by {@link mergedCount}. Unlike
   * the output-based {@link tokensPerMerge}, this folds the model-family burn
   * weights + cacheRead weight, so it reflects what a merge actually COST the
   * subscription, not just how many output tokens it emitted.
   *
   * NULL-vs-ZERO discipline (invariant): `null` when `mergedCount` is 0 (or
   * null) OR when `weightedQuota` is null/undefined — "no data" / "can't divide",
   * NEVER collapsed to 0. Null for non-dev roles (only dev classes open PRs, so
   * only they have a per-merge cost). `undefined` (field absent) when the
   * composer injected no usage inputs at all — additive-field back-compat,
   * mirroring {@link weightedQuota}.
   */
  weightedQuotaPerMerge?: number | null;
  /**
   * PRODUCER role: the spine's marginal effect β_c for this class (the
   * downstream-merge attribution). Null when non-producer OR the class has no
   * identifiable β column in the estimator (the common case — see
   * `betaSuspect`). NEVER read as a verdict when `betaSuspect` is true.
   */
  beta: number | null;
  /**
   * PRODUCER role: true when the estimator flagged this class's β
   * identifiability-suspect (low-variance/collinear) OR below the noise floor,
   * OR the class had no β column at all. A suspect β is NEVER read as a
   * producer-class verdict (invariant 8): such a class stays
   * `insufficient-sample`. Null for non-producer roles.
   */
  betaSuspect: boolean | null;
  /**
   * The class's **Weighted-Quota Cost Axis** over the window (issue #3548): the
   * model-weighted, cacheRead-inclusive quota burn attributed to this class's
   * skill via `weightedQuotaBurn(bySkillByModel[skill], cacheReadWeight,
   * burnWeights)` — the SAME fold backing `/api/usage`'s `weightedBurn7d`, so the
   * scoreboard's per-class weighted-quota totals reconcile to the usage
   * snapshot's 7d weighted burn.
   *
   * NULL-vs-ZERO discipline (invariant): `null` when the usage breakdown is
   * unavailable (the composer's usage read failed / was absent) OR when the class
   * is below the min-sample floor — "no data", NEVER collapsed to 0. A genuine
   * computed 0 (a class that cleared the floor but whose skill truly burned zero
   * weighted tokens in-window) is legitimate but practically unreachable, never
   * fabricated. `undefined` (field absent) when the composer injected no usage
   * inputs at all — additive-field back-compat for callers that never pass them.
   */
  weightedQuota?: number | null;
  /** The verdict for this class. */
  verdict: ClassVerdict;
}

/**
 * The Weighted-Quota Cost Axis inputs the composer injects into the pure leaf
 * (issue #3548). Mirrors the injection discipline of `records`/`estimate`/`now`:
 * the leaf reads NO Redis / `getUsage()` / `process.env` — the composer resolves
 * these from the 60s-cached usage snapshot + the env-derived weights and passes
 * the already-computed values in.
 */
export interface WeightedQuotaInputs {
  /**
   * Per-class cacheRead-inclusive per-family token breakdown over the window,
   * keyed by dispatch-class name. The composer builds this by mapping each
   * `className → skill` (via the taxonomy) and reading `snapshot.bySkillByModel[skill]`.
   * A class whose skill produced zero in-window tokens is simply ABSENT from this
   * map → its `weightedQuota` is `null` (never a fabricated 0).
   */
  byClassBreakdown: Record<string, Record<ModelFamily, TokenBreakdown>>;
  /** Axis A: the resolved cacheRead weight (`getCacheReadWeight()`, default 1.0). */
  cacheReadWeight: number;
  /**
   * Axis B: the resolved per-model-family burn weights. The composer applies the
   * SAME calibration gate the usage snapshot uses (`quotaWeightCalibrated`
   * ? env weights : `{opus:1,sonnet:1,haiku:1}` identity) so the axis matches
   * `/api/usage` exactly — dormant identity weights in prod today.
   */
  burnWeights: { opus: number; sonnet: number; haiku: number };
}

/** The full rolling scoreboard. */
export interface ClassScoreboard {
  /** Rolling window width in ms (CLASS_STATS_WINDOW_MS). */
  windowMs: number;
  /** Epoch ms the scoreboard was computed for (window is `[now-windowMs, now]`). */
  computedAt: number;
  /** Min-sample floor applied (CLASS_STATS_MIN_SAMPLE). */
  minSample: number;
  /** One row per dispatch class, in taxonomy (dispatch) order. */
  classes: ClassStat[];
}

/**
 * The shadow-mode dampener verdict for one class: the cadence multiplier a
 * future live mode WOULD apply, plus the re-probe deadline. In v1 this is
 * LOGGED and never applied (the byte-identical-dispatch invariant).
 */
interface ShadowDampenerVerdict {
  className: string;
  /**
   * The cadence multiplier that WOULD be applied to this class's cooldown.
   * Always in `[DAMPENER_MIN_MULTIPLIER, DAMPENER_MAX_MULTIPLIER]`; `1.0` means
   * "no change" (healthy / insufficient-sample / not-scored). NEVER zero.
   */
  multiplier: number;
  /**
   * Epoch ms after which a live mode would lift this dampener back to 1.0 and
   * re-probe at full cadence. `null` when `multiplier === 1.0` (nothing to lift).
   */
  reprobeAt: number | null;
  /** The verdict that produced this multiplier (for the shadow log). */
  verdict: ClassVerdict;
}

/** The full shadow-mode plan: per-class multipliers a live mode would apply. */
export interface ShadowDampenerPlan {
  computedAt: number;
  reprobeHours: number;
  verdicts: ShadowDampenerVerdict[];
}

// ---------------------------------------------------------------------------
// Pure scoring core
// ---------------------------------------------------------------------------

/**
 * Extract the estimator's marginal effect β_c for a producer class, respecting
 * the identifiability + noise-floor flags. Returns `{beta, suspect}`:
 *
 *   - `beta` is the class's effect on the metric with the largest |β| for that
 *     class (its strongest attributed signal), or null when the class appears in
 *     NO metric's design matrix.
 *   - `suspect` is true when that β is identifiability-suspect OR below the noise
 *     floor OR absent. A suspect β must NEVER be read as a verdict (invariant 8).
 *
 * Pure — reads the already-computed estimate, no I/O.
 */
function producerBeta(
  className: string,
  estimate: AttributionEstimate,
): { beta: number | null; suspect: boolean } {
  let best: { beta: number; suspect: boolean } | null = null;
  for (const metric of estimate.metrics) {
    for (const eff of metric.effects) {
      if (eff.producerClass !== className) continue;
      const suspect = eff.identifiabilitySuspect || eff.belowNoiseFloor;
      if (best === null || Math.abs(eff.beta) > Math.abs(best.beta)) {
        best = { beta: eff.beta, suspect };
      }
    }
  }
  // Absent column → no identifiable effect → suspect (cannot tell), null beta.
  if (best === null) return { beta: null, suspect: true };
  return best;
}

/**
 * Compute the per-class yield scoreboard from already-read inputs. PURE — no
 * I/O, never throws, deterministic in `now`.
 *
 * @param records  Per-dispatch outcome records over (at least) the window.
 *   Records outside `[now-windowMs, now]` are filtered out here.
 * @param estimate The spine's ridge estimate (producer-class β_c). Consumed
 *   read-only; the identifiability flags are respected.
 * @param opts.now Decision clock (epoch ms). Injected for deterministic tests.
 * @param opts.minSample Override the min-sample floor (tests).
 * @param opts.windowMs Override the window width (tests).
 * @param opts.weightedQuota Optional Weighted-Quota Cost Axis inputs (issue
 *   #3548). When present, each in-window class that cleared the min-sample floor
 *   AND has a per-family breakdown gets its `weightedQuota` computed via the
 *   reused Cost fold. When ABSENT the field is left `undefined` on every row
 *   (additive back-compat); a class below the floor / with no breakdown gets
 *   `null` (never a fabricated 0). For DEV rows this also derives
 *   `weightedQuotaPerMerge` = `weightedQuota / mergedCount` (issue #3549) — the
 *   true subscription cost per shipped PR, distinct from the output-based
 *   `tokensPerMerge`; `null` when there are no merges or `weightedQuota` is null.
 */
export function computeClassScoreboard(
  records: DispatchOutcomeRecord[],
  estimate: AttributionEstimate,
  opts: {
    now: number;
    minSample?: number;
    windowMs?: number;
    weightedQuota?: WeightedQuotaInputs;
  },
): ClassScoreboard {
  const now = opts.now;
  const minSample = opts.minSample ?? CLASS_STATS_MIN_SAMPLE;
  const windowMs = opts.windowMs ?? CLASS_STATS_WINDOW_MS;
  const since = now - windowMs;
  const wq = opts.weightedQuota;

  /**
   * The per-class Weighted-Quota value for a row, respecting null-vs-zero:
   *   - `undefined` when the composer injected no usage inputs (`wq` absent) —
   *     the field stays off the row entirely (additive back-compat).
   *   - `null` when the class is below the min-sample floor (`cleared` false) OR
   *     the usage breakdown has no entry for this class ("no data", never 0).
   *   - otherwise the reused `weightedQuotaBurn` fold over the class's breakdown.
   */
  const weightedQuotaFor = (
    className: string,
    cleared: boolean,
  ): number | null | undefined => {
    if (wq === undefined) return undefined;
    if (!cleared) return null;
    const byModel = wq.byClassBreakdown[className];
    if (byModel === undefined) return null;
    return weightedQuotaBurn(byModel, wq.cacheReadWeight, wq.burnWeights);
  };

  /**
   * The per-class **weighted-quota-per-merge** value for a DEV row (issue #3549):
   * the class's Weighted-Quota Cost Axis divided by its merged-PR count. Mirrors
   * {@link weightedQuotaFor}'s null-vs-zero discipline:
   *   - `undefined` when the composer injected no usage inputs (`wq` absent) —
   *     the field stays off the row (additive back-compat).
   *   - `null` when there are no merges (`mergedCount` 0) OR the class's
   *     `weightedQuota` is null (below floor / no breakdown) — "can't divide" /
   *     "no data", NEVER a fabricated 0.
   *   - otherwise `round(weightedQuota / mergedCount)`.
   * Non-dev callers never invoke this — only dev classes open PRs.
   */
  const weightedQuotaPerMergeFor = (
    weightedQuota: number | null | undefined,
    mergedCount: number,
  ): number | null | undefined => {
    if (weightedQuota === undefined) return undefined;
    if (weightedQuota === null || mergedCount <= 0) return null;
    return Math.round(weightedQuota / mergedCount);
  };

  /**
   * Non-dev rows never have a per-merge cost (only dev classes open PRs), but
   * they still honor the additive-field back-compat: `undefined` when the
   * composer injected no usage inputs at all, else `null`.
   */
  const nonDevWeightedQuotaPerMerge = (): null | undefined =>
    wq === undefined ? undefined : null;

  // Bucket in-window records by class. A record with a null class is dropped
  // from the per-class rollup (it cannot be attributed) but never fabricated.
  type Acc = { dispatches: number; merged: number; mergedTokens: number };
  const byClass = new Map<string, Acc>();
  for (const rec of records) {
    if (rec.recordedAt < since || rec.recordedAt > now) continue;
    if (rec.className === null) continue;
    let acc = byClass.get(rec.className);
    if (!acc) {
      acc = { dispatches: 0, merged: 0, mergedTokens: 0 };
      byClass.set(rec.className, acc);
    }
    acc.dispatches += 1;
    if (bucketCycleStatus(rec.outcome) === "merged") {
      acc.merged += 1;
      if (rec.tokens !== null) acc.mergedTokens += rec.tokens;
    }
  }

  // One row per dispatch class, in taxonomy order (a class with zero in-window
  // dispatches still gets a row, so the scoreboard is complete + stable).
  const classes: ClassStat[] = DISPATCH_CLASSES.map((row) => {
    const name = row.name;
    const role = classRole(name);
    const acc = byClass.get(name) ?? { dispatches: 0, merged: 0, mergedTokens: 0 };
    const dispatches = acc.dispatches;

    if (dispatches < minSample) {
      // Below the floor → no verdict, regardless of role (null-vs-zero).
      const weightedQuota = weightedQuotaFor(name, false);
      return {
        className: name,
        role,
        dispatches,
        mergedCount: role === "dev" ? acc.merged : null,
        mergeRate: null,
        tokensPerMerge: null,
        // Below-floor weightedQuota is null (or undefined when no inputs), so
        // per-merge is null (undefined when absent) — never a fabricated 0.
        weightedQuotaPerMerge:
          role === "dev"
            ? weightedQuotaPerMergeFor(weightedQuota, acc.merged)
            : weightedQuota === undefined
              ? undefined
              : null,
        beta: null,
        betaSuspect: role === "producer" ? true : null,
        weightedQuota,
        verdict: "insufficient-sample",
      };
    }

    if (role === "dev") {
      const mergeRate = acc.merged / dispatches;
      const tokensPerMerge = acc.merged > 0 ? Math.round(acc.mergedTokens / acc.merged) : null;
      const weightedQuota = weightedQuotaFor(name, true);
      const weightedQuotaPerMerge = weightedQuotaPerMergeFor(weightedQuota, acc.merged);
      // Verdict order (issue #3550):
      //   1. A weak merge rate is `underperforming` regardless of cost — the
      //      class isn't shipping, so cost-per-merge isn't even meaningful.
      //   2. A healthy merge rate BUT an extreme weighted-quota-per-merge is
      //      `cost-ineffective` — it ships, but at an extreme subscription cost
      //      per PR (the Weighted-Quota Cost Axis verdict). Only reachable when
      //      `weightedQuotaPerMerge` is a real number (composer injected usage
      //      inputs AND a merge exists); a null/undefined figure never triggers
      //      it (null-vs-zero discipline — "no data" is not "extreme cost").
      //   3. Otherwise `healthy`.
      // This is STRICTLY reporting — `shadowDampener` treats `cost-ineffective`
      // exactly like `healthy` (multiplier 1.0), preserving the #2943
      // byte-identical-dispatch invariant.
      let verdict: ClassVerdict;
      if (mergeRate <= DEV_WEAK_MERGE_RATE) {
        verdict = "underperforming";
      } else if (
        typeof weightedQuotaPerMerge === "number" &&
        weightedQuotaPerMerge >= DEV_WEAK_COST_PER_MERGE
      ) {
        verdict = "cost-ineffective";
      } else {
        verdict = "healthy";
      }
      return {
        className: name,
        role,
        dispatches,
        mergedCount: acc.merged,
        mergeRate: Math.round(mergeRate * 1000) / 1000,
        tokensPerMerge,
        weightedQuotaPerMerge,
        beta: null,
        betaSuspect: null,
        weightedQuota,
        verdict,
      };
    }

    if (role === "producer") {
      const { beta, suspect } = producerBeta(name, estimate);
      // A suspect / absent β is never read as a verdict → treat as
      // insufficient-sample even though the dispatch count cleared the floor
      // (invariant 8: "a suspect beta is never read as a producer-class verdict").
      if (suspect || beta === null) {
        return {
          className: name,
          role,
          dispatches,
          mergedCount: null,
          mergeRate: null,
          tokensPerMerge: null,
          weightedQuotaPerMerge: nonDevWeightedQuotaPerMerge(),
          beta,
          betaSuspect: true,
          weightedQuota: weightedQuotaFor(name, true),
          verdict: "insufficient-sample",
        };
      }
      const verdict: ClassVerdict =
        beta <= PRODUCER_WEAK_BETA ? "underperforming" : "healthy";
      return {
        className: name,
        role,
        dispatches,
        mergedCount: null,
        mergeRate: null,
        tokensPerMerge: null,
        weightedQuotaPerMerge: nonDevWeightedQuotaPerMerge(),
        beta: Math.round(beta * 1000) / 1000,
        betaSuspect: false,
        weightedQuota: weightedQuotaFor(name, true),
        verdict,
      };
    }

    // role === "other": no class-appropriate yield metric.
    return {
      className: name,
      role,
      dispatches,
      mergedCount: null,
      mergeRate: null,
      tokensPerMerge: null,
      weightedQuotaPerMerge: nonDevWeightedQuotaPerMerge(),
      beta: null,
      betaSuspect: null,
      weightedQuota: weightedQuotaFor(name, true),
      verdict: "not-scored",
    };
  });

  return { windowMs, computedAt: now, minSample, classes };
}

/**
 * Compute the shadow-mode dampener plan from a scoreboard. PURE — no I/O.
 *
 * The soft, never-zero, time-boxed multiplier a FUTURE live mode would apply:
 *
 *   - `underperforming` → DAMPENER_MAX_MULTIPLIER (2x cooldown), re-probe after
 *     `reprobeHours`. A dampened class still runs — just at half cadence — so it
 *     keeps producing the fresh evidence a suppression was warranted.
 *   - everything else (`healthy` / `cost-ineffective` / `insufficient-sample` /
 *     `not-scored`) → 1.0 (no change), `reprobeAt: null`. In particular
 *     `cost-ineffective` (issue #3550) is a REPORTING-only verdict: it surfaces
 *     an extreme weighted-quota-per-merge on the scoreboard but NEVER dampens —
 *     the multiplier is byte-identical to a `healthy` class, preserving the
 *     #2943 byte-identical-dispatch invariant.
 *
 * v1 NEVER applies this — it is logged by `decide.py`'s shadow path and thrown
 * away. The math is unit-tested so the flip to live is a config change, not a
 * new implementation.
 *
 * @param opts.reprobeHours Override the re-probe interval (tests).
 */
export function shadowDampener(
  scoreboard: ClassScoreboard,
  opts: { reprobeHours?: number } = {},
): ShadowDampenerPlan {
  const reprobeHours = opts.reprobeHours ?? DAMPENER_REPROBE_HOURS;
  const reprobeMs = reprobeHours * 3600 * 1000;
  const verdicts: ShadowDampenerVerdict[] = scoreboard.classes.map((stat) => {
    if (stat.verdict === "underperforming") {
      return {
        className: stat.className,
        multiplier: DAMPENER_MAX_MULTIPLIER,
        reprobeAt: scoreboard.computedAt + reprobeMs,
        verdict: stat.verdict,
      };
    }
    return {
      className: stat.className,
      multiplier: DAMPENER_MIN_MULTIPLIER,
      reprobeAt: null,
      verdict: stat.verdict,
    };
  });
  return { computedAt: scoreboard.computedAt, reprobeHours, verdicts };
}

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
   * DEV role: total tokens across merged dispatches divided by mergedCount —
   * "cost per merge". Null when non-dev OR no merges (undefined, not 0).
   */
  tokensPerMerge: number | null;
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
  /** The verdict for this class. */
  verdict: ClassVerdict;
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
 */
export function computeClassScoreboard(
  records: DispatchOutcomeRecord[],
  estimate: AttributionEstimate,
  opts: { now: number; minSample?: number; windowMs?: number },
): ClassScoreboard {
  const now = opts.now;
  const minSample = opts.minSample ?? CLASS_STATS_MIN_SAMPLE;
  const windowMs = opts.windowMs ?? CLASS_STATS_WINDOW_MS;
  const since = now - windowMs;

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
      return {
        className: name,
        role,
        dispatches,
        mergedCount: role === "dev" ? acc.merged : null,
        mergeRate: null,
        tokensPerMerge: null,
        beta: null,
        betaSuspect: role === "producer" ? true : null,
        verdict: "insufficient-sample",
      };
    }

    if (role === "dev") {
      const mergeRate = acc.merged / dispatches;
      const tokensPerMerge = acc.merged > 0 ? Math.round(acc.mergedTokens / acc.merged) : null;
      const verdict: ClassVerdict =
        mergeRate <= DEV_WEAK_MERGE_RATE ? "underperforming" : "healthy";
      return {
        className: name,
        role,
        dispatches,
        mergedCount: acc.merged,
        mergeRate: Math.round(mergeRate * 1000) / 1000,
        tokensPerMerge,
        beta: null,
        betaSuspect: null,
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
          beta,
          betaSuspect: true,
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
        beta: Math.round(beta * 1000) / 1000,
        betaSuspect: false,
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
      beta: null,
      betaSuspect: null,
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
 *   - everything else (`healthy` / `insufficient-sample` / `not-scored`) → 1.0
 *     (no change), `reprobeAt: null`.
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

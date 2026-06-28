/**
 * Outcome Regression Policy (issue #2507; originally folded into
 * `src/holdback.ts` in #2380, first extracted from `src/outcomes.ts` in #2095).
 *
 * This module owns the *pure* Outcome Holdback regression policy: sampling the
 * leading outcomes, comparing a fresh snapshot against a baseline, deciding
 * "did this outcome regress?", and the bus-free / Redis-free
 * {@link decideHoldback} decision. It sits ON TOP of the loader: it imports
 * `loadOutcomes` and `getOutcomeValue` from `src/outcomes.ts` (the loader/
 * adapter Module) and adds the comparison policy. The pure helpers
 * (`detectRegressions`, `isOutcomeRegressed`, `decideHoldback`) take plain
 * arrays / structs — no filesystem, no YAML, no adapter switching, no event
 * bus, no Redis — so the holdback policy is testable in isolation.
 *
 * It deliberately carries only a **type-only** import of `HoldbackBaseline`
 * from `src/redis/holdback.ts`, so this module has ZERO Redis import-time side
 * effect: importing it never opens a connection. The Redis-touching coordinator
 * half (`enrollHoldback`, `checkHoldback`, `reportRevertFailed`, the
 * `HoldbackEventBus`) lives in the sibling `src/holdback.ts`, which imports the
 * policy from here.
 *
 * Invariant: only `kind: leading` outcomes ever drive a holdback decision.
 * Terminal outcomes are too slow for any watch window (outcomes.yaml schema
 * comment + CONTEXT.md) and are filtered out here so a caller cannot
 * accidentally watch one.
 *
 * Per CLAUDE.md conventions:
 *   - Never throws: a failed load yields an empty snapshot (logged by
 *     `loadOutcomes`); the pure helpers return `false`/`[]` on no-data.
 *   - Adapter outages surface as `value: null` — never a synthetic 0 — so a
 *     missing reading is treated as no-data, never a false regression.
 */

import {
  loadOutcomes,
  getOutcomeValue,
  DEFAULT_OUTCOMES_FILE,
  type OutcomeDirection,
} from "./outcomes.ts";
import {
  HOLDBACK_MAX_REVERTS_PER_DAY,
  type HoldbackBaseline,
} from "./redis/holdback.ts";

// ---------------------------------------------------------------------------
// Snapshot + regression detection
// ---------------------------------------------------------------------------

/** One leading-outcome sample: the outcome's contract fields + current value. */
export interface LeadingOutcomeSample {
  name: string;
  direction: OutcomeDirection;
  /** Absolute change below this is treated as no-move. */
  noiseEpsilon: number;
  /** Current value, or null if the adapter returned no data (no-data, not 0). */
  value: number | null;
}

/**
 * Snapshot the current value of every `kind: leading` outcome.
 *
 * Returns one sample per leading outcome (terminal outcomes are excluded).
 * Adapter outages surface as `value: null` — never as a synthetic 0 — so the
 * regression detector can treat them as no-data rather than a false regression.
 * Never throws: a failed load yields an empty array (logged by `loadOutcomes`).
 */
export async function snapshotLeadingOutcomes(
  filePath: string = DEFAULT_OUTCOMES_FILE,
): Promise<LeadingOutcomeSample[]> {
  const result = await loadOutcomes(filePath);
  if (result.ok === false) return [];
  const leading = result.outcomes.filter((o) => o.kind === "leading");
  return Promise.all(
    leading.map(async (o) => {
      const reading = await getOutcomeValue(o);
      return {
        name: o.name,
        direction: o.direction,
        noiseEpsilon: o.noise_epsilon,
        value: reading?.value ?? null,
      };
    }),
  );
}

/**
 * Decide whether a single leading outcome has regressed vs its baseline.
 *
 * A regression is a move in the UNFAVORABLE direction (opposite `direction`)
 * whose magnitude EXCEEDS `noiseEpsilon`. A favorable move, a no-move (delta
 * ≤ epsilon), or missing data on either side is NOT a regression.
 *
 *   direction: "up"   → regressed when current < baseline by more than epsilon
 *   direction: "down" → regressed when current > baseline by more than epsilon
 *
 * Returns `false` (no regression) when either value is null — adapter outages
 * are no-data, never a synthetic regression (matches the historical watcher's
 * "no false revert" posture, docs/reference.md).
 */
export function isOutcomeRegressed(
  baselineValue: number | null,
  currentValue: number | null,
  direction: OutcomeDirection,
  noiseEpsilon: number,
): boolean {
  if (baselineValue == null || currentValue == null) return false;
  if (!Number.isFinite(baselineValue) || !Number.isFinite(currentValue)) return false;
  const eps = Number.isFinite(noiseEpsilon) ? Math.abs(noiseEpsilon) : 0;
  // Favorable delta is positive when moving the favorable way.
  const favorableDelta = direction === "up"
    ? currentValue - baselineValue
    : baselineValue - currentValue;
  // Regressed = moved unfavorably by MORE than epsilon.
  return favorableDelta < -eps;
}

/** A leading outcome that regressed past its noise epsilon vs baseline. */
export interface OutcomeRegression {
  name: string;
  baseline: number;
  current: number;
  direction: OutcomeDirection;
  noiseEpsilon: number;
}

/**
 * Compare a baseline snapshot against a current snapshot and return the leading
 * outcomes that regressed past their noise epsilon. The two arrays are matched
 * by outcome `name`; an outcome present in one but not the other, or with null
 * data on either side, is skipped (no-data, not a regression).
 *
 * Pure function — no I/O — so the producer (and its tests) can reason about the
 * revert decision deterministically.
 */
export function detectRegressions(
  baseline: Array<{ name: string; direction: OutcomeDirection; noiseEpsilon: number; value: number | null }>,
  current: Array<{ name: string; value: number | null }>,
): OutcomeRegression[] {
  const currentByName = new Map(current.map((c) => [c.name, c.value]));
  const regressions: OutcomeRegression[] = [];
  for (const b of baseline) {
    const cur = currentByName.has(b.name) ? currentByName.get(b.name)! : null;
    if (isOutcomeRegressed(b.value, cur, b.direction, b.noiseEpsilon)) {
      regressions.push({
        name: b.name,
        baseline: b.value as number,
        current: cur as number,
        direction: b.direction,
        noiseEpsilon: b.noiseEpsilon,
      });
    }
  }
  return regressions;
}

// ---------------------------------------------------------------------------
// Pure holdback decision
// ---------------------------------------------------------------------------

/**
 * The {@link CheckDecision} the pure {@link decideHoldback} can emit. The
 * `no-enrollment` arm lives on {@link import("./holdback.ts")}'s public
 * `CheckDecision` only — a missing baseline is handled by the coordinator
 * before it has anything to decide over — so it is intentionally NOT part of
 * this pure-policy union.
 */
export type HoldbackPolicyDecision =
  /** Window completed clean — caller clears the baseline, no revert. */
  | { decision: "passed"; commitSha: string }
  /** No regression yet; keep watching. */
  | { decision: "watching"; commitSha: string }
  /** Cap reached — revert SUPPRESSED; caller emits `holdback.cap-reached`. */
  | { decision: "cap-reached"; commitSha: string; regressedOutcomes: string[] }
  /** Revert WARRANTED — caller emits `holdback.reverted` and performs the revert. */
  | { decision: "revert"; commitSha: string; prNumber: number | null; regressedOutcomes: string[] };

/**
 * Inputs to the pure {@link decideHoldback} regression decision.
 *
 * Everything the coordinator `checkHoldback` reads from Redis / the clock / the
 * outcome adapter is hoisted into this struct so the decision is a
 * deterministic function of plain in-memory values — no bus, no Redis, no
 * filesystem.
 */
export interface DecideHoldbackInput {
  /** The persisted pre-merge baseline being evaluated. */
  baseline: HoldbackBaseline;
  /**
   * Freshly sampled leading-outcome values to compare against the baseline.
   * Only `{ name, value }` is consulted (by {@link detectRegressions}); the
   * direction/epsilon come from the enrolled baseline, so the full
   * {@link LeadingOutcomeSample} (which `snapshotLeadingOutcomes` returns) is
   * accepted but only its `name`/`value` matter.
   */
  current: Array<{ name: string; value: number | null }>;
  /** Today's revert count (against the per-day cap), read before deciding. */
  revertCount: number;
  /** Epoch millis "now" — defaults to {@link Date.now}; injectable for tests. */
  nowMs?: number;
}

/**
 * The pure Outcome Holdback regression decision (issue #2096).
 *
 * Given an enrolled baseline, a fresh outcome snapshot, and today's revert
 * count, decide what should happen — with NO side effects: no event-bus
 * publish, no Redis write, no clock read beyond the injectable `nowMs`. The
 * returned {@link HoldbackPolicyDecision} discriminant is the single source of
 * truth for which side effects the coordinator `checkHoldback` then applies:
 *
 *   - `revert`      → caller increments the day's revert count, clears the
 *                     baseline, and publishes `holdback.reverted`.
 *   - `cap-reached` → caller publishes `holdback.cap-reached` (revert
 *                     suppressed; baseline left intact for the next sample).
 *   - `passed`      → caller clears the baseline (probation complete).
 *   - `watching`    → caller does nothing (keep watching).
 *
 * Tests for the branching logic ("cap reached", "window elapsed", "regression
 * but not yet capped") pass plain arguments — they no longer need a stubbed
 * `HoldbackEventBus` or a Redis fixture. The `no-enrollment` decision is NOT
 * produced here: a missing baseline is handled by the coordinator before it
 * has anything to decide over.
 */
export function decideHoldback(input: DecideHoldbackInput): HoldbackPolicyDecision {
  const { baseline, current, revertCount } = input;
  const nowMs = input.nowMs ?? Date.now();

  const regressions = detectRegressions(baseline.leading, current);

  if (regressions.length === 0) {
    // No regression. If the window has elapsed, the merge passed probation.
    const windowMs = baseline.windowCycles * cycleDurationMs();
    const elapsed = nowMs - baseline.enrolledAt >= windowMs;
    if (elapsed) {
      return { decision: "passed", commitSha: baseline.commitSha };
    }
    return { decision: "watching", commitSha: baseline.commitSha };
  }

  const regressedOutcomes = regressions.map((r) => r.name);

  // Enforce the per-day cap BEFORE reverting (ADR-0004 step 4).
  if (revertCount >= HOLDBACK_MAX_REVERTS_PER_DAY) {
    return { decision: "cap-reached", commitSha: baseline.commitSha, regressedOutcomes };
  }

  // Revert warranted.
  return {
    decision: "revert",
    commitSha: baseline.commitSha,
    prNumber: baseline.prNumber,
    regressedOutcomes,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Approximate real time per autopilot cycle, used to decide when a watch
 * window has elapsed. Env-overridable (ADR-0005) so operators can tune the
 * window→wall-clock mapping without code edits. Defaults to 1h/cycle.
 *
 * Called only by {@link decideHoldback}, so it moves with it.
 */
function cycleDurationMs(): number {
  const raw = process.env.HYDRA_HOLDBACK_CYCLE_MS;
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 60 * 60 * 1000;
}

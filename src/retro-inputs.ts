/**
 * retro-inputs.ts — the ONE shared leaf holding the pure CLI-arg parser and
 * cue-grammar regex common to the two retro emit planners (issue #4535).
 *
 * Consumers:
 *   - scripts/ci/hydra-retro-emit.ts — the `/hydra-retro` (Orchestrator)
 *     skill's pure routing core (epic #917).
 *   - scripts/target/target-retro.ts — the `/hydra-target-retro` (Target)
 *     skill's pure routing core (epic #1052).
 *
 * Before #4535 each planner hand-duplicated these two primitives
 * byte-for-byte (the parseArgs doc-comments differed only in a trailing
 * skill-specific clause), so a CLI-contract change (a new flag) or a
 * cue-grammar change had to be made twice in lockstep. This leaf is the
 * domain-neutral seam both planners import, so a fix lands once — the same
 * shape as src/mutation-gate-inputs.ts for the ci/target mutation-gate pair
 * (issue #4489/#4346).
 *
 * The leaf lives under src/ deliberately (mirrors #4346 INV-10): the PR's own
 * mutation gate mutates only src/**\/*.ts, so placing the shared parser and
 * grammar here puts them under the kill-rate floor.
 *
 * DELIBERATELY NOT HERE: validateFindings / validateObservations. The two
 * planners' validators genuinely differ in the fields they check (findings:
 * kind/confidence; observations: lane/source) — that is divergence, not
 * drift — so each planner keeps its own validator next to its own input
 * shape, importing KEBAB_CUE from here for the shared cue-grammar check.
 *
 * Everything here is pure — no env, no filesystem, no git, no Redis, no
 * network. Its one test suite (the shared parseArgs + KEBAB_CUE cases for
 * BOTH retro skills) lives in test/hydra-retro-emit.test.mts, imported
 * directly from this leaf (issue #4535's design-concept: no separate
 * per-leaf test file).
 */

import {
  extractReviewFindingArms,
  type ReviewFindingArm,
  type ReviewFindingHotSpot,
} from "./qa/review-findings-extract.ts";

// ---------------------------------------------------------------------------
// Cue grammar
// ---------------------------------------------------------------------------

/**
 * The friction-store cue grammar: one or more `-`-separated segments, each a
 * non-empty run of `[a-z0-9]`. A retro cue MUST match this so the dedup /
 * recurrence keys line up with the friction-pattern store's keys — a
 * retrospective gotcha and its friction twin have to meet on the same key.
 * Free text is a bug (each planner's validator enforces this).
 */
export const KEBAB_CUE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

/** What {@link parseArgs} returns — the shared `/hydra*-retro` arg shape. */
export interface RetroArgs {
  /** Whether the run may mutate anything (issues / PRs / feedback edits). */
  apply: boolean;
  /** The positional run id; omitted entirely when absent (⇒ latest run). */
  runId?: string;
}

/**
 * Parse the CLI-style args the retro skills receive. Recognised forms:
 *
 *   <run_id>            → positional run id; omitted ⇒ latest completed run
 *   --audit | --dry-run → print the plan, do NOT emit anything
 *   --apply             → opt-in to actually emitting (the only mutating path)
 *
 * `--audit` (dry-run) is the DEFAULT for safety: `parseArgs("")` returns
 * `{ apply: false }` — a missing/empty arg string can never opt a retro run
 * into mutation. The calling skill's mutation paths (issues / the gated PR /
 * feedback-file edits / backlog writes) are all gated behind
 * `apply === true`.
 *
 * Unknown `--flags` are ignored rather than misparsed as a run id; of the
 * positional tokens only the first is the run id. Pure — test it by passing
 * arbitrary strings (test/hydra-retro-emit.test.mts).
 */
export function parseArgs(args: string | null | undefined): RetroArgs {
  if (!args) return { apply: false };
  const tokens = args
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  let apply = false;
  let runId: string | undefined;
  for (const t of tokens) {
    if (t === "--apply") {
      apply = true;
      continue;
    }
    if (t === "--audit" || t === "--dry-run") {
      apply = false;
      continue;
    }
    if (t.startsWith("--")) {
      // Unknown flag — ignore rather than misparse it as a run id.
      continue;
    }
    // First positional token is the run id.
    if (runId === undefined) runId = t;
  }
  // Omit `runId` entirely when absent so the shape matches `{ apply }` exactly
  // (a `runId: undefined` key would break a strict deepEqual against
  // `{ apply: false }`).
  return runId === undefined ? { apply } : { apply, runId };
}

// ---------------------------------------------------------------------------
// Review-findings retro mode (issue #5271, R2; ADR-0046 Decision 8)
// ---------------------------------------------------------------------------
//
// `review_retro_due` is derived from the Redis review-findings rows ONLY
// (`src/redis/review-findings.ts` -> `readReviewFindingRows`), never from
// GitHub or a transcript. The caller reads the rows and the prior-emit ledger
// and hands them to {@link planReviewRetro}; this module stays pure.

/** The escalation ladder, shallowest first: check, then standard, then fence. */
export const REVIEW_RETRO_LADDER = ["check", "standard", "fence"] as const;
export type ReviewRetroRung = (typeof REVIEW_RETRO_LADDER)[number];

/** Review-mode emit caps: needs-triage check issues, and gated PRs. */
export const REVIEW_RETRO_MAX_ISSUES = 2;
export const REVIEW_RETRO_MAX_PRS = 1;

/** One earlier review-retro emit for an arm, as recorded in the ledger. */
export interface ReviewRetroPriorEmit {
  armKey: string;
  rung: ReviewRetroRung;
  /** True while the emitted issue / PR is still open. */
  open: boolean;
}

/** An arm that tripped, with the ladder rung this retro should emit at. */
export interface ReviewRetroTrip {
  armKey: string;
  arm: ReviewFindingArm["arm"];
  rung: ReviewRetroRung;
}

export interface ReviewRetroPlan {
  /** True iff at least one arm tripped and may emit (the `review_retro_due` signal). */
  due: boolean;
  trips: ReviewRetroTrip[];
  hotSpots: ReviewFindingHotSpot[];
  warnings: string[];
}

/** Stable per-arm ledger key. The pair-miss arm is one global arm. */
export function reviewArmKey(arm: ReviewFindingArm): string {
  return arm.arm === "pair-miss" ? "pair-miss" : `${arm.arm}:${arm.key}`;
}

/**
 * The rung an arm may emit at, or null when it must stay quiet. Re-trip only
 * after the prior emit closes (any open emit blocks), and each re-trip climbs
 * exactly one rung; an arm already emitted at `fence` is exhausted.
 */
export function nextReviewRung(
  prior: readonly ReviewRetroPriorEmit[],
  armKey: string,
): ReviewRetroRung | null {
  const mine = prior.filter((p) => p.armKey === armKey);
  if (mine.length === 0) return "check";
  if (mine.some((p) => p.open)) return null;
  const highest = Math.max(...mine.map((p) => REVIEW_RETRO_LADDER.indexOf(p.rung)));
  return REVIEW_RETRO_LADDER[highest + 1] ?? null;
}

/** Fold stored rows + the prior-emit ledger into this retro's trips. Pure. */
export function planReviewRetro(
  rows: readonly unknown[],
  prior: readonly ReviewRetroPriorEmit[],
  opts: { now: number },
): ReviewRetroPlan {
  const { arms, hotSpots, warnings } = extractReviewFindingArms(rows, { now: opts.now });
  const trips: ReviewRetroTrip[] = [];
  for (const arm of arms) {
    const armKey = reviewArmKey(arm);
    const rung = nextReviewRung(prior, armKey);
    if (rung !== null) trips.push({ armKey, arm: arm.arm, rung });
  }
  return { due: trips.length > 0, trips, hotSpots, warnings };
}

/**
 * Apply the emit caps: at most {@link REVIEW_RETRO_MAX_ISSUES} `check`-rung
 * needs-triage issues and {@link REVIEW_RETRO_MAX_PRS} PR (the `standard` /
 * `fence` rungs, limited to CODING_STANDARDS.md or prod-code fences). Trips
 * over the cap are returned in `deferred` and re-trip next retro.
 */
export function capReviewRetroEmits(trips: readonly ReviewRetroTrip[]): {
  issues: ReviewRetroTrip[];
  pr: ReviewRetroTrip | null;
  deferred: ReviewRetroTrip[];
} {
  const issues: ReviewRetroTrip[] = [];
  let pr: ReviewRetroTrip | null = null;
  const deferred: ReviewRetroTrip[] = [];
  for (const t of trips) {
    if (t.rung === "check") {
      if (issues.length < REVIEW_RETRO_MAX_ISSUES) issues.push(t);
      else deferred.push(t);
    } else if (pr === null) {
      pr = t;
    } else {
      deferred.push(t);
    }
  }
  return { issues, pr, deferred };
}

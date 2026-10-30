/**
 * src/qa/fanout.ts — the reviewer fan-out phase: tier x change-shape sizing of the review spawn.
 *
 * Moved verbatim out of scripts/ci/qa-verdict.ts (issue #5079, qa-verdict-engine
 * slice 2/4; ADR-0038). Pure — no fs/network. The workflow-facing facade
 * scripts/ci/qa-verdict.ts re-exports the names its consumers import.
 */

import { classifyChangeShape, type ChangeShape } from "./change-shape.ts";
import { requiresOneWayDepth, type OneWayDoorClass, type OneWayDoorResult } from "./one-way-door.ts";
import type { TwoWayPairValue } from "./rollout-switches.ts";

/**
 * The reviewer fan-out step 7 spawns:
 *   single      — ONE blocking reviewer covering Standards + Spec (1 spawn)
 *   standard    — the T1/T2 Standards + Spec pair (2 spawns)
 *   adversarial — the T3/T4 two independent refutation reviewers (4 spawns)
 */
export type ReviewerFanoutMode = "single" | "standard" | "adversarial";

export interface ReviewerFanoutDecision {
  mode: ReviewerFanoutMode;
  shape: ChangeShape;
  /**
   * Every reviewer name step 7 spawns. Step 7.5's completeness check requires
   * a real result for each entry — a one-element list for `single`.
   */
  reviewers: string[];
  /** One line for the verdict comment: which fan-out ran and why. */
  reason: string;
  /** Present only when the caller supplied the reversibility argument (#5263). */
  reversibility?: ReversibilityRecord;
}

type Door = OneWayDoorResult["door"];

/** Optional third argument of {@link decideReviewerFanout} (ADR-0046 D5/D6, #5263). */
export interface ReversibilityInput {
  /** `null` = detector not run. */
  door: Door | null;
  classes?: readonly OneWayDoorClass[];
  /** Effective rollout switch; defaults to `off`. */
  twoWayPair?: TwoWayPairValue;
}

/** Shadow record P2 (#5264) keys on: `pairEligible && !reductionApplied`. */
export interface ReversibilityRecord {
  door: Door | null;
  twoWayPair: TwoWayPairValue;
  legacyMode: ReviewerFanoutMode;
  selectedMode: ReviewerFanoutMode;
  pairEligible: boolean;
  reductionApplied: boolean;
  escalated: boolean;
}

const MODE_ORDER: Record<ReviewerFanoutMode, number> = { single: 0, standard: 1, adversarial: 2 };

/**
 * Escalate-only fold of door verdicts (ADR-0046 D5): one-way > unknown > two-way > null.
 * The single place max(detector, `Merge danger:` field, reviewer) lives.
 */
export function maxDoor(...doors: (Door | null | undefined)[]): Door | null {
  if (doors.includes("one-way")) return "one-way";
  if (doors.includes("unknown")) return "unknown";
  if (doors.includes("two-way")) return "two-way";
  return null;
}

function normalizeTier(tier: number | null): number | null {
  return typeof tier === "number" && !Number.isNaN(tier) ? tier : null;
}

/**
 * Reversibility-scored depth policy with switch=on semantics (ADR-0046 D5, #5263).
 * Floor for code is the Standards+Spec pair; only an explicit `two-way` door lowers T3 code.
 */
export function selectReviewDepth(input: {
  tier: number | null;
  shape: ChangeShape;
  door: Door | null;
}): { mode: ReviewerFanoutMode; reason: string } {
  const tier = normalizeTier(input.tier);
  if (tier === null) return { mode: "adversarial", reason: "tier unknown, fail-closed" };
  if (tier >= 4) return { mode: "adversarial", reason: "Verifier Core, door not consulted" };
  const oneWay = input.door !== null && requiresOneWayDepth({ door: input.door });
  if (input.shape === "code") {
    if (oneWay) return { mode: "adversarial", reason: `door \`${input.door}\` is one-way depth` };
    if (input.door === "two-way") return { mode: "standard", reason: "two-way door, pair floor" };
    return { mode: tier >= 3 ? "adversarial" : "standard", reason: "no door evidence, tier path" };
  }
  if (oneWay) return { mode: "adversarial", reason: `non-code but door \`${input.door}\` is one-way depth` };
  return { mode: "single", reason: "non-code, two-way or no door" };
}

const FANOUT_REVIEWERS: Record<ReviewerFanoutMode, readonly string[]> = {
  single: ["reviewer-single"],
  standard: ["standards", "spec"],
  adversarial: [
    "reviewer-A-standards",
    "reviewer-A-spec",
    "reviewer-B-standards",
    "reviewer-B-spec",
  ],
};

const FANOUT_LABEL: Record<ReviewerFanoutMode, string> = {
  single: "single (1 reviewer covering Standards + Spec)",
  standard: "standard (Standards + Spec, 2 sub-agents)",
  adversarial: "adversarial (2 reviewers × Standards + Spec, 4 sub-agents)",
};

/**
 * Size the reviewer fan-out from the PR tier and its change shape (#4733).
 *
 * - T4 → always `adversarial` (Verifier Core never loses depth).
 * - unknown tier (`null`) → `adversarial` (fail-closed, like step 6.5).
 * - `code` shape → the unchanged tier path (T1/T2 standard, T3 adversarial).
 * - T1–T3 with a docs/tests/prompt-only shape → `single`.
 */
export function decideReviewerFanout(
  tier: number | null,
  paths: readonly string[],
  reversibility?: ReversibilityInput,
): ReviewerFanoutDecision {
  const shape = classifyChangeShape(paths);
  const knownTier = normalizeTier(tier);

  let mode: ReviewerFanoutMode;
  let why: string;
  if (knownTier === null) {
    mode = "adversarial";
    why = "tier classifier unreachable, fail-closed to full depth";
  } else if (knownTier >= 4) {
    mode = "adversarial";
    why = "Verifier Core always gets the full fan-out";
  } else if (shape === "code") {
    mode = knownTier >= 3 ? "adversarial" : "standard";
    why = "the diff touches code, so the tier sets the depth";
  } else {
    mode = "single";
    why = "the diff touches no code, so one reviewer is sized to the change";
  }

  const tierLabel = knownTier === null ? "tier unknown" : `T${knownTier}`;
  if (!reversibility) {
    return {
      mode,
      shape,
      reviewers: [...FANOUT_REVIEWERS[mode]],
      reason: `Review fan-out: ${FANOUT_LABEL[mode]} — ${tierLabel}, change shape \`${shape}\`: ${why} (issue #4733).`,
    };
  }

  // Reversibility axis (#5263): escalation is ungated; only the reduction needs switch=on.
  const legacyMode = mode;
  const twoWayPair = reversibility.twoWayPair ?? "off";
  const selected = selectReviewDepth({ tier: knownTier, shape, door: reversibility.door });
  const escalated = MODE_ORDER[selected.mode] > MODE_ORDER[legacyMode];
  const pairEligible = knownTier === 3 && shape === "code" && reversibility.door === "two-way";
  const reductionApplied = pairEligible && twoWayPair === "on";
  const live: ReviewerFanoutMode = escalated || twoWayPair === "on" ? selected.mode : legacyMode;
  const doorLabel = reversibility.door ?? "not run";
  const shadowNote =
    pairEligible && !reductionApplied ? `: pair would run, ${legacyMode} still decides` : "";
  return {
    mode: live,
    shape,
    reviewers: [...FANOUT_REVIEWERS[live]],
    reason: `Review fan-out: ${FANOUT_LABEL[live]} — ${tierLabel}, change shape \`${shape}\`: ${why}; door \`${doorLabel}\`, two-way-pair \`${twoWayPair}\`${shadowNote} (issue #4733, #5263).`,
    reversibility: {
      door: reversibility.door,
      twoWayPair,
      legacyMode,
      selectedMode: selected.mode,
      pairEligible,
      reductionApplied,
      escalated,
    },
  };
}

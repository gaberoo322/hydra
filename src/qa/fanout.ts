/**
 * src/qa/fanout.ts — the reviewer fan-out phase: tier x change-shape sizing of the review spawn.
 *
 * Moved verbatim out of scripts/ci/qa-verdict.ts (issue #5079, qa-verdict-engine
 * slice 2/4; ADR-0038). Pure — no fs/network. The workflow-facing facade
 * scripts/ci/qa-verdict.ts re-exports the names its consumers import.
 */

import { classifyChangeShape, type ChangeShape } from "./change-shape.ts";

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
): ReviewerFanoutDecision {
  const shape = classifyChangeShape(paths);
  const knownTier = typeof tier === "number" && !Number.isNaN(tier) ? tier : null;

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
  return {
    mode,
    shape,
    reviewers: [...FANOUT_REVIEWERS[mode]],
    reason: `Review fan-out: ${FANOUT_LABEL[mode]} — ${tierLabel}, change shape \`${shape}\`: ${why} (issue #4733).`,
  };
}

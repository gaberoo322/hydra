/**
 * Contracts for the hydra-qa plumbing scripts (`scripts/qa/{preflight,packet,
 * route,poll}.ts`, issue #5269, ADR-0046 Decision 7). These sit NEXT TO the
 * engine's CLI contracts (`qa-verdict-cli.ts`): the engine owns every verdict
 * RULE; the plumbing scripts only fetch facts, assemble packets and perform
 * the label/comment effects the playbook used to spell as bash.
 *
 * One schema per file boundary. `PreflightResultSchema` is both the output of
 * `preflight.ts` and the validated input of `packet.ts` / `route.ts`, so a
 * hand-edited or truncated preflight file fails at the boundary (exit 2)
 * rather than half-way through a verdict.
 */

import { z } from "zod";

const finalVerdict = z.enum(["PASS", "FAIL", "PASS-pending-CI", "FAIL-pending-CI"]);

/** Why a preflight stopped before the review (exit 0; the playbook stub posts one comment and ends). */
export const PREFLIGHT_STAGES = ["ready", "no-issue", "no-pr", "spec-missing-enforce"] as const;

export const CheckListSchema = z.array(
  z.object({
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
    required: z.boolean(),
  }),
);

export const PreflightResultSchema = z.object({
  ok: z.boolean(),
  stage: z.enum(PREFLIGHT_STAGES),
  issue: z.number().int().nullable(),
  pr: z
    .object({
      number: z.number().int().positive(),
      headSha: z.string(),
      headRefName: z.string(),
      baseRefName: z.string(),
      mergeStateStatus: z.string(),
      glmAuthored: z.boolean(),
    })
    .nullable(),
  fixedSha: z.string().nullable(),
  changedPaths: z.array(z.string()),
  checks: z.object({
    list: CheckListSchema,
    /** True when the list is the rollup-only all-optional mapping, or unreadable. */
    degraded: z.boolean(),
    /** `branch-protection`, `rollup-only-all-optional`, or null when the rollup was unreadable. */
    source: z.string().nullable(),
  }),
  spec: z.object({
    found: z.boolean(),
    input: z.unknown().nullable(),
    skippedReason: z.string().nullable(),
    mode: z.string(),
  }),
  tier: z.object({ num: z.number().int().nullable(), adversarial: z.boolean() }),
  gate: z.object({
    action: z.enum(["admit", "defer", "skip-required-failed"]),
    reason: z.string(),
    redRequired: z.array(z.string()),
    /** Set exactly on `skip-required-failed`: the FAIL the fold already determined (no review needed). */
    skipVerdict: z.object({ verdict: z.string(), reason: z.string() }).nullable(),
    skipCiSummary: z.string().nullable(),
  }),
  fanout: z.object({
    mode: z.enum(["single", "standard", "adversarial"]),
    reviewers: z.array(z.string()),
    reason: z.string(),
  }),
  /** The one comment a non-ready stage posts (target says where). Null on `ready`. */
  stop: z.object({ target: z.enum(["pr", "issue"]), body: z.string() }).nullable(),
  degraded: z.array(z.string()),
});
export type PreflightResult = z.infer<typeof PreflightResultSchema>;

export const PacketResultSchema = z.object({
  reviewPacketPath: z.string(),
  standardsPacketPath: z.string().nullable(),
  standardsFound: z.boolean(),
  specInputPath: z.string().nullable(),
  priorFindings: z.string(),
  rereviewDiffBase: z.string(),
  /** Merge-danger comparison (#5258): the step-8 row and the verdict-comment gap line. */
  mergeDanger: z.object({
    finding: z.unknown().nullable(),
    gapLine: z.string().nullable(),
  }),
  degraded: z.array(z.string()),
});
export type PacketResult = z.infer<typeof PacketResultSchema>;

/** `--summaries <file>`: the two axis paragraphs (already prefixed A:/B: at T3/T4 by the session). */
export const SummariesSchema = z.object({
  standardsSummary: z.string(),
  specSummary: z.string(),
});
export type Summaries = z.infer<typeof SummariesSchema>;

export const RouteEffectSchema = z.object({
  kind: z.string(),
  target: z.string(),
  ok: z.boolean(),
});
export type RouteEffect = z.infer<typeof RouteEffectSchema>;

/**
 * The reviewer-commit decision route carries on its result (#5415): on pass 1 with
 * `action: 'commit-a'` it is the plan the agent-executed step-9.4 block reads; on every
 * other path it is the audit of why no reviewer commit ran.
 */
export const ReviewerCommitPlanSchema = z.object({
  action: z.enum(["none", "commit-a"]),
  reason: z.string(),
  reviewedHead: z.string().optional(),
  headRef: z.string().optional(),
  fixedSha: z.string().nullable().optional(),
  blockingPaths: z.array(z.string()).optional(),
  followUpPaths: z.array(z.string()).optional(),
  bodyFix: z.boolean().optional(),
  blockingLocations: z.array(z.string()).optional(),
});
export type ReviewerCommitPlan = z.infer<typeof ReviewerCommitPlanSchema>;

export const RouteResultSchema = z.object({
  verdict: finalVerdict.nullable(),
  reason: z.string(),
  reviewVerdict: z.enum(["PASS", "FAIL"]).nullable(),
  blockers: z.number().int().nonnegative(),
  maxSeverity: z.enum(["high", "medium", "low", "none"]),
  worstFinding: z.string(),
  trailer: z.string(),
  round: z.number().int().nullable(),
  deepQa: z.unknown().nullable(),
  effects: z.array(RouteEffectSchema),
  nextStep: z.enum(["arm-auto-merge", "reviewer-commit", "none"]),
  reviewerCommit: ReviewerCommitPlanSchema.optional(),
  dryRun: z.boolean(),
  degraded: z.array(z.string()),
});
export type RouteResult = z.infer<typeof RouteResultSchema>;

export const PollResultSchema = z.object({
  /** Count of pending checks at the last readable poll; null when `gh` never answered. */
  pending: z.number().int().nonnegative().nullable(),
  settled: z.boolean(),
  iterations: z.number().int().nonnegative(),
  checks: z.array(z.object({ name: z.string(), state: z.string() })),
});
export type PollResult = z.infer<typeof PollResultSchema>;

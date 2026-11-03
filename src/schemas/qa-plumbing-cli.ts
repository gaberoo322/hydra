/**
 * Result schemas for the hydra-qa plumbing scripts (`scripts/qa/*.ts`, issue
 * #5269, ADR-0046 Decision 7). Each script validates the ONE JSON object it
 * prints against its schema here (STD-SCHEMA-SEAM): a result that does not
 * parse is a usage/schema failure (exit 2), never printed.
 *
 * The scripts add NO verdict rule. Every decision field (`gate`, `fanout`,
 * `verdict`, `round`, `deepQa`) is the engine's own output, carried verbatim.
 */

import { z } from "zod";

const looseObject = z.record(z.string(), z.unknown());

const checkState = z.object({
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  required: z.boolean(),
});

const preflightStages = ["no-issue", "no-pr", "spec-missing-enforce"] as const;
export type PreflightStage = (typeof preflightStages)[number];

/** steps 1-6.7 in one call. `ok:false` is exit 0: the stub posts `message` and stops. */
export const PreflightResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(false),
    stage: z.enum(preflightStages),
    issue: z.number().int().nullable(),
    pr: z.number().int().nullable(),
    /** Exact comment body the playbook stub posts (`commentTarget` says where), or null. */
    message: z.string().nullable(),
    commentTarget: z.enum(["issue", "pr"]).nullable(),
    degraded: z.array(z.string()),
  }),
  z.object({
    ok: z.literal(true),
    stage: z.literal("ready"),
    issue: z.number().int(),
    repo: z.string(),
    pr: z.object({
      number: z.number().int(),
      headSha: z.string(),
      headRefName: z.string(),
      baseRefName: z.string(),
      mergeStateStatus: z.string(),
      glmAuthored: z.boolean(),
    }),
    fixedSha: z.string(),
    changedPaths: z.array(z.string()),
    checks: z.object({
      /** null = the rollup was unreadable; route then exits before any verdict. */
      list: z.array(checkState).nullable(),
      degraded: z.array(z.string()),
    }),
    spec: z.object({
      found: z.boolean(),
      input: looseObject.nullable(),
      skippedReason: z.string().nullable(),
      mode: z.string(),
    }),
    tier: z.object({ num: z.number().int().nullable(), adversarial: z.boolean() }),
    gate: z.object({
      action: z.enum(["admit", "defer", "skip-required-failed"]),
      reason: z.string(),
      redRequired: z.array(z.string()),
      /** The skip path's engine-computed FAIL + CI summary (null unless skip-required-failed). */
      skipVerdict: z.object({ verdict: z.string(), reason: z.string() }).nullable(),
      skipCiSummary: z.string().nullable(),
    }),
    fanout: z.object({
      mode: z.string(),
      reviewers: z.array(z.string()),
      reason: z.string(),
    }),
    degraded: z.array(z.string()),
  }),
]);
export type PreflightResult = z.infer<typeof PreflightResultSchema>;
export type PreflightReady = Extract<PreflightResult, { ok: true }>;

export const PacketResultSchema = z.object({
  reviewPacketPath: z.string(),
  standardsPacketPath: z.string().nullable(),
  standardsFound: z.boolean(),
  specInputPath: z.string().nullable(),
  priorFindings: z.string(),
  rereviewDiffBase: z.string(),
  /** 7.0b: the escalate-only merge-danger comparison. */
  mergeDanger: z.object({
    finding: looseObject.nullable(),
    gapLine: z.string().nullable(),
  }),
  degraded: z.array(z.string()),
});
export type PacketResult = z.infer<typeof PacketResultSchema>;

export const RouteEffectSchema = z.object({
  kind: z.string(),
  target: z.string(),
  ok: z.boolean(),
});
export type RouteEffect = z.infer<typeof RouteEffectSchema>;

export const RouteResultSchema = z.object({
  verdict: z.string().nullable(),
  reason: z.string(),
  reviewVerdict: z.string().nullable(),
  blockers: z.number().int().nonnegative(),
  maxSeverity: z.string(),
  worstFinding: z.string(),
  trailer: z.string().nullable(),
  round: z.number().int().nullable(),
  deepQa: z.unknown().nullable(),
  effects: z.array(RouteEffectSchema),
  nextStep: z.enum(["arm-auto-merge", "none"]),
  degraded: z.array(z.string()),
});
export type RouteResult = z.infer<typeof RouteResultSchema>;

export const PollResultSchema = z.object({
  /** null = no `gh pr checks` read ever succeeded (unknown, never read as terminal). */
  pending: z.number().int().nonnegative().nullable(),
  settled: z.boolean(),
  iterations: z.number().int().nonnegative(),
  checks: z.array(z.object({ name: z.string(), state: z.string() })),
});
export type PollResult = z.infer<typeof PollResultSchema>;

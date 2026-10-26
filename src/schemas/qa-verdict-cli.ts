/**
 * Input schemas for the qa-verdict CLI (`scripts/ci/qa-verdict.ts`, issue
 * #5080, qa-verdict-engine slice 3/4). One schema per engine phase; each is
 * the source of truth for both the parser and the inferred input type.
 *
 * Fact fields (`checks`, `priorBodies`, `headSha`, `changedPaths`,
 * `mergeStateStatus`) are all OPTIONAL: a supplied fact is used verbatim, an
 * absent one is fetched through the `QaVerdictFetchers` port (INV-6). Failure
 * envelope at the CLI boundary: `{code: "schema-validation-failed", issues}`.
 */

import { z } from "zod";

const pr = z.number().int().positive();
const tier = z.number().int().nullable();
const bodies = z.array(z.string().nullable()).optional();
const checks = z.array(
  z.object({
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
    required: z.boolean(),
  }),
);
const reviewFinding = z.object({
  severity: z.enum(["high", "medium", "low"]),
  axis: z.enum(["standards", "spec"]),
  reviewer: z.string(),
  location: z.string(),
  finding: z.string(),
  fix: z.string(),
  key: z.string().optional(),
});
// Flat array, or (with spawnedReviewers) a per-reviewer map of arrays.
const reviewFindings = z.union([z.array(reviewFinding), z.record(z.string(), z.array(reviewFinding))]);
const finalVerdict = z.enum(["PASS", "FAIL", "PASS-pending-CI", "FAIL-pending-CI"]);

export const QA_VERDICT_PHASES = [
  "checks",
  "admission",
  "fanout",
  "prior-context",
  "fold",
  "trailer",
  "round-action",
] as const;
export type QaVerdictPhase = (typeof QA_VERDICT_PHASES)[number];

export const QaVerdictCliSchemas = {
  checks: z.object({ pr }),
  admission: z.object({
    pr,
    tier,
    checks: checks.optional(),
    mergeStateStatus: z.string().optional(),
    changedPaths: z.array(z.string()).optional(),
  }),
  fanout: z.object({ pr, tier, changedPaths: z.array(z.string()).optional() }),
  "prior-context": z.object({
    pr,
    tier,
    headSha: z.string().optional(),
    priorBodies: bodies,
  }),
  fold: z.object({
    tier,
    findings: reviewFindings,
    spawnedReviewers: z.array(z.string()).nullable().optional(),
    checks,
    standardsSummary: z.string(),
    specSummary: z.string(),
    fanoutReason: z.string().optional(),
  }),
  trailer: z.object({
    pr,
    verdict: finalVerdict,
    headSha: z.string().optional(),
    blockers: z.number().int().nonnegative(),
    maxSeverity: z.enum(["high", "medium", "low", "none"]),
    priorBodies: bodies,
  }),
  "round-action": z.object({
    pr,
    tier,
    verdict: z.string(),
    reviewVerdict: z.enum(["PASS", "FAIL"]),
    headSha: z.string().optional(),
    currentReviewed: z.boolean().optional(),
    currentTrailer: z.string().optional(),
    priorBodies: bodies,
  }),
} as const satisfies Record<QaVerdictPhase, z.ZodType>;

export type QaVerdictCliInput<P extends QaVerdictPhase> = z.infer<(typeof QaVerdictCliSchemas)[P]>;

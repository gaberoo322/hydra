/**
 * src/qa/phases.ts — the qa-verdict engine's per-phase runner (issue #5080,
 * qa-verdict-engine slice 3/4, ADR-0038).
 *
 * `runQaVerdictPhase(phase, input, fetchers)` composes the existing phase
 * heads (admission / fanout / prior-round / fold / verdict-trailer /
 * round-action) and adds NO verdict rule (INV-8): every phase output is the
 * head's return value plus `degraded`.
 *
 * The only decisions made here:
 *   - supplied facts win, absent facts are fetched through the
 *     {@link QaVerdictFetchers} port (INV-6);
 *   - a fetch failure never aborts a phase — it is named in `degraded` and
 *     the phase falls to its conservative value (INV-5) — EXCEPT the prior
 *     bodies in `trailer` and `round-action`: they ARE the round count, and
 *     an empty fallback would read as round 1 and reset the round cap, so
 *     there an unreadable history throws (CLI exit 1, no result).
 *
 * This module performs no I/O itself: only the port touches gh/git.
 */

import {
  buildCheckStates,
  classifyVerdict,
  decideAdmission,
  redRequiredChecks,
  type CheckState,
  type RawRollupEntry,
} from "./admission.ts";
import { decideReviewerFanout } from "./fanout.ts";
import { foldReview } from "./fold.ts";
import { priorRoundContext, qaVerdictHistory, type AncestryPort } from "./prior-round.ts";
import { decideRound } from "./round-action.ts";
import {
  QA_VERDICT_UNKNOWN_SHA,
  buildQaVerdictTrailer,
  nextQaVerdictRound,
} from "./verdict-trailer.ts";
import type { QaVerdictCliInput, QaVerdictPhase } from "../schemas/qa-verdict-cli.ts";
import { NotFoundError } from "../errors.ts";

/** What a fetcher can learn about a prior verdict sha vs HEAD. null = unverifiable. */
export interface QaAncestryFacts {
  isAncestor: boolean | null;
  changedSince: readonly string[] | null;
}

/**
 * The fetch port. Every getter returns null on failure and NEVER throws; the
 * phase records the null in `degraded`. Two adapters: `src/qa/fetchers.ts`
 * (gh/git) and the in-process fixture fetcher in tests.
 */
export interface QaVerdictFetchers {
  rollup(pr: number): Promise<RawRollupEntry[] | null>;
  /** Branch-protection required contexts; a well-formed `contexts: null` is `[]`. */
  requiredContexts(): Promise<string[] | null>;
  headSha(pr: number): Promise<string | null>;
  mergeStateStatus(pr: number): Promise<string | null>;
  changedFiles(pr: number): Promise<string[] | null>;
  /** Comment + review bodies of the PR. */
  priorBodies(pr: number): Promise<string[] | null>;
  ancestry(priorSha: string, headSha: string): Promise<QaAncestryFacts>;
}

export type QaChecksSource = "branch-protection" | "rollup-only-all-optional";

export interface QaChecksResult {
  checks: CheckState[] | null;
  red: string[];
  requiredPending: number | null;
  rollup: RawRollupEntry[] | null;
  source: QaChecksSource | null;
  degraded: string[];
}

/** The `checks` phase: fetch + fold the required-check state. */
export async function runChecksPhase(pr: number, f: QaVerdictFetchers): Promise<QaChecksResult> {
  const rollup = await f.rollup(pr);
  if (rollup === null) {
    return { checks: null, red: [], requiredPending: null, rollup: null, source: null, degraded: ["rollup"] };
  }
  const contexts = await f.requiredContexts();
  const degraded: string[] = [];
  let source: QaChecksSource = "branch-protection";
  if (contexts === null) {
    // hydra-qa INV-7 fallback, now in code: every check optional.
    degraded.push("required-contexts");
    source = "rollup-only-all-optional";
  }
  const checks = buildCheckStates(rollup, contexts ?? []);
  return {
    checks,
    red: redRequiredChecks(checks),
    requiredPending: classifyVerdict("PASS", checks).summary.requiredPending,
    rollup,
    source,
    degraded,
  };
}

/**
 * Fallback when the changed-file list is unreadable: one code-shaped path, so
 * fan-out sizing and admission take the MAXIMAL (code) depth rather than the
 * lightest docs-only classification (fail-closed, not fail-open).
 */
export const UNREADABLE_CHANGED_PATHS: string[] = ["src/__changed-files-unreadable__.ts"];

/** Use a supplied fact verbatim; otherwise fetch it, recording a miss in `degraded`. */
async function resolveFact<T>(
  supplied: T | undefined,
  fetch: () => Promise<T | null>,
  name: string,
  fallback: T,
  degraded: string[],
): Promise<T> {
  if (supplied !== undefined) return supplied;
  const got = await fetch();
  if (got === null) {
    degraded.push(name);
    return fallback;
  }
  return got;
}

/**
 * Prior bodies for a phase that COUNTS rounds (trailer, round-action). There is
 * no conservative fallback: `[]` means "round 1", which would silently reset the
 * round cap, so an unreadable history throws instead of degrading.
 */
async function requirePriorBodies(
  supplied: Array<string | null> | undefined,
  f: QaVerdictFetchers,
  pr: number,
): Promise<Array<string | null>> {
  if (supplied !== undefined) return supplied;
  const got = await f.priorBodies(pr);
  if (got === null) {
    throw new NotFoundError(
      `prior-bodies unreadable for PR #${pr}: refusing to count the round from an empty history (it would reset the round cap)`,
    );
  }
  return got;
}

export async function runQaVerdictPhase(
  phase: QaVerdictPhase,
  input: unknown,
  f: QaVerdictFetchers,
): Promise<Record<string, unknown>> {
  const degraded: string[] = [];
  switch (phase) {
    case "checks": {
      const i = input as QaVerdictCliInput<"checks">;
      return { ...(await runChecksPhase(i.pr, f)) };
    }
    case "admission": {
      const i = input as QaVerdictCliInput<"admission">;
      let checks = i.checks as CheckState[] | undefined;
      if (checks === undefined) {
        const r = await runChecksPhase(i.pr, f);
        degraded.push(...r.degraded.map((d) => `checks:${d}`));
        // Unreadable rollup => no states => fail-closed admit (INV-E).
        checks = r.checks ?? [];
      }
      const mergeStateStatus = await resolveFact(
        i.mergeStateStatus, () => f.mergeStateStatus(i.pr), "merge-state", "", degraded);
      const changedPaths = await resolveFact(
        i.changedPaths, () => f.changedFiles(i.pr), "changed-paths", UNREADABLE_CHANGED_PATHS, degraded);
      const result = decideAdmission({ checks, mergeStateStatus, tier: i.tier, changedPaths });
      return { ...result, degraded };
    }
    case "fanout": {
      const i = input as QaVerdictCliInput<"fanout">;
      const changedPaths = await resolveFact(
        i.changedPaths, () => f.changedFiles(i.pr), "changed-paths", UNREADABLE_CHANGED_PATHS, degraded);
      return { ...decideReviewerFanout(i.tier, changedPaths), degraded };
    }
    case "prior-context": {
      const i = input as QaVerdictCliInput<"prior-context">;
      const priorBodies = await resolveFact(
        i.priorBodies, () => f.priorBodies(i.pr), "prior-bodies", [] as Array<string | null>, degraded);
      const headSha = await resolveFact(i.headSha, () => f.headSha(i.pr), "head-sha", "", degraded);
      // The head's AncestryPort is synchronous; resolve the one async lookup it
      // can make (the latest prior verdict's sha) up front.
      const history = qaVerdictHistory(priorBodies, i.pr);
      const prior = history.length > 0 ? history[history.length - 1] : null;
      let facts: QaAncestryFacts = { isAncestor: null, changedSince: null };
      if (prior && headSha !== "") facts = await f.ancestry(prior.sha, headSha);
      const ancestry: AncestryPort = {
        isAncestor: () => facts.isAncestor,
        changedSince: () => facts.changedSince,
      };
      const result = priorRoundContext({ tier: i.tier, pr: i.pr, headSha, priorBodies, ancestry });
      return { ...result, degraded };
    }
    case "fold": {
      const i = input as QaVerdictCliInput<"fold">;
      const result = foldReview({
        tier: i.tier,
        findings: i.findings,
        spawnedReviewers: i.spawnedReviewers,
        checks: i.checks as CheckState[],
        standardsSummary: i.standardsSummary,
        specSummary: i.specSummary,
        fanoutReason: i.fanoutReason,
      });
      return { ...result, degraded };
    }
    case "trailer": {
      const i = input as QaVerdictCliInput<"trailer">;
      const priorBodies = await requirePriorBodies(i.priorBodies, f, i.pr);
      const headSha = await resolveFact(
        i.headSha, () => f.headSha(i.pr), "head-sha", QA_VERDICT_UNKNOWN_SHA, degraded);
      const trailer = buildQaVerdictTrailer({
        verdict: i.verdict, pr: i.pr, headSha, blockers: i.blockers,
        maxSeverity: i.maxSeverity, priorBodies,
      });
      return { trailer, round: nextQaVerdictRound(priorBodies, i.pr), degraded };
    }
    case "round-action": {
      const i = input as QaVerdictCliInput<"round-action">;
      const priorBodies = await requirePriorBodies(i.priorBodies, f, i.pr);
      const headSha = await resolveFact(i.headSha, () => f.headSha(i.pr), "head-sha", "", degraded);
      const result = decideRound({
        tier: i.tier, verdict: i.verdict, reviewVerdict: i.reviewVerdict, pr: i.pr,
        headSha, priorBodies, currentReviewed: i.currentReviewed, currentTrailer: i.currentTrailer,
      });
      return { ...result, degraded };
    }
  }
}

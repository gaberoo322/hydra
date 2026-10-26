/**
 * src/qa/prior-round.ts — the prior-round phase: QA verdict history and the re-review context.
 *
 * Moved verbatim out of scripts/ci/qa-verdict.ts (issue #5079, qa-verdict-engine
 * slice 2/4; ADR-0038). Pure — no fs/network. The workflow-facing facade
 * scripts/ci/qa-verdict.ts re-exports the names its consumers import.
 */

import { QA_FINDINGS_HEADING } from "./fold.ts";
import { isFailVerdict, parseQaVerdictTrailers, qaVerdictShaMatches, type QaVerdictTrailer } from "./verdict-trailer.ts";

/**
 * One trailer per round for `pr`, in round order. A round that appears twice
 * (a quoted or re-posted trailer) keeps a FAIL over a PASS, so a duplicate can
 * never hide a FAIL round from the cap.
 */
export function qaVerdictHistory(
  priorBodies: ReadonlyArray<string | null | undefined>,
  pr: number,
): QaVerdictTrailer[] {
  const byRound = new Map<number, QaVerdictTrailer>();
  for (const body of priorBodies) {
    for (const t of parseQaVerdictTrailers(body)) {
      if (t.pr !== pr) continue;
      const seen = byRound.get(t.round);
      if (!seen || (!isFailVerdict(seen.verdict) && isFailVerdict(t.verdict))) byRound.set(t.round, t);
    }
  }
  return [...byRound.values()].sort((a, b) => a.round - b.round);
}

export interface ReReviewContext {
  /** Whether the prior FAIL round's findings table is appended to the packet. */
  includeFindings: boolean;
  /** Whether `git diff <baseSha>..HEAD` is appended as extra context. */
  includeDiff: boolean;
  /** The prior verdict's `sha=` (the diff base); null unless `includeDiff`. */
  baseSha: string | null;
  reason: string;
}

/**
 * The prior round's findings section (up to the `## Standards` heading) from
 * the PR comment whose trailer names `pr` and `round`, or "" when there is
 * none — e.g. a `skip-required-failed` round, which reviewed nothing.
 */
export function priorFindingsSection(
  priorBodies: ReadonlyArray<string | null | undefined>,
  pr: number,
  round: number,
): string {
  for (const body of priorBodies) {
    if (!parseQaVerdictTrailers(body).some((t) => t.pr === pr && t.round === round)) continue;
    const text = String(body);
    const start = text.indexOf(QA_FINDINGS_HEADING);
    if (start < 0) continue;
    const end = text.indexOf("\n## Standards", start);
    return text.slice(start, end < 0 ? undefined : end).trim();
  }
  return "";
}

/**
 * True iff the prior round was a REVIEWED FAIL the packet may quote: a T1–T3
 * PR whose latest prior verdict is a FAIL whose comment carries a findings
 * section (`QA_FINDINGS_HEADING`). The step-7.0a playbook block calls this
 * instead of an inline duplicate (issue #4758) — one definition of
 * "reviewed", shared with `decideReReviewContext` below.
 */
export function isReviewedFailRound(
  tier: number | null,
  prior: Pick<QaVerdictTrailer, "verdict"> | null,
  priorFindings: string,
): boolean {
  return (
    (tier === 1 || tier === 2 || tier === 3) &&
    prior !== null &&
    isFailVerdict(prior.verdict) &&
    String(priorFindings ?? "").includes(QA_FINDINGS_HEADING)
  );
}

/**
 * What re-review context the packet may carry (issue #4735, reshaped in
 * #4758): `includeFindings` appends the prior FAIL round's findings table;
 * `includeDiff` additionally appends `git diff <baseSha>..HEAD`. Both are
 * EXTRA CONTEXT, display only: the reviewers always get the full diff and
 * changed files, and the verdict is always `foldReviewFindings`.
 *
 * `includeFindings` is exactly `isReviewedFailRound` — a T1–T3 PR whose
 * latest prior verdict is a FAIL with a findings table. `includeDiff`
 * additionally requires every input to prove the diff meaningful: a hex
 * `sha=` that is still an ancestor of HEAD (no force-push or rebase), at
 * least one commit since, and a non-empty changed-file list. Anything less
 * simply omits the diff (and, when even `includeFindings` fails, all
 * context) — a plain first-pass review, never an error.
 */
export function decideReReviewContext(input: {
  tier: number | null;
  prior: QaVerdictTrailer | null;
  headSha: string;
  priorShaIsAncestor: boolean | null;
  changedSince: readonly string[] | null;
  priorFindings: string;
}): ReReviewContext {
  const none = (reason: string): ReReviewContext => ({
    includeFindings: false,
    includeDiff: false,
    baseSha: null,
    reason,
  });
  const tableOnly = (reason: string): ReReviewContext => ({
    includeFindings: true,
    includeDiff: false,
    baseSha: null,
    reason: `Prior findings only — ${reason}`,
  });
  const { tier, prior } = input;
  if (tier !== 1 && tier !== 2 && tier !== 3) {
    return none(tier === 4 ? "T4 deep QA never takes re-review context." : "tier unknown.");
  }
  if (!prior) return none("no prior QA verdict on this PR.");
  if (!isFailVerdict(prior.verdict)) {
    return none(`the latest prior verdict (round ${prior.round}) was not a FAIL.`);
  }
  if (!isReviewedFailRound(tier, prior, input.priorFindings)) {
    return none(`round ${prior.round} has no findings table to verify (a CI-only round reviewed nothing).`);
  }
  if (!/^[0-9a-f]{7,40}$/.test(prior.sha)) {
    return tableOnly(`the prior verdict's sha=${prior.sha} is not a commit.`);
  }
  if (qaVerdictShaMatches(prior, input.headSha)) {
    return tableOnly("no commits since the prior verdict.");
  }
  if (input.priorShaIsAncestor !== true) {
    return tableOnly(
      `prior sha ${prior.sha} is ${
        input.priorShaIsAncestor === false
          ? "no longer an ancestor of HEAD (force-push or rebase)"
          : "not verifiable as an ancestor of HEAD"
      }.`,
    );
  }
  if (!input.changedSince || input.changedSince.length === 0) {
    return tableOnly("no changed-file list since the prior verdict.");
  }
  return {
    includeFindings: true,
    includeDiff: true,
    baseSha: prior.sha,
    reason:
      `Re-review context — prior findings from round ${prior.round} plus ` +
      `\`git diff ${prior.sha}..HEAD\` (${input.changedSince.length} file(s)).`,
  };
}


// ---------------------------------------------------------------------------
// Phase head (issue #5079, INV-3): the ONE composed entry the prior-round step
// binds to. The git facts (is the prior sha an ancestor of HEAD; files changed
// since) come in through an injectable port so the core stays pure.
// ---------------------------------------------------------------------------

/** What the caller can learn from git about the prior verdict's sha. */
export interface AncestryPort {
  /** true / false when verifiable, null when it could not be checked. */
  isAncestor(priorSha: string, headSha: string): boolean | null;
  /** Files changed `priorSha..headSha`, or null when unknown. */
  changedSince(priorSha: string, headSha: string): readonly string[] | null;
}

export interface PriorRoundInput {
  tier: number | null;
  pr: number;
  headSha: string;
  priorBodies: ReadonlyArray<string | null | undefined>;
  ancestry: AncestryPort;
}

export interface PriorRoundResult {
  history: QaVerdictTrailer[];
  /** The latest prior verdict trailer, or null on a first pass. */
  prior: QaVerdictTrailer | null;
  /** The latest prior round's findings section ("" when none). */
  priorFindings: string;
  context: ReReviewContext;
}

export function priorRoundContext(input: PriorRoundInput): PriorRoundResult {
  const history = qaVerdictHistory(input.priorBodies, input.pr);
  const prior = history.length > 0 ? history[history.length - 1] : null;
  const priorFindings = prior ? priorFindingsSection(input.priorBodies, input.pr, prior.round) : "";
  const context = decideReReviewContext({
    tier: input.tier,
    prior,
    headSha: input.headSha,
    priorShaIsAncestor: prior ? input.ancestry.isAncestor(prior.sha, input.headSha) : null,
    changedSince: prior ? input.ancestry.changedSince(prior.sha, input.headSha) : null,
    priorFindings,
  });
  return { history, prior, priorFindings, context };
}

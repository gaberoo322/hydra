/**
 * src/qa/round-action.ts — the round-action phase: bounce / escalate (T1-T3 round cap) and the T4 deep-QA remediation loop + PASS marker.
 *
 * Moved verbatim out of scripts/ci/qa-verdict.ts (issue #5079, qa-verdict-engine
 * slice 2/4; ADR-0038). Pure — no fs/network. The workflow-facing facade
 * scripts/ci/qa-verdict.ts re-exports the names its consumers import.
 */

import { isVerifierCore } from "../untouchable.ts";
import type { ReviewVerdict } from "./admission.ts";
import { classifyQaFixPath } from "./fix-proof.ts";
import { detectOneWayDoor, requiresOneWayDepth } from "./one-way-door.ts";
import type { ReviewerCommitsValue } from "./rollout-switches.ts";
import { priorFindingsSection, qaVerdictHistory } from "./prior-round.ts";
import { isFailVerdict, nextQaVerdictRound, type FinalVerdict, type QaVerdictTrailer } from "./verdict-trailer.ts";

/**
 * T4 Deep-QA Remediation Loop (issue #740, ADR-0015).
 *
 * T4 inherits the full T3 adversarial depth (the two-reviewer refutation
 * fan-out folded by `aggregateAdversarialReview` above) and ADDS the
 * **Verifier-Core checklist** plus the block-and-escalate teeth no other tier
 * has. This module is the pure decision rule for the *remediation* half: given
 * the current T4 review verdict and the PR's own comment history, decide
 * whether a FAIL bounces the PR back to a dev agent (1st fail) or blocks the PR
 * and escalates to the operator (2nd consecutive fail).
 *
 * Why the count lives on the PR, not in Redis / on an issue label: the FAIL
 * bounce path is stateless on the issue — step 10 strips `needs-qa` and adds
 * `ready-for-agent`, resetting any label-carried counter on every bounce. A new
 * persistent Redis key would be a state surface that can desync from PR
 * reality. The PR is the durable per-attempt ledger: every deep-QA FAIL leaves
 * a machine-greppable marker comment, so the next QA pass derives the fail
 * number live by counting prior markers. "Consecutive" and "total fails on this
 * PR" coincide because a PASS merges the PR and ends the loop — a PR never
 * accumulates a FAIL after a PASS. See the rejected-alternatives in the #740
 * design-concept artifact.
 *
 * This module stays pure — no fs/network — so it is unit-tested directly.
 */

/**
 * The machine-greppable marker every T4 deep-QA FAIL comment MUST contain on
 * its own line. The next deep-QA pass counts occurrences of this literal across
 * the PR's prior comments to derive the consecutive-fail number. Changing this
 * string is a breaking change to the per-PR ledger — the playbook's step-10 T4
 * branch posts it verbatim and the count below greps for it verbatim.
 */
export const DEEP_QA_FAIL_MARKER = "Verifier-Core deep-QA: FAIL";

/**
 * The base literal of the positive Deep-QA PASS marker (ADR-0020, issue #847).
 *
 * This is the SHA-bound proof that a T4 PR cleared the deep-QA branch — the
 * positive counterpart to `DEEP_QA_FAIL_MARKER`, on the same PR-as-ledger
 * surface #740 blessed (no new verdict literal, Redis key, or label). On a T4
 * PASS, `hydra-qa` posts a PR comment carrying the rendered marker line
 * `Verifier-Core deep-QA: PASS @ <head-sha>`; the `deep-qa-gate` required CI
 * check (`.github/workflows/deep-qa-gate.yml`) verifies a marker matching the
 * PR's CURRENT head SHA before a T4 PR may merge.
 *
 * Changing this string is a breaking change to BOTH the `hydra-qa` playbook
 * (which posts it via `renderDeepQaPassMarker`) and the gate (which greps it
 * via `hasFreshDeepQaPass`) — keep this constant the single source of truth.
 */
export const DEEP_QA_PASS_MARKER = "Verifier-Core deep-QA: PASS";

/**
 * Render the exact Deep-QA PASS marker line for a given head SHA.
 *
 * Produces `Verifier-Core deep-QA: PASS @ <head-sha>` — the literal line the
 * `hydra-qa` T4 PASS path posts (on its own line) and the line
 * `hasFreshDeepQaPass` greps for. Pure — no fs/network.
 *
 * @param headSha the PR's current head commit SHA (e.g. from
 *   `gh pr view --json headRefOid`). Trimmed; passed through verbatim
 *   otherwise so the marker is byte-for-byte reproducible by the gate.
 */
export function renderDeepQaPassMarker(headSha: string): string {
  return `${DEEP_QA_PASS_MARKER} @ ${headSha.trim()}`;
}

/**
 * True iff some comment carries a fresh Deep-QA PASS marker — one matching
 * THIS head SHA. The freshness check is what makes the proof SHA-bound
 * (ADR-0020 Decision 2): pushing new commits after a pass changes the head
 * SHA, so a marker for the old SHA no longer satisfies the gate and forces
 * re-QA. A blank/whitespace `headSha` never matches (defensive — an unknown
 * head SHA must never satisfy the gate). Pure — no fs/network.
 *
 * Matching is `String.includes` of the rendered marker line, mirroring how
 * `decideDeepQaAction` counts `DEEP_QA_FAIL_MARKER` — the marker is one line
 * inside a larger comment body, not the whole body.
 *
 * @param commentBodies the PR's comment bodies (order irrelevant).
 * @param headSha the PR's current head commit SHA the marker must match.
 */
export function hasFreshDeepQaPass(
  commentBodies: readonly string[],
  headSha: string,
): boolean {
  const trimmed = headSha.trim();
  if (trimmed.length === 0) return false;
  const marker = renderDeepQaPassMarker(trimmed);
  return commentBodies.some((body) => body.includes(marker));
}

export type DeepQaAction = "proceed" | "bounce" | "block-and-escalate";

export interface DeepQaDecision {
  /**
   * - `proceed` — current verdict is not a FAIL; the normal step-10 routing
   *   (PASS / PASS-pending-CI) applies, no T4-specific remediation.
   * - `bounce` — 1st deep-QA FAIL on this PR: comment findings + re-label
   *   `ready-for-agent` (the universal #739 remediation loop).
   * - `block-and-escalate` — 2nd+ consecutive deep-QA FAIL: block the PR and
   *   add the source issue to the `/hydra-review` pickup set (`ready-for-human`
   *   + structured reason). No new operator channel, no new verdict literal.
   */
  action: DeepQaAction;
  /**
   * The 1-based fail number this verdict represents on this PR. Undefined when
   * `action === "proceed"` (the verdict wasn't a FAIL, so nothing was counted).
   */
  failNumber?: number;
  /** Human-readable reason for the routing decision (for the QA report body). */
  reason: string;
}

/**
 * Decide the T4 deep-QA remediation action from the current review verdict and
 * the PR's prior comment bodies.
 *
 * The fail number is derived **live** from how many prior comments already
 * carry `DEEP_QA_FAIL_MARKER` — the PR is the ledger, there is no separate
 * counter. `failNumber = priorMarkers + 1`. The first FAIL (`failNumber === 1`)
 * bounces; the second-or-later (`failNumber >= 2`) blocks-and-escalates.
 *
 * Tiering is the caller's job (the playbook reads `GET /api/tier` and only runs
 * this branch for T4). This helper does NOT change the four-verdict literal
 * `decide.py` consumes — block-and-escalate is expressed through the existing
 * `ready-for-human` pickup set, not a new `FinalVerdict`.
 *
 * @param currentVerdict the folded T4 review verdict for this pass
 *   (`"PASS" | "FAIL"`) — the per-reviewer/adversarial fold, before CI folding.
 * @param priorPrComments the bodies of comments already posted on the PR (the
 *   durable per-attempt ledger). Order does not matter; only the marker count.
 */
export function decideDeepQaAction(
  currentVerdict: ReviewVerdict,
  priorPrComments: readonly string[],
): DeepQaDecision {
  if (currentVerdict !== "FAIL") {
    return {
      action: "proceed",
      reason:
        "T4 deep-QA: review did not FAIL — normal verdict routing applies, no remediation.",
    };
  }

  const priorFailMarkers = priorPrComments.filter((c) =>
    c.includes(DEEP_QA_FAIL_MARKER),
  ).length;
  const failNumber = priorFailMarkers + 1;

  if (failNumber >= 2) {
    return {
      action: "block-and-escalate",
      failNumber,
      reason:
        `T4 deep-QA: ${failNumber}th consecutive Verifier-Core FAIL on this PR — ` +
        "block the PR and add the source issue to the /hydra-review pickup set " +
        "(ready-for-human + structured reason). No further auto-bounce.",
    };
  }

  return {
    action: "bounce",
    failNumber,
    reason:
      "T4 deep-QA: first Verifier-Core FAIL on this PR — comment findings and " +
      "bounce to a dev agent (re-label ready-for-agent), the universal remediation loop.",
  };
}

// ---------------------------------------------------------------------------
// Convergent QA (issue #4735): round cap, re-review context.
//
// A 150-PR audit found 17 of 67 FAIL rounds raised a blocker that had already
// existed at an earlier round, and single PRs bounced up to 7 times. Two rules
// make re-review convergent, both read from the `QA-Verdict:` trailers on the
// PR (the PR is the ledger; no new Redis key or counter):
//
// - Round cap: the 3rd FAIL round on a T1–T3 PR escalates to the operator
//   (`ready-for-human`) instead of bouncing to dev again. T4 keeps its own
//   2nd-fail rule, `decideDeepQaAction`, unchanged.
// - Re-review context (prompt only): after a FAIL, reviewers also get the prior
//   findings table and, when the prior `sha=` is safely usable,
//   `git diff <prior sha>..HEAD`. They still review the FULL diff, and
//   `foldReviewFindings` alone decides the verdict: no code here filters,
//   demotes or narrows a finding (operator decision on #4735, after two QA
//   rounds found fail-open holes in a code-level re-review filter).
//
// Pure, never throws.
// ---------------------------------------------------------------------------

/** The FAIL round (1-based, per PR) at which T1–T3 QA escalates instead of bouncing. */
export const QA_FAIL_ROUND_CAP = 3;

/**
 * The marker text the step-6.6 admission-gate skip path puts in its
 * `REVIEW_REPORT` (issue #4758). Step 10's `CURRENT_REVIEWED` case greps this
 * literal so a CI-only skip round never counts toward the round cap. Both
 * sites are shell in the playbook, so no TS code reads this constant: it is the
 * single source the drift test pins those two playbook literals against.
 */
export const QA_ADMISSION_SKIP_MARKER = "Review skipped by the admission gate";

/**
 * Label routing for an escalated issue and its PR. Every dev lane keys on
 * `ready-for-agent` (dev_orch, the GLM drainer via `glmLane`) or
 * `needs-dev-resume` (the pinned resume / GLM forward-fix), so both are
 * removed; `ready-for-human` on the PR also drops it from collect-state's
 * dev-resume pick, which skips a `ready-for-human` PR.
 */
export const QA_ESCALATION_LABELS: {
  issueRemove: readonly string[];
  issueAdd: readonly string[];
  prAdd: readonly string[];
} = {
  issueRemove: ["needs-qa", "ready-for-agent", "needs-dev-resume", "in-progress"],
  issueAdd: ["ready-for-human"],
  prAdd: ["ready-for-human"],
};

export type QaRoundAction = "proceed" | "bounce" | "escalate" | "deep-qa";

export interface QaRoundDecision {
  /**
   * - `proceed` — the verdict is not a FAIL; normal routing.
   * - `bounce` — FAIL rounds 1–2: the universal remediation loop.
   * - `escalate` — FAIL round 3+ on T1–T3: `ready-for-human`, no dev bounce.
   * - `deep-qa` — T4: `decideDeepQaAction` owns the routing (unchanged).
   */
  action: QaRoundAction;
  /** The round this verdict's trailer carries (`nextQaVerdictRound`). */
  round: number;
  /** 1-based FAIL round this verdict represents; null unless bounce/escalate. */
  failRound: number | null;
  reason: string;
}

/**
 * Bounce or escalate a T1–T3 FAIL, from the FAIL rounds already on the PR.
 * Only REVIEWED FAIL rounds count: a round whose comment has a `### Findings`
 * table (`priorFindingsSection`). A CI-only `skip-required-failed` round
 * reviewed nothing, so an ambient red required check can never walk a PR to
 * the cap (PR #4759 QA r1). `failRound` = reviewed prior FAIL rounds (by
 * `round=`) + 1 when the current round was reviewed (`currentReviewed`,
 * default true); a CI-only current round never escalates. A null tier is
 * routed like T1–T3, the same as the playbook's step-10 FAIL block.
 */
export function decideQaRoundAction(input: {
  tier: number | null;
  verdict: FinalVerdict | string;
  pr: number;
  priorBodies: ReadonlyArray<string | null | undefined>;
  currentReviewed?: boolean;
}): QaRoundDecision {
  const round = nextQaVerdictRound(input.priorBodies, input.pr);
  if (input.tier === 4) {
    return { action: "deep-qa", round, failRound: null, reason: "T4 Verifier-Core: decideDeepQaAction owns FAIL routing (2nd FAIL escalates)." };
  }
  const verdict = String(input.verdict ?? "").trim() as FinalVerdict;
  if (!isFailVerdict(verdict)) {
    return { action: "proceed", round, failRound: null, reason: "Not a FAIL — normal verdict routing." };
  }
  const priorFails = qaVerdictHistory(input.priorBodies, input.pr).filter(
    (t) => isFailVerdict(t.verdict) && priorFindingsSection(input.priorBodies, input.pr, t.round) !== "",
  ).length;
  const currentReviewed = input.currentReviewed !== false;
  const failRound = priorFails + (currentReviewed ? 1 : 0);
  if (currentReviewed && failRound >= QA_FAIL_ROUND_CAP) {
    return {
      action: "escalate",
      round,
      failRound,
      reason: `FAIL round ${failRound} on this PR (cap ${QA_FAIL_ROUND_CAP}) — escalate to the operator (ready-for-human); no further dev bounce.`,
    };
  }
  return {
    action: "bounce",
    round,
    failRound,
    reason: `FAIL round ${failRound} of ${QA_FAIL_ROUND_CAP} — bounce to dev (the universal remediation loop).`,
  };
}

export type QaEscalationRecommendation = "redesign" | "accept-with-follow-ups" | "close";

const RECOMMENDATION_LABEL: Record<QaEscalationRecommendation, string> = {
  redesign: "redesign via grill",
  "accept-with-follow-ups": "accept with follow-ups",
  close: "close",
};

/**
 * Recommend how the operator should resolve an escalated PR, from its FAIL
 * rounds (in round order). A high blocker still open, or blockers that are
 * not falling, means the approach is not converging → redesign. Fewer,
 * medium-or-lower blockers than round 1 → accept with follow-ups. `close` is
 * always offered as an option but is the operator's call, never computed.
 */
export function recommendQaEscalation(
  failRounds: ReadonlyArray<Pick<QaVerdictTrailer, "blockers" | "maxSeverity">>,
): { recommendation: QaEscalationRecommendation; reason: string } {
  const first = failRounds[0];
  const last = failRounds[failRounds.length - 1];
  if (!first || !last) {
    return { recommendation: "redesign", reason: "No FAIL rounds could be read — review the PR from scratch." };
  }
  if (last.maxSeverity === "high") {
    return { recommendation: "redesign", reason: "A high-severity blocker is still open in the latest round — the approach likely needs a redesign." };
  }
  if (last.blockers < first.blockers) {
    return {
      recommendation: "accept-with-follow-ups",
      reason: `Blockers fell from ${first.blockers} to ${last.blockers} and none is high — the rest may be fine as tracked follow-ups.`,
    };
  }
  return { recommendation: "redesign", reason: `Blockers did not fall (${first.blockers} → ${last.blockers}) — the rounds are not converging.` };
}

/**
 * The escalation comment body (before the trailer): one table row per QA
 * round on the PR (last 10), the recommendation, and the three options.
 * Rounds come from the PR's trailers plus the current trailer; an
 * unparseable current trailer is simply left out, never fatal.
 */
export function renderQaEscalationSummary(input: {
  pr: number;
  priorBodies: ReadonlyArray<string | null | undefined>;
  currentTrailer: string;
}): string {
  const history = qaVerdictHistory([...input.priorBodies, input.currentTrailer], input.pr);
  const fails = history.filter((t) => isFailVerdict(t.verdict));
  const rec = recommendQaEscalation(fails);
  const rows = history.slice(-10).map((t) => `| ${t.round} | ${t.verdict} | ${t.sha} | ${t.blockers} | ${t.maxSeverity} |`);
  return [
    `This PR reached the QA round cap (${QA_FAIL_ROUND_CAP} reviewed FAIL rounds), so QA is not bouncing it to dev again.`,
    "",
    "| Round | Verdict | SHA | Blockers | Max severity |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    `**Recommendation: ${RECOMMENDATION_LABEL[rec.recommendation]}** — ${rec.reason}`,
    "",
    "Options: (1) **redesign** — re-grill the issue (`hydra-grill`) and close this PR; " +
      "(2) **accept with follow-ups** — merge after your review and file the open findings as issues; " +
      "(3) **close** — close the PR and the issue. Each round's findings table is in the QA comments on the PR.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Phase head (issue #5079, INV-3): the ONE composed entry the round-action
// step binds to. T1-T3: decideQaRoundAction (+ renderQaEscalationSummary when
// it escalates). T4: decideDeepQaAction (+ the SHA-bound PASS marker). No new
// rule — every branch below is owned by the helpers it calls.
// ---------------------------------------------------------------------------

export interface DecideRoundInput {
  tier: number | null;
  /** The final verdict literal (PASS / FAIL / PASS-pending-CI / FAIL-pending-CI). */
  verdict: FinalVerdict | string;
  /** The folded review verdict, the input of the T4 deep-QA loop. */
  reviewVerdict: ReviewVerdict;
  pr: number;
  headSha: string;
  priorBodies: ReadonlyArray<string | null | undefined>;
  currentReviewed?: boolean;
  /** The current round's rendered trailer (for the escalation summary table). */
  currentTrailer?: string;
}

export interface DecideRoundResult {
  round: QaRoundDecision;
  /** Set exactly when `round.action === "deep-qa"` (T4). */
  deepQa: DeepQaDecision | null;
  /** The T4 `Verifier-Core deep-QA: PASS @ <sha>` line; set only when `deepQa.action === "proceed"`. */
  passMarker: string | null;
  /** The structured escalation comment; set exactly when `round.action === "escalate"`. */
  escalationSummary: string | null;
  /** The escalation label sets, always present so the playbook spells no label name (issue #5081). */
  labels: typeof QA_ESCALATION_LABELS;
  /** `DEEP_QA_FAIL_MARKER` when the T4 action is bounce / block-and-escalate, else null (issue #5081). */
  failMarker: string | null;
}

export function decideRound(input: DecideRoundInput): DecideRoundResult {
  const round = decideQaRoundAction({
    tier: input.tier,
    verdict: input.verdict,
    pr: input.pr,
    priorBodies: input.priorBodies,
    currentReviewed: input.currentReviewed,
  });
  const deepQa =
    round.action === "deep-qa"
      ? decideDeepQaAction(
          // A T4 FAIL driven by CI alone (review PASS, a required check red)
          // is still a deep-QA FAIL: it must bounce and be counted, never
          // "proceed" with a PASS marker (QA round-1 finding on #5306).
          String(input.verdict).startsWith("FAIL") ? "FAIL" : input.reviewVerdict,
          input.priorBodies.map((b) => String(b ?? "")),
        )
      : null;
  // Only a T4 PASS carries the SHA-bound proof `hasFreshDeepQaPass` trusts;
  // a bounce / block-and-escalate (FAIL) must never emit it.
  const passMarker = deepQa?.action === "proceed" ? renderDeepQaPassMarker(input.headSha) : null;
  const escalationSummary =
    round.action === "escalate"
      ? renderQaEscalationSummary({
          pr: input.pr,
          priorBodies: input.priorBodies,
          currentTrailer: input.currentTrailer ?? "",
        })
      : null;
  const failMarker =
    deepQa?.action === "bounce" || deepQa?.action === "block-and-escalate" ? DEEP_QA_FAIL_MARKER : null;
  return { round, deepQa, passMarker, escalationSummary, labels: QA_ESCALATION_LABELS, failMarker };
}

// ---------------------------------------------------------------------------
// Reviewer commit, class A (issue #5267, ADR-0046 Decision 2; epic #5255).
//
// When the `reviewer-commits` rollout stage is `A` or `A+B`, a round whose
// EVERY blocking finding sits in a class-A location (the PR body, docs,
// changelog, generated inventories, ratchet baselines) may be repaired by the
// reviewer itself instead of bouncing to dev. The decision is pure and
// all-or-nothing: one blocking finding anywhere else makes the whole round
// `none` and the ordinary FAIL routing runs unchanged. It never edits, filters
// or re-grades a finding (the fold owns the verdict). All I/O lives in
// src/qa/phases.ts and the playbook's step 9.4.
// ---------------------------------------------------------------------------

export type ReviewerCommitReason =
  | "stage-off"
  | "tier-fence"
  | "verifier-core"
  | "one-way-door"
  | "no-blocking"
  | "ineligible-finding"
  | "out-of-scope"
  | "decision-error"
  | "class-a-fixable";

export interface ReviewerCommitDecision {
  action: "none" | "commit-a";
  reason: ReviewerCommitReason;
  detail: string;
  /** Class-A paths named by BLOCKING findings: every one must end up staged (empty unless commit-a). */
  blockingPaths: string[];
  /** Class-A paths named only by low follow-ups: an optional subset may ride along, none is required. */
  followUpPaths: string[];
  /** True when a blocking finding is located at the PR body. */
  bodyFix: boolean;
}

export interface ReviewerCommitInput {
  /** The EFFECTIVE `reviewer-commits` switch (read from the QA session's master-based tree). */
  stage: ReviewerCommitsValue;
  tier: number | null;
  /** The PR's full changed-file list. */
  changedPaths: readonly string[];
  /** Unified diff of the PR (empty/unparseable => door `unknown` => refuse). */
  diff: string;
  /** `fold.blocking[]` rows (the rows that set blockers>0). */
  blocking: ReadonlyArray<{ location: string }>;
  /** `fold.followUps[]` rows; lows at class-A locations may ride along. */
  followUps?: ReadonlyArray<{ location: string }>;
  /** Paths listed under the PR body's `## Files out of scope`; null = unreadable body (fail closed). */
  outOfScope: readonly string[] | null;
}

const noReviewerCommit = (reason: ReviewerCommitReason, detail: string): ReviewerCommitDecision => ({
  action: "none",
  reason,
  detail,
  blockingPaths: [],
  followUpPaths: [],
  bodyFix: false,
});

/** The repo path a finding location names, or null for a placeholder / non-path. */
export function reviewerCommitLocationPath(location: string): string | null {
  let s = String(location ?? "").replace(/\s+/g, " ").trim();
  s = s.replace(/^(["'`])(.*)\1$/, "$2").trim();
  s = s.replace(/\s*\([^)]*\)\s*$/, "").trim();
  s = s.replace(/(?:[:#]\s*L?\d+(?:[-:]\d+)*|\s+L\d+)$/i, "").trim();
  s = s.replace(/^\.\//, "");
  if (!/^[A-Za-z0-9_.\-/]+$/.test(s)) return null;
  return s.includes("/") || s.includes(".") ? s : null;
}

/** Paths listed under a PR body's `## Files out of scope` heading (backticked or bare bullets). */
export function parseFilesOutOfScope(body: string): string[] {
  const lines = String(body ?? "").split(/\r?\n/);
  const out: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) {
      inSection = /^#{1,6}\s+files out of scope\b/i.test(line);
      continue;
    }
    if (!inSection) continue;
    const ticks = [...line.matchAll(/`([^`]+)`/g)].map((m) => (m[1] as string).trim());
    if (ticks.length > 0) {
      out.push(...ticks);
      continue;
    }
    const bullet = /^\s*[-*]\s+(\S+)/.exec(line);
    if (bullet) out.push(bullet[1] as string);
  }
  return out.map((p) => p.replace(/^\.\//, "")).filter((p) => p !== "");
}

function isOutOfScope(path: string, outOfScope: readonly string[]): boolean {
  return outOfScope.some((o) => (o.endsWith("/") ? path.startsWith(o) : path === o || path.startsWith(`${o}/`)));
}

/**
 * Decide whether the reviewer may repair this round itself with a class-A
 * commit. Pure, total, never throws (STD-VERIFY-NEVER-THROW). Fences, in order:
 * stage, tier (T4 / unknown), Verifier Core, one-way/unknown door; then
 * all-or-nothing eligibility of every blocking finding.
 */
export function decideReviewerCommit(input: ReviewerCommitInput): ReviewerCommitDecision {
  try {
    if (input.stage !== "A" && input.stage !== "A+B") {
      return noReviewerCommit("stage-off", "reviewer-commits rollout stage is off");
    }
    const tier = typeof input.tier === "number" && Number.isFinite(input.tier) && input.tier >= 1 ? input.tier : null;
    if (tier === null || tier >= 4) {
      return noReviewerCommit("tier-fence", "no reviewer commits on T4 or an unknown tier");
    }
    const changed = input.changedPaths.map((p) => String(p ?? "").trim()).filter((p) => p !== "");
    if (changed.some((p) => isVerifierCore(p))) {
      return noReviewerCommit("verifier-core", "the PR touches Verifier Core");
    }
    const door = detectOneWayDoor({ paths: changed, diff: input.diff });
    if (requiresOneWayDepth(door)) {
      return noReviewerCommit("one-way-door", `door is ${door.door}: one-way and unknown refuse`);
    }
    if (input.blocking.length === 0) {
      return noReviewerCommit("no-blocking", "no blocking finding to repair");
    }
    const blockingPaths: string[] = [];
    const followUpPaths: string[] = [];
    let bodyFix = false;
    const consider = (location: string, blocking: boolean): ReviewerCommitDecision | null => {
      if (/^\s*pr body\s*$/i.test(String(location ?? ""))) {
        bodyFix = true;
        return null;
      }
      const path = reviewerCommitLocationPath(location);
      const cls = path === null ? "deny" : classifyQaFixPath(path);
      if (path === null || (cls !== "A" && cls !== "AB")) {
        return blocking
          ? noReviewerCommit("ineligible-finding", `blocking finding at ${JSON.stringify(location)} is not class A`)
          : null;
      }
      if (input.outOfScope === null || isOutOfScope(path, input.outOfScope)) {
        return blocking
          ? noReviewerCommit("out-of-scope", `${path} is listed under Files out of scope or the scope is unreadable`)
          : null;
      }
      const into = blocking ? blockingPaths : followUpPaths;
      if (!into.includes(path)) into.push(path);
      return null;
    };
    for (const f of input.blocking) {
      const refusal = consider(f.location, true);
      if (refusal) return refusal;
    }
    for (const f of input.followUps ?? []) consider(f.location, false);
    // A path that is also blocking is required, never merely optional.
    const optionalPaths = followUpPaths.filter((p) => !blockingPaths.includes(p));
    return {
      action: "commit-a",
      reason: "class-a-fixable",
      detail: `every blocking finding is class A (${blockingPaths.length} path(s)${bodyFix ? " + PR body" : ""})`,
      blockingPaths,
      followUpPaths: optionalPaths,
      bodyFix,
    };
  } catch (err) {
    console.error("[round-action] decideReviewerCommit failed; refusing the commit path:", err);
    return noReviewerCommit("decision-error", "decision threw; fail closed");
  }
}


// ---------------------------------------------------------------------------
// Deterministic re-verify helpers for playbook step 9.4 (issue #5267, round-3
// fix-forward). Pure; scripts/ci/qa-commit-checks.ts is their only caller.
// ---------------------------------------------------------------------------

const SECTION_HEADING = /^#{1,6}\s/;
const FILES_IN_SCOPE_HEADING = /^#{1,6}\s+files in scope\b/i;

function splitBodySections(body: string): Array<{ heading: string; lines: string[] }> {
  const lines = String(body ?? "").replace(/\r\n/g, "\n").replace(/\s+$/, "").split("\n");
  const sections: Array<{ heading: string; lines: string[] }> = [{ heading: "", lines: [] }];
  for (const line of lines) {
    if (SECTION_HEADING.test(line)) sections.push({ heading: line.trim(), lines: [] });
    else (sections[sections.length - 1] as { lines: string[] }).lines.push(line);
  }
  return sections;
}

/**
 * INV-6: a reviewer body fix may only ADD bullets under `## Files in scope`.
 * Every other section (Files out of scope, reconciliation, Closes-ref...) must
 * be byte-identical, the heading sequence unchanged, and the original lines of
 * Files in scope must survive in order. Never throws.
 */
export function checkBodyScopeEdit(orig: string, next: string): { ok: boolean; reason: string } {
  try {
    const a = splitBodySections(orig);
    const b = splitBodySections(next);
    if (a.length !== b.length || a.some((s, i) => s.heading !== (b[i] as { heading: string }).heading)) {
      return { ok: false, reason: "section headings changed" };
    }
    for (let i = 0; i < a.length; i++) {
      const x = a[i] as { heading: string; lines: string[] };
      const y = b[i] as { heading: string; lines: string[] };
      if (!FILES_IN_SCOPE_HEADING.test(x.heading)) {
        if (x.lines.join("\n") !== y.lines.join("\n")) {
          return { ok: false, reason: `section ${JSON.stringify(x.heading || "(preamble)")} was edited` };
        }
        continue;
      }
      let j = 0;
      for (const line of y.lines) {
        if (j < x.lines.length && line === x.lines[j]) j++;
        else if (!/^\s*$/.test(line) && !/^\s*[-*]\s+\S/.test(line)) {
          return { ok: false, reason: `Files in scope gained a non-bullet line ${JSON.stringify(line)}` };
        }
      }
      if (j !== x.lines.length) return { ok: false, reason: "an original Files in scope line was removed or edited" };
    }
    return { ok: true, reason: "only Files in scope bullets were added" };
  } catch (err) {
    console.error("[round-action] checkBodyScopeEdit failed; refusing:", err);
    return { ok: false, reason: "check threw; fail closed" };
  }
}

/**
 * True when a unified `-U0` diff of ONE file has a hunk touching or adjacent
 * to `line` (old or new side). A non-positive / non-integer line is false.
 */
export function diffHasHunkNearLine(diffU0: string, line: number): boolean {
  if (!Number.isInteger(line) || line < 1) return false;
  for (const m of String(diffU0 ?? "").matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const oa = Number(m[1]);
    const ol = m[2] === undefined ? 1 : Number(m[2]);
    const na = Number(m[3]);
    const nl = m[4] === undefined ? 1 : Number(m[4]);
    if ((line >= oa - 1 && line <= oa + ol) || (line >= na - 1 && line <= na + nl)) return true;
  }
  return false;
}

/**
 * scripts/ci/qa-verdict.ts — Pure helpers for the hydra-qa skill's
 * one-pass verdict classifier (issue #405).
 *
 * Background: before #405, the hydra-qa subagent looped waiting on pending
 * required CI checks (e.g. `mutation-test`) before emitting a verdict. This
 * meant a single QA run could span hours, sometimes long enough that the PR
 * auto-merged in the background. The new behaviour: run the code-review pass
 * once, then return one of four verdicts based on (review verdict + CI
 * state):
 *
 *   PASS              — review passed AND all required checks have concluded successfully
 *   FAIL              — review failed (regardless of CI), OR a required check failed/errored
 *   PASS-pending-CI   — review passed BUT some required checks are still queued/running
 *   FAIL-pending-CI   — reserved tier: review passed but a NON-required pending check would
 *                       likely block merge if it later fails. (Currently behaves like
 *                       PASS-pending-CI for the classifier; documented for the operator playbook
 *                       so autopilot can route accordingly.)
 *
 * The autopilot loop polls CI separately and re-dispatches QA (or merges) once
 * the pending state resolves. The subagent itself never blocks waiting on CI.
 *
 * This module is pure — no fs/network — so it can be unit-tested directly
 * (see test/hydra-qa-prompt-verdict.test.mts).
 */

/** Conclusion strings GitHub returns for a completed check. */
export type CheckConclusion =
  | "success"
  | "failure"
  | "cancelled"
  | "skipped"
  | "timed_out"
  | "action_required"
  | "neutral"
  | "stale"
  | "startup_failure"
  | null;

/** Status strings GitHub returns. `queued` / `in_progress` / `pending` mean "not yet decided". */
export type CheckStatus =
  | "queued"
  | "in_progress"
  | "pending"
  | "completed"
  | "waiting"
  | "requested";

export interface CheckState {
  name: string;
  status: CheckStatus;
  /** Only meaningful when status === "completed". */
  conclusion?: CheckConclusion;
  /** True when this check is gated by branch protection / required-status-checks. */
  required?: boolean;
}

export type ReviewVerdict = "PASS" | "FAIL";

export type FinalVerdict =
  | "PASS"
  | "FAIL"
  | "PASS-pending-CI"
  | "FAIL-pending-CI";

export interface VerdictResult {
  verdict: FinalVerdict;
  /** Human-readable reason — used in the QA report body. */
  reason: string;
  /** The exact checks block included in the QA report (one row per check). */
  checks: Array<{
    name: string;
    status: CheckStatus;
    conclusion: CheckConclusion | "—";
    required: boolean;
  }>;
  /** Summary counts for quick scanning. */
  summary: {
    total: number;
    passed: number;
    failed: number;
    pending: number;
    requiredPending: number;
    requiredFailed: number;
  };
}

const PENDING_STATUSES: ReadonlySet<CheckStatus> = new Set([
  "queued",
  "in_progress",
  "pending",
  "waiting",
  "requested",
]);

const SUCCESS_CONCLUSIONS: ReadonlySet<Exclude<CheckConclusion, null>> = new Set([
  "success",
  "skipped",
  "neutral",
]);

/**
 * Fold caller-supplied casing to the lowercase-canonical tokens the
 * PENDING_STATUSES / SUCCESS_CONCLUSIONS sets are keyed on. GitHub's GraphQL
 * API (surfaced verbatim by `gh pr view --json statusCheckRollup`) returns
 * `status` and `conclusion` as UPPERCASE enums (QUEUED, IN_PROGRESS,
 * COMPLETED, SUCCESS, ...). Without this fold an uppercase `QUEUED` matches
 * neither the pending nor the completed branch, so a still-queued check
 * silently counts as "concluded" and the classifier falls through to a
 * false-green PASS (issue #761). The CheckStatus/CheckConclusion union types
 * stay lowercase-canonical (the domain vocabulary); casing is folded here at
 * the external-input boundary, not modeled in the type. This is defense in
 * depth — the hydra-qa playbook also ascii_downcases — so the classifier is
 * correct even if a future caller forwards raw casing.
 */
function normaliseStatus(status: CheckState["status"]): CheckStatus {
  return (typeof status === "string" ? status.toLowerCase() : status) as CheckStatus;
}

function normaliseConclusion(
  conclusion: CheckState["conclusion"],
): CheckConclusion | undefined {
  if (conclusion === null || conclusion === undefined) return conclusion ?? undefined;
  return (
    typeof conclusion === "string" ? conclusion.toLowerCase() : conclusion
  ) as CheckConclusion;
}

function isPending(c: CheckState): boolean {
  return PENDING_STATUSES.has(normaliseStatus(c.status));
}

function isSuccess(c: CheckState): boolean {
  if (normaliseStatus(c.status) !== "completed") return false;
  const conclusion = normaliseConclusion(c.conclusion);
  if (conclusion === null || conclusion === undefined) return false;
  return SUCCESS_CONCLUSIONS.has(conclusion);
}

function isFailure(c: CheckState): boolean {
  if (normaliseStatus(c.status) !== "completed") return false;
  const conclusion = normaliseConclusion(c.conclusion);
  if (conclusion === null || conclusion === undefined) return false;
  return !SUCCESS_CONCLUSIONS.has(conclusion);
}

/**
 * Classify a QA verdict in one pass. Never blocks/waits/polls.
 *
 * Decision table:
 *
 *   review=FAIL                            → FAIL                (CI state ignored)
 *   review=PASS, required check failed     → FAIL                (won't merge anyway)
 *   review=PASS, required checks pending   → PASS-pending-CI     (autopilot polls)
 *   review=PASS, optional checks pending,
 *     no required failures                 → PASS-pending-CI     (treated same; documented)
 *   review=PASS, everything green          → PASS
 */
export function classifyVerdict(
  reviewVerdict: ReviewVerdict,
  checks: CheckState[],
): VerdictResult {
  const normalised = checks.map((c) => ({
    name: c.name,
    status: normaliseStatus(c.status),
    conclusion: (normaliseConclusion(c.conclusion) ?? "—") as CheckConclusion | "—",
    required: c.required ?? false,
  }));

  const total = checks.length;
  const passed = checks.filter(isSuccess).length;
  const failed = checks.filter(isFailure).length;
  const pending = checks.filter(isPending).length;
  const requiredPending = checks.filter((c) => (c.required ?? false) && isPending(c)).length;
  const requiredFailed = checks.filter((c) => (c.required ?? false) && isFailure(c)).length;

  const summary = { total, passed, failed, pending, requiredPending, requiredFailed };

  // Review FAIL trumps everything.
  if (reviewVerdict === "FAIL") {
    return {
      verdict: "FAIL",
      reason: "Code review FAIL — see report body for unmet criteria.",
      checks: normalised,
      summary,
    };
  }

  // A required check has already failed — merge would be blocked, so emit FAIL.
  if (requiredFailed > 0) {
    const names = checks
      .filter((c) => (c.required ?? false) && isFailure(c))
      .map((c) => c.name)
      .join(", ");
    return {
      verdict: "FAIL",
      reason: `Required CI check(s) failed: ${names}`,
      checks: normalised,
      summary,
    };
  }

  // Required checks still pending → emit PASS-pending-CI and exit (no looping).
  if (requiredPending > 0) {
    const names = checks
      .filter((c) => (c.required ?? false) && isPending(c))
      .map((c) => c.name)
      .join(", ");
    return {
      verdict: "PASS-pending-CI",
      reason: `Review PASS. Required CI still pending: ${names}. Autopilot will poll and merge once green.`,
      checks: normalised,
      summary,
    };
  }

  // No pending required checks, but optional checks pending → still emit
  // PASS-pending-CI so the operator/autopilot can see the unresolved state
  // in the verdict body. The classifier intentionally never returns PASS
  // while any check is pending — that's the whole bug fix.
  if (pending > 0) {
    const names = checks.filter(isPending).map((c) => c.name).join(", ");
    return {
      verdict: "PASS-pending-CI",
      reason: `Review PASS. Non-required check(s) still pending: ${names}. Safe to merge per branch protection, but autopilot may wait.`,
      checks: normalised,
      summary,
    };
  }

  // All checks concluded successfully (or were skipped/neutral).
  return {
    verdict: "PASS",
    reason: "Review PASS. All CI checks concluded successfully.",
    checks: normalised,
    summary,
  };
}

/**
 * T3 adversarial-QA aggregation (issue #739).
 *
 * Tier model (ADR-0015, monotonic T1<T2<T3<T4): a T3-classified diff must
 * survive an *adversarial* (refutation-framed) review before it auto-merges.
 * Instead of a single standard QA pass, the playbook fans out to TWO
 * independent reviewers — each prompted to actively find a reason the change
 * is wrong / regresses something, neither told the other exists. The diff
 * passes only if BOTH reviewers surface no real blocker; a single real
 * blocker from EITHER reviewer is a FAIL.
 *
 * This helper is the pure aggregation rule. It does NOT change the verdict
 * literal consumed by decide.py — it folds the two reviewer verdicts into the
 * single `ReviewVerdict` ("PASS" | "FAIL") that `classifyVerdict` already
 * takes. The CI-state classification downstream is unchanged; this is purely
 * additive verification depth (the issue: "no policy change here").
 *
 * Tiering is the caller's job (the playbook reads `GET /api/tier`). For T1/T2
 * the caller passes a single reviewer verdict straight to `classifyVerdict`
 * and never calls this; for T3 (and T4, which inherits T3 depth) the caller
 * collects two reviewer verdicts and folds them here first.
 */
export interface AdversarialReviewResult {
  /** AND over the two reviewers — PASS iff neither found a real blocker. */
  reviewVerdict: ReviewVerdict;
  /** Human-readable reason, naming the blocking reviewer(s) on FAIL. */
  reason: string;
}

/**
 * Fold two independent refutation reviewers into one review verdict.
 *
 * `PASS` iff BOTH reviewers returned `PASS` (neither surfaced a real
 * blocker). Any single `FAIL` short-circuits the aggregate to `FAIL` — the
 * defining asymmetry of refutation framing: one refuter is enough to bounce.
 *
 * @param reviewerA verdict from the first independent reviewer
 * @param reviewerB verdict from the second independent reviewer
 */
export function aggregateAdversarialReview(
  reviewerA: ReviewVerdict,
  reviewerB: ReviewVerdict,
): AdversarialReviewResult {
  const aFail = reviewerA === "FAIL";
  const bFail = reviewerB === "FAIL";

  if (aFail && bFail) {
    return {
      reviewVerdict: "FAIL",
      reason:
        "Adversarial QA (T3): both refutation reviewers surfaced a real blocker.",
    };
  }
  if (aFail) {
    return {
      reviewVerdict: "FAIL",
      reason:
        "Adversarial QA (T3): reviewer A surfaced a real blocker (reviewer B clean).",
    };
  }
  if (bFail) {
    return {
      reviewVerdict: "FAIL",
      reason:
        "Adversarial QA (T3): reviewer B surfaced a real blocker (reviewer A clean).",
    };
  }
  return {
    reviewVerdict: "PASS",
    reason:
      "Adversarial QA (T3): both independent refutation reviewers found no real blocker.",
  };
}

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

/**
 * Render the `checks:` block as a markdown table for inclusion in the
 * QA report body. Stable column ordering, deterministic for testability.
 */
export function renderChecksBlock(result: VerdictResult): string {
  if (result.checks.length === 0) {
    return "_No CI checks reported for this PR._";
  }
  const header = "| Check | Status | Conclusion | Required |";
  const sep = "|-------|--------|------------|----------|";
  const rows = result.checks.map(
    (c) =>
      `| ${c.name} | ${c.status} | ${c.conclusion} | ${c.required ? "yes" : "no"} |`,
  );
  return [header, sep, ...rows].join("\n");
}

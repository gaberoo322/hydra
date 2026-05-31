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

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
 * The ONE definition of a "red required check" (issue #4746): a check gated
 * by branch protection (`required`) that has COMPLETED with a non-success
 * conclusion (anything outside `SUCCESS_CONCLUSIONS` — failure, cancelled,
 * timed_out, action_required, startup_failure, stale, …). Returns the names
 * in input order.
 *
 * Every consumer derives from this helper: `classifyVerdict`'s
 * `requiredFailed` count and FAIL reason, and the hydra-qa playbook's
 * `RED_REQUIRED_LIST` (the names quoted in bounce comments and the
 * worst-finding summary) plus the skip path's `BLOCKERS` count. Before #4746
 * the playbook re-derived both with two divergent jq filters, one of which
 * `join`ed objects and so always produced an empty list.
 */
export function redRequiredChecks(checks: readonly CheckState[]): string[] {
  return checks
    .filter((c) => (c.required ?? false) && isFailure(c))
    .map((c) => c.name);
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
  const redRequired = redRequiredChecks(checks);
  const requiredFailed = redRequired.length;

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
    return {
      verdict: "FAIL",
      reason: `Required CI check(s) failed: ${redRequired.join(", ")}`,
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
 * Change-shape reviewer sizing (issue #4733). Pure, no fs/network.
 *
 * The tier classifier is Verifier Core (T4) and lands most PRs at T3, so a
 * doc-only PR paid the full T3 two-reviewer × two-axis (4 sub-agent) fan-out.
 * Rather than touch the classifier, hydra-qa sizes its fan-out from the SHAPE
 * of the changed-file list:
 *
 *   code        — anything under src/, scripts/, dashboard/src/, .github/, or
 *                 any other path that is not doc / test / prompt. A mixed diff
 *                 with even ONE code path is `code`.
 *   prompt-only — prompt/skill surfaces (playbook `.md` under
 *                 docs/operator-playbooks/, `.claude/skills/**.md`,
 *                 config/agents/, config/feedback/).
 *   tests-only  — paths under test/.
 *   docs-only   — documentation: docs/**, or a `.md` outside the code dirs.
 *
 * A non-code MIX reports its most behavioural component (prompt > tests >
 * docs) so the literal set stays four-valued. An empty list is `code`
 * (fail-closed: no evidence of a narrow change buys full review).
 */
export type ChangeShape = "docs-only" | "tests-only" | "prompt-only" | "code";

/** Path prefixes that always make a diff `code`, regardless of extension. */
const CODE_PATH_PREFIXES = ["src/", "scripts/", "dashboard/src/", ".github/"] as const;

type NonCodeKind = "docs" | "tests" | "prompt";

function normalizeChangedPath(rawPath: string): string {
  return rawPath.trim().replace(/^\.\//, "");
}

/**
 * The ONE prompt/skill path list (issue #4733): shared by the change-shape
 * classifier and the playbook's step-6 Tier-1 Spec auto-bypass, so the two
 * cannot disagree about what "prompt-only" means.
 */
export function isPromptPath(rawPath: string): boolean {
  const p = normalizeChangedPath(rawPath);
  const isMarkdown = p.endsWith(".md");
  return (
    (p.startsWith("docs/operator-playbooks/") && isMarkdown) ||
    (p.startsWith(".claude/skills/") && isMarkdown) ||
    p.startsWith("config/agents/") ||
    p.startsWith("config/feedback/")
  );
}

/** True iff the list is non-empty and EVERY path is a prompt path. */
export function isPromptOnlyChange(paths: readonly string[]): boolean {
  const real = paths.filter((p) => typeof p === "string" && p.trim() !== "");
  return real.length > 0 && real.every(isPromptPath);
}

function classifyChangedPath(rawPath: string): NonCodeKind | "code" {
  const p = normalizeChangedPath(rawPath);
  if (CODE_PATH_PREFIXES.some((prefix) => p.startsWith(prefix))) return "code";
  if (isPromptPath(p)) return "prompt";
  const isMarkdown = p.endsWith(".md");
  if (p.startsWith("test/")) return "tests";
  // Non-.md playbook siblings (e.g. a hook `.settings.json`) register runtime
  // behaviour, so they stay `code` instead of falling into the docs arm.
  if (p.startsWith("docs/operator-playbooks/")) return "code";
  if (p.startsWith("docs/") || isMarkdown) return "docs";
  return "code";
}

/**
 * Classify a PR's changed-file list into its change shape. Any single `code`
 * path makes the whole diff `code` (a doc and a `src/` file together → code).
 * Callers pass `git diff --no-renames --name-only` so a rename contributes
 * BOTH its old and new path — a `src/` → `test/` move stays `code`.
 */
export function classifyChangeShape(paths: readonly string[]): ChangeShape {
  const kinds = new Set<NonCodeKind>();
  for (const raw of paths) {
    if (typeof raw !== "string" || raw.trim() === "") continue;
    const kind = classifyChangedPath(raw);
    if (kind === "code") return "code";
    kinds.add(kind);
  }
  if (kinds.size === 0) return "code";
  if (kinds.has("prompt")) return "prompt-only";
  if (kinds.has("tests")) return "tests-only";
  return "docs-only";
}

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

/**
 * Reviewer Admission Gate (issue #3815 — reduce the cost of the adversarial
 * fan-out). Pure, no fs/network — co-located with the fold it derives from so
 * the two cannot silently desync (INV-A: the gate is a derivation of the
 * verdict fold, never an independent policy).
 *
 * The T3/T4 fan-out (step 7 of the playbook) spawns 2-4 reviewer sub-agents and
 * is the second-largest token consumer in the system. In two situations a
 * reviewer's output PROVABLY cannot change the emitted verdict, so the entire
 * fan-out is dead work paid for in tokens:
 *
 *   A2 — `mergeStateStatus == DIRTY` (a merge conflict): the diff under review
 *        is not the diff that will merge, so any verdict computed over it is
 *        about a commit that cannot land. Defer (route to rebase); spawn zero
 *        reviewers.
 *   A1 — a required CI check has already concluded failure: `classifyVerdict`'s
 *        second branch returns `FAIL` on `requiredFailed > 0` for BOTH
 *        `reviewVerdict` values, so no reviewer output can alter it. For T1/T2/T3
 *        emit that FAIL and skip the fan-out; for T4 defer (INV-B — the gate may
 *        only DEFER a T4 review, never reduce its depth, because the T4 deep-QA
 *        routing needs a real review verdict the skip would not produce).
 *
 * `BLOCKED` is deliberately NOT a trigger (a reviewer's verdict IS load-bearing
 * there — `BLOCKED` covers "required checks still pending", where
 * `classifyVerdict` returns `PASS-pending-CI`, a verdict that still requires a
 * real review input). Only `DIRTY` and `requiredFailed > 0` are verdict-invariant
 * under the current fold.
 *
 * INV-E (fail-closed on every unknown): an unreachable tier classifier
 * (`tier === null`), or an unknown/absent `mergeStateStatus`, always ADMITS —
 * ambiguity buys MORE review, never less, mirroring the playbook's existing
 * `ADVERSARIAL=1`-on-empty-`PR_TIER` default.
 *
 * The caller (the playbook) is responsible for the routing: `admit` runs the
 * full fan-out; `defer` and `skip-required-failed` both strip `needs-qa` and
 * bounce to `ready-for-agent` (so the universal remediation loop re-queues QA
 * once the PR is rebased / CI is green — leaving `needs-qa` in place would
 * busy-loop hydra-qa every autopilot tick, issue #974). A deferred/skipped PR
 * is one that cannot merge on this pass, so INV-C holds by construction: every
 * PR that reaches auto-merge has been reviewed at full depth.
 *
 * This helper changes neither the verdict literal `decide.py` consumes nor the
 * `aggregateAdversarialReview` / `classifyVerdict` folds — it only declines to
 * spawn reviewers whose output is provably moot (INV-D).
 */
export type ReviewAdmissionAction = "admit" | "defer" | "skip-required-failed";

export interface ReviewAdmissionInput {
  checks: CheckState[];
  /**
   * Raw `gh pr view --json mergeStateStatus` value. GitHub returns one of
   * BEHIND / BLOCKED / CLEAN / DIRTY / HAS_HOOKS / UNSTABLE / UNKNOWN. Matched
   * case-insensitively; "" / "UNKNOWN" / nullish ⇒ fail-closed admit (INV-E).
   */
  mergeStateStatus: string;
  /**
   * PR Modification Tier (1-4) from `GET /api/tier` — the single tier authority.
   * `null` ⇒ the classifier was unreachable; fail-closed admit (INV-E).
   */
  tier: number | null;
}

export interface ReviewAdmissionDecision {
  action: ReviewAdmissionAction;
  /** Human-readable reason for the QA report / PR comment. */
  reason: string;
  /**
   * Present only for `skip-required-failed`: the single `FAIL` verdict the fold
   * already determined. The admission gate NEVER carries `PASS` — a skipped
   * review never yields PASS (INV-D).
   */
  verdict?: "FAIL";
}

/**
 * Decide whether the reviewer fan-out should launch at all. A derivation of the
 * verdict fold in this file, not an independent policy (INV-A): `requiredFailed`
 * is read from `classifyVerdict`'s own summary so the gate and the fold cannot
 * disagree about when a review is moot.
 *
 * @param input checks (the step-5 `statusCheckRollup`), the PR's
 *   `mergeStateStatus`, and its Modification Tier.
 */
export function decideReviewAdmission(
  input: ReviewAdmissionInput,
): ReviewAdmissionDecision {
  const { checks, mergeStateStatus, tier } = input;

  // INV-E — fail-closed on every unknown: full depth (admit) when we cannot
  // confirm the tier or the merge state. Never skip on missing data.
  const tierKnown = typeof tier === "number" && !Number.isNaN(tier);
  const ms =
    typeof mergeStateStatus === "string" ? mergeStateStatus.trim().toUpperCase() : "";
  const mergeStateKnown = ms !== "" && ms !== "UNKNOWN";
  if (!tierKnown || !mergeStateKnown) {
    return {
      action: "admit",
      reason:
        "Admission gate fail-closed: tier or mergeStateStatus unknown — running the full fan-out (ambiguity buys more review, never less).",
    };
  }

  // A2 — merge conflict (DIRTY). The diff under review is not the diff that
  // will merge, so a verdict over it is moot. Defer to a rebase. All tiers; for
  // T4 this is a DEFER (never a depth reduction), satisfying INV-B.
  if (ms === "DIRTY") {
    return {
      action: "defer",
      reason:
        "PR has a merge conflict (mergeStateStatus DIRTY) — the diff under review is not the diff that will merge. Deferring until the PR is rebased; the full review runs once it is clean.",
    };
  }

  // A1 — a required check has already concluded failure. Read the count from
  // classifyVerdict's own summary: when requiredFailed > 0, classifyVerdict
  // returns FAIL for BOTH review verdicts, so the fan-out is provably dead work
  // (INV-A). The executable property is pinned in the regression test.
  const requiredFailed = classifyVerdict("PASS", checks).summary.requiredFailed;
  if (requiredFailed > 0) {
    if (tier === 4) {
      // INV-B — the gate can only DEFER a T4 review. decideDeepQaAction needs a
      // real review verdict; skipping the fan-out would leave none, so defer
      // until CI concludes and the full Verifier-Core fan-out can run.
      return {
        action: "defer",
        reason:
          "T4 PR with a required CI check already failed — deferring until CI concludes, then the full Verifier-Core fan-out runs (INV-B: a T4 review is only ever deferred, never depth-reduced).",
      };
    }
    return {
      action: "skip-required-failed",
      reason:
        "A required CI check already failed — the review verdict cannot change the FAIL classifyVerdict returns regardless of the reviewers' finding (INV-A), so the fan-out is skipped.",
      verdict: "FAIL",
    };
  }

  // Every other state (CLEAN / BLOCKED / BEHIND / UNSTABLE / HAS_HOOKS with no
  // required failure): a reviewer's verdict can still change the outcome
  // (BLOCKED covers pending required checks → PASS-pending-CI, which requires a
  // real review). Run the full fan-out.
  return {
    action: "admit",
    reason: "Reviewer output may change the verdict — running the full fan-out.",
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

/**
 * The compact CI line for a verdict comment (issue #4734). The CI state
 * appears ONCE and lists ONLY the required checks that are not green (red
 * first, then pending) — the full per-check table was repeated every round
 * and pushed the median QA comment to 4.4k chars. Optional checks are
 * omitted: they never gate the merge. Derives the red set from
 * `redRequiredChecks` (the one definition, #4746).
 */
export function renderCiSummary(result: VerdictResult): string {
  if (result.checks.length === 0) {
    return "**CI:** _no checks reported for this PR._";
  }
  const required = result.checks.filter((c) => c.required);
  if (required.length === 0) {
    return "**CI:** no required checks reported.";
  }
  const red = new Set(
    redRequiredChecks(
      required.map((c) => ({
        name: c.name,
        status: c.status,
        conclusion: c.conclusion === "—" ? null : c.conclusion,
        required: true,
      })),
    ),
  );
  const pending = required
    .filter((c) => PENDING_STATUSES.has(c.status))
    .map((c) => c.name);
  const notGreen = [
    ...required.filter((c) => red.has(c.name)).map((c) => `\`${c.name}\` (${c.conclusion})`),
    ...pending.map((name) => `\`${name}\` (pending)`),
  ];
  const green = required.length - notGreen.length;
  if (notGreen.length === 0) {
    return `**CI:** all ${required.length} required checks green.`;
  }
  return `**CI:** ${green}/${required.length} required checks green. Not green: ${notGreen.join(", ")}.`;
}

// ---------------------------------------------------------------------------
// Severity-gated findings fold (issue #4734)
//
// Every reviewer finding carries `severity`, `file:line` and a concrete fix.
// The T1–T3 fold FAILs when ANY finding is medium or higher, OR when BOTH
// independent reviewers (A and B of the T3 fan-out) raise the same low
// finding. Otherwise it PASSes and the lone low findings become non-blocking
// follow-ups. T4 (and an unknown tier, fail-closed) keeps the pre-#4734
// any-blocker semantics: every finding blocks, folded through the unchanged
// `aggregateAdversarialReview`.
//
// The fold changes only how `REVIEW_VERDICT` is computed. The verdict
// literals, `classifyVerdict`, and decide.py are untouched. Pure, never throws.
// ---------------------------------------------------------------------------

/** A finding's severity. The rubric the reviewer prompts carry:
 *  high   — behaviour regression, data or work loss, or a weakened safety gate
 *  medium — a spec criterion unmet, or a real bug on a non-critical path
 *  low    — wording, comments, citations, style */
export type FindingSeverity = "high" | "medium" | "low";

/** Which review axis raised the finding. */
export type FindingAxis = "standards" | "spec";

/** One reviewer finding, as the step-8 aggregate transcribes it. */
export interface ReviewFinding {
  severity: FindingSeverity;
  axis: FindingAxis;
  /** The reviewer sub-agent that raised it, e.g. `reviewer-A-standards`. */
  reviewer: string;
  /** `path/to/file.ts:42` (or `path:12-18`); `PR body` for body findings. */
  location: string;
  finding: string;
  fix: string;
  /**
   * Optional dedupe key the aggregator sets when two reviewers raised the
   * same finding at different locations. Without it, findings are matched
   * by `location`.
   */
  key?: string;
}

/** One table row after merging the same finding raised by several reviewers. */
export interface FoldedFinding {
  severity: FindingSeverity;
  axis: FindingAxis;
  location: string;
  finding: string;
  fix: string;
  /** Every reviewer sub-agent that raised it, in input order. */
  reviewers: string[];
  /** Distinct independent reviewers (A / B, or `primary`) that raised it. */
  reviewerGroups: string[];
}

export interface FindingsFoldResult {
  reviewVerdict: ReviewVerdict;
  /** `severity-gated` for T1–T3; `any-blocker` for T4 / unknown tier. */
  mode: "severity-gated" | "any-blocker";
  /** Findings that block, worst first. */
  blocking: FoldedFinding[];
  /** Non-blocking follow-ups (lone low findings on T1–T3), worst first. */
  followUps: FoldedFinding[];
  /** `blocking.length` — the trailer's `blockers=` before red CI checks. */
  blockers: number;
  /** Worst blocking severity; `none` when nothing blocks. */
  maxSeverity: QaSeverity;
  /** One line (≤ 120 chars) naming the worst blocking finding, or "". */
  worstFinding: string;
  reason: string;
}

const SEVERITY_RANK: Record<FindingSeverity, number> = { high: 3, medium: 2, low: 1 };

function normaliseSeverity(raw: unknown): FindingSeverity {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  // Fail toward loud: a missing or unknown severity is treated as high.
  return s === "medium" || s === "low" || s === "high" ? s : "high";
}

function oneLine(raw: unknown): string {
  return String(raw ?? "").replace(/\s+/g, " ").trim();
}

/**
 * The independent reviewer a sub-agent belongs to: `reviewer-A-standards`
 * and `reviewer-A-spec` are both reviewer `A`. Every other name (the T1/T2
 * `standards` / `spec` pair, `reviewer-single`) is the one `primary`
 * reviewer, so the both-reviewers rule can only fire on the T3 fan-out.
 */
export function reviewerGroup(reviewer: string): string {
  const m = /^reviewer-([A-Za-z0-9]+)-(?:standards|spec)$/.exec(String(reviewer ?? "").trim());
  return m ? (m[1] as string).toUpperCase() : "primary";
}

/**
 * Coerce untrusted aggregate JSON into findings. Never throws: a non-array
 * yields `[]`, a non-object row is dropped, and a missing severity becomes
 * `high` so a malformed row can never downgrade a verdict.
 */
export function normaliseReviewFindings(raw: unknown): ReviewFinding[] {
  if (!Array.isArray(raw)) return [];
  const out: ReviewFinding[] = [];
  for (const row of raw) {
    if (row === null || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const axis = oneLine(r.axis).toLowerCase() === "spec" ? "spec" : "standards";
    const key = oneLine(r.key);
    out.push({
      severity: normaliseSeverity(r.severity),
      axis,
      reviewer: oneLine(r.reviewer) || "primary",
      location: oneLine(r.location ?? r.file) || "(no location)",
      finding: oneLine(r.finding) || "(no description)",
      fix: oneLine(r.fix) || "(no fix given)",
      ...(key ? { key } : {}),
    });
  }
  return out;
}

function mergeFindings(findings: readonly ReviewFinding[]): FoldedFinding[] {
  const byKey = new Map<string, FoldedFinding>();
  for (const f of findings) {
    const key = (f.key ?? f.location).trim().toLowerCase() || f.finding.toLowerCase();
    const group = reviewerGroup(f.reviewer);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        severity: f.severity,
        axis: f.axis,
        location: f.location,
        finding: f.finding,
        fix: f.fix,
        reviewers: [f.reviewer],
        reviewerGroups: [group],
      });
      continue;
    }
    if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[existing.severity]) {
      existing.severity = f.severity;
      existing.axis = f.axis;
      existing.finding = f.finding;
      existing.fix = f.fix;
    }
    if (!existing.reviewers.includes(f.reviewer)) existing.reviewers.push(f.reviewer);
    if (!existing.reviewerGroups.includes(group)) existing.reviewerGroups.push(group);
  }
  return [...byKey.values()];
}

function worstFirst(rows: FoldedFinding[]): FoldedFinding[] {
  // Array.prototype.sort is stable, so equal severities keep input order.
  return [...rows].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}

/**
 * Fold the reviewers' findings into one review verdict (issue #4734).
 *
 * - T1–T3: FAIL iff any finding is medium/high, or the same low finding was
 *   raised by BOTH independent reviewers. Lone lows → PASS + follow-ups.
 * - T4, or an unknown tier (`null`, fail-closed): unchanged any-blocker
 *   semantics — every finding blocks. The verdict is the pre-#4734
 *   `aggregateAdversarialReview` AND over reviewers A and B.
 */
export function foldReviewFindings(input: {
  tier: number | null;
  findings: unknown;
}): FindingsFoldResult {
  const tier = typeof input.tier === "number" && !Number.isNaN(input.tier) ? input.tier : null;
  const rows = mergeFindings(normaliseReviewFindings(input.findings));
  const anyBlocker = tier === null || tier >= 4;

  let blocking: FoldedFinding[];
  let followUps: FoldedFinding[];
  let reviewVerdict: ReviewVerdict;
  let reason: string;
  if (anyBlocker) {
    blocking = worstFirst(rows);
    followUps = [];
    // Per-reviewer verdicts (A / B), folded by the unchanged T3/T4 AND. A row
    // from a non-A/B reviewer still blocks: any finding at all is a FAIL.
    const failed = (g: string): ReviewVerdict =>
      blocking.some((r) => r.reviewerGroups.includes(g)) ? "FAIL" : "PASS";
    const agg = aggregateAdversarialReview(failed("A"), failed("B"));
    reviewVerdict = blocking.length > 0 ? "FAIL" : agg.reviewVerdict;
    reason =
      tier === null
        ? `Tier unknown — fail-closed to the any-blocker fold: ${agg.reason}`
        : `T4 Verifier-Core — any-blocker fold (unchanged): ${agg.reason}`;
  } else {
    const blocks = (r: FoldedFinding): boolean =>
      r.severity !== "low" || r.reviewerGroups.length >= 2;
    blocking = worstFirst(rows.filter(blocks));
    followUps = worstFirst(rows.filter((r) => !blocks(r)));
    reviewVerdict = blocking.length > 0 ? "FAIL" : "PASS";
    reason =
      blocking.length > 0
        ? `Severity-gated fold (T${tier}): ${blocking.length} blocking finding(s) — medium or higher, or a low raised by both reviewers.`
        : `Severity-gated fold (T${tier}): no medium/high finding and no low raised by both reviewers` +
          (followUps.length > 0 ? ` — ${followUps.length} non-blocking follow-up(s).` : ".");
  }

  const top = blocking[0];
  const worstFinding = top ? `${top.location} — ${top.finding}`.slice(0, 120) : "";
  return {
    reviewVerdict,
    mode: anyBlocker ? "any-blocker" : "severity-gated",
    blocking,
    followUps,
    blockers: blocking.length,
    maxSeverity: top ? top.severity : "none",
    worstFinding,
    reason,
  };
}

/**
 * The trailer's `blockers=` / `max_severity=` for a verdict: the fold's
 * blocking findings plus one `high` blocker per red required check (the
 * #4729 rule), so a CI-driven FAIL never renders `blockers=0`.
 */
export function trailerBlockerCounts(
  fold: Pick<FindingsFoldResult, "blockers" | "maxSeverity">,
  redRequired: readonly string[],
): { blockers: number; maxSeverity: QaSeverity } {
  const blockers = Math.max(0, fold.blockers) + redRequired.length;
  if (redRequired.length > 0) return { blockers, maxSeverity: "high" };
  return { blockers, maxSeverity: blockers > 0 ? fold.maxSeverity : "none" };
}

function cell(raw: string): string {
  return oneLine(raw).replace(/\|/g, "\\|");
}

/** Markdown findings table: severity, axis, reviewer, file:line, finding, fix. */
export function renderFindingsTable(rows: readonly FoldedFinding[]): string {
  const header = "| Severity | Axis | Reviewer | File:line | Finding | Fix |";
  const sep = "|---|---|---|---|---|---|";
  const body = rows.map(
    (r) =>
      `| ${r.severity} | ${r.axis} | ${cell(r.reviewers.join(", "))} | ${cell(r.location)} | ${cell(r.finding)} | ${cell(r.fix)} |`,
  );
  return [header, sep, ...body].join("\n");
}

/**
 * The step-8 `$REVIEW_REPORT`: the blocking findings table, the non-blocking
 * follow-ups, one short paragraph per axis, and the fan-out line. The CI
 * state is NOT here — step 10 adds it once, via `renderCiSummary`.
 */
export function renderReviewReport(input: {
  fold: FindingsFoldResult;
  standardsSummary: string;
  specSummary: string;
  fanoutReason?: string;
}): string {
  const { fold } = input;
  const parts: string[] = ["### Findings", ""];
  parts.push(fold.blocking.length > 0 ? renderFindingsTable(fold.blocking) : "_No blocking findings._");
  if (fold.followUps.length > 0) {
    parts.push("", "### Follow-ups (non-blocking)", "", renderFindingsTable(fold.followUps));
  }
  parts.push(
    "",
    "## Standards",
    "",
    oneLine(input.standardsSummary) || "_No summary._",
    "",
    "## Spec",
    "",
    oneLine(input.specSummary) || "_No summary._",
    "",
    fold.reason,
  );
  const fanout = oneLine(input.fanoutReason);
  if (fanout) parts.push(fanout);
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Canonical QA-Verdict trailer (issue #4729)
//
// Every hydra-qa verdict comment ends with exactly ONE machine-readable line:
//
//   QA-Verdict: <PASS|FAIL|PASS-pending-CI|FAIL-pending-CI> pr=<N> round=<k> sha=<head12> blockers=<n> max_severity=<high|medium|low|none>
//
// It replaces the drifting human headers (`> *Automated QA — …*`,
// `## hydra-qa verdict: PASS`, `## QA Verdict: PASS`) as the thing measurement
// keys on: `qa-catch-rate.ts` parses it first and attributes a verdict ONLY to
// the PR named by `pr=`, so a shared linked issue no longer leaks one PR's
// bounce onto its sibling. `round` = prior trailers on the same PR + 1.
//
// Pure — no fs/network. Never throws: malformed input parses to `null`.
// ---------------------------------------------------------------------------

/** The literal prefix of the canonical trailer line. */
export const QA_VERDICT_TRAILER_PREFIX = "QA-Verdict:";

/** Highest severity among a verdict's hard findings; `none` when blockers=0. */
export type QaSeverity = "high" | "medium" | "low" | "none";

/** The parsed fields of one `QA-Verdict:` trailer line. */
export interface QaVerdictTrailer {
  verdict: FinalVerdict;
  /** The PR this verdict is about — the ONLY PR it may be attributed to. */
  pr: number;
  /** 1-based review round on this PR. */
  round: number;
  /**
   * Head SHA reviewed: lowercase hex, 12 chars when rendered (7–40 accepted
   * on parse), or the `QA_VERDICT_UNKNOWN_SHA` sentinel when the head SHA was
   * empty/unknown at render time — which never matches any head SHA
   * (`qaVerdictShaMatches`).
   */
  sha: string;
  /** Count of hard findings (a red required check counts as one high blocker). */
  blockers: number;
  maxSeverity: QaSeverity;
}

const QA_SEVERITIES: readonly QaSeverity[] = ["high", "medium", "low", "none"];

/** Every `FinalVerdict` literal, in the order the parser tries them. */
const FINAL_VERDICTS: readonly FinalVerdict[] = [
  "PASS-pending-CI",
  "FAIL-pending-CI",
  "PASS",
  "FAIL",
];

/**
 * The documented `sha=` sentinel for an empty or unknown head SHA (issue
 * #4746). The renderer emits it instead of a malformed `sha=` field, the
 * parser accepts it, and `qaVerdictShaMatches` treats it as "no SHA match" —
 * so a merge guard keyed on `sha=` can never be satisfied by it.
 */
export const QA_VERDICT_UNKNOWN_SHA = "unknown";

/**
 * Anchored per line (`m` flag). The `-pending-CI` literals are listed first
 * so `PASS` can never shadow `PASS-pending-CI`.
 */
const QA_VERDICT_TRAILER_RE =
  /^QA-Verdict:[ \t]+(PASS-pending-CI|FAIL-pending-CI|PASS|FAIL)[ \t]+pr=(\d+)[ \t]+round=(\d+)[ \t]+sha=([0-9a-fA-F]{7,40}|unknown)[ \t]+blockers=(\d+)[ \t]+max_severity=(high|medium|low|none)[ \t]*\r?$/gm;

/**
 * Parse EVERY well-formed `QA-Verdict:` line in a comment/review body, in
 * order. A malformed line (wrong field order, unknown verdict, pr=0,
 * round=0) is skipped, never partially parsed.
 */
export function parseQaVerdictTrailers(
  body: string | null | undefined,
): QaVerdictTrailer[] {
  if (typeof body !== "string" || !body.includes(QA_VERDICT_TRAILER_PREFIX)) {
    return [];
  }
  const out: QaVerdictTrailer[] = [];
  for (const m of body.matchAll(QA_VERDICT_TRAILER_RE)) {
    const pr = Number.parseInt(m[2] as string, 10);
    const round = Number.parseInt(m[3] as string, 10);
    if (pr < 1 || round < 1) continue;
    out.push({
      verdict: m[1] as FinalVerdict,
      pr,
      round,
      sha: (m[4] as string).toLowerCase(),
      blockers: Number.parseInt(m[5] as string, 10),
      maxSeverity: m[6] as QaSeverity,
    });
  }
  return out;
}

/**
 * The FIRST well-formed `QA-Verdict:` line in a body, or `null` when the body
 * carries none (a legacy, pre-#4729 comment).
 */
export function parseQaVerdictTrailer(
  body: string | null | undefined,
): QaVerdictTrailer | null {
  return parseQaVerdictTrailers(body)[0] ?? null;
}

/** True for the two FAIL literals — the "caught" side of a verdict. */
export function isFailVerdict(verdict: FinalVerdict): boolean {
  return verdict === "FAIL" || verdict === "FAIL-pending-CI";
}

/**
 * The round the NEXT verdict on `pr` gets: prior trailers naming `pr` across
 * the PR's own comment + review bodies, plus one. Trailers naming a different
 * PR are ignored.
 */
export function nextQaVerdictRound(
  priorBodies: ReadonlyArray<string | null | undefined>,
  pr: number,
): number {
  let prior = 0;
  for (const body of priorBodies) {
    for (const t of parseQaVerdictTrailers(body)) {
      if (t.pr === pr) prior += 1;
    }
  }
  return prior + 1;
}

/**
 * True iff trailer `t` was rendered for `headSha` (its 12-char `sha=` is a
 * prefix of the full head SHA). The `QA_VERDICT_UNKNOWN_SHA` sentinel and a
 * blank `headSha` NEVER match — an unknown SHA must never satisfy a merge
 * guard (same fail-closed rule as `hasFreshDeepQaPass`).
 */
export function qaVerdictShaMatches(
  t: Pick<QaVerdictTrailer, "sha">,
  headSha: string,
): boolean {
  const head = String(headSha ?? "").trim().toLowerCase();
  const sha = String(t.sha ?? "").toLowerCase();
  if (head.length === 0 || !/^[0-9a-f]{7,40}$/.test(sha)) return false;
  return head.startsWith(sha);
}

// ---------------------------------------------------------------------------
// `QA-Verdict-Error:` — the loud fallback (issue #4746)
//
// If step 9.5 cannot render a trailer at all (neither the full render nor the
// minimal bash retry produced a parseable line), the verdict is still posted,
// ending with one explicit error line instead of silently dropping the
// trailer:
//
//   QA-Verdict-Error: verdict=<V> pr=<N> reason=<free text>
//
// `qa:catch-rate` counts it as a real QA pass for PR <N> (caught iff <V> is a
// FAIL literal). It is NEVER a `QA-Verdict:` trailer: it carries no `sha=`,
// so no SHA-keyed merge guard can be satisfied by it. Parsing is lenient —
// the line exists precisely because an input was bad, so an unrecognised
// verdict or a missing pr still parses (as `null`) rather than vanishing.
// ---------------------------------------------------------------------------

/** The literal prefix of the fallback error line. */
export const QA_VERDICT_ERROR_PREFIX = "QA-Verdict-Error:";

/** The parsed fields of one `QA-Verdict-Error:` line. */
export interface QaVerdictError {
  /** `null` when the line's `verdict=` is absent or not a FinalVerdict. */
  verdict: FinalVerdict | null;
  /** `null` when the line's `pr=` is absent or not a positive integer. */
  pr: number | null;
  reason: string;
}

const QA_VERDICT_ERROR_LINE_RE = /^QA-Verdict-Error:([^\r\n]*)\r?$/gm;

/** Parse every `QA-Verdict-Error:` line (line-anchored) in a body, in order. */
export function parseQaVerdictErrors(
  body: string | null | undefined,
): QaVerdictError[] {
  if (typeof body !== "string" || !body.includes(QA_VERDICT_ERROR_PREFIX)) {
    return [];
  }
  const out: QaVerdictError[] = [];
  for (const m of body.matchAll(QA_VERDICT_ERROR_LINE_RE)) {
    const rest = m[1] as string;
    const v = /(?:^|[ \t])verdict=(\S*)/.exec(rest)?.[1] as FinalVerdict | undefined;
    const p = /(?:^|[ \t])pr=(\d+)(?=[ \t]|$)/.exec(rest)?.[1];
    const pr = p === undefined ? null : Number.parseInt(p, 10);
    out.push({
      verdict: v !== undefined && FINAL_VERDICTS.includes(v) ? v : null,
      pr: pr !== null && pr >= 1 ? pr : null,
      reason: (/(?:^|[ \t])reason=(.*)$/.exec(rest)?.[1] ?? "").trim(),
    });
  }
  return out;
}

/**
 * Render the error line — the TS twin of the playbook's bash `printf`
 * fallback (which must work when node itself is what failed). The reason is
 * collapsed to one line; an unknown verdict/pr renders `unknown`.
 */
export function renderQaVerdictErrorLine(e: {
  verdict: string | null;
  pr: number | null;
  reason: string;
}): string {
  const verdict = String(e.verdict ?? "").replace(/[^A-Za-z-]/g, "") || "unknown";
  const pr = Number.isInteger(e.pr) && (e.pr as number) >= 1 ? String(e.pr) : "unknown";
  const reason = String(e.reason ?? "").replace(/\s+/g, " ").trim();
  return `${QA_VERDICT_ERROR_PREFIX} verdict=${verdict} pr=${pr}${
    reason ? ` reason=${reason}` : ""
  }`;
}

/**
 * Render one trailer line. Inputs are normalised, never rejected, and the
 * output ALWAYS parses (issue #4746): the verdict is trimmed and an unknown
 * literal renders `FAIL` (fail toward loud); the SHA is lowercased and cut to
 * 12 chars, and anything that is not then 7–12 hex chars (empty, unknown,
 * non-hex) renders the `QA_VERDICT_UNKNOWN_SHA` sentinel; counts are floored
 * at their minimum; a zero-blocker verdict always renders
 * `max_severity=none`, and a non-zero blocker count with no usable severity
 * renders `high`.
 */
export function renderQaVerdictTrailer(t: QaVerdictTrailer): string {
  const int = (n: number, min: number): number =>
    Number.isFinite(n) ? Math.max(min, Math.trunc(n)) : min;
  const blockers = int(t.blockers, 0);
  let severity: QaSeverity = "none";
  if (blockers > 0) {
    severity =
      QA_SEVERITIES.includes(t.maxSeverity) && t.maxSeverity !== "none"
        ? t.maxSeverity
        : "high";
  }
  const rawVerdict = String(t.verdict ?? "").trim() as FinalVerdict;
  const verdict: FinalVerdict = FINAL_VERDICTS.includes(rawVerdict)
    ? rawVerdict
    : "FAIL";
  const cut = String(t.sha ?? "").trim().toLowerCase().slice(0, 12);
  const sha = /^[0-9a-f]{7,12}$/.test(cut) ? cut : QA_VERDICT_UNKNOWN_SHA;
  return (
    `${QA_VERDICT_TRAILER_PREFIX} ${verdict} pr=${int(t.pr, 1)} ` +
    `round=${int(t.round, 1)} sha=${sha} blockers=${blockers} ` +
    `max_severity=${severity}`
  );
}

/**
 * The one call the hydra-qa playbook makes: derive `round` from the PR's
 * prior comment + review bodies, then render the trailer line.
 */
export function buildQaVerdictTrailer(input: {
  verdict: FinalVerdict;
  pr: number;
  headSha: string;
  blockers: number;
  maxSeverity: QaSeverity;
  priorBodies: ReadonlyArray<string | null | undefined>;
}): string {
  return renderQaVerdictTrailer({
    verdict: input.verdict,
    pr: input.pr,
    round: nextQaVerdictRound(input.priorBodies, input.pr),
    sha: input.headSha,
    blockers: input.blockers,
    maxSeverity: input.maxSeverity,
  });
}

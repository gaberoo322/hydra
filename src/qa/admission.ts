/**
 * src/qa/admission.ts — the admission phase: CI-check classification, the one-pass verdict classifier and the reviewer admission gate.
 *
 * Moved verbatim out of scripts/ci/qa-verdict.ts (issue #5079, qa-verdict-engine
 * slice 2/4; ADR-0038). Pure — no fs/network. The workflow-facing facade
 * scripts/ci/qa-verdict.ts re-exports the names its consumers import.
 */

import { isPromptOnlyChange } from "./change-shape.ts";
import type { FinalVerdict } from "./verdict-trailer.ts";

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
 * A raw `gh pr view --json statusCheckRollup` entry, verbatim. CheckRun rows
 * carry `status`/`conclusion` (UPPERCASE GraphQL enums); StatusContext rows
 * (commit statuses) carry only `state`. NEITHER kind carries required-ness.
 */
export type RawRollupEntry = Record<string, unknown>;

/**
 * Build the canonical `CheckState[]` every CHECKS_JSON consumer reads, from
 * the RAW statusCheckRollup payload plus the branch-protection required
 * contexts (issue #4757). The ONE definition of the rollup→CheckState fold:
 * normalisation, de-duplication, StatusContext folding, required-marking and
 * absent-required synthesis all live here — pure, no I/O, so the shared bash
 * fetch fragment (`docs/operator-playbooks/_fragments/checks-fetch.md`) and
 * both its playbook call sites can never drift apart.
 *
 * Required-ness NEVER comes from the rollup — the GraphQL rollup has no
 * required-ness field at all (verified live on PRs #4754/#4764) — only from
 * `requiredContexts`, read from
 * `gh api .../branches/<base>/protection/required_status_checks` (the same
 * source as the Turn Snapshot's dev-resume classifier, #4460 INV-4).
 *
 * Rules:
 * - CheckRun rows fold to lowercase-canonical `status`/`conclusion` (issue
 *   #761); a missing `status` defaults to `completed` (the legacy mapping).
 * - StatusContext rows fold by commit-status `state`: PENDING/EXPECTED/empty
 *   → pending; SUCCESS → completed/success; FAILURE/ERROR →
 *   completed/failure; an unknown state reads pending (not yet decided).
 * - Entries are de-duplicated by name (`.name // .context`) KEEPING THE
 *   LATEST — greatest `startedAt`, ties broken by later list index — because
 *   re-runs leave stale duplicates in the rollup (verified live on PR #4478:
 *   one name CANCELLED then SUCCESS). Entries with no name at all are noise
 *   and skipped.
 * - A required context ABSENT from the rollup is synthesized as
 *   `{status: "pending", conclusion: null, required: true}` — a check that
 *   has not reported yet must read PENDING, never be invisible (the #4460
 *   INV-3(e) rule; deep-qa-gate posts late).
 *
 * The output shape is exactly `{name, status, conclusion, required}` — the
 * pre-#4757 CHECKS_JSON contract — so `classifyVerdict` /
 * `redRequiredChecks` / `decideReviewAdmission` and every downstream
 * consumer need no change.
 */
export function buildCheckStates(
  rollup: readonly RawRollupEntry[],
  requiredContexts: readonly string[],
): CheckState[] {
  const required = new Set(requiredContexts);
  const latest = new Map<
    string,
    { startedAt: string; idx: number; status: CheckStatus; conclusion: CheckConclusion | null }
  >();
  rollup.forEach((entry, idx) => {
    const name =
      typeof entry.name === "string" && entry.name !== ""
        ? entry.name
        : typeof entry.context === "string" && entry.context !== ""
          ? entry.context
          : null;
    if (name === null) return;
    const folded = foldRawRollupEntry(entry);
    if (folded === null) return;
    // One timestamp rule for BOTH row kinds: CheckRun `startedAt`, else
    // StatusContext `createdAt`. A row with NO timestamp is queued / not yet
    // started — the newest thing that can exist — so it beats any stamped row
    // (a queued required check must never be shadowed by a stale completed
    // SUCCESS → PENDING, not PASS, in either list order). Equal or both-absent
    // timestamps fall to the later list index.
    const startedAt =
      typeof entry.startedAt === "string" && entry.startedAt !== ""
        ? entry.startedAt
        : typeof entry.createdAt === "string" && entry.createdAt !== ""
          ? entry.createdAt
          : "";
    const prev = latest.get(name);
    if (prev === undefined || rowIsNewer(startedAt, prev.startedAt)) {
      latest.set(name, { startedAt, idx, ...folded });
    }
  });
  const states: CheckState[] = [...latest.entries()]
    .sort((a, b) => a[1].idx - b[1].idx)
    .map(([name, v]) => ({
      name,
      status: v.status,
      conclusion: v.conclusion,
      required: required.has(name),
    }));
  for (const ctx of requiredContexts) {
    if (!latest.has(ctx)) {
      states.push({ name: ctx, status: "pending", conclusion: null, required: true });
    }
  }
  return states;
}

/** True when a row stamped `cur` supersedes one stamped `prev` (later index assumed). "" = unstamped/queued = newest. */
function rowIsNewer(cur: string, prev: string): boolean {
  if (cur === "") return true; // queued beats stamped; both unstamped -> later index
  if (prev === "") return false;
  return cur >= prev;
}

/**
 * Fold ONE raw rollup entry to canonical status/conclusion. Returns null for
 * an entry carrying neither a CheckRun `status` nor a StatusContext `state`
 * (unrecognisable — skipped rather than guessed).
 */
function foldRawRollupEntry(
  entry: RawRollupEntry,
): { status: CheckStatus; conclusion: CheckConclusion | null } | null {
  if (typeof entry.state === "string" && typeof entry.status !== "string") {
    // StatusContext row (commit status): fold by state.
    const state = entry.state.toLowerCase();
    if (state === "success") return { status: "completed", conclusion: "success" };
    if (state === "failure" || state === "error") return { status: "completed", conclusion: "failure" };
    return { status: "pending", conclusion: null };
  }
  if (typeof entry.status === "string" || "conclusion" in entry || entry.__typename === "CheckRun") {
    // CheckRun row: UPPERCASE enums fold to lowercase-canonical (#761); a
    // null conclusion on a COMPLETED row stays null (neither green nor red).
    return {
      status: normaliseStatus((entry.status ?? "completed") as CheckStatus),
      conclusion: (normaliseConclusion(
        (entry.conclusion ?? null) as CheckConclusion | null,
      ) ?? null) as CheckConclusion | null,
    };
  }
  return null;
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
  // One entry per check NAME (e.g. `deep-qa-gate` reports as both a commit
  // status and a CheckRun). The worst state wins — red, then pending, then
  // green — so a duplicate can never hide a red or pending check.
  const byName = new Map<string, { state: 0 | 1 | 2; label: string }>();
  for (const c of required) {
    const isRed =
      redRequiredChecks([
        { name: c.name, status: c.status, conclusion: c.conclusion === "—" ? null : c.conclusion, required: true },
      ]).length > 0;
    const entry = isRed
      ? { state: 2 as const, label: `\`${c.name}\` (${c.conclusion})` }
      : PENDING_STATUSES.has(c.status)
        ? { state: 1 as const, label: `\`${c.name}\` (pending)` }
        : { state: 0 as const, label: "" };
    const prev = byName.get(c.name);
    if (!prev || entry.state > prev.state) byName.set(c.name, entry);
  }
  const entries = [...byName.values()];
  const notGreen = [
    ...entries.filter((e) => e.state === 2).map((e) => e.label),
    ...entries.filter((e) => e.state === 1).map((e) => e.label),
  ];
  const green = entries.length - notGreen.length;
  if (notGreen.length === 0) {
    return `**CI:** all ${entries.length} required checks green.`;
  }
  return `**CI:** ${green}/${entries.length} required checks green. Not green: ${notGreen.join(", ")}.`;
}

// ---------------------------------------------------------------------------
// Phase head (issue #5079, INV-3): the ONE composed entry the admission step
// binds to. Calls the helpers above in the order the playbook does (step 6.4
// prompt-only bypass -> step 6.6 admission gate -> red-required list -> the
// skip-path verdict). Introduces no branch the helpers do not already own.
// ---------------------------------------------------------------------------

export interface AdmissionPhaseInput extends ReviewAdmissionInput {
  /** The PR's changed paths (step 6.4); omitted/empty is never prompt-only. */
  changedPaths?: readonly string[];
}

export interface AdmissionPhaseResult {
  /** `isPromptOnlyChange(changedPaths)` — the step-6.4 bypass signal. */
  promptOnly: boolean;
  admission: ReviewAdmissionDecision;
  /** Names of required checks that are red right now. */
  redRequired: string[];
  /**
   * The classifier result for the skip path: set exactly when the admission
   * action is `skip-required-failed` (a FAIL with the CI table), else null.
   */
  skipVerdict: VerdictResult | null;
}

export function decideAdmission(input: AdmissionPhaseInput): AdmissionPhaseResult {
  const promptOnly = isPromptOnlyChange(input.changedPaths ?? []);
  const admission = decideReviewAdmission(input);
  const redRequired = redRequiredChecks(input.checks);
  const skipVerdict =
    admission.action === "skip-required-failed" ? classifyVerdict("FAIL", input.checks) : null;
  return { promptOnly, admission, redRequired, skipVerdict };
}

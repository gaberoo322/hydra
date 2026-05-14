/**
 * scripts/ci/pr-rebase.ts — Pure helpers for the hydra-pr-rebase skill
 * (issue #407).
 *
 * Background: PRs in gaberoo322/hydra periodically fall behind master after a
 * sibling PR merges. Branch protection requires "branch must be up to date",
 * so a stale PR cannot auto-merge until either the author or an automated
 * job calls GitHub's `update-branch` API. PR #404 (2026-05-14) sat at
 * mergeStateStatus=BEHIND for 30+ minutes with no human touching it; PR #401
 * needed a manual `gh api -X PUT .../update-branch` after #403 merged.
 *
 * The hydra-pr-rebase skill walks open PRs and classifies each as:
 *
 *   rebase  — BEHIND, no opt-out label   → call update-branch + post comment
 *   surface — DIRTY, not already labeled → add `ready-for-human` + list conflicts
 *   skip    — everything else            → no-op (idempotent)
 *
 * Idempotency rules:
 *
 *  - A DIRTY PR labeled `ready-for-human` is `skip` (operator already notified).
 *  - A BEHIND PR labeled `no-rebase` is `skip` (operator opt-out).
 *  - A CLEAN / BLOCKED / HAS_HOOKS / UNSTABLE / UNKNOWN PR is `skip`
 *    (mergeStateStatus changes after a successful rebase, so the next sweep
 *    naturally no-ops on a freshly-rebased PR).
 *
 * This module is pure — no fs / network / process — so it can be unit tested
 * directly. See test/hydra-pr-rebase.test.mts.
 */

/**
 * GitHub's GraphQL MergeStateStatus enum, exposed via `gh pr list --json mergeStateStatus`.
 * Source: https://docs.github.com/en/graphql/reference/enums#mergestatestatus
 */
export type MergeStateStatus =
  | "CLEAN"
  | "BEHIND"
  | "DIRTY"
  | "BLOCKED"
  | "HAS_HOOKS"
  | "UNSTABLE"
  | "UNKNOWN";

/** Minimal PR shape we need from `gh pr list --json number,mergeStateStatus,headRefName,labels`. */
export interface PullRequestRow {
  number: number;
  mergeStateStatus: MergeStateStatus;
  headRefName: string;
  labels: Array<{ name: string }>;
  /** Optional — only used for the comment-idempotency check, never for classification. */
  headRefOid?: string;
}

export type RebaseAction = "rebase" | "surface" | "skip";

export interface ClassifyResult {
  action: RebaseAction;
  /** Human-readable reason for the action — used in the report body. */
  reason: string;
}

/** Label names the classifier treats as opt-out / already-handled signals. */
export const READY_FOR_HUMAN_LABEL = "ready-for-human";
export const NO_REBASE_LABEL = "no-rebase";

function hasLabel(row: PullRequestRow, name: string): boolean {
  return row.labels.some((l) => l.name === name);
}

/**
 * Classify one PR row into a single action. Pure — no I/O.
 *
 * Decision order (highest priority first):
 *
 *  1. DIRTY + already labeled ready-for-human → skip (idempotent: operator was notified)
 *  2. DIRTY                                    → surface
 *  3. BEHIND + labeled no-rebase               → skip (operator opt-out)
 *  4. BEHIND                                   → rebase
 *  5. anything else                            → skip
 */
export function classifyPR(row: PullRequestRow): ClassifyResult {
  const state = row.mergeStateStatus;

  if (state === "DIRTY") {
    if (hasLabel(row, READY_FOR_HUMAN_LABEL)) {
      return {
        action: "skip",
        reason: `DIRTY but already labeled ${READY_FOR_HUMAN_LABEL} — operator notified.`,
      };
    }
    return {
      action: "surface",
      reason: "DIRTY — merge conflict, surface to operator.",
    };
  }

  if (state === "BEHIND") {
    if (hasLabel(row, NO_REBASE_LABEL)) {
      return {
        action: "skip",
        reason: `BEHIND but labeled ${NO_REBASE_LABEL} — operator opted out.`,
      };
    }
    return {
      action: "rebase",
      reason: "BEHIND — call update-branch to rebase onto master.",
    };
  }

  return {
    action: "skip",
    reason: `mergeStateStatus=${state} — not our concern.`,
  };
}

export interface ClassifyBuckets {
  rebase: PullRequestRow[];
  surface: PullRequestRow[];
  skip: Array<{ row: PullRequestRow; reason: string }>;
}

/**
 * Classify a batch of PR rows into three buckets. Stable input order is preserved
 * within each bucket.
 */
export function classifyBatch(rows: PullRequestRow[]): ClassifyBuckets {
  const buckets: ClassifyBuckets = { rebase: [], surface: [], skip: [] };
  for (const row of rows) {
    const r = classifyPR(row);
    if (r.action === "rebase") buckets.rebase.push(row);
    else if (r.action === "surface") buckets.surface.push(row);
    else buckets.skip.push({ row, reason: r.reason });
  }
  return buckets;
}

/**
 * Idempotency guard for the "rebased onto master" comment.
 *
 * Given the body of the most recent automated comment on a PR (or empty string
 * if none), return true iff the skill should post a fresh comment. The check is
 * intentionally string-based: the skill's comment template is stable and the
 * worst case (over-strict) is one duplicate comment per millennium.
 *
 * `commentBody` is the most recent comment whose body starts with the
 * `> *Automated by \`/hydra-pr-rebase\`*` marker — callers extract it via
 * `gh pr view ... --json comments --jq '...'`.
 */
export function shouldPostRebaseComment(commentBody: string | null | undefined): boolean {
  if (!commentBody) return true;
  return !commentBody.includes("Rebased onto master");
}

/**
 * Render a single-pass report. Pure — deterministic for testability.
 */
export function renderReport(buckets: ClassifyBuckets, when: string): string {
  const lines: string[] = [];
  lines.push(`## Hydra PR Rebase — ${when}`);
  lines.push("");
  lines.push(
    `Scanned: ${
      buckets.rebase.length + buckets.surface.length + buckets.skip.length
    } open PRs`,
  );
  lines.push("");

  lines.push("### Rebased (BEHIND → updated)");
  if (buckets.rebase.length === 0) {
    lines.push("- _none_");
  } else {
    for (const r of buckets.rebase) lines.push(`- #${r.number} (${r.headRefName})`);
  }
  lines.push("");

  lines.push("### Surfaced (DIRTY → operator)");
  if (buckets.surface.length === 0) {
    lines.push("- _none_");
  } else {
    for (const r of buckets.surface) lines.push(`- #${r.number} (${r.headRefName})`);
  }
  lines.push("");

  lines.push("### Skipped");
  if (buckets.skip.length === 0) {
    lines.push("- _none_");
  } else {
    for (const s of buckets.skip) {
      lines.push(`- #${s.row.number}: ${s.reason}`);
    }
  }

  return lines.join("\n");
}

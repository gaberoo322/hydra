/**
 * Stuck-items aggregator (issue #617, PRD #615; collapsed onto the waiting read
 * by issue #5093).
 *
 * Returns three buckets of stalled work:
 *
 *   - `blockedOver2d`     — CLASSIFIED `blocked` issues older than the blocked
 *                            threshold (default: 2 days).
 *   - `needsInfoWaiting`  — CLASSIFIED `needs-info` issues older than the
 *                            needs-info threshold (default: 1 day).
 *   - `prsWithFailedCi`   — open PRs whose required checks are failing.
 *
 * # Design contract
 *
 * - **One issue-label reader.** The issue half is
 *   `projectStuckIssues(readWaitingIssues(...))` — the age rule, Epic
 *   exclusion and machine-owned-blocker suppression live in issues-waiting.ts
 *   only. This module imports no issue-label reader. The PR bucket is a PR
 *   read and stays here.
 * - **Never throws.** The waiting read and the PR read run under one
 *   `Promise.allSettled` pair; a rejected PR read degrades to `[]`.
 * - **Clock + repo injectable.** Production callers pass nothing.
 */

import { listOpenPrsOrEmpty, type PrRow } from "../github/issues.ts";
import { listRequiredStatusContextsOrNull } from "../github/prs.ts";
import { settledOrEmpty } from "../settled-fold.ts";
import { foldRollup } from "../github/check-rollup.ts";
import { isFailedRequiredStatus } from "./stalled-prs.ts";
import {
  projectStuckIssues,
  readWaitingIssues,
  type IssuesWaitingDeps,
  type StuckIssue,
  type StuckThresholds,
} from "./issues-waiting.ts";

// The ONE stale threshold and the StuckIssue row live in issues-waiting.ts
// (issues #5091, #5093); re-exported so existing import paths keep resolving.
export { DEFAULT_THRESHOLDS, type StuckIssue, type StuckThresholds } from "./issues-waiting.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface StuckPr {
  number: number;
  title: string;
  url: string;
  failedChecks: string[];
  updatedAt: string;
}

export interface StuckItems {
  blockedOver2d: StuckIssue[];
  needsInfoWaiting: StuckIssue[];
  prsWithFailedCi: StuckPr[];
  /** Echo of the thresholds used so the dashboard can render "stale >= Xd". */
  thresholds: StuckThresholds;
  generatedAt: string;
  /**
   * ADR-0034 §5.2 asserted-emptiness evidence (issue #4007). Raw `blocked` +
   * `needs-info` rows plus the failed-CI PR rows from the fulfilled reads, so
   * an empty snapshot can prove the lookup actually ran.
   */
  scanned: number;
  /** True iff the `blocked` / `needs-info` reads and the PR read all succeeded. */
  sourcesOk: boolean;
}

export interface StuckItemsDeps {
  /** Wall-clock anchor — defaults to `new Date()`. */
  now?: Date;
  /** GitHub repo handle (`owner/name`). Defaults to `gaberoo322/hydra`. */
  githubRepo?: string;
  /** Override default age thresholds. */
  thresholds?: Partial<StuckThresholds>;
  /**
   * The waiting-read overrides, under their issues-waiting names, so one test
   * deps object can feed both `readWaitingIssues` and `getStuckItems`.
   */
  listIssuesByLabel?: IssuesWaitingDeps["listIssuesByLabel"];
  listIssuesBySearch?: IssuesWaitingDeps["listIssuesBySearch"];
  listOpenPrs?: IssuesWaitingDeps["listOpenPrs"];
  /** PR-bucket reader (issue #908/#915). Tests inject it to avoid spawning `gh`. */
  listOpenPrsOrEmpty?: typeof listOpenPrsOrEmpty;
  /**
   * Override the branch-protection required-contexts reader (issue #4569).
   * `null` means UNKNOWN, which keeps every failing check counting.
   */
  listRequiredStatusContextsOrNull?: typeof listRequiredStatusContextsOrNull;
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export async function getStuckItems(
  deps: StuckItemsDeps = {},
): Promise<StuckItems> {
  const listPrs = deps.listOpenPrsOrEmpty ?? listOpenPrsOrEmpty;
  const listRequired =
    deps.listRequiredStatusContextsOrNull ?? listRequiredStatusContextsOrNull;
  const opts = { repo: deps.githubRepo };

  const [readResult, prsResult] = await Promise.allSettled([
    readWaitingIssues({
      now: deps.now,
      githubRepo: deps.githubRepo,
      thresholds: deps.thresholds,
      listIssuesByLabel: deps.listIssuesByLabel,
      listIssuesBySearch: deps.listIssuesBySearch,
      listOpenPrs: deps.listOpenPrs,
    }),
    fetchPrsWithFailedCi(listPrs, listRequired, opts),
  ]);
  // readWaitingIssues never throws; a rejection here is a bug — fail loud.
  if (readResult.status === "rejected") throw readResult.reason;

  const issues = projectStuckIssues(readResult.value);
  const prs = settledOrEmpty(prsResult, "stuck-items/prs-failed-ci");

  return {
    blockedOver2d: issues.blockedOver2d,
    needsInfoWaiting: issues.needsInfoWaiting,
    prsWithFailedCi: prs,
    thresholds: issues.thresholds,
    generatedAt: issues.generatedAt,
    // ADR-0034 §5.2 (issue #4007): a genuine zero-item snapshot must never be
    // bit-for-bit identical to a total sub-fetch failure.
    scanned: issues.scanned + prs.length,
    sourcesOk: issues.sourcesOk && prsResult.status === "fulfilled",
  };
}

// ---------------------------------------------------------------------------
// Sub-source: open PRs with at least one failing check
// ---------------------------------------------------------------------------

async function fetchPrsWithFailedCi(
  listPrs: typeof listOpenPrsOrEmpty,
  listRequired: typeof listRequiredStatusContextsOrNull,
  opts: { repo?: string },
): Promise<StuckPr[]> {
  const [rows, required] = await Promise.all([
    listPrs("stuck-items/prs-failed-ci", opts),
    listRequired("stuck-items/required-contexts", opts),
  ]);
  return selectPrsWithFailedCi(rows, required === null ? null : new Set(required));
}

/**
 * Pure helper — exported for tests. Keeps only the PRs (the seam's
 * {@link PrRow}) with at least one failing check, mapping each survivor to a
 * {@link StuckPr} with the failing check names. The per-context latest-wins fold is
 * the shared one in `src/github/check-rollup.ts` and the red-or-cancelled
 * posture is `isFailedRequiredStatus` in `stalled-prs.ts` (issue #4624): a superseded failure followed by a green
 * rerun no longer counts, and StatusContext `state` FAILURE/ERROR does. When
 * `requiredContexts` is known, only failures of a required context count
 * (issue #4569); `null` means unknown and keeps this endpoint's legacy
 * posture of counting every failure (the attention feed's rank 1 does NOT —
 * see stalled-prs.ts). Sorted most-recently-updated last so the dashboard's
 * "oldest first" ordering matches the issue lists.
 */
export function selectPrsWithFailedCi(
  rows: readonly PrRow[],
  requiredContexts: ReadonlySet<string> | null = null,
): StuckPr[] {
  const out: StuckPr[] = [];
  for (const pr of rows) {
    const failed: string[] = [];
    for (const [name, { status }] of foldRollup(pr.statusCheckRollup).contexts) {
      if (!isFailedRequiredStatus(status)) continue;
      // Issue #4569: only a REQUIRED check is breakage. A non-required job
      // that is red on master itself (advisory-checks) otherwise flags every
      // open PR. An unknown required set (null) keeps every failure counting.
      if (requiredContexts !== null && !requiredContexts.has(name)) continue;
      failed.push(name);
    }
    if (failed.length === 0) continue;
    out.push({
      number: pr.number,
      title: pr.title,
      url: pr.url,
      failedChecks: failed,
      updatedAt: pr.updatedAt || new Date(0).toISOString(),
    });
  }
  out.sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
  return out;
}

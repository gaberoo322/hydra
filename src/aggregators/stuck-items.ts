/**
 * Stuck-items aggregator (issue #617, PRD #615).
 *
 * Returns three classified buckets of stalled work:
 *
 *   - `blockedOver2d`     — issues labeled `blocked` whose age exceeds the
 *                            blocked threshold (default: 2 days).
 *   - `needsInfoWaiting`  — issues labeled `needs-info` whose age exceeds
 *                            the needs-info threshold (default: 1 day).
 *   - `prsWithFailedCi`   — open PRs whose checks are reporting a failure.
 *
 * # Design contract
 *
 * - **Pure classifier core.** Age thresholds and the classifier itself are
 *   pure functions exported separately so tests don't need stubs to pin
 *   the boundary behavior.
 * - **Never throws.** Each sub-fetch runs under `Promise.allSettled`; a
 *   failure degrades to `[]` for that bucket.
 * - **Clock + repo injectable.** Same `deps` shape as the slice-1
 *   aggregator. Production callers pass nothing.
 */

import {
  listIssuesByLabelOrEmpty,
  listOpenPrsOrEmpty,
  type IssueRow,
  type PrRow,
} from "../github/issues.ts";
import { settledOrEmpty } from "../settled-fold.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface StuckIssue {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  ageDays: number;
  labels: string[];
}

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
  /** Echo of the thresholds used so the dashboard can render "stale ≥ Xd". */
  thresholds: StuckThresholds;
  generatedAt: string;
}

export interface StuckThresholds {
  /** Minimum age (days) before a `blocked` issue counts as stuck. */
  blockedDays: number;
  /** Minimum age (days) before a `needs-info` issue counts as stuck. */
  needsInfoDays: number;
}

export const DEFAULT_THRESHOLDS: StuckThresholds = {
  blockedDays: 2,
  needsInfoDays: 1,
};

export interface StuckItemsDeps {
  /** Wall-clock anchor — defaults to `new Date()`. */
  now?: Date;
  /** GitHub repo handle (`owner/name`). Defaults to `gaberoo322/hydra`. */
  githubRepo?: string;
  /** Override default age thresholds. */
  thresholds?: Partial<StuckThresholds>;
  /**
   * Override the GitHub Issue/PR Read seam readers (issue #908/#915). Tests
   * inject these to avoid spawning `gh`; production uses the real seam readers.
   * The aggregator consumes the seam's typed `IssueRow`/`PrRow` directly — no
   * local argv or parser.
   */
  listIssuesByLabelOrEmpty?: typeof listIssuesByLabelOrEmpty;
  listOpenPrsOrEmpty?: typeof listOpenPrsOrEmpty;
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export async function getStuckItems(
  deps: StuckItemsDeps = {},
): Promise<StuckItems> {
  const now = deps.now ?? new Date();
  const thresholds: StuckThresholds = {
    ...DEFAULT_THRESHOLDS,
    ...(deps.thresholds ?? {}),
  };

  const listByLabel = deps.listIssuesByLabelOrEmpty ?? listIssuesByLabelOrEmpty;
  const listPrs = deps.listOpenPrsOrEmpty ?? listOpenPrsOrEmpty;
  const opts = { repo: deps.githubRepo };

  const [blockedResult, infoResult, prsResult] = await Promise.allSettled([
    listByLabel("blocked", "stuck-items/blocked", opts),
    listByLabel("needs-info", "stuck-items/needs-info", opts),
    fetchPrsWithFailedCi(listPrs, opts),
  ]);

  const blocked = settledOrEmpty(blockedResult, "stuck-items/blocked");
  const info = settledOrEmpty(infoResult, "stuck-items/needs-info");
  const prs = settledOrEmpty(prsResult, "stuck-items/prs-failed-ci");

  return {
    blockedOver2d: classifyByAge(blocked, now, thresholds.blockedDays),
    needsInfoWaiting: classifyByAge(info, now, thresholds.needsInfoDays),
    prsWithFailedCi: prs,
    thresholds,
    generatedAt: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Pure classifier — exported for tests
// ---------------------------------------------------------------------------

/**
 * Pure helper — exported for tests. Filters a list of issues (the seam's
 * {@link IssueRow}, of which only `number,title,url,createdAt,labels` are read)
 * down to those whose age (now - createdAt) is at least `minAgeDays`, attaching
 * the computed `ageDays` to each surviving item. Sorts oldest-first.
 */
export function classifyByAge(
  issues: readonly Pick<IssueRow, "number" | "title" | "url" | "createdAt" | "labels">[],
  now: Date,
  minAgeDays: number,
): StuckIssue[] {
  const nowMs = now.getTime();
  const minAgeMs = minAgeDays * 24 * 60 * 60 * 1000;
  const out: StuckIssue[] = [];
  for (const issue of issues) {
    const createdMs = Date.parse(issue.createdAt);
    if (!Number.isFinite(createdMs)) continue;
    const ageMs = nowMs - createdMs;
    if (ageMs < minAgeMs) continue;
    out.push({
      number: issue.number,
      title: issue.title,
      url: issue.url,
      createdAt: issue.createdAt,
      ageDays: Math.floor(ageMs / (24 * 60 * 60 * 1000)),
      labels: [...issue.labels],
    });
  }
  out.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return out;
}

// ---------------------------------------------------------------------------
// Sub-source: open PRs with at least one failing check
// ---------------------------------------------------------------------------

async function fetchPrsWithFailedCi(
  listPrs: typeof listOpenPrsOrEmpty,
  opts: { repo?: string },
): Promise<StuckPr[]> {
  const rows = await listPrs("stuck-items/prs-failed-ci", opts);
  return selectPrsWithFailedCi(rows);
}

const FAILING_CI_CONCLUSIONS = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "STARTUP_FAILURE",
  "ACTION_REQUIRED",
]);

/**
 * Pure helper — exported for tests. Keeps only the PRs (the seam's
 * {@link PrRow}) whose `statusCheckRollup` contains at least one conclusion of
 * FAILURE / TIMED_OUT / CANCELLED / STARTUP_FAILURE / ACTION_REQUIRED, mapping
 * each survivor to a {@link StuckPr} with the failing check names. Sorted
 * most-recently-updated last so the dashboard's "oldest first" ordering matches
 * the issue lists.
 */
export function selectPrsWithFailedCi(rows: readonly PrRow[]): StuckPr[] {
  const out: StuckPr[] = [];
  for (const pr of rows) {
    const failed: string[] = [];
    for (const check of pr.statusCheckRollup) {
      const conclusion = typeof check.conclusion === "string" ? check.conclusion : "";
      if (!FAILING_CI_CONCLUSIONS.has(conclusion.toUpperCase())) continue;
      const name =
        typeof check.name === "string"
          ? check.name
          : typeof check.context === "string"
            ? check.context
            : "check";
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

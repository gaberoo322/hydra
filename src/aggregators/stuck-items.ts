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

import { execFileViaSeam } from "../github/exec-file-compat.ts";
import { resolveGithubRepo } from "../github/issues.ts";
import { settledOrEmpty } from "./settle.ts";

// The production default routes `gh`/`git` through the GitHub CLI Adapter seam
// (issue #899). Tests still inject `deps.execFileAsync` directly — this only
// changes the default, not the injection seam.
const execFile = execFileViaSeam;

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
  /** Async exec used for `gh` sub-shells. */
  execFileAsync?: (
    cmd: string,
    args: readonly string[],
    opts?: { cwd?: string; timeout?: number; maxBuffer?: number },
  ) => Promise<{ stdout: string; stderr: string }>;
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

  const [blockedResult, infoResult, prsResult] = await Promise.allSettled([
    fetchIssuesWithLabel("blocked", deps),
    fetchIssuesWithLabel("needs-info", deps),
    fetchPrsWithFailedCi(deps),
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

interface RawIssue {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  labels: string[];
}

/**
 * Pure helper — exported for tests. Filters a list of raw issues down to
 * those whose age (now - createdAt) is at least `minAgeDays`, attaching
 * the computed `ageDays` to each surviving item. Sorts oldest-first.
 */
export function classifyByAge(
  issues: RawIssue[],
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
// Sub-source: labeled issues
// ---------------------------------------------------------------------------

async function fetchIssuesWithLabel(
  label: string,
  deps: StuckItemsDeps,
): Promise<RawIssue[]> {
  const exec = deps.execFileAsync ?? execFile;
  const repo = resolveGithubRepo(deps.githubRepo);
  if (!repo) return [];
  const { stdout } = await exec(
    "gh",
    [
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--label",
      label,
      "--limit",
      "100",
      "--json",
      "number,title,url,createdAt,labels",
    ],
    { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
  );
  return parseRawIssues(stdout);
}

/**
 * Pure helper — exported for tests. Parses `gh issue list --json` output
 * into the raw shape the classifier expects. Returns `[]` on structural
 * issues rather than throwing.
 */
export function parseRawIssues(jsonStdout: string): RawIssue[] {
  if (!jsonStdout.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: RawIssue[] = [];
  for (const candidate of parsed) {
    if (!candidate || typeof candidate !== "object") continue;
    const c = candidate as {
      number?: unknown;
      title?: unknown;
      url?: unknown;
      createdAt?: unknown;
      labels?: Array<{ name?: unknown }>;
    };
    const number = typeof c.number === "number" ? c.number : NaN;
    if (!Number.isFinite(number) || number <= 0) continue;
    const createdAt = typeof c.createdAt === "string" ? c.createdAt : "";
    if (!createdAt) continue;
    out.push({
      number,
      title: typeof c.title === "string" ? c.title : `Issue #${number}`,
      url: typeof c.url === "string" ? c.url : `https://github.com/gaberoo322/hydra/issues/${number}`,
      createdAt,
      labels: (c.labels ?? [])
        .map((l) => l?.name)
        .filter((n): n is string => typeof n === "string"),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sub-source: open PRs with at least one failing check
// ---------------------------------------------------------------------------

async function fetchPrsWithFailedCi(deps: StuckItemsDeps): Promise<StuckPr[]> {
  const exec = deps.execFileAsync ?? execFile;
  const repo = resolveGithubRepo(deps.githubRepo);
  if (!repo) return [];
  const { stdout } = await exec(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      "number,title,url,updatedAt,statusCheckRollup",
    ],
    { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
  );
  return parsePrsWithFailedCi(stdout);
}

/**
 * Pure helper — exported for tests. Parses `gh pr list --json` output and
 * keeps only the PRs whose `statusCheckRollup` contains at least one
 * conclusion of FAILURE / TIMED_OUT / CANCELLED / STARTUP_FAILURE.
 */
export function parsePrsWithFailedCi(jsonStdout: string): StuckPr[] {
  if (!jsonStdout.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const FAILING = new Set([
    "FAILURE",
    "TIMED_OUT",
    "CANCELLED",
    "STARTUP_FAILURE",
    "ACTION_REQUIRED",
  ]);

  const out: StuckPr[] = [];
  for (const candidate of parsed) {
    if (!candidate || typeof candidate !== "object") continue;
    const c = candidate as {
      number?: unknown;
      title?: unknown;
      url?: unknown;
      updatedAt?: unknown;
      statusCheckRollup?: unknown;
    };
    const number = typeof c.number === "number" ? c.number : NaN;
    if (!Number.isFinite(number) || number <= 0) continue;
    const checks = Array.isArray(c.statusCheckRollup) ? c.statusCheckRollup : [];
    const failed: string[] = [];
    for (const check of checks) {
      if (!check || typeof check !== "object") continue;
      const cc = check as { conclusion?: unknown; name?: unknown; context?: unknown };
      const conclusion = typeof cc.conclusion === "string" ? cc.conclusion : "";
      if (!FAILING.has(conclusion.toUpperCase())) continue;
      const name = typeof cc.name === "string" ? cc.name : typeof cc.context === "string" ? cc.context : "check";
      failed.push(name);
    }
    if (failed.length === 0) continue;
    out.push({
      number,
      title: typeof c.title === "string" ? c.title : `PR #${number}`,
      url: typeof c.url === "string" ? c.url : `https://github.com/gaberoo322/hydra/pull/${number}`,
      failedChecks: failed,
      updatedAt: typeof c.updatedAt === "string" ? c.updatedAt : new Date(0).toISOString(),
    });
  }
  // Most-recently-updated last so the dashboard's "oldest first" ordering
  // matches the issue lists.
  out.sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
  return out;
}

/**
 * Recent-merges aggregator (issue #617, PRD #615).
 *
 * Returns the most recent N merged PRs on master, each enriched with the
 * Hydra-specific Tier classification and "class" label (dev_orch /
 * dev_target / sweep_orch / etc.) so the dashboard can render a
 * compact "what happened" log.
 *
 * # Data path
 *
 * 1. `git log master --first-parent --merges|--no-merges` is the cheapest
 *    way to list merge commits. We use `--first-parent` so squash merges
 *    (one-parent commits on master) and true merges both surface. We
 *    parse the subject for the canonical `(#NNN)` PR-number suffix that
 *    GitHub's squash-merge UI appends.
 * 2. For each merged PR number, we fetch labels via `gh pr view --json`.
 *    Tier comes from a label of the form `tier:N`; the class label comes
 *    from the autopilot-class taxonomy (`dev_orch`, `dev_target`, etc.).
 *    Either may be absent — both fields are nullable on the output.
 *
 * # Design contract
 *
 * - **Pure parser core.** `extractPrNumbersFromGitLog`,
 *   `tierFromLabels`, and `classLabelFromLabels` are pure functions
 *   exported for tests. The aggregator wires them up against
 *   subprocess-backed defaults.
 * - **Never throws.** Sub-fetch failures degrade to a partial list rather
 *   than aborting the whole call.
 * - **Bounded limit.** Caller passes a `limit` (1..50). The default 10
 *   matches what the dashboard renders.
 */

import { resolve } from "node:path";

import { execFileViaSeam } from "../github/exec-file-compat.ts";
import {
  classLabelFromLabels as seamClassLabelFromLabels,
  resolveGithubRepo,
} from "../github/issues.ts";

// The production default routes `gh`/`git` through the GitHub CLI Adapter seam
// (issue #899). Tests still inject `deps.execFileAsync` directly — this only
// changes the default, not the injection seam.
const execFile = execFileViaSeam;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MergeItem {
  prNumber: number;
  title: string;
  /** Tier extracted from a `tier:N` label, if any. Null when unlabeled. */
  tier: number | null;
  /** Autopilot class label (`dev_orch` / `dev_target` / …), if any. */
  classLabel: string | null;
  mergedAt: string;
  url: string;
}

export interface RecentMergesDeps {
  repoPath?: string;
  githubRepo?: string;
  execFileAsync?: (
    cmd: string,
    args: readonly string[],
    opts?: { cwd?: string; timeout?: number; maxBuffer?: number },
  ) => Promise<{ stdout: string; stderr: string }>;
  /**
   * Override the per-PR label fetch — tests pass a stub so they don't have
   * to mock `gh pr view` per number. Returns null when the lookup fails;
   * the aggregator treats that as "no labels known" and produces a
   * MergeItem with null tier and null classLabel.
   */
  fetchPrMeta?: (prNumber: number) => Promise<PrMeta | null>;
}

export interface PrMeta {
  title: string;
  labels: string[];
  mergedAt: string;
  url: string;
}

// The autopilot dispatch-class taxonomy lives in the GitHub Issue/PR Read seam
// (issue #908) — one authoritative copy. `classLabelFromLabels` below re-exports
// the seam's classifier (formerly a divergent local Set copy of backlog-flow's
// array taxonomy).

const MAX_LIMIT = 50;

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export async function getRecentMerges(
  limit: number,
  deps: RecentMergesDeps = {},
): Promise<MergeItem[]> {
  const bounded = clampLimit(limit);
  let prNumbers: number[];
  try {
    prNumbers = await listRecentPrNumbers(bounded, deps);
  } catch (err: any) {
    console.error(`[recent-merges] git log failed: ${err?.message || err}`);
    return [];
  }
  if (prNumbers.length === 0) return [];

  const fetchMeta = deps.fetchPrMeta ?? defaultFetchPrMeta(deps);
  const metas = await Promise.allSettled(
    prNumbers.map((n) => fetchMeta(n)),
  );

  const out: MergeItem[] = [];
  for (let i = 0; i < prNumbers.length; i += 1) {
    const number = prNumbers[i];
    const result = metas[i];
    if (result.status !== "fulfilled" || !result.value) {
      out.push({
        prNumber: number,
        title: `PR #${number}`,
        tier: null,
        classLabel: null,
        mergedAt: new Date(0).toISOString(),
        url: `https://github.com/gaberoo322/hydra/pull/${number}`,
      });
      continue;
    }
    const meta = result.value;
    out.push({
      prNumber: number,
      title: meta.title,
      tier: tierFromLabels(meta.labels),
      classLabel: classLabelFromLabels(meta.labels),
      mergedAt: meta.mergedAt,
      url: meta.url,
    });
  }
  // git log already returns newest-first, but a per-PR fetch may surface a
  // canonical `mergedAt` that differs slightly — re-sort newest-first to be
  // safe. Items with a missing mergedAt land at the end.
  out.sort((a, b) => {
    const aMs = Date.parse(a.mergedAt) || 0;
    const bMs = Date.parse(b.mergedAt) || 0;
    return bMs - aMs;
  });
  return out;
}

export function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 10;
  const n = Math.floor(limit);
  if (n < 1) return 1;
  if (n > MAX_LIMIT) return MAX_LIMIT;
  return n;
}

// ---------------------------------------------------------------------------
// Sub-source: recent PR numbers from `git log`
// ---------------------------------------------------------------------------

async function listRecentPrNumbers(
  limit: number,
  deps: RecentMergesDeps,
): Promise<number[]> {
  const exec = deps.execFileAsync ?? execFile;
  const cwd = deps.repoPath ?? resolveDefaultRepoPath();
  const { stdout } = await exec(
    "git",
    ["log", "master", "--first-parent", `-n`, String(limit * 2), "--pretty=format:%s"],
    { cwd, timeout: 5000, maxBuffer: 1024 * 1024 },
  );
  return extractPrNumbersFromGitLog(stdout, limit);
}

/**
 * Pure helper — exported for tests. Pulls a `(#NNN)` PR-number suffix from
 * each commit subject in the git-log output. Returns the first `limit`
 * matches in newest-first order. Commits without a recognizable suffix are
 * skipped (they're typically operator-direct commits, not PR merges, and
 * don't have label-derived tier data to display).
 */
export function extractPrNumbersFromGitLog(stdout: string, limit: number): number[] {
  if (!stdout) return [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Common shapes:
    //   "feat: foo (#123)"
    //   "Merge pull request #123 from owner/branch"
    let n: number | null = null;
    const suffix = trimmed.match(/\(#(\d+)\)\s*$/);
    if (suffix) n = Number(suffix[1]);
    if (n === null) {
      const merge = trimmed.match(/^Merge pull request #(\d+)\b/);
      if (merge) n = Number(merge[1]);
    }
    if (n === null || !Number.isFinite(n) || n <= 0) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length >= limit) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sub-source: per-PR metadata via `gh pr view`
// ---------------------------------------------------------------------------

function defaultFetchPrMeta(deps: RecentMergesDeps): (n: number) => Promise<PrMeta | null> {
  const exec = deps.execFileAsync ?? execFile;
  const repo = resolveGithubRepo(deps.githubRepo);
  return async (n: number) => {
    if (!repo) return null;
    try {
      const { stdout } = await exec(
        "gh",
        [
          "pr",
          "view",
          String(n),
          "--repo",
          repo,
          "--json",
          "title,labels,mergedAt,url",
        ],
        { timeout: 10_000, maxBuffer: 1024 * 1024 },
      );
      return parsePrMeta(stdout);
    } catch (err: any) {
      console.error(`[recent-merges] gh pr view #${n} failed: ${err?.message || err}`);
      return null;
    }
  };
}

/**
 * Pure helper — exported for tests. Parses one `gh pr view --json` payload
 * into the `PrMeta` shape. Returns `null` on structural problems so the
 * caller can substitute a stub item.
 */
export function parsePrMeta(jsonStdout: string): PrMeta | null {
  if (!jsonStdout.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStdout);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const c = parsed as {
    title?: unknown;
    labels?: Array<{ name?: unknown }>;
    mergedAt?: unknown;
    url?: unknown;
  };
  const title = typeof c.title === "string" ? c.title : "";
  const url = typeof c.url === "string" ? c.url : "";
  const mergedAt = typeof c.mergedAt === "string" ? c.mergedAt : "";
  const labels = (c.labels ?? [])
    .map((l) => l?.name)
    .filter((n): n is string => typeof n === "string");
  return { title, labels, mergedAt, url };
}

// ---------------------------------------------------------------------------
// Pure label parsers — exported for tests
// ---------------------------------------------------------------------------

/**
 * Pure helper — exported for tests. Finds a `tier:N` label (case-insensitive)
 * and returns the integer N. Returns null when no such label exists or
 * when N isn't a non-negative integer.
 */
export function tierFromLabels(labels: readonly string[]): number | null {
  for (const raw of labels) {
    if (typeof raw !== "string") continue;
    const m = raw.toLowerCase().match(/^tier[:\s-]*(\d+)$/);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

/**
 * Pure helper — exported for tests. Finds the first autopilot-class label
 * (`dev_orch`, `qa`, `sweep_target`, …). Returns null when none of the
 * known classes appear. Delegates to the GitHub Issue/PR Read seam (issue
 * #908) so the taxonomy has exactly one home; re-exported for backward
 * compatibility with existing importers.
 */
export const classLabelFromLabels = seamClassLabelFromLabels;

function resolveDefaultRepoPath(): string {
  const env = process.env.HYDRA_ROOT;
  if (env) return env;
  const home = process.env.HOME;
  if (home) return `${home}/hydra`;
  return process.cwd();
}

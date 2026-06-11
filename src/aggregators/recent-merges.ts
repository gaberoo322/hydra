/**
 * Recent-merges aggregator (issue #617, PRD #615).
 *
 * Returns the most recent N merged PRs on master, each enriched with the
 * Hydra-specific Tier classification and provenance label (tool-scout /
 * architecture-scan / cleanup-scan / sentry) so the dashboard can render a
 * compact "what happened" log.
 *
 * # Data path
 *
 * 1. `git log origin/master --first-parent` is the cheapest way to list
 *    merge commits. We use `--first-parent` so squash merges (one-parent
 *    commits on master) and true merges both surface. We parse the subject
 *    for the canonical `(#NNN)` PR-number suffix that GitHub's squash-merge
 *    UI appends. We read the `origin/master` remote-tracking ref — refreshed
 *    by a bounded, fail-open `git fetch` — NOT the local `master` ref: in
 *    HYDRA_ROOT local master only advances when deploy pulls, and deploy
 *    waves cancel each other, so local master goes stale exactly when fresh
 *    merges need to be visible (issue #1757 — false-positive
 *    `unproductive-loop` signals during merge waves).
 * 2. For each merged PR number, we fetch labels via `gh pr view --json`.
 *    Tier comes from a label of the form `tier:N`; the provenance label
 *    comes from the Dispatch-Class Taxonomy Module (classes.json
 *    `provenanceLabel` column + residual list, #1672). Either may be
 *    absent — both fields are nullable on the output.
 *
 * # Design contract
 *
 * - **Pure parser core.** `extractPrNumbersFromGitLog` and
 *   `tierFromLabels` are pure functions exported for tests
 *   (provenance classification is the taxonomy Module's
 *   `provenanceFromLabels`). The aggregator wires them up against
 *   subprocess-backed defaults.
 * - **Never throws.** Sub-fetch failures degrade to a partial list rather
 *   than aborting the whole call.
 * - **Bounded limit.** Caller passes a `limit` (1..50). The default 10
 *   matches what the dashboard renders.
 */

import { resolve } from "node:path";

import { execFileViaSeam } from "../github/exec-file-compat.ts";
import { viewPr } from "../github/issues.ts";
import { provenanceFromLabels } from "../taxonomy/classes.ts";

// The production default routes the `git log` read through the GitHub CLI
// Adapter seam (issue #899). Tests still inject `deps.execFileAsync` for the
// `git` call — this only changes the default, not the injection seam. The
// per-PR GitHub read now goes through the Issue/PR Read seam's `viewPr`
// (issue #908/#915), not a hand-built `gh pr view` argv.
const execFile = execFileViaSeam;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MergeItem {
  prNumber: number;
  title: string;
  /** Tier extracted from a `tier:N` label, if any. Null when unlabeled. */
  tier: number | null;
  /**
   * Provenance label (`tool-scout` / `cleanup-scan` / …), if any. Wire key
   * stays `classLabel` for dashboard stability (RecentMerges/ClassLabelBadge)
   * — only the value vocabulary changed (#1672).
   */
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

// The provenance vocabulary + classifier live in the Dispatch-Class Taxonomy
// Module (`src/taxonomy/classes.ts`, #1672) — one authoritative copy derived
// from classes.json; no label alphabet is hand-listed here.

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
      classLabel: provenanceFromLabels(meta.labels),
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

/** Bounded cap on the pre-read `git fetch` — fail-open past this. */
const FETCH_TIMEOUT_MS = 5000;

async function listRecentPrNumbers(
  limit: number,
  deps: RecentMergesDeps,
): Promise<number[]> {
  const exec = deps.execFileAsync ?? execFile;
  const cwd = deps.repoPath ?? resolveDefaultRepoPath();
  const logArgs = (ref: string) => [
    "log",
    ref,
    "--first-parent",
    "-n",
    String(limit * 2),
    "--pretty=format:%s",
  ];

  // Refresh the remote-tracking ref first (issue #1757). Bounded + fail-open:
  // a slow/offline fetch degrades to the cached `origin/master`, which is
  // still fresher than local `master` in practice (sibling worktree
  // dispatches fetch into the shared gitdir), never an error.
  try {
    await exec("git", ["fetch", "origin", "master", "--quiet"], {
      cwd,
      timeout: FETCH_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
  } catch (err: any) {
    console.error(
      `[recent-merges] git fetch origin master failed (fail-open to cached origin/master): ${err?.message || err}`,
    );
  }

  // Primary read: `origin/master`. The local `master` ref in HYDRA_ROOT only
  // advances when deploy pulls — stale during merge waves (issue #1757) — so
  // it is only the fallback for repos with no remote-tracking ref.
  try {
    const { stdout } = await exec("git", logArgs("origin/master"), {
      cwd,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    return extractPrNumbersFromGitLog(stdout, limit);
  } catch (err: any) {
    console.error(
      `[recent-merges] git log origin/master failed (falling back to local master): ${err?.message || err}`,
    );
  }

  const { stdout } = await exec("git", logArgs("master"), {
    cwd,
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
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
  return async (n: number) => {
    // viewPr reads through the Issue/PR Read seam (issue #908/#915): it owns
    // the `gh pr view` argv + repo handle and returns the raw parsed object or
    // null on any failure (never throws). We map the raw shape to PrMeta here.
    const view = await viewPr<{
      title?: unknown;
      labels?: Array<{ name?: unknown }>;
      mergedAt?: unknown;
      url?: unknown;
    }>(n, "title,labels,mergedAt,url", { repo: deps.githubRepo });
    return view ? prMetaFromView(view) : null;
  };
}

/**
 * Pure helper — exported for tests. Maps one raw `gh pr view --json` object
 * (as `viewPr` returns it) into the `PrMeta` shape, flattening `labels` to a
 * `string[]` and defaulting missing string fields to `""`. Never throws.
 */
export function prMetaFromView(view: {
  title?: unknown;
  labels?: Array<{ name?: unknown }>;
  mergedAt?: unknown;
  url?: unknown;
}): PrMeta {
  return {
    title: typeof view.title === "string" ? view.title : "",
    url: typeof view.url === "string" ? view.url : "",
    mergedAt: typeof view.mergedAt === "string" ? view.mergedAt : "",
    labels: (view.labels ?? [])
      .map((l) => l?.name)
      .filter((n): n is string => typeof n === "string"),
  };
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

function resolveDefaultRepoPath(): string {
  const env = process.env.HYDRA_ROOT;
  if (env) return env;
  const home = process.env.HOME;
  if (home) return `${home}/hydra`;
  return process.cwd();
}

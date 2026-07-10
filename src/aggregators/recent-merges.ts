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
 *    UI appends, and the committer date (`%cI`) for the merge timestamp.
 *    We read the `origin/master` remote-tracking ref — refreshed
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
 * # Two named steps — split for cost transparency (issue #2177)
 *
 * Step 1 (the bounded git fetch + first-parent git-log parse) is exposed as a
 * first-class public primitive, `listRecentMergeCommits(limit)`, returning
 * `MergeCommit[]` = `{prNumber, mergedAt}` pairs sourced entirely from the
 * git-log committer date (`%cI`) — **zero per-PR `gh pr view` calls**. Callers
 * that only need counts or PR-number+timestamp lists (e.g.
 * `autopilot-health.ts`'s window-merge-count) call this cheap primitive
 * directly instead of paying the N-parallel gh fan-out for data they discard.
 * `getRecentMerges` is then a visible composition: it calls
 * `listRecentMergeCommits` for step 1, then enriches each commit with gh
 * metadata in step 2. The two costs (a single git-log read vs. N network
 * calls) are now legible at the interface, not hidden behind one opaque name.
 *
 * For Hydra's squash-merge mode the committer date of the first-parent commit
 * on master IS the merge time — equivalent to gh's `mergedAt` for counting
 * purposes — so the count path needs no gh fan-out at all.
 *
 * # Design contract
 *
 * - **Pure parser core.** `extractMergeCommitsFromGitLog`,
 *   `extractPrNumbersFromGitLog`, and `tierFromLabels` are pure functions
 *   exported for tests (provenance classification is the taxonomy Module's
 *   `provenanceFromLabels`). The aggregator wires them up against
 *   subprocess-backed defaults.
 * - **Never throws.** Sub-fetch failures degrade to a partial list rather
 *   than aborting the whole call. `listRecentMergeCommits` fails open to an
 *   empty list on any subprocess failure.
 * - **Bounded limit.** Caller passes a `limit` (1..50). The default 10
 *   matches what the dashboard renders.
 */

import { resolve } from "node:path";

import { execFileViaSeam } from "../github/exec-file-compat.ts";
import { viewPr } from "../github/issues.ts";
import { provenanceFromLabels } from "../taxonomy/classes.ts";
import {
  GIT_LOG_FIELD_SEP,
  extractMergeCommitsFromGitLog,
  prMetaFromView,
  tierFromLabels,
  type MergeCommit,
  type PrMeta,
} from "./merge-commit-parser.ts";

// Re-export the pure parser leaf's symbols so existing import paths
// (`import { extractMergeCommitsFromGitLog, ... } from "./recent-merges.ts"`)
// stay zero-diff after the extraction (issue #3100). The canonical home for
// the parsers and their domain-record types is `merge-commit-parser.ts`; this
// module keeps the IO orchestration and imports the leaf.
export {
  extractMergeCommitsFromGitLog,
  extractPrNumbersFromGitLog,
  prMetaFromView,
  prNumberFromSubject,
  tierFromLabels,
} from "./merge-commit-parser.ts";
export type { MergeCommit, PrMeta } from "./merge-commit-parser.ts";

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

// `PrMeta` and `MergeCommit` — the domain records the parsers produce — are
// defined in the `merge-commit-parser.ts` leaf and imported/re-exported above
// (issue #3100).

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
  // Step 1 — the cheap git-log primitive (no gh fan-out). This is the same
  // call `autopilot-health.ts` makes directly when it only needs counts.
  const commits = await listRecentMergeCommits(limit, deps);
  if (commits.length === 0) return [];

  // Step 2 — enrich each commit with per-PR gh metadata (the N-parallel
  // network fan-out). Only callers that need titles/labels/tier pay this.
  const prNumbers = commits.map((c) => c.prNumber);
  const fetchMeta = deps.fetchPrMeta ?? defaultFetchPrMeta(deps);
  const metas = await Promise.allSettled(
    prNumbers.map((n) => fetchMeta(n)),
  );

  const out: MergeItem[] = [];
  for (let i = 0; i < prNumbers.length; i += 1) {
    const number = prNumbers[i];
    const result = metas[i];
    if (result.status !== "fulfilled" || !result.value) {
      // Fall back to the git-log committer date when the gh fetch failed, so
      // the item still carries a usable mergedAt instead of epoch-0.
      const gitDate = commits[i].mergedAt;
      out.push({
        prNumber: number,
        title: `PR #${number}`,
        tier: null,
        classLabel: null,
        mergedAt: gitDate || new Date(0).toISOString(),
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
// Step 1 — the cheap git-log primitive: recent merge commits (issue #2177)
// ---------------------------------------------------------------------------

/** Bounded cap on the pre-read `git fetch` — fail-open past this. */
const FETCH_TIMEOUT_MS = 5000;

// `GIT_LOG_FIELD_SEP` (the `%cI|%s` delimiter) lives in the parser leaf and is
// imported above — the git-log pretty format here must use the same literal.

/**
 * Public primitive (issue #2177) — the intermediate "list recent merge
 * commits" step: bounded fail-open `git fetch` + first-parent `git log` read +
 * pure parse, and NOTHING else (no per-PR `gh pr view` fan-out). Returns
 * `{prNumber, mergedAt}` pairs in newest-first order, with `mergedAt` sourced
 * from the git-log committer date (`%cI`).
 *
 * This is the cheap path for callers that only need counts or PR-number+
 * timestamp lists (e.g. `autopilot-health.ts`'s window-merge-count). The
 * full-metadata path (`getRecentMerges`) is a composition of this primitive
 * plus the gh enrichment step.
 *
 * Never throws: any subprocess failure degrades to an empty (or partial) list,
 * matching the module's fail-open contract.
 */
export async function listRecentMergeCommits(
  limit: number,
  deps: RecentMergesDeps = {},
): Promise<MergeCommit[]> {
  const bounded = clampLimit(limit);
  const exec = deps.execFileAsync ?? execFile;
  const cwd = deps.repoPath ?? resolveDefaultRepoPath();
  const logArgs = (ref: string) => [
    "log",
    ref,
    "--first-parent",
    "-n",
    String(bounded * 2),
    `--pretty=format:%cI${GIT_LOG_FIELD_SEP}%s`,
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
    return extractMergeCommitsFromGitLog(stdout, bounded);
  } catch (err: any) {
    console.error(
      `[recent-merges] git log origin/master failed (falling back to local master): ${err?.message || err}`,
    );
  }

  try {
    const { stdout } = await exec("git", logArgs("master"), {
      cwd,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    return extractMergeCommitsFromGitLog(stdout, bounded);
  } catch (err: any) {
    // Final fallback also failed — fail open to an empty list (never throw).
    console.error(
      `[recent-merges] git log master failed (fail-open to empty): ${err?.message || err}`,
    );
    return [];
  }
}

// The pure git-log parsers (`extractMergeCommitsFromGitLog`,
// `extractPrNumbersFromGitLog`, `prNumberFromSubject`) live in the
// `merge-commit-parser.ts` leaf and are imported/re-exported above (issue
// #3100). `listRecentMergeCommits` above calls the imported
// `extractMergeCommitsFromGitLog`.

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

// `prMetaFromView` (the gh-json → PrMeta mapper) and `tierFromLabels` (the
// `tier:N` label parser) live in the `merge-commit-parser.ts` leaf and are
// imported/re-exported above (issue #3100). `defaultFetchPrMeta` above uses the
// imported `prMetaFromView`; `getRecentMerges` uses the imported
// `tierFromLabels`.

function resolveDefaultRepoPath(): string {
  const env = process.env.HYDRA_ROOT;
  if (env) return env;
  const home = process.env.HOME;
  if (home) return `${home}/hydra`;
  return process.cwd();
}

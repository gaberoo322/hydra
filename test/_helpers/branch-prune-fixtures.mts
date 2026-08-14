/**
 * Shared test fixtures for the hydra-branch-prune classifier suite (issue
 * #4062).
 *
 * Split out of the former single ~1800-line test/hydra-branch-prune.test.mts
 * (33 top-level describes / 138 tests) into five sibling files, one per
 * classifier pass, to shrink the per-file top-level-entry count that drives
 * the `--test-force-exit` suite-count-drop race documented in
 * scripts/test/suite-count-check.mjs's header and CLAUDE.md's suite-count-gate
 * pitfall.
 *
 * # Why this is the fix, not a runner workaround
 *
 * Direct measurement (issue #4062 investigation) ruled out every code-level
 * suspect the issue asked to check: this suite has zero teardown hooks, zero
 * `before`/`beforeEach` state leakage, zero unawaited promises, and zero
 * subprocess spawning (the two `readFileSync` driver-guard describes read
 * scripts/branch-prune.sh as inert text — they never execute it). Removing
 * `--test-force-exit` entirely made the original 33-describe file complete
 * deterministically at 33/33 in ~340ms with NO hang, proving there was never
 * an open handle to force-exit past.
 *
 * With `--test-force-exit` restored, isolated single-file reruns of the
 * original file dropped every single time across 5 measured runs (CI: 27,
 * 24; local: 27, 30, 30) — never once completing clean. Shrinking the
 * top-level-entry count directly shrank the failure rate in the same
 * experiment: an 18-describe half still dropped 1/3 runs, a 9-describe
 * quarter still dropped 1/3 runs, but a 4-describe slice ran clean 3/3. This
 * is the "large batched subtests" mechanism the issue's own suspect list
 * named — total registered top-level work in one process is what the race
 * scales with, not any authorship defect in this file. The fix scoped here
 * is therefore the same "reduce entries per file" mitigation the retry logic
 * in redis-db-launch.mjs already leans on (isolating a shortfall file cuts
 * contention from ~428 siblings); this goes one step further and shrinks the
 * file itself. See the `## Friction Report` in the PR that introduced this
 * split for the residual-risk caveat: splitting reduces, but by the nature of
 * a race, cannot categorically zero out, this upstream Node behavior.
 */

import {
  classifyWorktreeOrphan,
  classifyDeadBranch,
  classifyMergedRemote,
  classifyMasterTrackingOrphan,
  DEFAULT_WORKTREE_MIN_AGE_SECONDS,
  type BranchRow,
  type WorktreeRow,
  type LivePidCheck,
} from "../../scripts/ci/branch-prune.ts";

export const NEVER_LIVE: LivePidCheck = () => false;
export const ALWAYS_LIVE: LivePidCheck = () => true;

export function branch(
  name: string,
  opts: { gone?: boolean; current?: boolean; upstream?: boolean } = {},
): BranchRow {
  return {
    name,
    upstreamGone: opts.gone ?? true,
    isCurrent: opts.current ?? false,
    // Pass-1 fixtures model branches that WERE pushed (gone or healthy
    // upstream) — default hasUpstream true. The dead-branch GC fixtures
    // (issue #1784) use localBranch() below instead.
    hasUpstream: opts.upstream ?? true,
  };
}

// Dead-branch GC fixture (issue #1784): a never-pushed local-only branch.
// Default age is comfortably past the floor; pass an explicit ageSeconds
// (or null = unknown) to exercise the floor.
export function localBranch(
  name: string,
  opts: { current?: boolean; ageSeconds?: number | null } = {},
): BranchRow {
  return {
    name,
    upstreamGone: false,
    isCurrent: opts.current ?? false,
    hasUpstream: false,
    ageSeconds: "ageSeconds" in opts ? (opts.ageSeconds ?? null) : OLD,
  };
}

// Age fixtures: `OLD` is comfortably past the 6h floor; `YOUNG` is under it.
// Shared by the worktree-orphan GC tests (issue #911) and the [gone]-pass
// age-floor tests (issue #1773).
export const OLD = DEFAULT_WORKTREE_MIN_AGE_SECONDS + 3600;
export const YOUNG = 60;

export function wt(
  path: string,
  branchName: string | null,
  lockedByPid: number | null = null,
  opts: { ageSeconds?: number | null } = {},
): WorktreeRow {
  return {
    path,
    branch: branchName,
    lockedByPid,
    // Default comfortably past the [gone]-pass age floor (issue #1773) so the
    // pre-existing delete-path tests keep exercising the delete arm. Pass an
    // explicit ageSeconds (or null = unknown age) to exercise the floor.
    ageSeconds: "ageSeconds" in opts ? (opts.ageSeconds ?? null) : OLD,
  };
}

export function owt(
  path: string,
  branchName: string | null,
  opts: { pid?: number | null; ageSeconds?: number | null } = {},
): WorktreeRow {
  return {
    path,
    branch: branchName,
    lockedByPid: opts.pid ?? null,
    // Preserve an explicit `null` (unknown age) — `??` would swallow it, so
    // only default to OLD when the key is genuinely absent.
    ageSeconds: "ageSeconds" in opts ? (opts.ageSeconds ?? null) : OLD,
  };
}

export const MAIN_WT = "/home/gabe/hydra";
export function orphanCtx(over: Partial<Parameters<typeof classifyWorktreeOrphan>[1]> = {}) {
  return {
    mainWorktreePath: MAIN_WT,
    currentBranch: "master",
    isLivePid: NEVER_LIVE,
    openPrHeads: new Set<string>(),
    minAgeSeconds: DEFAULT_WORKTREE_MIN_AGE_SECONDS,
    ...over,
  };
}

export function deadCtx(over: Partial<Parameters<typeof classifyDeadBranch>[1]> = {}) {
  return {
    currentBranch: "master",
    worktrees: [] as WorktreeRow[],
    isLivePid: NEVER_LIVE,
    openPrHeads: new Set<string>(),
    minAgeSeconds: DEFAULT_WORKTREE_MIN_AGE_SECONDS,
    ...over,
  };
}

// A pushed branch with a LIVE (non-gone) upstream — the zombie-remote shape.
export function liveUpstreamBranch(
  name: string,
  opts: { current?: boolean; ageSeconds?: number | null } = {},
): BranchRow {
  return {
    name,
    upstreamGone: false,
    isCurrent: opts.current ?? false,
    hasUpstream: true,
    ageSeconds: "ageSeconds" in opts ? (opts.ageSeconds ?? null) : OLD,
  };
}

export function mergedCtx(over: Partial<Parameters<typeof classifyMergedRemote>[1]> = {}) {
  return {
    currentBranch: "master",
    worktrees: [] as WorktreeRow[],
    isLivePid: NEVER_LIVE,
    mergedOrClosedPrHeads: new Set<string>(),
    openPrHeads: new Set<string>(),
    minAgeSeconds: DEFAULT_WORKTREE_MIN_AGE_SECONDS,
    ...over,
  };
}

// A branch with a LIVE (non-gone) FOREIGN upstream — the master-tracking shape.
// Default upstream is origin/master and default age is past the floor.
export function masterOrphanBranch(
  name: string,
  opts: { current?: boolean; ageSeconds?: number | null; upstreamRef?: string | null } = {},
): BranchRow {
  return {
    name,
    upstreamGone: false,
    isCurrent: opts.current ?? false,
    hasUpstream: true,
    ageSeconds: "ageSeconds" in opts ? (opts.ageSeconds ?? null) : OLD,
    upstreamRef: "upstreamRef" in opts ? (opts.upstreamRef ?? null) : "origin/master",
  };
}

export function masterCtx(over: Partial<Parameters<typeof classifyMasterTrackingOrphan>[1]> = {}) {
  return {
    currentBranch: "master",
    worktrees: [] as WorktreeRow[],
    isLivePid: NEVER_LIVE,
    openPrHeads: new Set<string>(),
    minAgeSeconds: DEFAULT_WORKTREE_MIN_AGE_SECONDS,
    ...over,
  };
}

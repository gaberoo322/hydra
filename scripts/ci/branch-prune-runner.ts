/**
 * scripts/ci/branch-prune-runner.ts — thin runner that reads JSON input on
 * stdin, drives the pure classifier in `branch-prune.ts`, and emits an
 * action plan + rendered report on stdout.
 *
 * Invoked by `scripts/branch-prune.sh`. Kept separate from the classifier so
 * the classifier stays pure and unit-testable.
 *
 * Input JSON shape:
 *   {
 *     branchesRaw: string,      // `git branch -vv` output
 *     worktreesRaw: string,     // `git worktree list --porcelain` output
 *     currentBranch: string,    // e.g. "master"
 *     locks: { [worktreePath: string]: string },  // lock-file body per worktree
 *     audit: boolean,           // true = audit-only, false = apply
 *     // Worktree-orphan GC inputs (issue #911) — optional; absent = GC off.
 *     // worktreeAges/minAgeSeconds ALSO gate the `[gone]`-branch pass's
 *     // delete-worktree-and-branch arm (issue #1773): a worktree with no /
 *     // unknown age is never reclaimed by either pass.
 *     mainWorktreePath?: string,                 // path of the main working tree
 *     openPrHeads?: string[],                    // `gh pr list --json headRefName`
 *     worktreeAges?: { [worktreePath: string]: number }, // dir age in seconds
 *     minAgeSeconds?: number,                    // override the 6h age floor
 *     // Dead-branch GC input (issue #1784) — optional; absent = every
 *     // no-upstream branch has unknown age → conservative skip.
 *     branchAges?: { [branchName: string]: number }, // ref age in seconds
 *     // Merged-remote GC input (issue #2029) — optional; absent/empty = the
 *     // pass deletes nothing (no positive merge signal). Branch names whose PR
 *     // is MERGED/CLOSED but whose `origin/<name>` remote ref still exists.
 *     mergedOrClosedPrHeads?: string[],
 *     // Master-tracking-orphan GC input (issue #2459) — optional; absent = the
 *     // pass is a no-op (no foreign-upstream signal). Maps each local branch
 *     // name → its upstream short-name (e.g. `origin/master`), from
 *     // `git for-each-ref --format='%(upstream:short)'`. A branch whose tracked
 *     // branch segment differs from its own name is a master-tracking orphan.
 *     branchUpstreams?: { [branchName: string]: string }
 *   }
 *
 * Output JSON shape:
 *   {
 *     report: string,           // human-readable report (all five passes)
 *     plan: {
 *       deleteWorktreeAndBranch: Array<{ branch: string, worktreePath: string }>,
 *       deleteBranchOnly: string[],
 *       // Worktree-orphan GC plan (issue #911):
 *       deleteOrphanWorktree: Array<{ worktreePath: string, branch: string | null }>,
 *       // Dead-branch GC plan (issue #1784) — never-pushed dead-dispatch branches:
 *       deleteBranchNoUpstream: string[],
 *       // Merged-remote GC plan (issue #2029) — local refs of merged/closed
 *       // PRs whose remote branch survived; LOCAL delete only:
 *       deleteBranchMergedRemote: string[],
 *       // Master-tracking-orphan GC plan (issue #2459) — dispatch branches that
 *       // track origin/master, never pushed under their own name; LOCAL delete:
 *       deleteBranchMasterTrackingOrphan: string[],
 *     }
 *   }
 *
 * The runner does NOT execute the destructive ops; the shell driver does
 * that after parsing the plan. This keeps the runner side-effect-free and
 * lets the shell layer log per-op outcomes.
 */

import { readFileSync } from "node:fs";
import {
  parseBranchLine,
  parseWorktreeList,
  classifyBatch,
  renderReport,
  classifyWorktreeOrphans,
  renderWorktreeOrphanReport,
  classifyDeadBranches,
  renderDeadBranchReport,
  classifyMergedRemotes,
  renderMergedRemoteReport,
  classifyMasterTrackingOrphans,
  renderMasterTrackingOrphanReport,
  DEFAULT_WORKTREE_MIN_AGE_SECONDS,
  type WorktreeRow,
} from "./branch-prune.ts";

interface RunnerInput {
  branchesRaw?: string;
  worktreesRaw?: string;
  currentBranch?: string;
  locks?: Record<string, string>;
  audit?: boolean;
  // Worktree-orphan GC inputs (issue #911).
  mainWorktreePath?: string;
  openPrHeads?: string[];
  worktreeAges?: Record<string, number>;
  minAgeSeconds?: number;
  // Dead-branch GC input (issue #1784): branch-name → seconds since the ref
  // was last updated. Absent entries = unknown age = conservative skip.
  branchAges?: Record<string, number>;
  // Merged-remote GC input (issue #2029): branch names whose PR is MERGED or
  // CLOSED but whose `origin/<name>` remote ref still exists (squash-merge
  // without --delete-branch). Absent/empty → the pass deletes nothing.
  mergedOrClosedPrHeads?: string[];
  // Master-tracking-orphan GC input (issue #2459): branch-name → its upstream
  // short-name (e.g. `origin/master`). A branch whose tracked branch segment
  // differs from its own name tracks a FOREIGN upstream and is a candidate.
  // Absent entries leave upstreamRef null → tracksForeignUpstream is false →
  // the pass treats the branch as out-of-scope (conservative no-op).
  branchUpstreams?: Record<string, string>;
}

function readStdin(): string {
  try {
    return readFileSync(0, "utf-8");
  } catch (err: any) {
    console.error(`branch-prune-runner: failed to read stdin: ${err.message}`);
    process.exit(2);
  }
}

const raw = readStdin();
let input: RunnerInput;
try {
  input = JSON.parse(raw) as RunnerInput;
} catch (err: any) {
  console.error(`branch-prune-runner: stdin is not valid JSON: ${err.message}`);
  process.exit(2);
}

const branches = String(input.branchesRaw || "")
  .split("\n")
  .map(parseBranchLine)
  .filter((b): b is NonNullable<typeof b> => b !== null)
  // Attach caller-computed ref ages (issue #1784) — consumed by the dead-
  // branch GC age floor. A missing entry stays null = unknown = skip.
  // Also attach the per-branch upstream short-name (issue #2459) — consumed by
  // the master-tracking-orphan GC's foreign-upstream predicate. A missing entry
  // stays null → the branch is out of that pass's scope (conservative no-op).
  .map((b) => ({
    ...b,
    ageSeconds: input.branchAges ? input.branchAges[b.name] ?? null : null,
    upstreamRef: input.branchUpstreams ? input.branchUpstreams[b.name] ?? null : null,
  }));

const locks = new Map<string, string>(Object.entries(input.locks || {}));
// Attach caller-computed dir ages to EVERY row up front (issue #1773): the
// `[gone]`-branch pass needs them too — its delete-worktree-and-branch arm
// defers (`skip-too-young`) under the age floor, so an in-flight cycle whose
// branch went `[gone]` the moment auto-merge deleted it is not reaped
// mid-cycle. A missing entry stays null = unknown age = conservative skip of
// the worktree (the branch itself is then left alone too).
const worktrees: WorktreeRow[] = parseWorktreeList(String(input.worktreesRaw || ""), locks).map(
  (wt) => ({
    ...wt,
    ageSeconds: input.worktreeAges ? input.worktreeAges[wt.path] ?? null : null,
  }),
);
const currentBranch = input.currentBranch || "master";
const audit = input.audit !== false;
const minAgeSeconds =
  typeof input.minAgeSeconds === "number" && input.minAgeSeconds >= 0
    ? input.minAgeSeconds
    : DEFAULT_WORKTREE_MIN_AGE_SECONDS;

function isLivePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM means the process exists but we can't signal it — treat as live.
    return err && err.code === "EPERM";
  }
}

const buckets = classifyBatch(branches, {
  currentBranch,
  worktrees,
  isLivePid,
  minAgeSeconds,
});

const report = renderReport(buckets, new Date().toISOString(), audit);

// ── Worktree-orphan GC pass (issue #911) ───────────────────────────────────
// Reclaims local-only worktrees the `[gone]`-branch pass above can never see.
// The branch pass deletes the worktrees attached to `[gone]` branches; we must
// not double-handle those here, so subtract them from the candidate set first.
const branchPassWorktreePaths = new Set(
  buckets.deleteWorktreeAndBranch.map((e) => e.worktree.path),
);
// Ages are already attached to every row above (issue #1773).
const orphanCandidates: WorktreeRow[] = worktrees.filter(
  (wt) => !branchPassWorktreePaths.has(wt.path),
);

// The 250-deletion hard cap spans BOTH passes: seed the worktree pass with the
// branch pass's deletion count so we never blow past the ceiling in one run.
const priorDeletions =
  buckets.deleteWorktreeAndBranch.length + buckets.deleteBranchOnly.length;

const orphanBuckets = classifyWorktreeOrphans(orphanCandidates, {
  mainWorktreePath: input.mainWorktreePath || "",
  currentBranch,
  isLivePid,
  openPrHeads: new Set(input.openPrHeads || []),
  minAgeSeconds,
  priorDeletions,
});

const orphanReport = renderWorktreeOrphanReport(orphanBuckets, audit);

// ── Dead-branch GC pass (issue #1784) ──────────────────────────────────────
// Never-pushed dead-dispatch branches: no upstream (pass 1 can never see
// them), worktree already reaped (pass 2 can never see them). The classifier
// itself filters to dispatch-shaped names, skips open-PR heads and attached
// worktrees, and applies the shared age floor — so we feed it ALL branch rows
// and let its rails decide. The hard cap is seeded with BOTH prior passes'
// deletion counts so the 250 ceiling spans the whole run.
const deadBranchBuckets = classifyDeadBranches(branches, {
  currentBranch,
  worktrees,
  isLivePid,
  openPrHeads: new Set(input.openPrHeads || []),
  minAgeSeconds,
  priorDeletions: priorDeletions + orphanBuckets.deleteOrphan.length,
});

const deadBranchReport = renderDeadBranchReport(deadBranchBuckets, audit);

// ── Merged-remote GC pass (issue #2029) ────────────────────────────────────
// Squash-merge-with-zombie-remote: a dispatch branch whose PR is MERGED or
// CLOSED but whose `origin/<name>` ref still exists, so the upstream never
// goes `[gone]` — pass 1 sees a healthy upstream (skip-not-gone), pass 3 sees
// hasUpstream (skip-has-upstream). The merged/closed-PR set is the positive
// merge signal; an absent set (no `gh`) → the pass deletes nothing. Hard cap
// seeded with all three prior passes so the 250 ceiling spans the whole run.
// Deletes the LOCAL ref ONLY (the remote zombie ref is an operator step).
const mergedRemoteBuckets = classifyMergedRemotes(branches, {
  currentBranch,
  worktrees,
  isLivePid,
  mergedOrClosedPrHeads: new Set(input.mergedOrClosedPrHeads || []),
  openPrHeads: new Set(input.openPrHeads || []),
  minAgeSeconds,
  priorDeletions:
    priorDeletions + orphanBuckets.deleteOrphan.length + deadBranchBuckets.deleteBranch.length,
});

const mergedRemoteReport = renderMergedRemoteReport(mergedRemoteBuckets, audit);

// ── Master-tracking-orphan GC pass (issue #2459) ───────────────────────────
// Dispatch branches that INHERITED `origin/master` as their upstream (via
// `git worktree add` / `checkout -b`) and were never pushed under their own
// name. The upstream is healthy and non-`[gone]` forever, and the name was
// never a PR head, so passes 1/3/4 all skip them permanently:
//   pass 1 → skip-not-gone, pass 3 → skip-has-upstream, pass 4 → skip-pr-unresolved.
// The distinguishing signal is the foreign-upstream test (upstreamRef tracks a
// branch whose name differs from the local branch's own name), supplied via the
// per-branch upstream map. Hard cap seeded with ALL four prior passes so the
// 250 ceiling spans the whole run. Deletes the LOCAL ref ONLY (no `origin/<name>`
// ref exists to touch — that absence is precisely why these accumulate).
const masterTrackingOrphanBuckets = classifyMasterTrackingOrphans(branches, {
  currentBranch,
  worktrees,
  isLivePid,
  openPrHeads: new Set(input.openPrHeads || []),
  minAgeSeconds,
  priorDeletions:
    priorDeletions +
    orphanBuckets.deleteOrphan.length +
    deadBranchBuckets.deleteBranch.length +
    mergedRemoteBuckets.deleteBranch.length,
});

const masterTrackingOrphanReport = renderMasterTrackingOrphanReport(
  masterTrackingOrphanBuckets,
  audit,
);
const fullReport = `${report}\n\n${orphanReport}\n\n${deadBranchReport}\n\n${mergedRemoteReport}\n\n${masterTrackingOrphanReport}`;

const plan = {
  deleteWorktreeAndBranch: buckets.deleteWorktreeAndBranch.map((e) => ({
    branch: e.row.name,
    worktreePath: e.worktree.path,
  })),
  deleteBranchOnly: buckets.deleteBranchOnly.map((b) => b.name),
  deleteOrphanWorktree: orphanBuckets.deleteOrphan.map((e) => ({
    worktreePath: e.worktree.path,
    branch: e.branch,
  })),
  deleteBranchNoUpstream: deadBranchBuckets.deleteBranch.map((b) => b.name),
  deleteBranchMergedRemote: mergedRemoteBuckets.deleteBranch.map((b) => b.name),
  deleteBranchMasterTrackingOrphan: masterTrackingOrphanBuckets.deleteBranch.map((b) => b.name),
};

process.stdout.write(JSON.stringify({ report: fullReport, plan }));

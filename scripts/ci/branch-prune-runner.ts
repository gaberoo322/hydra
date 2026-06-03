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
 *     // Worktree-orphan GC inputs (issue #911) — optional; absent = GC off:
 *     mainWorktreePath?: string,                 // path of the main working tree
 *     openPrHeads?: string[],                    // `gh pr list --json headRefName`
 *     worktreeAges?: { [worktreePath: string]: number }, // dir age in seconds
 *     minAgeSeconds?: number                     // override the 6h age floor
 *   }
 *
 * Output JSON shape:
 *   {
 *     report: string,           // human-readable report (both passes)
 *     plan: {
 *       deleteWorktreeAndBranch: Array<{ branch: string, worktreePath: string }>,
 *       deleteBranchOnly: string[],
 *       // Worktree-orphan GC plan (issue #911):
 *       deleteOrphanWorktree: Array<{ worktreePath: string, branch: string | null }>,
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
  .filter((b): b is NonNullable<typeof b> => b !== null);

const locks = new Map<string, string>(Object.entries(input.locks || {}));
const worktrees = parseWorktreeList(String(input.worktreesRaw || ""), locks);
const currentBranch = input.currentBranch || "master";
const audit = input.audit !== false;

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
});

const report = renderReport(buckets, new Date().toISOString(), audit);

// ── Worktree-orphan GC pass (issue #911) ───────────────────────────────────
// Reclaims local-only worktrees the `[gone]`-branch pass above can never see.
// The branch pass deletes the worktrees attached to `[gone]` branches; we must
// not double-handle those here, so subtract them from the candidate set first.
const branchPassWorktreePaths = new Set(
  buckets.deleteWorktreeAndBranch.map((e) => e.worktree.path),
);
const orphanCandidates: WorktreeRow[] = worktrees
  .filter((wt) => !branchPassWorktreePaths.has(wt.path))
  .map((wt) => ({
    ...wt,
    ageSeconds: input.worktreeAges ? input.worktreeAges[wt.path] ?? null : null,
  }));

// The 250-deletion hard cap spans BOTH passes: seed the worktree pass with the
// branch pass's deletion count so we never blow past the ceiling in one run.
const priorDeletions =
  buckets.deleteWorktreeAndBranch.length + buckets.deleteBranchOnly.length;

const orphanBuckets = classifyWorktreeOrphans(orphanCandidates, {
  mainWorktreePath: input.mainWorktreePath || "",
  currentBranch,
  isLivePid,
  openPrHeads: new Set(input.openPrHeads || []),
  minAgeSeconds:
    typeof input.minAgeSeconds === "number" && input.minAgeSeconds >= 0
      ? input.minAgeSeconds
      : DEFAULT_WORKTREE_MIN_AGE_SECONDS,
  priorDeletions,
});

const orphanReport = renderWorktreeOrphanReport(orphanBuckets, audit);
const fullReport = `${report}\n\n${orphanReport}`;

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
};

process.stdout.write(JSON.stringify({ report: fullReport, plan }));

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
 *     audit: boolean            // true = audit-only, false = apply
 *   }
 *
 * Output JSON shape:
 *   {
 *     report: string,           // human-readable report
 *     plan: {
 *       deleteWorktreeAndBranch: Array<{ branch: string, worktreePath: string }>,
 *       deleteBranchOnly: string[],
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
} from "./branch-prune.ts";

interface RunnerInput {
  branchesRaw?: string;
  worktreesRaw?: string;
  currentBranch?: string;
  locks?: Record<string, string>;
  audit?: boolean;
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

const plan = {
  deleteWorktreeAndBranch: buckets.deleteWorktreeAndBranch.map((e) => ({
    branch: e.row.name,
    worktreePath: e.worktree.path,
  })),
  deleteBranchOnly: buckets.deleteBranchOnly.map((b) => b.name),
};

process.stdout.write(JSON.stringify({ report, plan }));

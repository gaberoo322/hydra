/**
 * mergeToMain regression tests (issue #218).
 *
 * Regression: mergeToMain ran in PROJECT_WORKSPACE which was already on main.
 * It checked `git branch --show-current`, saw `main`, took the
 * "Already on main, pushed" path, and returned the existing SHA as success —
 * even though the executor's actual feature branch lived in a separate
 * worktree at /dev/shm/hydra-worktrees/... and was never merged.
 *
 * Fix:
 *   1. mergeToMain accepts an explicit feature branch name, so callers can
 *      thread `execResult.branch` through (control-loop.ts: runMergeStep).
 *   2. mergeToMain refuses to merge when the feature branch has no commits
 *      beyond main, returning { ok: false, error: "empty diff" } instead of
 *      silently succeeding.
 *   3. A real worktree branch with commits produces a real merge commit on
 *      main and ok: true.
 *
 * These tests use a real on-disk git repo (no remotes pushed; remote-push
 * paths fail fast and surface as `error` strings, which is fine — the
 * test asserts on the success path locally).
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mergeToMain } from "../src/pipeline-steps.ts";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Helpers — set up a self-contained git repo with a fake "origin" remote so
// `git push` calls inside mergeToMain can succeed locally without network.
// ---------------------------------------------------------------------------

async function git(cwd: string, ...args: string[]) {
  return execFileAsync("git", args, { cwd, timeout: 10000 });
}

async function setupRepo(): Promise<{ root: string; bare: string; main: string; worktree: string }> {
  const root = await mkdtemp(join(tmpdir(), "hydra-merge-test-"));
  const bare = join(root, "bare.git");
  const main = join(root, "main");
  const worktree = join(root, "worktree");

  // Bare "origin"
  await execFileAsync("git", ["init", "--bare", bare], { timeout: 10000 });

  // Main clone
  await execFileAsync("git", ["clone", bare, main], { timeout: 10000 });
  await git(main, "config", "user.email", "test@example.com");
  await git(main, "config", "user.name", "Test");
  await git(main, "checkout", "-b", "main");
  await writeFile(join(main, "README.md"), "initial\n");
  await git(main, "add", "README.md");
  await git(main, "commit", "-m", "initial");
  await git(main, "push", "-u", "origin", "main");

  return { root, bare, main, worktree };
}

async function cleanupRepo(root: string) {
  await rm(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mergeToMain (issue #218)", () => {
  test("threading: explicit feature branch with commits produces real merge commit", async () => {
    const { root, main, worktree } = await setupRepo();
    try {
      // Create a worktree on a feature branch, write a real commit there.
      await git(main, "worktree", "add", "-b", "feature/cycle-001-slug", worktree, "main");
      await git(worktree, "config", "user.email", "test@example.com");
      await git(worktree, "config", "user.name", "Test");
      await writeFile(join(worktree, "added.ts"), "export const x = 1;\n");
      await git(worktree, "add", "added.ts");
      await git(worktree, "commit", "-m", "feat: add x");

      // SHA of main BEFORE merge
      const { stdout: shaBefore } = await git(main, "rev-parse", "HEAD");

      // Caller threads the executor's branch into mergeToMain.
      // (Workspace `main` is checked out on `main`; mergeToMain must NOT take
      // the "already on main" shortcut just because of that — it must use
      // the explicit feature branch.)
      const result = await mergeToMain(main, "cycle-001", "feature/cycle-001-slug");

      // Push to the bare origin will succeed because we set up a real remote.
      assert.equal(result.ok, true, `expected ok=true, got error=${result.error}`);
      assert.equal(result.featureBranch, "feature/cycle-001-slug");
      assert.notEqual(result.commitSha, shaBefore.trim(), "merge must advance HEAD");

      // Verify a merge commit (not fast-forward) was produced — `--no-ff`.
      const { stdout: parents } = await git(main, "rev-list", "--parents", "-n", "1", "HEAD");
      const parentParts = parents.trim().split(/\s+/);
      assert.equal(parentParts.length, 3, `expected 2-parent merge commit, got ${parentParts.length - 1}`);

      // Verify the new file actually landed on main.
      const { stdout: ls } = await git(main, "ls-tree", "-r", "--name-only", "HEAD");
      assert.ok(ls.split("\n").includes("added.ts"), "added.ts should be on main after merge");
    } finally {
      await cleanupRepo(root);
    }
  });

  test("empty-diff guard: feature branch with no commits beyond main returns ok:false", async () => {
    const { root, main, worktree } = await setupRepo();
    try {
      // Worktree on feature branch but no new commits.
      await git(main, "worktree", "add", "-b", "feature/cycle-002-slug", worktree, "main");
      // (No commits made on the feature branch.)

      const result = await mergeToMain(main, "cycle-002", "feature/cycle-002-slug");

      assert.equal(result.ok, false);
      assert.equal(result.error, "empty diff");
      assert.equal(result.commitSha, "");

      // main HEAD must be unchanged — no phantom merge commit.
      const { stdout: log } = await git(main, "log", "--oneline", "main");
      assert.equal(log.trim().split("\n").length, 1, "main must have only the initial commit");
    } finally {
      await cleanupRepo(root);
    }
  });

  test("empty-diff guard: no feature branch supplied + workspace on main returns ok:false (was the phantom-merge bug)", async () => {
    const { root, main } = await setupRepo();
    try {
      // Workspace is on main, no feature branch ever created. Prior behavior:
      // returned ok:true with the existing SHA. New behavior: ok:false with
      // "empty diff" so callers can react instead of silently recording a
      // phantom merge.
      const result = await mergeToMain(main, "cycle-003");

      assert.equal(result.ok, false);
      assert.equal(result.error, "empty diff");
      assert.equal(result.featureBranch, null);
    } finally {
      await cleanupRepo(root);
    }
  });

  test("threading: explicit branch overrides current-branch detection", async () => {
    // Even when workspace happens to be on `main`, an explicit branch name
    // must be used (not silently ignored). This is the core of the fix.
    const { root, main, worktree } = await setupRepo();
    try {
      await git(main, "worktree", "add", "-b", "feature/cycle-004-slug", worktree, "main");
      await git(worktree, "config", "user.email", "test@example.com");
      await git(worktree, "config", "user.name", "Test");
      await writeFile(join(worktree, "f.ts"), "x\n");
      await git(worktree, "add", "f.ts");
      await git(worktree, "commit", "-m", "feat");

      // Confirm workspace is on `main` (worktree took the new branch).
      const { stdout: cur } = await git(main, "branch", "--show-current");
      assert.equal(cur.trim(), "main");

      const result = await mergeToMain(main, "cycle-004", "feature/cycle-004-slug");
      assert.equal(result.ok, true, `expected ok=true, got error=${result.error}`);
      assert.equal(result.featureBranch, "feature/cycle-004-slug");
    } finally {
      await cleanupRepo(root);
    }
  });
});

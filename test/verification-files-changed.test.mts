/**
 * extractDiff regression tests (issue #220).
 *
 * Regression: runVerification computed `filesChanged` via
 * `git diff --stat main` from PROJECT_WORKSPACE. When the workspace was
 * silently still on main (e.g. executor's `git checkout featureBranch`
 * never landed in the main repo), this returned an empty diff. 19/20
 * recent reality reports had `verification.filesChanged: []`, which in
 * turn vacuously skipped mutation testing, JIT, scope-enforcement, and
 * adversarial validation, and made the reconciler emit false-positive
 * scopeGap warnings for every planned file.
 *
 * Fix: introduce extractDiff(projectDir, { featureBranch?, commitSha? })
 * which prefers `main...<featureBranch>` (workspace-state-independent) and
 * falls back to `git show --name-only <commitSha>` (post-merge). Tests run
 * against a real on-disk git repo so we exercise the actual git invocations.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractDiff } from "../src/verification.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]) {
  return execFileAsync("git", args, { cwd, timeout: 10000 });
}

/**
 * Set up a git repo on `main` with one initial commit. Returns the repo
 * path; caller is responsible for cleanup via rm().
 */
async function setupRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hydra-extractdiff-test-"));
  await execFileAsync("git", ["init", "-b", "main", root], { timeout: 10000 });
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");
  await writeFile(join(root, "README.md"), "initial\n");
  await git(root, "add", "README.md");
  await git(root, "commit", "-m", "initial");
  return root;
}

describe("extractDiff (issue #220)", () => {
  test("featureBranch path: workspace on main, branch in worktree, files appear", async () => {
    // This is the exact failure mode from the bug report. PROJECT_WORKSPACE
    // is on main; the executor's branch lives in a worktree. The legacy
    // `git diff --stat main` returns empty. extractDiff with featureBranch
    // must use `main...<branch>` and surface the changes.
    const root = await setupRepo();
    try {
      const worktree = join(root, "..", `wt-${Date.now()}`);
      await git(root, "worktree", "add", "-b", "feature/x", worktree, "main");
      await git(worktree, "config", "user.email", "test@example.com");
      await git(worktree, "config", "user.name", "Test");
      await writeFile(join(worktree, "src.ts"), "export const x = 1;\n");
      await writeFile(join(worktree, "test.ts"), "test();\n");
      await git(worktree, "add", "src.ts", "test.ts");
      await git(worktree, "commit", "-m", "feat: x");

      // workspace (root) is still on main — confirm the legacy path is empty
      const { stdout: legacyDiff } = await git(root, "diff", "--stat", "main");
      assert.equal(legacyDiff.trim(), "", "precondition: legacy diff should be empty");

      // extractDiff with featureBranch should find the files
      const result = await extractDiff(root, { featureBranch: "feature/x" });

      assert.ok(
        result.filesChanged.includes("src.ts"),
        `expected src.ts in filesChanged, got ${JSON.stringify(result.filesChanged)}`,
      );
      assert.ok(
        result.filesChanged.includes("test.ts"),
        `expected test.ts in filesChanged, got ${JSON.stringify(result.filesChanged)}`,
      );
      assert.equal(result.filesChanged.length, 2);
      assert.ok(result.diffSummary.length > 0, "diffSummary should be non-empty");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("featureBranch path: when workspace IS on the branch, still returns the same set", async () => {
    // Sanity: extractDiff should be agnostic to whether the workspace HEAD
    // matches the requested branch.
    const root = await setupRepo();
    try {
      await git(root, "checkout", "-b", "feature/y");
      await writeFile(join(root, "added.ts"), "export const y = 1;\n");
      await git(root, "add", "added.ts");
      await git(root, "commit", "-m", "feat: y");

      const result = await extractDiff(root, { featureBranch: "feature/y" });
      assert.deepEqual(result.filesChanged, ["added.ts"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("commitSha path: post-merge, list files via git show", async () => {
    // After mergeToMain, PROJECT_WORKSPACE is back on main with a new merge
    // commit. extractDiff with commitSha should list the files the merge
    // brought in.
    const root = await setupRepo();
    try {
      await git(root, "checkout", "-b", "feature/z");
      await writeFile(join(root, "z1.ts"), "export const z = 1;\n");
      await writeFile(join(root, "z2.ts"), "export const z2 = 2;\n");
      await git(root, "add", "z1.ts", "z2.ts");
      await git(root, "commit", "-m", "feat: z");

      await git(root, "checkout", "main");
      await git(root, "merge", "--no-ff", "feature/z", "-m", "merge feature/z");
      const { stdout: sha } = await git(root, "rev-parse", "HEAD");
      const mergeSha = sha.trim();

      const result = await extractDiff(root, { commitSha: mergeSha });

      assert.ok(
        result.filesChanged.includes("z1.ts"),
        `expected z1.ts, got ${JSON.stringify(result.filesChanged)}`,
      );
      assert.ok(
        result.filesChanged.includes("z2.ts"),
        `expected z2.ts, got ${JSON.stringify(result.filesChanged)}`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("featureBranch falls through to commitSha when branch yields nothing", async () => {
    // Edge case: branch was already merged and reset to main, so the branch
    // ref no longer has unique commits. extractDiff should fall through to
    // the commitSha strategy.
    const root = await setupRepo();
    try {
      await git(root, "checkout", "-b", "feature/w");
      await writeFile(join(root, "w.ts"), "export const w = 1;\n");
      await git(root, "add", "w.ts");
      await git(root, "commit", "-m", "feat: w");
      await git(root, "checkout", "main");
      await git(root, "merge", "--no-ff", "feature/w", "-m", "merge feature/w");
      const { stdout: sha } = await git(root, "rev-parse", "HEAD");
      const mergeSha = sha.trim();

      // Reset feature branch to main so `main...feature/w` is empty
      await git(root, "branch", "-f", "feature/w", "main");

      const result = await extractDiff(root, {
        featureBranch: "feature/w",
        commitSha: mergeSha,
      });

      assert.ok(
        result.filesChanged.includes("w.ts"),
        `expected fallback to commitSha to surface w.ts, got ${JSON.stringify(result.filesChanged)}`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("returns empty filesChanged (never throws) when branch and sha are bogus", async () => {
    // Defensive: extractDiff is documented to never throw. If both refs are
    // bogus and the workspace has no diff vs main, return empty.
    const root = await setupRepo();
    try {
      const result = await extractDiff(root, {
        featureBranch: "nope/does-not-exist",
        commitSha: "deadbeef0000000000000000000000000000dead",
      });
      assert.deepEqual(result.filesChanged, []);
      assert.equal(result.diffSummary, "");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("no opts: legacy behaviour — diffs against main when workspace on feature branch", async () => {
    // Backwards compatibility: callers that don't supply featureBranch or
    // commitSha (none currently exist after this fix, but defensive) get the
    // legacy `git diff --stat main` path.
    const root = await setupRepo();
    try {
      await git(root, "checkout", "-b", "feature/legacy");
      await writeFile(join(root, "legacy.ts"), "export const l = 1;\n");
      await git(root, "add", "legacy.ts");
      await git(root, "commit", "-m", "feat: legacy");

      const result = await extractDiff(root);
      assert.deepEqual(result.filesChanged, ["legacy.ts"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

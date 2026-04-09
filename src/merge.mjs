import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Merge the current feature branch into main and push.
 *
 * Flow:
 *   1. Detect current branch.
 *   2. If on main: just push the already-committed work.
 *   3. Otherwise: checkout main, pull (best-effort), merge --no-ff the feature
 *      branch, push, delete the merged feature branch (best-effort).
 *
 * Never throws — returns a result object so the caller can decide how to
 * report the failure (publish a merge_failed event, transition task state,
 * etc.) without the merge module reaching into those concerns itself.
 *
 * Extracted from control-loop.mjs in the 2026-04-08 architecture pass so
 * the 1000-line control loop has a clear seam around git operations.
 *
 * @param {string} projectDir
 * @param {string} cycleId — used in the merge commit message for traceability
 * @returns {Promise<{ok: boolean, commitSha: string, featureBranch: string|null, error: string|null}>}
 */
export async function mergeToMain(projectDir, cycleId) {
  try {
    const { stdout: branchOut } = await execFileAsync(
      "git",
      ["branch", "--show-current"],
      { cwd: projectDir, timeout: 5000 },
    );
    const featureBranch = branchOut.trim();

    if (featureBranch && featureBranch !== "main") {
      await execFileAsync("git", ["checkout", "main"], {
        cwd: projectDir,
        timeout: 10000,
      });
      await execFileAsync(
        "git",
        ["pull", "origin", "main"],
        { cwd: projectDir, timeout: 30000 },
      ).catch((err) => {
        console.error(
          `[Merge] git pull before merge failed (continuing with local main): ${err.message}`,
        );
      });
      await execFileAsync(
        "git",
        [
          "merge",
          "--no-ff",
          featureBranch,
          "-m",
          `merge: ${featureBranch} into main for ${cycleId}`,
        ],
        { cwd: projectDir, timeout: 30000 },
      );
      await execFileAsync("git", ["push", "origin", "main"], {
        cwd: projectDir,
        timeout: 30000,
      });
      const { stdout: sha } = await execFileAsync(
        "git",
        ["rev-parse", "HEAD"],
        { cwd: projectDir, timeout: 5000 },
      );
      const commitSha = sha.trim();

      // Delete the merged feature branch (non-fatal if it fails — e.g. branch
      // was already deleted or is still referenced somewhere).
      try {
        await execFileAsync("git", ["branch", "-d", featureBranch], {
          cwd: projectDir,
          timeout: 5000,
        });
      } catch (err) {
        console.error(
          `[Merge] Failed to delete merged branch ${featureBranch}: ${err.message}`,
        );
      }

      return { ok: true, commitSha, featureBranch, error: null };
    }

    // Already on main — push (errors bubble up to the outer catch so callers
    // see a clean failure path rather than a silently unpushed commit).
    await execFileAsync("git", ["push", "origin", "main"], {
      cwd: projectDir,
      timeout: 30000,
    });
    const { stdout: sha } = await execFileAsync(
      "git",
      ["rev-parse", "HEAD"],
      { cwd: projectDir, timeout: 5000 },
    );
    return {
      ok: true,
      commitSha: sha.trim(),
      featureBranch: null,
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      commitSha: "",
      featureBranch: null,
      error: err?.message || String(err),
    };
  }
}

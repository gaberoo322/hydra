import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { acquireWorkspaceLock, releaseWorkspaceLock } from "./redis-adapter.ts";

const execFileAsync = promisify(execFile);

/**
 * Match orchestrator-owned cycle feature branches.
 *
 * Format produced by the executor: `feature/cycle-YYYY-MM-DD-NNNN-slug`
 * (see src/executor-agent.ts `branchName = feature/${cycleId}-slug`).
 *
 * Operator-driven branches (e.g. `feature/foo-bar`, `feature/operator-experiment`,
 * `feature/hotfix-3`) do NOT match this pattern — they're protected by the
 * existing safety gate.
 *
 * Exported for test coverage (issue #340).
 *
 * @param {string} branchName
 * @returns {boolean}
 */
export function isOrchestratorOwnedBranch(branchName) {
  if (!branchName || typeof branchName !== "string") return false;
  return /^feature\/cycle-\d{4}-\d{2}-\d{2}-\d{4}/.test(branchName.trim());
}

/**
 * Decide whether it's safe to auto-clean the target project's working tree.
 *
 * Historically this lived in grounding.mjs, where groundProject() would
 * silently run `git checkout main && git checkout . && git branch -D feature/*`
 * every cycle as a side effect of "reading truth." That broke operator work
 * mid-edit (the 2026-04-07 "file revert mystery"). Now workspace preparation
 * is an explicit step the control loop calls before grounding — grounding
 * is read-only.
 *
 * Safety rules:
 *   - Must be on main/master (not a feature/cycle branch)
 *   - Working tree must have no TRACKED modifications (untracked is fine;
 *     git checkout doesn't touch untracked files)
 *   - Must have a current branch (detached HEAD / fresh repo → skip)
 *
 * Pure function for testability: takes the captured runCmd output objects
 * from `git branch --show-current` and `git status --short` and returns
 * { ok, reason } without any side effects.
 *
 * @param {{stdout?: string}|null} branchResult
 * @param {{stdout?: string}|null} statusResult
 * @returns {{ok: boolean, reason?: string}}
 */
export function shouldCleanWorkingTree(branchResult, statusResult) {
  const branch = (branchResult?.stdout || "").trim();
  const status = (statusResult?.stdout || "").trim();

  if (!branch) {
    return { ok: false, reason: "no current branch (detached HEAD or fresh repo)" };
  }

  // Filter out untracked files (lines starting with "?? "). Untracked files
  // are safe — `git checkout main && git checkout .` doesn't touch them, and
  // the original cleanup code explicitly avoided `git clean -fd` for this
  // exact reason. Only TRACKED modifications (M, A, D, R, etc.) signal that
  // the operator is editing and we should defer.
  const trackedChanges = status
    ? status.split("\n").filter((line) => line && !line.startsWith("?? "))
    : [];

  if (branch !== "main" && branch !== "master") {
    // Issue #340: orchestrator-owned cycle branches (feature/cycle-YYYY-MM-DD-NNNN-*)
    // with a clean tracked tree are safe to auto-recover — they're leftovers
    // from a failed executor cleanup, not operator-driven work. Without this,
    // a single botched worktree-remove leaves the repo wedged on a feature
    // branch and every subsequent cycle abandons.
    if (isOrchestratorOwnedBranch(branch) && trackedChanges.length === 0) {
      return {
        ok: true,
        recoverFromOrchestratorBranch: branch,
      };
    }
    return { ok: false, reason: `on feature branch "${branch}" — operator-driven work, not auto-cleaning` };
  }

  if (trackedChanges.length > 0) {
    return {
      ok: false,
      reason: `working tree has ${trackedChanges.length} tracked modification(s) — operator-driven work, not auto-cleaning`,
    };
  }

  return { ok: true };
}

async function runGit(cwd, args, timeout = 5000) {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd, timeout });
    return { stdout, stderr };
  } catch (err) {
    return { stdout: err.stdout || "", stderr: err.stderr || err.message || "" };
  }
}

/**
 * Ensure the repo is on main with a clean tracked tree, and delete stale
 * feature branches. GATED on shouldCleanWorkingTree() so we don't clobber
 * operator-driven manual work.
 *
 * This used to live inline in groundProject() as a silent side effect. It
 * is now an explicit step the control loop calls BEFORE grounding, which
 * makes grounding a pure read of truth and makes workspace preparation
 * something the caller can observe and decide to skip.
 *
 * Never throws — errors from individual git operations are swallowed and
 * the function returns a descriptive result. The callers can decide whether
 * that's worth alerting on.
 *
 * @param {string} projectDir
 * @returns {Promise<{cleaned: boolean, reason: string|null, staleBranchesDeleted: number}>}
 */
export async function prepareWorkspace(projectDir) {
  const branchResult = await runGit(projectDir, ["branch", "--show-current"]);
  const statusResult = await runGit(projectDir, ["status", "--short"]);
  const decision = shouldCleanWorkingTree(branchResult, statusResult);
  const currentBranch = (branchResult?.stdout || "").trim();

  if (!decision.ok) {
    console.log(`[PrepareWorkspace] Skipping auto-cleanup: ${decision.reason}`);

    // Issue #340: track consecutive wedged cycles. A "wedged" workspace is one
    // where prepareWorkspace skipped cleanup because the target repo is sitting
    // on a feature branch we can't auto-recover (operator-named, or dirty).
    // Surfaces in /api/scheduler/status; scheduler halts at the configured
    // threshold so we don't burn the daily budget on no-op cycles.
    const wedged = await recordWedgedCycle(currentBranch, decision.reason);

    return {
      cleaned: false,
      reason: decision.reason,
      staleBranchesDeleted: 0,
      wedgedBranch: wedged.branch,
      wedgedConsecutiveCycles: wedged.consecutiveCycles,
    };
  }

  // Acquire workspace lock — prevents concurrent git operations from
  // Claude Code and Codex stepping on each other's workspace state
  const locked = await acquireWorkspaceLock(process.pid);
  if (!locked) {
    return { cleaned: false, reason: "Another process is modifying the workspace", staleBranchesDeleted: 0 };
  }

  try {
    if (decision.recoverFromOrchestratorBranch) {
      console.log(
        `[PrepareWorkspace] Auto-recovering from orchestrator-owned branch "${decision.recoverFromOrchestratorBranch}" — checking out main (issue #340)`,
      );
    }

    await runGit(projectDir, ["checkout", "main"]);
    await runGit(projectDir, ["checkout", "."]);

    const { stdout: branches } = await runGit(projectDir, ["branch", "--list", "feature/*"]);
    const stale = (branches || "")
      .trim()
      .split("\n")
      .map((b) => b.replace(/^\*?\s*/, "").trim())
      .filter(Boolean);

    for (const branch of stale) {
      await runGit(projectDir, ["branch", "-D", branch]);
    }

    if (stale.length > 0) {
      console.log(`[PrepareWorkspace] Cleaned up ${stale.length} stale feature branches`);
    }

    // Issue #340: cleanup succeeded — reset the wedged-cycle counter so a
    // single recovered cycle doesn't keep the alert state stuck.
    await clearWedgedCycle();

    return {
      cleaned: true,
      reason: null,
      staleBranchesDeleted: stale.length,
      recoveredFromOrchestratorBranch: decision.recoverFromOrchestratorBranch || null,
    };
  } finally {
    await releaseWorkspaceLock().catch((err) =>
      console.error(`[PrepareWorkspace] Failed to release workspace lock: ${err.message}`)
    );
  }
}

// ---------------------------------------------------------------------------
// Wedged-workspace counter (issue #340)
// ---------------------------------------------------------------------------
//
// Lazy import so test files that don't initialise Redis still work.

async function recordWedgedCycle(branch, reason) {
  try {
    const { incrWorkspaceWedgedCounter, setWorkspaceWedgedBranch, getWorkspaceWedgedBranch, resetWorkspaceWedgedCounter } =
      await import("./redis-adapter.ts");
    const previousBranch = await getWorkspaceWedgedBranch();

    // If the wedged branch changed, reset the counter — we're tracking
    // *consecutive* cycles on the *same* branch. A different branch means
    // a different incident.
    let consecutive;
    if (previousBranch && previousBranch !== branch) {
      await resetWorkspaceWedgedCounter();
      consecutive = await incrWorkspaceWedgedCounter();
    } else {
      consecutive = await incrWorkspaceWedgedCounter();
    }
    await setWorkspaceWedgedBranch(branch);

    if (consecutive >= 2) {
      console.error(
        `[PrepareWorkspace] WEDGED WORKSPACE ALERT: ${consecutive} consecutive cycles wedged on "${branch}" (reason: ${reason}). ` +
          `Scheduler will halt at the configured threshold to prevent abandon-storm. (issue #340)`,
      );
    }

    return { branch, consecutiveCycles: consecutive };
  } catch (err) {
    /* intentional: Redis unavailable should never block cycle progress. The
       wedge-detection feature degrades gracefully — operator can still recover
       manually. */
    console.error(`[PrepareWorkspace] Wedged-cycle tracking failed: ${err?.message || err}`);
    return { branch, consecutiveCycles: 0 };
  }
}

async function clearWedgedCycle() {
  try {
    const { resetWorkspaceWedgedCounter, clearWorkspaceWedgedBranch } = await import("./redis-adapter.ts");
    await resetWorkspaceWedgedCounter();
    await clearWorkspaceWedgedBranch();
  } catch (err) {
    /* intentional: best-effort reset; non-fatal */
    console.error(`[PrepareWorkspace] Wedged-cycle clear failed: ${err?.message || err}`);
  }
}

/**
 * Regression tests for src/prepare-workspace.ts.
 *
 * Issue #340 — Wedged feature-branch deadlock. When the executor's worktree
 * cleanup left the target repo on `feature/cycle-...-slug`, prepareWorkspace
 * silently skipped cleanup for 10+ cycles, burning ~$280 of abandoned cycles
 * on 2026-05-12. These tests pin down the recovery contract:
 *
 *   - Orchestrator-owned branches (feature/cycle-YYYY-MM-DD-NNNN-*) with
 *     clean trees ARE auto-recoverable.
 *   - Operator-named branches (feature/foo-bar, feature/operator-experiment,
 *     cycle/lint-cleanup-*) are always protected (existing safety).
 *   - Orchestrator-owned branches with DIRTY trees are still protected —
 *     the operator may be editing inside the cycle branch.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  shouldCleanWorkingTree,
  isOrchestratorOwnedBranch,
} from "../src/prepare-workspace.ts";

describe("isOrchestratorOwnedBranch", () => {
  test("matches the canonical orchestrator pattern", () => {
    assert.equal(isOrchestratorOwnedBranch("feature/cycle-2026-05-12-0712-slug"), true);
    assert.equal(isOrchestratorOwnedBranch("feature/cycle-2026-04-08-1234-slug"), true);
    assert.equal(isOrchestratorOwnedBranch("feature/cycle-2026-01-01-0001-foo-bar"), true);
  });

  test("trims whitespace before matching", () => {
    assert.equal(isOrchestratorOwnedBranch("  feature/cycle-2026-05-12-0712-slug\n"), true);
  });

  test("rejects operator-named feature branches", () => {
    assert.equal(isOrchestratorOwnedBranch("feature/foo-bar"), false);
    assert.equal(isOrchestratorOwnedBranch("feature/operator-experiment"), false);
    assert.equal(isOrchestratorOwnedBranch("feature/hotfix-3"), false);
    assert.equal(isOrchestratorOwnedBranch("feature/cycle-improvements"), false); // no date
    assert.equal(isOrchestratorOwnedBranch("feature/cycle-2026"), false); // partial date
  });

  test("rejects main/master and non-feature branches", () => {
    assert.equal(isOrchestratorOwnedBranch("main"), false);
    assert.equal(isOrchestratorOwnedBranch("master"), false);
    assert.equal(isOrchestratorOwnedBranch("cycle/lint-cleanup-2026-04-08-1355"), false);
    assert.equal(isOrchestratorOwnedBranch(""), false);
  });

  test("handles null / undefined / non-strings safely", () => {
    // @ts-expect-error — defensive coverage
    assert.equal(isOrchestratorOwnedBranch(null), false);
    // @ts-expect-error — defensive coverage
    assert.equal(isOrchestratorOwnedBranch(undefined), false);
    // @ts-expect-error — defensive coverage
    assert.equal(isOrchestratorOwnedBranch(42), false);
  });
});

describe("shouldCleanWorkingTree — orchestrator-owned branch auto-recovery (issue #340)", () => {
  test("orchestrator-owned branch with clean tree → ok (auto-recover)", () => {
    // This is the exact scenario from 2026-05-12 14:14:33Z:
    // executor's worktree-remove left ~/hydra-betting on this branch,
    // and the working tree was clean (executor's changes were on the
    // worktree, not the parent). prepareWorkspace MUST now auto-recover.
    const decision = shouldCleanWorkingTree(
      { stdout: "feature/cycle-2026-05-12-0712-slug\n" },
      { stdout: "" },
    );
    assert.equal(decision.ok, true, "orchestrator-owned cycle branch + clean tree must be auto-recoverable");
    assert.equal(
      decision.recoverFromOrchestratorBranch,
      "feature/cycle-2026-05-12-0712-slug",
      "decision must surface the recovered-from branch for logging",
    );
  });

  test("orchestrator-owned branch with DIRTY tree → still skip (operator may be editing)", () => {
    // The 2026-04-07 polymarket regression: operator was editing files on a
    // cycle/feature branch. Even though the branch name matches the
    // orchestrator pattern, the dirty tree signals operator intent — we
    // must NOT clobber it. The reason is the (broader) feature-branch
    // safety message; what matters is that the auto-recovery path is NOT
    // taken (recoverFromOrchestratorBranch is unset).
    const decision = shouldCleanWorkingTree(
      { stdout: "feature/cycle-2026-04-07-1115-polymarket-clientorderid" },
      { stdout: " M web/src/lib/execution/polymarket-executor.ts" },
    );
    assert.equal(decision.ok, false, "dirty tree on orchestrator branch must still be protected");
    assert.equal(decision.recoverFromOrchestratorBranch, undefined, "must NOT auto-recover when tree is dirty");
  });

  test("operator-named feature branch with clean tree → still skip (existing safety)", () => {
    // Even clean, a non-orchestrator branch is operator-driven work.
    const decision = shouldCleanWorkingTree(
      { stdout: "feature/operator-experiment" },
      { stdout: "" },
    );
    assert.equal(decision.ok, false);
    assert.match(decision.reason, /feature branch/);
    assert.equal(decision.recoverFromOrchestratorBranch, undefined);
  });

  test("orchestrator-owned branch with only UNTRACKED files → ok (auto-recover, untracked safe)", () => {
    // Untracked files are not at risk from `git checkout main` — matches the
    // semantics of the existing main-branch path.
    const decision = shouldCleanWorkingTree(
      { stdout: "feature/cycle-2026-05-12-0712-slug" },
      { stdout: "?? reports/decisions/foo.md\n?? scratchpad.txt" },
    );
    assert.equal(decision.ok, true);
    assert.equal(decision.recoverFromOrchestratorBranch, "feature/cycle-2026-05-12-0712-slug");
  });

  test("regression (#340 / 2026-05-12): 10-cycle abandon storm would have been prevented", () => {
    // The exact log line that fired 29 times across 35 minutes was:
    // "Skipping auto-cleanup: on feature branch \"feature/cycle-2026-05-12-0712-slug\" — operator-driven work, not auto-cleaning"
    //
    // With this fix, the same input now returns ok=true and prepareWorkspace
    // checks out main on the next cycle, breaking the loop after 1 cycle
    // instead of 10.
    const decision = shouldCleanWorkingTree(
      { stdout: "feature/cycle-2026-05-12-0712-slug\n" },
      { stdout: "" },
    );
    assert.equal(decision.ok, true);
    assert.notEqual(
      decision.reason,
      `on feature branch "feature/cycle-2026-05-12-0712-slug" — operator-driven work, not auto-cleaning`,
      "the wedged-deadlock reason string must no longer be emitted for orchestrator-owned branches with clean trees",
    );
  });
});

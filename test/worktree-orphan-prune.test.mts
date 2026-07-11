/**
 * Isolated unit coverage for the orphan-worktree prune housekeeping chore
 * (issue #3136).
 *
 * The chore is a thin scheduled wrapper over the shared
 * `pruneOrphanedTargetWorktrees` (whose full git-porcelain reclaim path is
 * covered by `test/worktree-orphan.test.mts`). These cases pin the WRAPPER's
 * contract in isolation — no live git workspace, no `node:fs`, no Redis — by
 * injecting a fake `prune` and asserting the wiring, the returned count, and the
 * never-throw guard.
 *
 * Top-level describe with no shared-Redis lifecycle: the chore takes every
 * side-effecting dependency through its injectable deps bag, so nothing here
 * touches a shared connection.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  runWorktreeOrphanPrune,
  type WorktreeOrphanPruneDeps,
} from "../src/scheduler/chores/worktree-orphan-prune.ts";

describe("worktree-orphan-prune chore — isolated (issue #3136)", () => {
  test("delegates to the injected pruner with the resolved workspace + git opts", async () => {
    const calls: Array<{ workspace: string; gitOpts: { cwd: string; timeout: number } }> = [];
    const deps: WorktreeOrphanPruneDeps = {
      getWorkspace: () => "/home/gabe/hydra-betting",
      prune: async (workspace, gitOpts) => {
        calls.push({ workspace, gitOpts });
        return 0;
      },
    };

    await runWorktreeOrphanPrune(deps);

    assert.equal(calls.length, 1, "the pruner is invoked exactly once");
    assert.equal(calls[0].workspace, "/home/gabe/hydra-betting");
    assert.equal(calls[0].gitOpts.cwd, "/home/gabe/hydra-betting", "gitOpts.cwd is the workspace");
    assert.equal(calls[0].gitOpts.timeout, 5000, "matches the startup path's 5s git timeout");
  });

  test("forwards the injected side-effecting deps into the pruner's deps bag", async () => {
    let received: any = null;
    const readFileSync = () => "claude agent agent-x (pid 999)";
    const statSync = () => ({ mtimeMs: 0 });
    const isLivePid = () => false;
    const now = () => 1_700_000_000_000;
    const gitExec = (async () => ({ ok: true, data: { stdout: "", stderr: "" } })) as any;

    const deps: WorktreeOrphanPruneDeps = {
      getWorkspace: () => "/ws",
      gitExec,
      readFileSync,
      statSync,
      isLivePid,
      now,
      prune: async (_workspace, _gitOpts, pruneDeps) => {
        received = pruneDeps;
        return 0;
      },
    };

    await runWorktreeOrphanPrune(deps);

    assert.ok(received, "the pruner received a deps bag");
    assert.equal(received.gitExec, gitExec, "gitExec is forwarded");
    assert.equal(received.readFileSync, readFileSync, "readFileSync is forwarded");
    assert.equal(received.statSync, statSync, "statSync is forwarded");
    assert.equal(received.isLivePid, isLivePid, "isLivePid is forwarded");
    assert.equal(received.now, now, "now is forwarded");
  });

  test("returns the reclaimed count the pruner reports", async () => {
    const reclaimed = await runWorktreeOrphanPrune({
      getWorkspace: () => "/ws",
      prune: async () => 3,
    });
    assert.equal(reclaimed, 3, "the chore surfaces the pruner's reclaimed count");
  });

  test("never throws — a throwing pruner folds to a logged 0", async () => {
    const reclaimed = await runWorktreeOrphanPrune({
      getWorkspace: () => "/ws",
      prune: async () => {
        throw new Error("git blew up");
      },
    });
    assert.equal(reclaimed, 0, "a thrown fault is caught and returns 0, not propagated");
  });

  test("never throws — a throwing workspace resolver also folds to 0", async () => {
    const reclaimed = await runWorktreeOrphanPrune({
      getWorkspace: () => {
        throw new Error("no workspace");
      },
      // prune must never be reached
      prune: async () => {
        throw new Error("prune should not run when the workspace resolver throws");
      },
    });
    assert.equal(reclaimed, 0, "resolver fault is caught and returns 0");
  });

  test("a clean tick (0 reclaimed) is a no-op that still returns 0", async () => {
    const reclaimed = await runWorktreeOrphanPrune({
      getWorkspace: () => "/ws",
      prune: async () => 0,
    });
    assert.equal(reclaimed, 0);
  });
});

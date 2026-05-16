/**
 * Regression tests for the hydra-branch-prune skill's classifier (issue #443).
 *
 * Before #443, branches whose upstream was gone after a squash-merge piled up
 * indefinitely on the host. A single manual sweep on 2026-05-15 cleaned 167
 * branches and 71 worktrees. The new skill walks `git branch -vv` for `[gone]`
 * entries, classifies each as one of:
 *
 *   delete-worktree-and-branch — wt attached, no live agent
 *   delete-branch-only         — no wt attached
 *   skip-live-agent            — wt held by a live `claude` PID (defer)
 *   skip-current-branch        — never delete the current branch
 *   skip-not-gone              — upstream is fine, not a candidate
 *   skip-cap                   — already hit the per-run hard cap
 *
 * These tests guard the classifier (pure helper in `scripts/ci/branch-prune.ts`)
 * and the worktree-list / lock-file parsers that feed it. The shell driver
 * itself is exercised by a smoke invocation in the playbook, not here.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseLockPid,
  parseBranchLine,
  parseWorktreeList,
  classifyBranch,
  classifyBatch,
  renderReport,
  HARD_CAP_DELETIONS_PER_RUN,
  type BranchRow,
  type WorktreeRow,
  type LivePidCheck,
} from "../scripts/ci/branch-prune.ts";

const NEVER_LIVE: LivePidCheck = () => false;
const ALWAYS_LIVE: LivePidCheck = () => true;

function branch(name: string, opts: { gone?: boolean; current?: boolean } = {}): BranchRow {
  return {
    name,
    upstreamGone: opts.gone ?? true,
    isCurrent: opts.current ?? false,
  };
}

function wt(path: string, branch: string | null, lockedByPid: number | null = null): WorktreeRow {
  return { path, branch, lockedByPid };
}

describe("parseLockPid (lock-file PID extraction)", () => {
  test("extracts PID from canonical Claude lock body", () => {
    assert.equal(parseLockPid("claude agent agent-abc123 (pid 12345)"), 12345);
  });

  test("returns null for bodies without a (pid <N>) token", () => {
    assert.equal(parseLockPid("some random lock note"), null);
    assert.equal(parseLockPid("locked by user pid was reset"), null);
    // The operator's lesson: `pid ` as a bare word collides with English; we
    // require the `(pid <N>)` form specifically.
    assert.equal(parseLockPid("manually locked, pid 9999"), null);
  });

  test("returns null for null/undefined/empty", () => {
    assert.equal(parseLockPid(null), null);
    assert.equal(parseLockPid(undefined), null);
    assert.equal(parseLockPid(""), null);
  });

  test("returns null for non-finite or zero/negative PIDs", () => {
    assert.equal(parseLockPid("(pid 0)"), null);
    // Negative — the regex won't match a minus sign, so it returns null.
    assert.equal(parseLockPid("(pid -1)"), null);
  });

  test("tolerates extra whitespace inside the (pid N) token", () => {
    assert.equal(parseLockPid("(pid   54321)"), 54321);
  });
});

describe("parseBranchLine (git branch -vv parsing)", () => {
  test("parses current branch with [gone] upstream", () => {
    const r = parseBranchLine("* issue-1-foo                abc1234 [origin/issue-1-foo: gone] wip");
    assert.deepEqual(r, { name: "issue-1-foo", upstreamGone: true, isCurrent: true });
  });

  test("parses non-current branch with [gone] upstream", () => {
    const r = parseBranchLine("  issue-2-bar                def5678 [origin/issue-2-bar: gone] feat");
    assert.deepEqual(r, { name: "issue-2-bar", upstreamGone: true, isCurrent: false });
  });

  test("parses branch checked out in another worktree (`+ ` marker)", () => {
    const r = parseBranchLine("+ issue-3-baz                aaaaaaa [origin/issue-3-baz: gone] ongoing");
    assert.deepEqual(r, { name: "issue-3-baz", upstreamGone: true, isCurrent: false });
  });

  test("parses healthy branch (no [gone] marker)", () => {
    const r = parseBranchLine("* master                     f4d3ecc [origin/master] fix(autopilot): ...");
    assert.deepEqual(r, { name: "master", upstreamGone: false, isCurrent: true });
  });

  test("parses branch with no tracking info", () => {
    const r = parseBranchLine("  worktree-agent-xyz        def5678 (no tracking info)");
    assert.deepEqual(r, { name: "worktree-agent-xyz", upstreamGone: false, isCurrent: false });
  });

  test("returns null on empty / whitespace-only input", () => {
    assert.equal(parseBranchLine(""), null);
    assert.equal(parseBranchLine("   "), null);
  });

  test("does NOT false-positive on the literal word `gone` outside the bracket marker", () => {
    // Subject line legitimately contains the word "gone" but the upstream is
    // healthy. We must not strip it as a prune candidate.
    const r = parseBranchLine("  feat-undo  abc1234 [origin/feat-undo] revert: undo something that's gone");
    assert.deepEqual(r, { name: "feat-undo", upstreamGone: false, isCurrent: false });
  });
});

describe("parseWorktreeList (porcelain parsing)", () => {
  test("parses a single attached worktree", () => {
    const porcelain = [
      "worktree /home/gabe/hydra",
      "HEAD abc1234",
      "branch refs/heads/master",
    ].join("\n");
    const rows = parseWorktreeList(porcelain);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], { path: "/home/gabe/hydra", branch: "master", lockedByPid: null });
  });

  test("parses multiple stanzas separated by blank lines", () => {
    const porcelain = [
      "worktree /home/gabe/hydra",
      "HEAD abc1234",
      "branch refs/heads/master",
      "",
      "worktree /home/gabe/hydra/.claude/worktrees/agent-aaa",
      "HEAD def5678",
      "branch refs/heads/issue-100-foo",
      "",
      "worktree /home/gabe/hydra/.claude/worktrees/agent-bbb",
      "HEAD 9999999",
      "detached",
    ].join("\n");
    const rows = parseWorktreeList(porcelain);
    assert.equal(rows.length, 3);
    assert.equal(rows[1].branch, "issue-100-foo");
    // Detached worktree → branch is null (no `branch ` line emitted).
    assert.equal(rows[2].branch, null);
  });

  test("populates lockedByPid from a supplied locks map", () => {
    const porcelain = [
      "worktree /tmp/wt-1",
      "branch refs/heads/feat-1",
    ].join("\n");
    const locks = new Map<string, string>([
      ["/tmp/wt-1", "claude agent agent-xyz (pid 4242)"],
    ]);
    const rows = parseWorktreeList(porcelain, locks);
    assert.equal(rows[0].lockedByPid, 4242);
  });

  test("returns empty array on empty input", () => {
    assert.deepEqual(parseWorktreeList(""), []);
    assert.deepEqual(parseWorktreeList("   \n   "), []);
  });
});

describe("classifyBranch — never-touch rails (issue #443 safety AC)", () => {
  const ctx = {
    currentBranch: "master",
    worktrees: [] as WorktreeRow[],
    isLivePid: NEVER_LIVE,
  };

  test("current branch (marker `*`) → skip-current-branch", () => {
    const r = classifyBranch(branch("master", { gone: true, current: true }), ctx);
    assert.equal(r.action, "skip-current-branch");
    assert.match(r.reason, /current branch/);
  });

  test("branch matching ctx.currentBranch (no marker, e.g. parent reading worktree) → skip-current-branch", () => {
    const r = classifyBranch(branch("master", { gone: true, current: false }), ctx);
    assert.equal(r.action, "skip-current-branch");
  });

  test("non-gone upstream → skip-not-gone (defense even if caller forgot to filter)", () => {
    const r = classifyBranch(branch("healthy-feature", { gone: false }), ctx);
    assert.equal(r.action, "skip-not-gone");
    assert.match(r.reason, /not \[gone\]/);
  });
});

describe("classifyBranch — happy path", () => {
  test("[gone] with no attached worktree → delete-branch-only", () => {
    const ctx = {
      currentBranch: "master",
      worktrees: [wt("/home/gabe/hydra", "master", null)],
      isLivePid: NEVER_LIVE,
    };
    const r = classifyBranch(branch("orphan-branch"), ctx);
    assert.equal(r.action, "delete-branch-only");
    assert.equal(r.worktree, null);
  });

  test("[gone] with attached worktree, no PID lock → delete-worktree-and-branch", () => {
    const w = wt("/home/gabe/hydra/.claude/worktrees/agent-a", "feat-a", null);
    const ctx = {
      currentBranch: "master",
      worktrees: [w],
      isLivePid: NEVER_LIVE,
    };
    const r = classifyBranch(branch("feat-a"), ctx);
    assert.equal(r.action, "delete-worktree-and-branch");
    assert.equal(r.worktree, w);
  });

  test("[gone] with attached worktree, PID lock for dead PID → delete-worktree-and-branch", () => {
    const w = wt("/home/gabe/hydra/.claude/worktrees/agent-b", "feat-b", 99999);
    const ctx = {
      currentBranch: "master",
      worktrees: [w],
      isLivePid: NEVER_LIVE, // PID 99999 is dead
    };
    const r = classifyBranch(branch("feat-b"), ctx);
    assert.equal(r.action, "delete-worktree-and-branch");
  });

  test("[gone] with attached worktree, PID lock for LIVE PID → skip-live-agent", () => {
    const w = wt("/home/gabe/hydra/.claude/worktrees/agent-c", "feat-c", 12345);
    const ctx = {
      currentBranch: "master",
      worktrees: [w],
      isLivePid: ALWAYS_LIVE,
    };
    const r = classifyBranch(branch("feat-c"), ctx);
    assert.equal(r.action, "skip-live-agent");
    assert.match(r.reason, /live PID 12345/);
  });
});

describe("classifyBranch — hard cap", () => {
  test("emits skip-cap once deletionCount() ≥ HARD_CAP_DELETIONS_PER_RUN", () => {
    const ctx = {
      currentBranch: "master",
      worktrees: [] as WorktreeRow[],
      isLivePid: NEVER_LIVE,
      deletionCount: () => HARD_CAP_DELETIONS_PER_RUN,
    };
    const r = classifyBranch(branch("would-be-deleted"), ctx);
    assert.equal(r.action, "skip-cap");
    assert.match(r.reason, /hard cap/);
  });

  test("does NOT cap when deletionCount() is under the limit", () => {
    const ctx = {
      currentBranch: "master",
      worktrees: [] as WorktreeRow[],
      isLivePid: NEVER_LIVE,
      deletionCount: () => HARD_CAP_DELETIONS_PER_RUN - 1,
    };
    const r = classifyBranch(branch("on-the-edge"), ctx);
    assert.equal(r.action, "delete-branch-only");
  });
});

describe("classifyBatch — bucket assembly + cap accounting", () => {
  test("routes each row into the correct bucket and preserves input order", () => {
    const w1 = wt("/tmp/wt-1", "feat-1", null);
    const w2 = wt("/tmp/wt-2", "feat-2", 12345); // live
    const ctx = {
      currentBranch: "master",
      worktrees: [w1, w2],
      isLivePid: ALWAYS_LIVE,
    };
    const rows: BranchRow[] = [
      branch("master", { gone: false, current: true }),
      branch("feat-1"),
      branch("feat-2"),
      branch("orphan-no-wt"),
      branch("healthy-feature", { gone: false }),
    ];
    const buckets = classifyBatch(rows, ctx);
    assert.equal(buckets.deleteWorktreeAndBranch.length, 1);
    assert.equal(buckets.deleteWorktreeAndBranch[0].row.name, "feat-1");
    assert.equal(buckets.deleteBranchOnly.length, 1);
    assert.equal(buckets.deleteBranchOnly[0].name, "orphan-no-wt");
    assert.equal(buckets.skipLiveAgent.length, 1);
    assert.equal(buckets.skipLiveAgent[0].row.name, "feat-2");
    assert.equal(buckets.skipLiveAgent[0].pid, 12345);
    // master + healthy-feature → two skip entries
    assert.equal(buckets.skip.length, 2);
    assert.equal(buckets.cappedOut, false);
  });

  test("hard cap fires once HARD_CAP deletions accumulate, marks cappedOut", () => {
    // Build N+5 candidate rows. The first HARD_CAP should be deleted; the
    // remainder should be skip-cap.
    const ctx = {
      currentBranch: "master",
      worktrees: [] as WorktreeRow[],
      isLivePid: NEVER_LIVE,
    };
    const rows: BranchRow[] = [];
    for (let i = 0; i < HARD_CAP_DELETIONS_PER_RUN + 5; i++) {
      rows.push(branch(`feat-${i}`));
    }
    const buckets = classifyBatch(rows, ctx);
    assert.equal(buckets.deleteBranchOnly.length, HARD_CAP_DELETIONS_PER_RUN);
    assert.equal(buckets.cappedOut, true);
    assert.equal(buckets.skip.length, 5);
    assert.ok(buckets.skip.every((s) => /hard cap/.test(s.reason)));
  });
});

describe("renderReport — deterministic output", () => {
  test("produces a stable report for the standard four-bucket case", () => {
    const w1 = wt("/tmp/wt-1", "feat-1", null);
    const w2 = wt("/tmp/wt-2", "feat-2", 12345);
    const buckets = {
      deleteWorktreeAndBranch: [{ row: branch("feat-1"), worktree: w1 }],
      deleteBranchOnly: [branch("orphan-no-wt")],
      skipLiveAgent: [{ row: branch("feat-2"), worktree: w2, pid: 12345 }],
      skip: [{ row: branch("healthy", { gone: false }), reason: "healthy upstream is not [gone] — not a prune candidate." }],
      cappedOut: false,
    };
    const out = renderReport(buckets, "2026-05-16T00:00:00Z", false);
    assert.match(out, /## Hydra Branch Prune — 2026-05-16T00:00:00Z$/m);
    assert.match(out, /Scanned: 4 local branches/);
    assert.match(out, /### Deleted \(worktree \+ branch\)/);
    assert.match(out, /- feat-1  \(worktree: \/tmp\/wt-1\)/);
    assert.match(out, /### Deleted \(branch only\)/);
    assert.match(out, /- orphan-no-wt/);
    assert.match(out, /### Skipped — live agent/);
    assert.match(out, /- feat-2  \(worktree \/tmp\/wt-2, pid 12345\)/);
    assert.match(out, /### Skipped — other/);
  });

  test("audit-only mode says 'Would delete' rather than 'Deleted'", () => {
    const buckets = {
      deleteWorktreeAndBranch: [],
      deleteBranchOnly: [branch("orphan")],
      skipLiveAgent: [],
      skip: [],
      cappedOut: false,
    };
    const out = renderReport(buckets, "2026-05-16T00:00:00Z", true);
    assert.match(out, /audit-only/);
    assert.match(out, /### Would delete \(branch only\)/);
    assert.doesNotMatch(out, /### Deleted \(/);
  });

  test("notes the cap when buckets.cappedOut is true", () => {
    const buckets = {
      deleteWorktreeAndBranch: [],
      deleteBranchOnly: [branch("orphan")],
      skipLiveAgent: [],
      skip: [],
      cappedOut: true,
    };
    const out = renderReport(buckets, "now", false);
    assert.match(out, /hard cap/);
  });
});

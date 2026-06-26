/**
 * Regression tests for the startup orphan-worktree prune classifier
 * (issue #2465, recurrence of #2115) — src/worktree-orphan.ts.
 *
 * The pure classifier is the never-touch-first safety logic the startup branch
 * cleanup in src/index.ts relies on to reclaim the orphaned /dev/shm worktrees
 * that block `git branch -D`. These tests pin every decision-order arm.
 *
 * Top-level describe with no shared-Redis lifecycle (the module is pure — no
 * fs/network/git), so it is isolation-safe alongside sibling suites.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseLockPid,
  parseWorktreeList,
  classifyOrphanWorktree,
  DEFAULT_WORKTREE_MIN_AGE_SECONDS,
  type WorktreeRow,
  type OrphanContext,
} from "../src/worktree-orphan.ts";

const SHM = "/dev/shm/hydra-worktrees/";
const OLD = DEFAULT_WORKTREE_MIN_AGE_SECONDS + 1; // comfortably past the floor
const YOUNG = 60; // under the floor

const baseCtx = (over: Partial<OrphanContext> = {}): OrphanContext => ({
  mainWorktreePath: "/home/gabe/hydra-betting",
  currentBranch: "main",
  isLivePid: () => false, // default: no PID is live
  minAgeSeconds: DEFAULT_WORKTREE_MIN_AGE_SECONDS,
  scopePrefix: SHM,
  ...over,
});

describe("worktree-orphan: parseLockPid", () => {
  test("extracts the (pid N) token from a harness lock body", () => {
    assert.equal(parseLockPid("claude agent agent-abc (pid 12345)"), 12345);
  });
  test("returns null when no (pid N) token is present", () => {
    assert.equal(parseLockPid("locked by operator"), null);
    assert.equal(parseLockPid(""), null);
    assert.equal(parseLockPid(null), null);
    assert.equal(parseLockPid(undefined), null);
  });
  test("does not match the bare word 'pid' in prose", () => {
    assert.equal(parseLockPid("held — see pid 999 in the logs"), null);
  });
  test("rejects a zero / non-positive pid", () => {
    assert.equal(parseLockPid("agent (pid 0)"), null);
  });
});

describe("worktree-orphan: parseWorktreeList", () => {
  const porcelain = [
    "worktree /home/gabe/hydra-betting",
    "HEAD 0091486",
    "branch refs/heads/main",
    "",
    "worktree /dev/shm/hydra-worktrees/hydra-betting-worktree-claude-cycle-2226",
    "HEAD 8b923c2",
    "branch refs/heads/feature/claude-cycle-2226",
    "",
  ].join("\n");

  test("parses path + branch per stanza, stripping refs/heads/", () => {
    const rows = parseWorktreeList(porcelain);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].path, "/home/gabe/hydra-betting");
    assert.equal(rows[0].branch, "main");
    assert.equal(rows[1].path, SHM + "hydra-betting-worktree-claude-cycle-2226");
    assert.equal(rows[1].branch, "feature/claude-cycle-2226");
  });

  test("populates lockedByPid from a supplied lock map", () => {
    const orphanPath = SHM + "hydra-betting-worktree-claude-cycle-2226";
    const locks = new Map<string, string>([[orphanPath, "claude agent (pid 4242)"]]);
    const rows = parseWorktreeList(porcelain, locks);
    assert.equal(rows[1].lockedByPid, 4242);
    assert.equal(rows[0].lockedByPid, null); // no lock entry for the main tree
  });

  test("tolerates a detached worktree (no branch line)", () => {
    const detached = ["worktree /dev/shm/hydra-worktrees/wt-detached", "HEAD abc123", "detached", ""].join("\n");
    const rows = parseWorktreeList(detached);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].branch, null);
  });

  test("empty input yields no rows", () => {
    assert.deepEqual(parseWorktreeList(""), []);
  });
});

describe("worktree-orphan: classifyOrphanWorktree decision order", () => {
  const orphan = (over: Partial<WorktreeRow> = {}): WorktreeRow => ({
    path: SHM + "hydra-betting-worktree-claude-cycle-2226",
    branch: "feature/claude-cycle-2226",
    lockedByPid: null,
    ageSeconds: OLD,
    ...over,
  });

  test("reclaims a dead, in-scope, old orphan", () => {
    const r = classifyOrphanWorktree(orphan(), baseCtx());
    assert.equal(r.action, "delete-orphan-worktree");
  });

  test("never reclaims the main working tree", () => {
    const r = classifyOrphanWorktree(
      orphan({ path: "/home/gabe/hydra-betting", branch: "main" }),
      baseCtx(),
    );
    assert.equal(r.action, "skip-main-worktree");
  });

  test("never reclaims a worktree holding the current branch", () => {
    const r = classifyOrphanWorktree(
      orphan({ branch: "main" }),
      baseCtx({ currentBranch: "main" }),
    );
    assert.equal(r.action, "skip-current-worktree");
  });

  test("skips a worktree outside the scope prefix", () => {
    const r = classifyOrphanWorktree(
      orphan({ path: "/home/gabe/hydra/.claude/worktrees/agent-xyz" }),
      baseCtx(),
    );
    assert.equal(r.action, "skip-out-of-scope");
  });

  test("never reclaims a worktree held by a live agent PID", () => {
    const r = classifyOrphanWorktree(
      orphan({ lockedByPid: 4242 }),
      baseCtx({ isLivePid: (pid) => pid === 4242 }),
    );
    assert.equal(r.action, "skip-live-agent");
  });

  test("live-agent rail wins over the age floor (precise reason)", () => {
    // A fresh worktree held by a live agent must surface skip-live-agent, not
    // skip-too-young — age is the LAST gate.
    const r = classifyOrphanWorktree(
      orphan({ lockedByPid: 4242, ageSeconds: YOUNG }),
      baseCtx({ isLivePid: () => true }),
    );
    assert.equal(r.action, "skip-live-agent");
  });

  test("defers a worktree under the age floor", () => {
    const r = classifyOrphanWorktree(orphan({ ageSeconds: YOUNG }), baseCtx());
    assert.equal(r.action, "skip-too-young");
  });

  test("treats unknown age as too-young (conservative)", () => {
    assert.equal(classifyOrphanWorktree(orphan({ ageSeconds: null }), baseCtx()).action, "skip-too-young");
    assert.equal(classifyOrphanWorktree(orphan({ ageSeconds: undefined }), baseCtx()).action, "skip-too-young");
  });

  test("an unlocked, old orphan with a dead-PID lock still reclaims", () => {
    const r = classifyOrphanWorktree(orphan({ lockedByPid: 999 }), baseCtx({ isLivePid: () => false }));
    assert.equal(r.action, "delete-orphan-worktree");
  });

  test("the observed #2465 orphan (no lock, ~3.2h old) defers under the 6h floor", () => {
    // The exact recurrence snapshot: dir present, unlocked, mtime ~3.2h ago.
    // The age floor correctly defers it — proving the safety rail is honest and
    // the prune is not over-eager.
    const r = classifyOrphanWorktree(orphan({ lockedByPid: null, ageSeconds: 3.2 * 3600 }), baseCtx());
    assert.equal(r.action, "skip-too-young");
  });
});

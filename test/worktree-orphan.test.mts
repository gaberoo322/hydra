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
  isLivePid,
  pruneOrphanedTargetWorktrees,
  DEFAULT_WORKTREE_MIN_AGE_SECONDS,
  type WorktreeRow,
  type OrphanContext,
  type PruneDeps,
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

// ---------------------------------------------------------------------------
// isLivePid — the consolidated host-liveness predicate (issue #2816).
//
// Pins the CONTRACT: false (dead → reclaimable) ONLY for a finite, positive pid
// whose process.kill(pid,0) throws a non-EPERM error (ESRCH). EVERY other input
// — a live pid, EPERM, OR any invalid pid (!Number.isFinite || <=0) — is TRUE
// (conservative-live). The invalid-pid → live rail is the latent-bug fix: the
// two former unguarded copies returned false on a non-finite pid, which the
// worktree-destroying caller would have read as "reclaim".
// ---------------------------------------------------------------------------
describe("worktree-orphan: isLivePid consolidated contract", () => {
  test("a live pid — this test process — is live", () => {
    assert.equal(isLivePid(process.pid), true);
  });

  test("a finite, positive, dead pid classifies dead (reclaimable)", () => {
    // 2^30 is comfortably above any real pid on this host; kill(pid,0) throws
    // ESRCH (no such process), the ONLY path that returns false.
    assert.equal(isLivePid(1 << 30), false);
  });

  test("a non-finite pid (NaN) is conservative-live — the #2816 latent-bug fix", () => {
    // The former unguarded copies returned FALSE here (would reclaim); the
    // consolidated predicate returns TRUE (never reclaim on garbage input).
    assert.equal(isLivePid(Number.NaN), true);
    assert.equal(isLivePid(Number("")), true); // Number('') === NaN
    assert.equal(isLivePid(Number.POSITIVE_INFINITY), true);
  });

  test("pid 0 and pid -1 are conservative-live (invalid → live)", () => {
    assert.equal(isLivePid(0), true);
    assert.equal(isLivePid(-1), true);
  });
});

// ---------------------------------------------------------------------------
// pruneOrphanedTargetWorktrees — the extracted impure orchestration, exercised
// entirely through the injected PruneDeps bag (no real git / fs / clock / pid).
// ---------------------------------------------------------------------------
describe("worktree-orphan: pruneOrphanedTargetWorktrees (injected deps)", () => {
  const WORKSPACE = "/home/gabe/hydra-betting";
  const gitOpts = { cwd: WORKSPACE, timeout: 30_000 };
  const ORPHAN = SHM + "hydra-betting-worktree-claude-cycle-9001";

  // A recording git stub: replays canned stdout per subcommand and records the
  // arg vectors it was called with. Any subcommand not in `responses` returns
  // an ok-empty result (so `worktree prune`/`remove` default to success).
  function makeGit(responses: Record<string, string>) {
    const calls: string[][] = [];
    const gitExec: PruneDeps["gitExec"] = async (args) => {
      calls.push(args);
      const key = args.join(" ");
      for (const [prefix, stdout] of Object.entries(responses)) {
        if (key.startsWith(prefix)) return { ok: true, data: { stdout, stderr: "" } };
      }
      return { ok: true, data: { stdout: "", stderr: "" } };
    };
    return { gitExec, calls };
  }

  // Two-stanza porcelain: the main tree first, then one in-scope orphan.
  const porcelain = [
    `worktree ${WORKSPACE}`,
    "HEAD 0091486",
    "branch refs/heads/main",
    "",
    `worktree ${ORPHAN}`,
    "HEAD 8b923c2",
    "branch refs/heads/feature/claude-cycle-9001",
    "",
  ].join("\n");

  const baseDeps = (over: Partial<PruneDeps> = {}): PruneDeps => ({
    gitExec: makeGit({}).gitExec,
    readFileSync: () => { throw new Error("no lock file"); }, // default: unlocked
    statSync: () => ({ mtimeMs: 0 }), // epoch-0 mtime → very old (past the floor)
    isLivePid: () => false, // default: no pid is live
    now: () => (DEFAULT_WORKTREE_MIN_AGE_SECONDS + 3600) * 1000, // well past the floor
    ...over,
  });

  test("removes a dead-pid, past-age, in-scope orphan then prunes", async () => {
    const git = makeGit({
      "rev-parse --git-common-dir": `${WORKSPACE}/.git`,
      "worktree list --porcelain": porcelain,
    });
    const reclaimed = await pruneOrphanedTargetWorktrees(WORKSPACE, gitOpts, baseDeps({ gitExec: git.gitExec }));
    assert.equal(reclaimed, 1);
    // The orphan (not the main tree) was the remove target.
    const removed = git.calls.filter((c) => c[0] === "worktree" && c[1] === "remove");
    assert.equal(removed.length, 1);
    assert.equal(removed[0].at(-1), ORPHAN);
    // The trailing `git worktree prune` always runs.
    assert.ok(git.calls.some((c) => c[0] === "worktree" && c[1] === "prune"));
  });

  test("a LIVE-pid lock is skipped (0 reclaimed) — never destroys an active agent's worktree", async () => {
    const git = makeGit({
      "rev-parse --git-common-dir": `${WORKSPACE}/.git`,
      "worktree list --porcelain": porcelain,
    });
    const reclaimed = await pruneOrphanedTargetWorktrees(
      WORKSPACE,
      gitOpts,
      baseDeps({
        gitExec: git.gitExec,
        readFileSync: (p) => (p.includes("cycle-9001") ? "claude agent (pid 4242)" : (() => { throw new Error("no lock"); })()),
        isLivePid: (pid) => pid === 4242, // the locked pid is live
      }),
    );
    assert.equal(reclaimed, 0);
    assert.equal(git.calls.filter((c) => c[1] === "remove").length, 0);
  });

  test("`git rev-parse --git-common-dir` failure → returns 0, no remove/prune", async () => {
    const gitExec: PruneDeps["gitExec"] = async (args) => {
      if (args[0] === "rev-parse") return { ok: false, code: "gh-unknown", stderr: "boom" };
      throw new Error("should not reach further git calls");
    };
    const reclaimed = await pruneOrphanedTargetWorktrees(WORKSPACE, gitOpts, baseDeps({ gitExec }));
    assert.equal(reclaimed, 0);
  });

  test("a vanished orphan dir (statSync throws) → unknown age → skip-too-young, but prune still runs", async () => {
    const git = makeGit({
      "rev-parse --git-common-dir": `${WORKSPACE}/.git`,
      "worktree list --porcelain": porcelain,
    });
    const reclaimed = await pruneOrphanedTargetWorktrees(
      WORKSPACE,
      gitOpts,
      baseDeps({
        gitExec: git.gitExec,
        statSync: () => { throw new Error("ENOENT: dir gone"); }, // ageSeconds → null
      }),
    );
    assert.equal(reclaimed, 0); // unknown age defers (conservative)
    assert.equal(git.calls.filter((c) => c[1] === "remove").length, 0);
    // The registry-entry reclaim still fires so a stale entry can't block a branch.
    assert.ok(git.calls.some((c) => c[0] === "worktree" && c[1] === "prune"));
  });

  test("a young in-scope orphan is deferred (skip-too-young), 0 reclaimed", async () => {
    const git = makeGit({
      "rev-parse --git-common-dir": `${WORKSPACE}/.git`,
      "worktree list --porcelain": porcelain,
    });
    const reclaimed = await pruneOrphanedTargetWorktrees(
      WORKSPACE,
      gitOpts,
      baseDeps({
        gitExec: git.gitExec,
        // mtime ~1 minute before `now` → well under the 6h floor.
        statSync: () => ({ mtimeMs: (DEFAULT_WORKTREE_MIN_AGE_SECONDS + 3600) * 1000 - 60_000 }),
      }),
    );
    assert.equal(reclaimed, 0);
    assert.equal(git.calls.filter((c) => c[1] === "remove").length, 0);
  });
});

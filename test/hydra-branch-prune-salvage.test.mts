/**
 * Issue #4518 (INV-4 / INV-5) — branch-prune never destroys uncommitted work.
 *
 * branch-prune is the ONLY code path that deletes an orchestrator agent
 * worktree (reap.py's `_gc_worktrees` shells to it with --apply on every
 * worktree-bearing reap; the daily hydra-branch-prune.timer runs it too).
 * Before #4518 both worktree-removing arms (`delete-worktree-and-branch` and
 * `delete-orphan-worktree`) ran `git worktree remove --force` with no
 * dirty-state check — six dead dev_orch dispatches' uncommitted work at #4510
 * survived only because the dirs were younger than the age floor.
 *
 * Two layers, both pinned here:
 *   1. The PURE classifier (scripts/ci/branch-prune.ts) gains a
 *      `salvage-then-delete` verdict driven by an injected `dirty` boolean
 *      (and `skip-dirty-unpushed` for a dirty DETACHED worktree, which has no
 *      branch to salvage onto). Existing verdicts are unchanged.
 *   2. The shell glue (scripts/branch-prune.sh) commits the work on the
 *      worktree's OWN branch and pushes it to origin before removal; a failed
 *      push leaves the worktree in place, still dirty, for the next run. It is
 *      exercised here against real throw-away git repos through the script's
 *      `--salvage-worktree` seam (the same function the apply loops call).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  classifyBranch,
  classifyBatch,
  classifyWorktreeOrphan,
  classifyWorktreeOrphans,
  renderReport,
  renderWorktreeOrphanReport,
  type WorktreeRow,
} from "../scripts/ci/branch-prune.ts";
import {
  branch,
  wt,
  owt,
  orphanCtx,
  NEVER_LIVE,
  ALWAYS_LIVE,
  YOUNG,
} from "./_helpers/branch-prune-fixtures.mts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "branch-prune.sh");

const AGENT_WT = "/home/gabe/hydra/.claude/worktrees/agent-acdae090b5ed69d61";
const AGENT_BR = "worktree-agent-acdae090b5ed69d61";

function dirty(row: WorktreeRow, value: boolean | null = true): WorktreeRow {
  return { ...row, dirty: value };
}

// ───────────────────────────────────────────────────────────────────────────
// Layer 1 — the pure classifier
// ───────────────────────────────────────────────────────────────────────────

describe("classifyWorktreeOrphan — dirty worktrees are salvaged, never plainly deleted (issue #4518)", () => {
  test("a dirty dead-PID orphan with a branch is never classified delete-orphan-worktree", () => {
    const r = classifyWorktreeOrphan(dirty(owt(AGENT_WT, AGENT_BR, { pid: 4242 })), orphanCtx());
    assert.notEqual(r.action, "delete-orphan-worktree");
    assert.equal(r.action, "salvage-then-delete");
    assert.match(r.reason, /uncommitted/);
    assert.match(r.reason, new RegExp(AGENT_BR), "the reason names the branch the salvage lands on");
  });

  test("a dirty DETACHED orphan has no branch to salvage onto → skip-dirty-unpushed (left in place)", () => {
    const r = classifyWorktreeOrphan(dirty(owt("/wt/detached", null)), orphanCtx());
    assert.equal(r.action, "skip-dirty-unpushed");
  });

  test("a clean orphan keeps the pre-#4518 verdict (dirty false / null / absent are all delete-orphan-worktree)", () => {
    for (const row of [dirty(owt(AGENT_WT, AGENT_BR), false), dirty(owt(AGENT_WT, AGENT_BR), null), owt(AGENT_WT, AGENT_BR)]) {
      assert.equal(classifyWorktreeOrphan(row, orphanCtx()).action, "delete-orphan-worktree");
    }
  });

  test("every never-touch rail still outranks the dirty check (live PID, open-PR head, age floor)", () => {
    assert.equal(
      classifyWorktreeOrphan(dirty(owt(AGENT_WT, AGENT_BR, { pid: 1 })), orphanCtx({ isLivePid: ALWAYS_LIVE })).action,
      "skip-live-agent",
    );
    assert.equal(
      classifyWorktreeOrphan(dirty(owt(AGENT_WT, AGENT_BR)), orphanCtx({ openPrHeads: new Set([AGENT_BR]) })).action,
      "skip-open-pr-head",
    );
    assert.equal(
      classifyWorktreeOrphan(dirty(owt(AGENT_WT, AGENT_BR, { ageSeconds: YOUNG })), orphanCtx()).action,
      "skip-too-young",
    );
  });

  test("batch: salvage rows land in their own bucket, count toward the hard cap, and render in the report", () => {
    const buckets = classifyWorktreeOrphans(
      [dirty(owt(AGENT_WT, AGENT_BR)), owt("/wt/clean", "worktree-agent-clean"), dirty(owt("/wt/detached", null))],
      orphanCtx(),
    );
    assert.deepEqual(buckets.salvageThenDelete.map((e) => [e.worktree.path, e.branch]), [[AGENT_WT, AGENT_BR]]);
    assert.deepEqual(buckets.deleteOrphan.map((e) => e.worktree.path), ["/wt/clean"]);
    assert.deepEqual(buckets.skip.map((s) => s.action), ["skip-dirty-unpushed"]);
    const report = renderWorktreeOrphanReport(buckets, true);
    assert.match(report, /salvage/i);
    assert.match(report, new RegExp(AGENT_BR));
  });
});

describe("classifyBranch — the [gone]-upstream pass salvages a dirty attached worktree (issue #4518)", () => {
  const ctx = (worktrees: WorktreeRow[]) => ({ currentBranch: "master", worktrees, isLivePid: NEVER_LIVE });

  test("a dirty attached worktree is never classified delete-worktree-and-branch", () => {
    const r = classifyBranch(branch(AGENT_BR), ctx([dirty(wt(AGENT_WT, AGENT_BR))]));
    assert.notEqual(r.action, "delete-worktree-and-branch");
    assert.equal(r.action, "salvage-then-delete");
    assert.equal(r.worktree?.path, AGENT_WT);
  });

  test("a clean attached worktree keeps delete-worktree-and-branch; rails still outrank dirty", () => {
    assert.equal(classifyBranch(branch(AGENT_BR), ctx([wt(AGENT_WT, AGENT_BR)])).action, "delete-worktree-and-branch");
    assert.equal(
      classifyBranch(branch(AGENT_BR), { ...ctx([dirty(wt(AGENT_WT, AGENT_BR, 9))]), isLivePid: ALWAYS_LIVE }).action,
      "skip-live-agent",
    );
    assert.equal(
      classifyBranch(branch(AGENT_BR), ctx([dirty(wt(AGENT_WT, AGENT_BR, null, { ageSeconds: YOUNG }))])).action,
      "skip-too-young",
    );
  });

  test("batch: salvage rows get their own bucket and the report names them", () => {
    const buckets = classifyBatch(
      [branch(AGENT_BR), branch("worktree-agent-clean")],
      ctx([dirty(wt(AGENT_WT, AGENT_BR)), wt("/wt/clean", "worktree-agent-clean")]),
    );
    assert.deepEqual(buckets.salvageThenDelete.map((e) => e.row.name), [AGENT_BR]);
    assert.deepEqual(buckets.deleteWorktreeAndBranch.map((e) => e.row.name), ["worktree-agent-clean"]);
    assert.match(renderReport(buckets, "2026-09-18T00:00:00Z", true), /salvage/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Layer 2 — the shell glue, against real throw-away repos
// ───────────────────────────────────────────────────────────────────────────

interface Sandbox { root: string; origin: string; main: string; worktree: string; branch: string }

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

/** bare origin + main clone + one `worktree-agent-<hash>` worktree. */
function makeSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "branch-prune-salvage-"));
  const origin = join(root, "origin.git");
  const main = join(root, "main");
  const branchName = "worktree-agent-deadbeefcafe0001";
  const worktree = join(main, ".claude", "worktrees", "agent-deadbeefcafe0001");
  git(root, "init", "-q", "--bare", "-b", "master", origin);
  git(root, "clone", "-q", origin, main);
  git(main, "config", "user.name", "t");
  git(main, "config", "user.email", "t@example.invalid");
  git(main, "checkout", "-q", "-b", "master");
  writeFileSync(join(main, "README.md"), "base\n");
  writeFileSync(join(main, ".gitignore"), "node_modules/\n");
  git(main, "add", "README.md", ".gitignore");
  git(main, "commit", "-q", "-m", "base");
  git(main, "push", "-q", "origin", "master");
  mkdirSync(join(main, ".claude", "worktrees"), { recursive: true });
  git(main, "worktree", "add", "-q", "-b", branchName, worktree);
  return { root, origin, main, worktree, branch: branchName };
}

function salvage(sb: Sandbox, branchArg: string = sb.branch): { status: number; out: string } {
  const r = spawnSync("bash", [SCRIPT, "--salvage-worktree", sb.worktree, branchArg], {
    encoding: "utf-8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("scripts/branch-prune.sh — salvage before worktree removal (issue #4518)", () => {
  test("a dirty worktree's work is committed on its OWN branch and pushed to origin before removal is allowed", () => {
    const sb = makeSandbox();
    try {
      writeFileSync(join(sb.worktree, "README.md"), "base\nedited by a dead dispatch\n");
      mkdirSync(join(sb.worktree, "src"));
      writeFileSync(join(sb.worktree, "src", "new-file.ts"), "export const x = 1;\n");
      const r = salvage(sb);
      assert.equal(r.status, 0, r.out);
      // Same branch name on origin — never a new wip/* name (INV-5).
      const refs = git(sb.origin, "for-each-ref", "--format=%(refname)", "refs/heads");
      assert.deepEqual(refs.split("\n").sort(), ["refs/heads/master", `refs/heads/${sb.branch}`]);
      assert.equal(git(sb.origin, "show", `${sb.branch}:src/new-file.ts`), "export const x = 1;");
      assert.match(git(sb.origin, "show", `${sb.branch}:README.md`), /edited by a dead dispatch/);
      assert.match(git(sb.origin, "log", "-1", "--format=%s", sb.branch), /salvage/i);
      assert.equal(git(sb.worktree, "status", "--porcelain"), "", "everything is committed — removal is now safe");
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test("a dirty worktree is never removed when the salvage push fails — it is left in place, still dirty", () => {
    const sb = makeSandbox();
    try {
      writeFileSync(join(sb.worktree, "wip.txt"), "uncommitted work\n");
      git(sb.main, "remote", "set-url", "origin", join(sb.root, "no-such-remote.git"));
      const r = salvage(sb);
      assert.notEqual(r.status, 0, "a failed push must refuse the removal");
      assert.match(r.out, /skip-dirty-unpushed/);
      assert.ok(existsSync(sb.worktree), "the worktree dir is still there");
      assert.equal(readFileSync(join(sb.worktree, "wip.txt"), "utf-8"), "uncommitted work\n");
      assert.notEqual(
        git(sb.worktree, "status", "--porcelain"),
        "",
        "still dirty, so the NEXT run classifies salvage-then-delete again instead of deleting a clean-looking dir",
      );
      assert.equal(git(sb.worktree, "log", "-1", "--format=%s"), "base", "the failed salvage commit is rolled back");
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test("a node_modules symlink is never committed by the salvage step", () => {
    const sb = makeSandbox();
    try {
      mkdirSync(join(sb.root, "real_node_modules"));
      symlinkSync(join(sb.root, "real_node_modules"), join(sb.worktree, "node_modules"));
      writeFileSync(join(sb.worktree, "wip.txt"), "uncommitted work\n");
      assert.equal(salvage(sb).status, 0);
      const tree = git(sb.origin, "ls-tree", "-r", "--name-only", sb.branch).split("\n");
      assert.ok(tree.includes("wip.txt"));
      assert.ok(!tree.includes("node_modules"), `node_modules leaked into the salvage commit: ${tree.join(",")}`);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test("a worktree whose only residue is the node_modules symlink needs no salvage commit and no push", () => {
    const sb = makeSandbox();
    try {
      mkdirSync(join(sb.root, "real_node_modules"));
      symlinkSync(join(sb.root, "real_node_modules"), join(sb.worktree, "node_modules"));
      const r = salvage(sb);
      assert.equal(r.status, 0, r.out);
      assert.equal(git(sb.worktree, "log", "-1", "--format=%s"), "base");
      assert.equal(git(sb.origin, "for-each-ref", "--format=%(refname)", "refs/heads"), "refs/heads/master");
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test("a dirty worktree with no branch (detached) is refused — nothing to salvage onto", () => {
    const sb = makeSandbox();
    try {
      writeFileSync(join(sb.worktree, "wip.txt"), "uncommitted work\n");
      const r = salvage(sb, "");
      assert.notEqual(r.status, 0);
      assert.match(r.out, /skip-dirty-unpushed/);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test("every `git worktree remove --force` in the script sits behind the salvage guard", () => {
    const text = readFileSync(SCRIPT, "utf-8");
    const code = text.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    const removes = code.match(/git worktree remove --force/g) ?? [];
    assert.equal(removes.length, 1, "exactly one removal site: inside remove_worktree_preserving_work");
    const fn = /remove_worktree_preserving_work\(\) \{([\s\S]*?)\n\}/.exec(code);
    assert.ok(fn, "remove_worktree_preserving_work() must exist");
    const body = fn[1]!;
    assert.ok(
      body.indexOf("salvage_worktree_before_remove") !== -1 &&
        body.indexOf("salvage_worktree_before_remove") < body.indexOf("git worktree remove --force"),
      "the salvage call must precede the removal",
    );
  });
});

/**
 * Regression tests for scripts/branch-prune.sh exit semantics (issue #494).
 *
 * Background: the `hydra-branch-prune.service` ExecStart comment claims
 * per-branch errors should NOT fail the service ("don't fail the service —
 * the next run picks them up"). But scripts/branch-prune.sh historically
 * exited 1 whenever its `ERRORS` counter > 0, so any transient per-branch
 * cleanup hiccup (e.g. a worktree lock held by a dead PID) flipped the
 * service to `failed` until the next successful run. hydra-doctor then had
 * to triage the spurious `failed_services=1` signal each timer pass.
 *
 * Issue #494 chose fix (a): make per-branch errors non-fatal at the script
 * level (exit 0 with a warning when only per-branch errors occurred). Hard
 * failures (worktree refusal, missing jq/npx, classifier returning no
 * output) must still be non-zero — only the per-branch error counter is
 * downgraded.
 *
 * The #494 tests pin the contract by reading the script as text and asserting
 * the structural properties of the relevant code path (the #4518 salvage
 * suite further down is the exception — see its header). They do NOT spawn
 * the script against a fake repo (that would require mocking git fetch,
 * npx tsx, the classifier output, and the destructive ops — overkill for a
 * single exit-code change).
 */

import test, { describe } from "node:test";
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
import { resolve, join } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPT_PATH = join(REPO_ROOT, "scripts/branch-prune.sh");

function readScript(): string {
  return readFileSync(SCRIPT_PATH, "utf-8");
}

describe("scripts/branch-prune.sh — per-branch errors are non-fatal (issue #494)", () => {
  // After issue #542 the script was refactored into a `prune_repo` function
  // that runs against both ~/hydra and ~/hydra-betting. Per-branch errors
  // from each pass are aggregated into a top-level `TOTAL_SOFT_ERRORS`
  // counter, and the issue-#494 non-fatal contract is enforced there. The
  // tests below were updated to look at the new top-level counter; the
  // contract (exit 0 on per-branch errors, WARNING logged, rationale present)
  // is unchanged.
  test("the soft-error branch exits 0, not 1", () => {
    const text = readScript();
    // Locate the `if [ "$TOTAL_SOFT_ERRORS" -gt 0 ]; then` block and verify
    // its `exit` statement is `exit 0`. We match on the surrounding shape to
    // avoid a false positive on some other `exit 0` elsewhere in the script.
    const match = text.match(/if \[ "\$TOTAL_SOFT_ERRORS" -gt 0 \]; then[\s\S]*?\n\s*exit\s+(\d+)\s*\n\s*fi/);
    assert.ok(match, "expected an `if [ \"$TOTAL_SOFT_ERRORS\" -gt 0 ]; then ... exit N; fi` block");
    assert.equal(
      match![1],
      "0",
      "per-branch errors must exit 0 so the systemd unit doesn't flap to `failed` (issue #494)",
    );
  });

  test("the soft-error branch logs a WARNING (so the operator can still see it)", () => {
    const text = readScript();
    // The warning has to be loud enough that journalctl/hydra-doctor still
    // surface it — exit 0 doesn't mean silent. We require the literal token
    // "WARNING" in the error-path echo so log scrapers can match on it.
    const block = text.match(/if \[ "\$TOTAL_SOFT_ERRORS" -gt 0 \]; then([\s\S]*?)\n\s*exit\s+0\s*\n\s*fi/);
    assert.ok(block, "expected the TOTAL_SOFT_ERRORS > 0 branch to be present");
    const body = block![1];
    assert.match(body, /WARNING/, "the soft-error branch must log a WARNING (operator visibility)");
    assert.match(body, /\$TOTAL_SOFT_ERRORS/, "the warning must include the error count");
  });

  test("hard-failure exits remain non-zero (worktree refusal, jq/npx missing, classifier empty)", () => {
    const text = readScript();
    // Safety rail 1: refusing to run from inside a worktree — exit 3.
    assert.match(
      text,
      /refusing to run from inside a worktree[\s\S]*?\n\s*exit\s+3\b/,
      "worktree-refusal path must still exit 3",
    );
    // Tool dependency check — exit 127 (POSIX "command not found"). The
    // jq/npx guards are single-line `|| { ... exit 127; }` forms, so we
    // assert the exit appears inside the same braced block (same line OK).
    assert.match(
      text,
      /jq required[^}]*?exit\s+127\b/,
      "missing-jq path must still exit 127",
    );
    assert.match(
      text,
      /npx required[^}]*?exit\s+127\b/,
      "missing-npx path must still exit 127",
    );
    // Classifier produced no output — exit 4.
    assert.match(
      text,
      /classifier produced no output[\s\S]*?\n\s*exit\s+4\b/,
      "empty-classifier path must still exit 4 (no destructive ops)",
    );
  });

  test("the success path still exits 0 (regression guard against accidentally inverting the change)", () => {
    const text = readScript();
    // The success exit comes right after a final `all passes done.` log line
    // (post-#542 the script runs two passes — orchestrator + target — and
    // the trailing log line was updated to reflect that).
    assert.match(
      text,
      /branch-prune: all passes done\.[\s\S]*?\n\s*exit\s+0\s*$/m,
      "successful run must still exit 0 with a final `all passes done.` log line",
    );
  });

  test("the exit-0 change references the systemd unit's promise (so future readers find the rationale)", () => {
    const text = readScript();
    // The ExecStart comment in ~/.config/systemd/user/hydra-branch-prune.service
    // says "don't fail the service — the next run picks them up". The script
    // must explain WHY soft errors are non-fatal so a future maintainer doesn't
    // "fix" the exit code back to 1 thinking it's a bug.
    const block = text.match(/if \[ "\$TOTAL_SOFT_ERRORS" -gt 0 \]; then([\s\S]*?)\n\s*exit\s+0/);
    assert.ok(block, "expected the TOTAL_SOFT_ERRORS > 0 branch to be present");
    const body = block![1];
    assert.match(
      body,
      /next (timer )?run|systemd|non-fatal|#494/i,
      "the non-fatal exit must be commented with rationale (rationale loss caused issue #494 in the first place)",
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Dirty-worktree salvage — the shell glue (issue #4518, INV-4 / INV-5)
//
// branch-prune is the ONLY code path that deletes `.claude/worktrees/agent-*`
// (reap.py shells to it with --apply on every worktree-bearing reap; the daily
// timer runs it too). Before #4518 both worktree-removing loops ran
// `git worktree remove --force` with no dirty-state check. Unlike the #494
// cases above, these DO run the script — against real throw-away repos, through
// its `--salvage-worktree` seam (the same function the apply loops call; it
// exits before any fetch / classification / removal). The pure-classifier half
// (the `salvage-then-delete` verdict) is pinned in
// test/hydra-branch-prune.test.mts + test/hydra-branch-prune-worktree-orphan.test.mts.
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
  const r = spawnSync("bash", [SCRIPT_PATH, "--salvage-worktree", sb.worktree, branchArg], {
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
    const text = readScript();
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

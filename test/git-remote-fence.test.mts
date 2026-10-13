/**
 * Regression test for scripts/claude-hooks/git-remote-fence.sh (issue #4939,
 * design-concept INV-4).
 *
 * The hook denies a Bash command that mutates a git remote when the session
 * cwd's `git rev-parse --git-common-dir` is the protected orchestrator gitdir
 * (any ~/hydra worktree or the main checkout). The protected dir is
 * overridden to a throwaway repo via HYDRA_REMOTE_FENCE_PROTECTED_GITDIR so the
 * test never touches the real gitdir.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const HOOK = join(REPO_ROOT, "scripts", "claude-hooks", "git-remote-fence.sh");

let tmp: string;
let protectedRepo: string;
let protectedWorktree: string;
let otherRepo: string;

function git(cwd: string, args: string[]): void {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
}

function run(command: string, cwd: string, tool = "Bash") {
  const r = spawnSync("bash", [HOOK], {
    input: JSON.stringify({ cwd, tool_name: tool, tool_input: { command } }),
    encoding: "utf-8",
    env: {
      ...process.env,
      HYDRA_REMOTE_FENCE_PROTECTED_GITDIR: join(protectedRepo, ".git"),
    },
  });
  return { status: r.status, stderr: r.stderr ?? "" };
}

before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "remote-fence-")));
  protectedRepo = join(tmp, "orch");
  otherRepo = join(tmp, "target");
  protectedWorktree = join(tmp, "orch-wt");
  for (const d of [protectedRepo, otherRepo]) {
    spawnSync("git", ["init", "-q", d]);
    git(d, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "i"]);
  }
  git(protectedRepo, ["worktree", "add", "-q", "-b", "wt", protectedWorktree]);
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("git-remote-fence", () => {
  const DENY = [
    'git remote set-url origin https://github.com/gaberoo322/claw-street-bets.git',
    'cd "$TARGET_WS" && git remote set-url origin https://x/y.git',
    "git remote remove origin",
    "git remote rm origin",
    "git remote rename origin old",
    "git config remote.origin.url https://x/y.git",
    "git config --local remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'",
    'bash -c "git remote set-url origin https://x/y.git"',
    "echo hi\ngit remote set-url origin https://x/y.git",
  ];
  for (const cmd of DENY) {
    it(`denies from the protected repo: ${cmd.split("\n").pop()}`, () => {
      const r = run(cmd, protectedRepo);
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /permissionDecision/);
      assert.match(r.stderr, /"deny"/);
    });
  }

  it("denies from a worktree of the protected repo (shared common dir)", () => {
    assert.equal(run("git remote set-url origin https://x/y.git", protectedWorktree).status, 2);
  });

  const ALLOW = [
    "git remote -v",
    "git remote get-url origin",
    "git remote show origin",
    "git config --get remote.origin.url",
    "git config --list",
    "git fetch origin master",
    "git commit -m 'document git remote set-url misuse'",
    "echo \"never run git remote set-url\"",
    "cat <<'EOF'\ngit remote set-url origin x\nEOF",
  ];
  for (const cmd of ALLOW) {
    it(`allows from the protected repo: ${cmd.split("\n")[0]}`, () => {
      const r = run(cmd, protectedRepo);
      assert.equal(r.status, 0, r.stderr);
    });
  }

  it("allows the same mutation when cwd is a different gitdir", () => {
    assert.equal(run("git remote set-url origin https://x/y.git", otherRepo).status, 0);
  });

  it("fails open on non-Bash tools, malformed stdin and a non-repo cwd", () => {
    assert.equal(run("git remote set-url origin x", protectedRepo, "Edit").status, 0);
    const bad = spawnSync("bash", [HOOK], { input: "not json", encoding: "utf-8" });
    assert.equal(bad.status, 0);
    assert.equal(run("git remote set-url origin x", tmp).status, 0);
  });

  it("resolves the EFFECTIVE repo of the command, not just the session cwd", () => {
    const url = "https://x/y.git";
    // From a non-protected cwd, a command that targets the protected repo is denied.
    assert.equal(run(`git -C ${protectedRepo} remote add up ${url}`, otherRepo).status, 2);
    assert.equal(run(`cd ${protectedRepo} && git remote set-url origin ${url}`, otherRepo).status, 2);
    assert.equal(run(`git --git-dir=${protectedRepo}/.git remote rm origin`, otherRepo).status, 2);
    // From the protected cwd, a command that targets a different repo is allowed.
    assert.equal(run(`git -C ${otherRepo} remote add up ${url}`, protectedRepo).status, 0);
    assert.equal(run(`cd ${otherRepo} && git remote set-url origin ${url}`, protectedRepo).status, 0);
    // An unresolvable (empty-var) target degrades to the cwd, as the shell does.
    assert.equal(run(`git -C "$NOPE" remote set-url origin ${url}`, protectedRepo).status, 2);
  });

  it("scans a heredoc body when the consumer is a shell, ignores it otherwise", () => {
    const body = "git remote set-url origin https://x/y.git";
    assert.equal(run(`bash <<'EOF'\n${body}\nEOF`, protectedRepo).status, 2);
    assert.equal(run(`sh -s <<EOS\n${body}\nEOS`, protectedRepo).status, 2);
    assert.equal(run(`gh pr create --body-file - <<'EOF'\n${body}\nEOF`, protectedRepo).status, 0);
    assert.equal(run(`echo $((1<<3))\n${body}`, protectedRepo).status, 2);
  });

  it("is registered as a PreToolUse Bash hook by setup-claude-hooks.sh and in the GLM drainer settings", () => {
    const setup = readFileSync(join(REPO_ROOT, "scripts", "setup-claude-hooks.sh"), "utf-8");
    assert.match(setup, /^\s*"git-remote-fence\.sh\|Bash"\s*$/m);
    const drainer = JSON.parse(
      readFileSync(join(REPO_ROOT, "config", "glm", "drainer-settings.json"), "utf-8"),
    );
    const entries = drainer.hooks.PreToolUse as Array<{ matcher: string; hooks: Array<{ command: string }> }>;
    const fence = entries.find((e) => e.hooks.some((h) => /git-remote-fence\.sh/.test(h.command)));
    assert.ok(fence, "drainer settings must register git-remote-fence.sh");
    assert.match(fence.matcher, /\bBash\b/);
  });
});

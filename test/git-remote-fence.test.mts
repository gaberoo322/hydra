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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

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

function run(command: string, cwd: string, tool = "Bash", extraEnv: Record<string, string> = {}) {
  const r = spawnSync("bash", [HOOK], {
    input: JSON.stringify({ cwd, tool_name: tool, tool_input: { command } }),
    encoding: "utf-8",
    env: {
      ...process.env,
      HYDRA_REMOTE_FENCE_PROTECTED_GITDIR: join(protectedRepo, ".git"),
      ...extraEnv,
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
    // `~` and `$HOME` are expanded before the unresolved check (QA round 2).
    const homeEnv = { HOME: dirname(protectedRepo) };
    const rel = basename(protectedRepo);
    assert.equal(run(`cd ~/${rel} && git remote set-url origin ${url}`, otherRepo, "Bash", homeEnv).status, 2);
    assert.equal(run(`cd $HOME/${rel} && git remote set-url origin ${url}`, otherRepo, "Bash", homeEnv).status, 2);
    assert.equal(run(`cd "\${HOME}/${rel}" && git remote set-url origin ${url}`, otherRepo, "Bash", homeEnv).status, 2);
    // An unresolvable (empty-var) target degrades to the cwd, as the shell does.
    assert.equal(run(`git -C "$NOPE" remote set-url origin ${url}`, protectedRepo).status, 2);
  });

  it("scans a heredoc body when the consumer is a shell, ignores it otherwise", () => {
    const body = "git remote set-url origin https://x/y.git";
    assert.equal(run(`bash <<'EOF'\n${body}\nEOF`, protectedRepo).status, 2);
    assert.equal(run(`sh -s <<EOS\n${body}\nEOS`, protectedRepo).status, 2);
    assert.equal(run(`gh pr create --body-file - <<'EOF'\n${body}\nEOF`, protectedRepo).status, 0);
    assert.equal(run(`echo $((1<<3))\n${body}`, protectedRepo).status, 2);
    // SHELLISH is checked against the whole opener line (QA round 3): a pipe to a shell.
    assert.equal(run(`cat <<'EOF' | bash\n${body}\nEOF`, protectedRepo).status, 2);
    assert.equal(run(`cat <<'EOF' | gh pr create --body-file -\n${body}\nEOF`, protectedRepo).status, 0);
  });

  it("accepts the space-separated form of value-taking long options (QA round 3)", () => {
    const url = "https://x/y.git";
    assert.equal(run(`git --git-dir ${protectedRepo}/.git remote rm origin`, otherRepo).status, 2);
    assert.equal(run(`git --namespace ns --git-dir ${protectedRepo}/.git remote set-url origin ${url}`, otherRepo).status, 2);
    assert.equal(run(`git --work-tree ${tmp} remote set-url origin ${url}`, protectedRepo).status, 2);
    assert.equal(run(`git --git-dir ${otherRepo}/.git remote set-url origin ${url}`, protectedRepo).status, 0);
  });

  describe("issue #5026 bypass shapes", () => {
    const url = "https://x/y.git";
    const set = `git remote set-url origin ${url}`;

    it("INV-1: a non-HOME $VAR in the hook env is unresolved, not expanded", () => {
      assert.equal(run(`cd "$TARGET_WS" && ${set}`, protectedRepo, "Bash", { TARGET_WS: otherRepo }).status, 2);
      assert.equal(run(`cd \${TARGET_WS} && ${set}`, protectedRepo, "Bash", { TARGET_WS: otherRepo }).status, 2);
    });

    it("INV-2: a literal but non-repo target falls back to the session cwd", () => {
      assert.equal(run(`cd ${tmp}/nonexistent ; ${set}`, protectedRepo).status, 2);
      assert.equal(run(`git -C ${tmp}/nonexistent remote add up ${url}`, protectedRepo).status, 2);
      assert.equal(run(`cd ${tmp}/nonexistent ; ${set}`, otherRepo).status, 0);
      assert.equal(run(`cd ${tmp}/nonexistent ; ${set}`, tmp).status, 0);
    });

    it("INV-3: cd scope follows shell scope", () => {
      assert.equal(run(`(cd ${otherRepo}) ; ${set}`, protectedRepo).status, 2);
      assert.equal(run(`x=$(cd ${otherRepo}); ${set}`, protectedRepo).status, 2);
      assert.equal(run(`(cd ${otherRepo} && ${set})`, protectedRepo).status, 0);
      assert.equal(run(`cd ${otherRepo} && (true) && ${set}`, protectedRepo).status, 0);
      // backtick substitution, pipeline stage and background job are not the git shell
      assert.equal(run(`x=\`cd ${otherRepo}\`; ${set}`, protectedRepo).status, 2);
      assert.equal(run(`cd ${otherRepo} | ${set}`, protectedRepo).status, 2);
      assert.equal(run(`cd ${otherRepo} & ${set}`, protectedRepo).status, 2);
      assert.equal(run(`cd ${otherRepo} && true | ${set}`, protectedRepo).status, 0);
      // guarded-cd idiom: `cd X || exit 1` still runs git in X
      assert.equal(run(`cd ${protectedRepo} || exit 1; ${set}`, otherRepo).status, 2);
      assert.equal(run(`cd ${otherRepo} || exit 1; ${set}`, protectedRepo).status, 0);
    });

    it("a $(...) / backtick value in -C is still a mutation (not an allow)", () => {
      assert.equal(run(`git -C $(pwd) remote set-url origin ${url}`, protectedRepo).status, 2);
      assert.equal(run(`git -C \`pwd\` remote set-url origin ${url}`, protectedRepo).status, 2);
      // nesting deeper than the WORD regex balances fails closed
      assert.equal(run(`git -C $(echo $(echo $(echo $(pwd)))) remote set-url origin ${url}`, protectedRepo).status, 2);
      assert.equal(run(`git -C $(echo $(echo $(echo $(pwd)))) remote -v`, protectedRepo).status, 0);
    });

    it("INV-4: a word is all its adjacent fragments", () => {
      const rel = basename(protectedRepo);
      const homeEnv = { HOME: dirname(protectedRepo) };
      assert.equal(run(`cd "$HOME"/${rel} && ${set}`, otherRepo, "Bash", homeEnv).status, 2);
      assert.equal(run(`cd "$HOME"/${basename(otherRepo)} && ${set}`, protectedRepo, "Bash", homeEnv).status, 0);
      assert.equal(run(`cd '${dirname(protectedRepo)}'/${rel} && ${set}`, otherRepo).status, 2);
    });

    it("INV-5: a GIT_DIR= prefix is resolved like --git-dir", () => {
      assert.equal(run(`GIT_DIR=${protectedRepo}/.git ${set}`, otherRepo).status, 2);
      assert.equal(run(`GIT_DIR=${otherRepo}/.git ${set}`, protectedRepo).status, 0);
    });

    it("INV-6: git config read/write classification", () => {
      assert.equal(run("git config remote.origin.url $(git config --get remote.origin.url)", protectedRepo).status, 2);
      assert.equal(run("git config remote.origin.url `git config --get remote.origin.url`", protectedRepo).status, 2);
      assert.equal(run("git config remote.origin.url", protectedRepo).status, 0);
      assert.equal(run("git config --local remote.origin.url", protectedRepo).status, 0);
      assert.equal(run("git config --unset remote.origin.url", protectedRepo).status, 2);
      assert.equal(run("git config --get remote.origin.url", protectedRepo).status, 0);
      assert.equal(run("(git config remote.origin.url)", protectedRepo).status, 0);
    });
  });

  describe("QA round 3: fail-closed loose scan (unparseable remote mutation)", () => {
    const url = "https://x/y.git";
    // `$(dirname $(dirname $(pwd)))` is depth 3; the extra $(echo ...) is depth 4.
    const nest = (depth: number, inner: string) =>
      "$(echo ".repeat(depth - 1) + `$(echo ${inner})` + ")".repeat(depth - 1);
    const unparseable = (cwd: string, cmd: string) => {
      const r = run(cmd, cwd);
      assert.equal(r.status, 2, `${cmd}\n${r.stderr}`);
      assert.match(r.stderr, /unparseable remote mutation — denied fail-closed/);
    };

    it("denies -C / -c / --git-dir values nested 3 and 4 deep", () => {
      for (const depth of [3, 4]) {
        for (const [cwd, target] of [[protectedRepo, protectedRepo], [otherRepo, protectedRepo]]) {
          const v = nest(depth, target);
          unparseable(cwd, `git -C ${v} remote set-url origin ${url}`);
          unparseable(cwd, `git -c core.x=${v} remote set-url origin ${url}`);
          unparseable(cwd, `git --git-dir=${nest(depth, `${target}/.git`)} remote add up ${url}`);
        }
      }
      // the QA-reported literal shape
      unparseable(protectedRepo, "git -C $(dirname $(dirname $(pwd))) remote set-url o x");
    });

    it("denies a config write at depth 3 (no strict match for config either)", () => {
      unparseable(protectedRepo, `git -C ${nest(3, protectedRepo)} config remote.origin.url x`);
      unparseable(otherRepo, `git -C ${nest(3, protectedRepo)} config remote.origin.url x`);
      unparseable(protectedRepo, "git -C $(a $(b $(c))) config remote.origin.url x");
    });

    it("denies every git spelling / wrapper / global flag the strict parser does not model", () => {
      const forms = [
        `/usr/bin/git remote set-url origin ${url}`,
        `time git remote set-url origin ${url}`,
        `nohup git remote set-url origin ${url}`,
        `timeout 5 git remote set-url origin ${url}`,
        `command -p git remote set-url origin ${url}`,
        `"git" remote set-url origin ${url}`,
        `'git' remote set-url origin ${url}`,
        `git -p remote set-url origin ${url}`,
        `git -P remote set-url origin ${url}`,
        `git -p --no-pager remote set-url origin ${url}`,
        `env GIT_DIR=${protectedRepo}/.git git remote set-url origin ${url}`,
        `nice -n 5 git config remote.origin.url ${url}`,
      ];
      for (const f of forms) {
        unparseable(protectedRepo, f);
        unparseable(otherRepo, f.replace(" remote ", ` -C ${protectedRepo} remote `));
      }
    });

    it("still denies plain --no-pager (strict) from the protected repo and from a repo targeting it", () => {
      assert.equal(run(`git --no-pager remote set-url origin ${url}`, protectedRepo).status, 2);
      assert.equal(run(`git --no-pager -C ${protectedRepo} remote set-url origin ${url}`, otherRepo).status, 2);
    });

    it("strict-parses the new mutation subcommands (set-head / set-branches / prune)", () => {
      for (const sub of ["set-head origin -a", "set-branches origin master", "prune origin"]) {
        assert.equal(run(`git remote ${sub}`, protectedRepo).status, 2, sub);
        assert.equal(run(`git remote ${sub}`, otherRepo).status, 0, sub);
      }
    });

    it("allows read-only forms, including deep nesting and a bare read with a redirect", () => {
      for (const cmd of [
        "git remote -v",
        "git remote get-url origin",
        "git config --get remote.origin.url",
        "git config remote.origin.url 2>/dev/null",
        "git config remote.origin.url > /tmp/x 2>&1",
        "time git remote -v",
        "/usr/bin/git config --get remote.origin.url",
        `git -C ${nest(3, protectedRepo)} remote -v`,
        `git -C ${nest(4, protectedRepo)} config --get remote.origin.url`,
        "echo \"time git remote set-url origin x\"",
      ]) {
        assert.equal(run(cmd, protectedRepo).status, 0, cmd);
      }
    });

    it("allows a strictly-resolved mutation of a clearly non-protected repo", () => {
      assert.equal(run(`git -C ${otherRepo} remote add up ${url}`, protectedRepo).status, 0);
      assert.equal(run(`git remote set-url origin ${url}`, otherRepo).status, 0);
      assert.equal(run(`git config remote.origin.url ${url}`, otherRepo).status, 0);
      assert.equal(run(`cd ${otherRepo} || exit 1; git remote set-url origin ${url}`, protectedRepo).status, 0);
    });
  });

  describe("issue #5026 decision A: scoped deny-on-crash", () => {
    const url = "https://x/y.git";

    it("a command mentioning neither remote nor config passes without python", () => {
      for (const py of ["/nonexistent/python3", "/bin/false"]) {
        for (const cmd of ["ls -la", "git status && npm test", "git push origin HEAD:x"]) {
          const r = run(cmd, protectedRepo, "Bash", { HYDRA_REMOTE_FENCE_PYTHON: py });
          assert.equal(r.status, 0, `${py}: ${cmd}: ${r.stderr}`);
        }
      }
    });

    it("denies a remote/config command when python is unavailable or emits no verdict", () => {
      for (const py of ["/nonexistent/python3", "/bin/true", "/bin/false"]) {
        for (const cwd of [protectedRepo, otherRepo, tmp]) {
          const r = run(`git remote set-url origin ${url}`, cwd, "Bash", { HYDRA_REMOTE_FENCE_PYTHON: py });
          assert.equal(r.status, 2, `${py} @ ${cwd}: ${r.stderr}`);
          assert.match(r.stderr, /analysis failed on a command mentioning remote\/config — denied fail-closed/);
          // The deny payload is valid JSON even though python never ran.
          const json = r.stderr.trim().split("\n").pop() ?? "";
          const parsed = JSON.parse(json);
          assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
          assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
        }
      }
      // Quote/backslash-split spellings still reach the analysis (pre-filter
      // drops quotes and backslashes before matching).
      for (const cmd of [`git "re"mote set-url origin ${url}`, `git re\\mote add up ${url}`, `git con'fig' remote.o.url y`]) {
        const r = run(cmd, protectedRepo, "Bash", { HYDRA_REMOTE_FENCE_PYTHON: "/nonexistent/python3" });
        assert.equal(r.status, 2, cmd);
      }
    });

    it("denies when the analysis itself crashes (git missing) on a config remote write", () => {
      // A PATH with python3 but no git: subprocess.run(["git", ...]) raises
      // inside is_protected, which must map to ERROR -> deny, never ALLOW.
      const which = (b: string) =>
        spawnSync("sh", ["-c", `command -v ${b}`], { encoding: "utf-8" }).stdout.trim();
      const binDir = join(tmp, "py-only-bin");
      mkdirSync(binDir, { recursive: true });
      for (const b of ["python3", "cat"]) {
        if (!existsSync(join(binDir, b))) symlinkSync(which(b), join(binDir, b));
      }
      assert.ok(!existsSync(join(binDir, "git")));
      const res = spawnSync(which("bash"), [HOOK], {
        input: JSON.stringify({
          cwd: protectedRepo,
          tool_name: "Bash",
          tool_input: { command: "git config remote.x.url y" },
        }),
        encoding: "utf-8",
        env: {
          PATH: binDir,
          HOME: process.env.HOME ?? "",
          HYDRA_REMOTE_FENCE_PROTECTED_GITDIR: join(protectedRepo, ".git"),
        },
      });
      assert.equal(res.status, 2, res.stderr);
      assert.match(res.stderr, /analysis failed on a command mentioning remote\/config/);
    });

    it("denies malformed stdin that mentions remote/config; allows malformed stdin that does not", () => {
      const bad = spawnSync("bash", [HOOK], { input: "{not json: git remote set-url origin x", encoding: "utf-8" });
      assert.equal(bad.status, 2, bad.stderr);
      assert.match(bad.stderr, /analysis failed/);
      const benign = spawnSync("bash", [HOOK], { input: "{not json: ls", encoding: "utf-8" });
      assert.equal(benign.status, 0);
    });

    it("denies a mutation with no session cwd; keeps the legitimate fail-open exits", () => {
      assert.equal(run(`git remote set-url origin ${url}`, "").status, 2);
      assert.equal(run("", protectedRepo).status, 0); // empty command
      assert.equal(run(`git remote set-url origin ${url}`, protectedRepo, "Edit").status, 0); // non-Bash
      assert.equal(run(`git remote set-url origin ${url}`, tmp).status, 0); // non-repo cwd, strict parse
      assert.equal(run("git remote -v && git config --get remote.origin.url", protectedRepo).status, 0);
      // Non-repo cwd does NOT open the loose fail-closed scan.
      assert.equal(run(`time git remote set-url origin ${url}`, tmp).status, 2);
    });
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

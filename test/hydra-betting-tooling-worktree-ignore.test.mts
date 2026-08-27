/**
 * Structural regression test for issue #4177's INV-6: every tool that walks
 * `web/` from the main hydra-betting checkout must not descend into or
 * report on the nested `web/.worktrees/<name>` worktree directory.
 *
 * This repo (gaberoo322/hydra) cannot import or execute hydra-betting's own
 * source tree — it is a SEPARATE repo, and this file cannot assume it is
 * checked out as a sibling in CI. So this test proves the underlying
 * MECHANISM against self-contained fixtures that mirror hydra-betting's
 * actual committed tool configuration shape (companion PR
 * gaberoo322/hydra-betting#1095's `web/tsconfig.json`, and the already-merged
 * `.gitignore` from hydra-betting commit 2a8609e1) — using tools this repo
 * already depends on (`typescript`, `git`), so the test is hermetic and
 * never network- or sibling-repo-dependent.
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Resolve the installed `tsc` binary via Node's own ancestor-walk module
// resolution (createRequire), NOT a literal `node_modules/.bin/tsc` path —
// a `~/hydra/.claude/worktrees/*` checkout has no LOCAL node_modules (it
// relies on the same ancestor walk this test's sibling invariant is about),
// so a hardcoded relative path would silently fail to resolve there.
function resolveTscBin(): string {
  const require = createRequire(import.meta.url);
  const typescriptPkgJson = require.resolve("typescript/package.json");
  return join(dirname(typescriptPkgJson), "bin", "tsc");
}

describe("hydra-betting tooling ignores web/.worktrees/ (issue #4177, INV-6)", () => {
  test("tsc (mirroring hydra-betting/web/tsconfig.json's include/exclude shape) does not descend into web/.worktrees/", () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-tsc-worktree-ignore-"));
    try {
      // Verbatim shape of the exclude list landed in the companion PR
      // (gaberoo322/hydra-betting#1095): node_modules + .worktrees, plus the
      // SAME include globs hydra-betting/web/tsconfig.json already ships.
      writeFileSync(
        join(dir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { noEmit: true, strict: true, skipLibCheck: true },
          include: ["**/*.ts", "**/*.tsx"],
          exclude: ["node_modules", ".worktrees"],
        }),
        "utf-8",
      );
      // A bad file INSIDE the nested worktree — must NOT be reported.
      mkdirSync(join(dir, ".worktrees", "cycle-x", "src"), { recursive: true });
      writeFileSync(
        join(dir, ".worktrees", "cycle-x", "src", "bad.ts"),
        "const x: string = 123;\n",
        "utf-8",
      );
      // A bad file OUTSIDE the worktree — the negative control. Proves this
      // test methodology actually exercises new files rather than passing
      // vacuously (the same control used to verify the real hydra-betting
      // fixture in the companion PR).
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "bad.ts"), "const y: number = \"nope\";\n", "utf-8");

      const r = spawnSync(process.execPath, [resolveTscBin(), "--noEmit"], { cwd: dir, encoding: "utf-8" });
      const output = r.stdout + r.stderr;
      const badTsMentions = (output.match(/bad\.ts/g) ?? []).length;

      assert.doesNotMatch(
        output,
        /\.worktrees[/\\]cycle-x/,
        `tsc must not report anything under .worktrees/ — got:\n${output}`,
      );
      // Negative control: exactly ONE bad.ts mention (the top-level one) must
      // survive. Zero would mean the assertion above is vacuously true
      // because tsc reported NEITHER file (e.g. a broken invocation) rather
      // than correctly excluding just the worktree copy.
      assert.equal(
        badTsMentions,
        1,
        `expected exactly 1 bad.ts mention (the file OUTSIDE .worktrees/), got ${badTsMentions}:\n${output}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("git status (mirroring hydra-betting's .gitignore entry) does not report web/.worktrees/", () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-git-worktree-ignore-"));
    const run = (...args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
    try {
      assert.equal(spawnSync("git", ["init", "-q", dir]).status, 0, "git init failed");
      run("config", "user.email", "t@t.com");
      run("config", "user.name", "t");
      // Verbatim entry landed in hydra-betting's .gitignore (commit 2a8609e1).
      writeFileSync(join(dir, ".gitignore"), "/web/.worktrees/\n", "utf-8");
      run("add", ".gitignore");
      assert.equal(run("commit", "-q", "-m", "init").status, 0, "seed commit failed");

      // Plant a throwaway nested-worktree-shaped tree, same as a real
      // `git worktree add web/.worktrees/<cycle-id>` would leave behind.
      mkdirSync(join(dir, "web", ".worktrees", "cycle-x"), { recursive: true });
      writeFileSync(join(dir, "web", ".worktrees", "cycle-x", "anything.ts"), "// scratch\n", "utf-8");

      const status = run("status", "--porcelain");
      assert.equal(status.status, 0, `git status failed: ${status.stderr}`);
      assert.equal(
        status.stdout.trim(),
        "",
        `git status in the main checkout must stay clean with web/.worktrees/ gitignored — got:\n${status.stdout}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

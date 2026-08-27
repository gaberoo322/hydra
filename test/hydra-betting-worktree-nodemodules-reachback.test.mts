/**
 * Structural regression test for issue #4177 (prevention half of #4175).
 *
 * The 2026-08-19 incident: a `/dev/shm` hydra-betting worktree's
 * `web/node_modules` was symlinked straight at the main checkout's real
 * `~/hydra-betting/web/node_modules`. A destructive install step inside the
 * worktree reached back through that link and wiped the main checkout's real
 * dependency tree, taking down six money-critical Target services for ~70
 * minutes.
 *
 * The fix nests the hydra-betting worktree under `web/.worktrees/<name>`
 * (NOT `/dev/shm`) so Node's upward module-resolution walk finds the real
 * `web/node_modules` as an ancestor — no symlink, no per-worktree install.
 * This is safe specifically because the walk is a resolver READ: a
 * destructive `rm -rf node_modules/` run inside the worktree is an ordinary
 * filesystem command, not a module-resolution call — it only ever targets a
 * LOCAL path, and since no node_modules is ever created or linked in the
 * worktree, that local path never exists, so the removal is a pure no-op.
 *
 * This test proves the mechanism directly against a real (throwaway) git
 * repo + `git worktree add`, mirroring the design-concept artifact's own
 * verified /tmp prototype for this issue — not asserted from prose.
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  lstatSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";

describe("hydra-betting worktree relocation: node_modules reach-back is structurally impossible (issue #4177)", () => {
  test("a worktree nested under web/.worktrees/<name> resolves node_modules by ancestor walk, creates NO local symlink, and a destructive rm -rf inside it never touches the ancestor", () => {
    const repo = mkdtempSync(join(tmpdir(), "hb-reachback-repo-"));
    const run = (...args: string[]) =>
      spawnSync("git", ["-C", repo, ...args], { encoding: "utf-8" });
    try {
      assert.equal(spawnSync("git", ["init", "-q", repo]).status, 0, "git init failed");
      run("config", "user.email", "t@t.com");
      run("config", "user.name", "t");

      // Simulate the hydra-betting layout: a tracked `web/` app dir, plus an
      // UNTRACKED `web/node_modules` (real deps are never committed) — the
      // ancestor the worktree is supposed to resolve against.
      mkdirSync(join(repo, "web"), { recursive: true });
      writeFileSync(join(repo, "web", "package.json"), JSON.stringify({ name: "web" }), "utf-8");
      writeFileSync(join(repo, ".gitignore"), "node_modules\n.worktrees\n", "utf-8");
      run("add", ".gitignore", "web/package.json");
      assert.equal(run("commit", "-q", "-m", "init").status, 0, "seed commit failed");

      // The REAL ancestor node_modules — untracked, sits at web/node_modules,
      // exactly like ~/hydra-betting/web/node_modules. Symlinked to a real
      // package dir (zod) so require.resolve has something genuine to find.
      mkdirSync(join(repo, "web", "node_modules"), { recursive: true });
      const zodTarget = join(repo, "web", "node_modules", "zod");
      const require2 = createRequire(import.meta.url);
      const zodSrc = dirname(require2.resolve("zod"));
      // Copy (not symlink) so this test's own filesystem assertions below
      // are unambiguous about what exists at which path.
      spawnSync("cp", ["-r", zodSrc, zodTarget]);

      // Create the worktree NESTED under web/ — the load-bearing placement
      // constraint from issue #4177 (a sibling `web/.worktrees/` would NOT
      // put web/node_modules on the ancestor-walk path).
      const wt = join(repo, "web", ".worktrees", "cycle-test");
      const add = run("worktree", "add", "-q", "-b", "feature-test", wt, "HEAD");
      assert.equal(add.status, 0, `worktree add failed: ${add.stderr}`);

      try {
        // --- INV-2: no web/node_modules symlink is ever created for the worktree ---
        const wtNodeModules = join(wt, "web", "node_modules");
        assert.equal(
          existsSync(wtNodeModules),
          false,
          "the worktree must not have its OWN local node_modules (no install, no symlink)",
        );

        // --- INV-3: ancestor walk resolves the REAL node_modules with zero symlink ---
        const resolved = require2.resolve("zod", { paths: [join(wt, "web")] });
        assert.equal(
          resolve(resolved),
          resolve(require2.resolve("zod", { paths: [join(repo, "web")] })),
          "require.resolve from inside the nested worktree must find the SAME real package the ancestor main tree resolves",
        );
        assert.ok(
          resolved.startsWith(resolve(zodTarget) + "/") || resolve(resolved) === resolve(zodTarget),
          `resolved path must live under the ancestor's real node_modules (${zodTarget}), got ${resolved}`,
        );

        // --- INV-1: a destructive rm -rf inside the worktree never reaches the ancestor ---
        const rm = spawnSync("rm", ["-rf", wtNodeModules]);
        assert.equal(rm.status, 0, "rm -rf on a nonexistent local path must exit 0 (a no-op)");
        assert.ok(
          existsSync(join(zodTarget, "package.json")),
          "the main tree's REAL node_modules/zod must survive the worktree's rm -rf untouched",
        );
        // Also assert nothing under the worktree resolved to a symlink at any
        // point — lstat would report a symlink type, not "does not exist".
        assert.throws(
          () => lstatSync(wtNodeModules),
          /ENOENT/,
          "the worktree's node_modules path must be ABSENT, not a (removed) symlink",
        );
      } finally {
        run("worktree", "remove", "--force", wt);
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

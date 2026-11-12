/**
 * Regression tests for scripts/reap-stale-tmp.sh (2026-10-31 /tmp inode
 * exhaustion; leakers filed as #5326 and claw-street-bets #335/#336).
 *
 * The reaper removes top-level temp dirs in the shared /tmp that fit a leaked
 * temp-dir SHAPE (mkdtemp's `<prefix>-<6 chars>`, or Vitest's nanoid dir whose
 * only entry is `ssr/`) and whose WHOLE subtree has been quiet for --max-age
 * minutes. These tests drive the real script through its `HYDRA_TMP_REAP_ROOT`
 * seam against a private fixture root, pinning both directions: the leaked
 * shapes go, and everything a live process or a person might still own stays.
 */

import test, { after, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lutimesSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPT_PATH = join(REPO_ROOT, "scripts/reap-stale-tmp.sh");

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "reap-stale-tmp-test-"));
  roots.push(root);
  return root;
}

/** Make a dir (with optional files) and back-date every path in it by `ageMin`. */
function makeDir(root: string, name: string, files: string[] = ["f"], ageMin = 2000): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date(Date.now() - ageMin * 60_000);
  for (const rel of files) {
    const p = join(dir, rel);
    mkdirSync(resolve(p, ".."), { recursive: true });
    writeFileSync(p, "x");
    utimesSync(p, stamp, stamp);
    utimesSync(resolve(p, ".."), stamp, stamp);
  }
  utimesSync(dir, stamp, stamp);
  return dir;
}

function run(
  root: string,
  ...args: string[]
): { status: number | null; stdout: string; stderr: string; summary: string } {
  return runWithEnv(root, {}, ...args);
}

function runWithEnv(
  root: string,
  extraEnv: Record<string, string>,
  ...args: string[]
): { status: number | null; stdout: string; stderr: string; summary: string } {
  const res = spawnSync("bash", [SCRIPT_PATH, ...args], {
    env: { ...process.env, ...extraEnv, HYDRA_TMP_REAP_ROOT: root },
    encoding: "utf8",
  });
  const summary = res.stdout.split("\n").find((l) => l.startsWith("SUMMARY")) ?? "";
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, summary };
}

describe("reap-stale-tmp.sh", () => {
  test("--apply removes stale mkdtemp-shaped dirs and stale Vitest ssr dirs", () => {
    const root = fixtureRoot();
    const leaked = makeDir(root, "csb-outcomes-route-1d5vgA", ["config/graduation-gate.yaml"]);
    const leakedDot = makeDir(root, "hydra-skill-mirror-drift.Ab12Cd");
    const vitest = makeDir(root, "zzeT1rfXrYVeQGQL3POIl", ["ssr/03e0d0c2679a1aefbf4406548e93c0180c89a6d0"]);

    const r = run(root, "--apply");

    assert.equal(r.status, 0);
    assert.equal(existsSync(leaked), false);
    assert.equal(existsSync(leakedDot), false);
    assert.equal(existsSync(vitest), false);
    assert.match(r.summary, /mode=apply .*matched=3 removed=3 failed=0/);
    assert.match(r.stdout, /CLASS class=vitest-ssr count=1/);
    assert.match(r.stdout, /CLASS class=mkdtemp:csb-outcomes-route- count=1/);
  });

  test("the default is a dry run that removes nothing", () => {
    const root = fixtureRoot();
    const leaked = makeDir(root, "pmh-e2e-Ab12Cd");

    const r = run(root);

    assert.equal(r.status, 0);
    assert.equal(existsSync(leaked), true);
    assert.ok(r.stdout.includes(`WOULD-REMOVE path=${leaked} class=mkdtemp:pmh-e2e-`), r.stdout);
    assert.match(r.summary, /mode=dry-run .*matched=1 removed=0/);
  });

  test("a dir whose subtree was touched inside the window is spared, however old the dir is", () => {
    const root = fixtureRoot();
    const dir = makeDir(root, "refl-dep-Ab12Cd", ["old", "nested/live.log"]);
    // A live writer touched one nested file just now; the dir's own mtime stays old.
    const now = new Date();
    utimesSync(join(dir, "nested/live.log"), now, now);

    const r = run(root, "--apply", "--max-age", "720");

    assert.equal(existsSync(dir), true);
    assert.match(r.summary, /matched=0 removed=0 failed=0 spared=1/);
  });

  test("a dir younger than --max-age is not even considered", () => {
    const root = fixtureRoot();
    const young = makeDir(root, "glm-recover-Ab12Cd", ["f"], 30);

    const r = run(root, "--apply", "--max-age", "60");

    assert.equal(existsSync(young), true);
    // Filtered out by the enumeration itself, so it is not even counted as spared.
    assert.match(r.summary, /matched=0 removed=0 failed=0 spared=0/);
  });

  test("names outside the temp-dir shapes, deny-listed runtime dirs, and non-ssr nanoid dirs are spared", () => {
    const root = fixtureRoot();
    const spared = [
      makeDir(root, "dashboard-build"), // no 6-char mkdtemp suffix
      // Ordinary words that happen to end in `-` plus 6 letters: an mkdtemp suffix
      // is random, so it must carry a digit or an uppercase letter (#5328 QA).
      makeDir(root, "build-output"),
      makeDir(root, "my-backup"),
      makeDir(root, "hydra-deploy"),
      makeDir(root, "old-config"),
      // A suffix must MIX letters and digits and must not lead with a year:
      // dates, numbers, capitalised words and year-led labels are names (#5328 QA r2).
      makeDir(root, "backup-202610"),
      makeDir(root, "logs-202611"),
      makeDir(root, "export-123456"),
      makeDir(root, "report-2026Q4"),
      makeDir(root, "old-Backup"),
      makeDir(root, "notes-ABCDEF"),
      // Version / hash-style names (#5329 operator ruling): no uppercase, or all-hex.
      makeDir(root, "images-v2beta"),
      makeDir(root, "debian-12slim"),
      makeDir(root, "checkout-3fa9c1"),
      makeDir(root, "checkout-3Fa9C1"), // mixed-case hex still a hash
      makeDir(root, "tmp.AbCdEfGhIj"), // mktemp(1) default: 10-char suffix
      makeDir(root, "claude-1000Ab12Cd"), // deny-listed runtime prefix
      makeDir(root, "tsx-1000-Ab12Cd"),
      makeDir(root, "com.google.Chrome.Ab12Cd"),
      makeDir(root, "node-compile-cache"),
      makeDir(root, "qzFskhPEL4yh9SrdKnFA3", ["sync-skills-plan.w2KoyJ"]), // nanoid, not ssr-only
      makeDir(root, "zBg5wlZRiCDPgWQ5FdNcd", ["ssr/a", "other"]), // ssr plus something else
    ];

    const r = run(root, "--apply");

    for (const dir of spared) assert.equal(existsSync(dir), true, `${dir} must survive`);
    assert.match(r.summary, /matched=0 removed=0 failed=0 spared=22 enum=ok/);
    assert.equal(r.status, 0);
  });

  test("a symlink with a leaked name is never followed or removed, and its target survives", () => {
    const root = fixtureRoot();
    // The target lives OUTSIDE the scanned root but is itself reapable (leaked
    // shape, stale subtree), so following the link would delete it.
    const target = makeDir(fixtureRoot(), "pmh-e2e-Xy12Zw");
    const link = join(root, "csb-outcomes-route-Ab12Cd");
    symlinkSync(target, link);
    // Back-date the link itself too, so only "never follow symlinks" protects it.
    const stamp = new Date(Date.now() - 2000 * 60_000);
    lutimesSync(link, stamp, stamp);

    const r = run(root, "--apply");

    assert.equal(existsSync(link), true);
    assert.equal(existsSync(join(target, "f")), true);
    assert.match(r.summary, /matched=0 removed=0/);
  });

  test("a dir whose quiet check cannot be completed (find fails) is spared, and the error is surfaced", (t) => {
    if (process.getuid?.() === 0) {
      t.skip("root reads mode-000 dirs, so find cannot fail this way");
      return;
    }
    const root = fixtureRoot();
    const dir = makeDir(root, "refl-dep-Qw34Er", ["f", "locked/inner"]);
    const locked = join(dir, "locked");
    chmodSync(locked, 0o000);
    const stamp = new Date(Date.now() - 2000 * 60_000);
    utimesSync(dir, stamp, stamp);
    try {
      const r = run(root, "--apply");

      assert.equal(existsSync(join(dir, "f")), true, "an unexaminable subtree must fail closed");
      assert.match(r.summary, /matched=0 removed=0/);
      assert.match(r.stderr, /Permission denied/, "find's error must not be discarded");
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  test("removal is bounded to the filesystem the quiet check examined (rm --one-file-system)", () => {
    const root = fixtureRoot();
    const leaked = makeDir(root, "pace-nudge-Zx98Cv");
    // Stub `rm` on PATH that refuses any call without --one-file-system and
    // otherwise delegates to the real rm.
    const bin = fixtureRoot();
    const realRm = spawnSync("bash", ["-c", "command -v rm"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(
      join(bin, "rm"),
      `#!/usr/bin/env bash\ncase " $* " in *" --one-file-system "*) exec '${realRm}' "$@" ;; esac\nexit 1\n`,
    );
    chmodSync(join(bin, "rm"), 0o755);

    const r = runWithEnv(root, { PATH: `${bin}:${process.env.PATH ?? ""}` }, "--apply");

    assert.equal(existsSync(leaked), false, "rm must be called with --one-file-system");
    assert.match(r.summary, /removed=1 failed=0/);
  });

  test("a failed removal is logged with rm's error and still exits 0", () => {
    const root = fixtureRoot();
    const leaked = makeDir(root, "pace-nudge-Fa11Ed");
    const bin = fixtureRoot();
    writeFileSync(join(bin, "rm"), "#!/usr/bin/env bash\necho \"rm: cannot remove: Device or resource busy\" >&2\nexit 1\n");
    chmodSync(join(bin, "rm"), 0o755);

    const r = runWithEnv(root, { PATH: `${bin}:${process.env.PATH ?? ""}` }, "--apply");

    assert.equal(r.status, 0);
    assert.equal(existsSync(leaked), true);
    assert.ok(
      r.stdout.includes(`FAILED path=${leaked} class=mkdtemp:pace-nudge- error=rm: cannot remove: Device or resource busy`),
      r.stdout,
    );
    assert.match(r.summary, /matched=1 removed=0 failed=1/);
  });

  test("an enumeration failure of the root is surfaced in SUMMARY with a non-zero exit", (t) => {
    if (process.getuid?.() === 0) {
      t.skip("root lists mode-300 dirs, so find cannot fail this way");
      return;
    }
    const root = fixtureRoot();
    makeDir(root, "pace-nudge-En0m8r");
    // Searchable but not readable: find cannot list the root's entries.
    chmodSync(root, 0o300);
    try {
      const r = run(root, "--apply");

      assert.equal(r.status, 1);
      assert.match(r.summary, /matched=0 removed=0 failed=0 spared=0 enum=failed/);
      assert.match(r.stderr, /Permission denied/, "find's error must not be discarded");
      assert.match(r.stderr, /enumeration of .* failed/);
    } finally {
      chmodSync(root, 0o755);
    }
  });

  test("--help prints the whole header", () => {
    const r = run(fixtureRoot(), "--help");

    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage: reap-stale-tmp\.sh/);
    assert.match(r.stdout, /journalctl --user -u hydra-tmp-reaper/);
    assert.doesNotMatch(r.stdout, /set -uo pipefail/);
  });

  test("--max-age below 60 minutes is refused", () => {
    const root = fixtureRoot();
    const leaked = makeDir(root, "pace-nudge-Ab12Cd");

    const r = run(root, "--apply", "--max-age", "5");

    assert.equal(r.status, 2);
    assert.equal(existsSync(leaked), true);
  });
});

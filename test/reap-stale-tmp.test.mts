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
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
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

function run(root: string, ...args: string[]): { status: number | null; stdout: string; summary: string } {
  const res = spawnSync("bash", [SCRIPT_PATH, ...args], {
    env: { ...process.env, HYDRA_TMP_REAP_ROOT: root },
    encoding: "utf8",
  });
  const summary = res.stdout.split("\n").find((l) => l.startsWith("SUMMARY")) ?? "";
  return { status: res.status, stdout: res.stdout, summary };
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
    assert.match(r.stdout, new RegExp(`WOULD-REMOVE path=${leaked} class=mkdtemp:pmh-e2e-`));
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

    run(root, "--apply", "--max-age", "60");

    assert.equal(existsSync(young), true);
  });

  test("names outside the temp-dir shapes, deny-listed runtime dirs, and non-ssr nanoid dirs are spared", () => {
    const root = fixtureRoot();
    const spared = [
      makeDir(root, "dashboard-build"), // no 6-char mkdtemp suffix
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
    assert.match(r.summary, /matched=0 removed=0/);
  });

  test("a symlink with a leaked name is never followed or removed, and its target survives", () => {
    const root = fixtureRoot();
    const target = makeDir(root, "real-data");
    const link = join(root, "csb-outcomes-route-Ab12Cd");
    symlinkSync(target, link);

    run(root, "--apply");

    assert.equal(existsSync(link), true);
    assert.equal(existsSync(join(target, "f")), true);
  });

  test("--max-age below 60 minutes is refused", () => {
    const root = fixtureRoot();
    const leaked = makeDir(root, "pace-nudge-Ab12Cd");

    const r = run(root, "--apply", "--max-age", "5");

    assert.equal(r.status, 2);
    assert.equal(existsSync(leaked), true);
  });
});

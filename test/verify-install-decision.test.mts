/**
 * Unit tests for the Step-6 worktree-install decision leaf (issue #4526,
 * design-concept INV-3/INV-6): when does a Target worktree need a LOCAL
 * `npm ci`, decided from RESULTS rather than a pre-probe.
 *
 * Why a leaf at all: Node's ancestor-walk resolves bare imports from a nested
 * worktree fine, but a bundler may pin its resolution root to the project
 * directory (CSB's Next.js/Turbopack `next build` inside `web/.worktrees/<id>`
 * cannot see the serving tree's node_modules). A `require.resolve` probe
 * passes while the build fails, so the build's own exit code + output is the
 * only generic ground truth. The decision is therefore a pure, stdlib-only
 * function the playbook calls via the mirrored CLI wrapper — never a grep
 * hand-rolled in playbook bash.
 *
 * The #4175 incident class is encoded as the FIRST rule: if the worktree-local
 * node_modules path is a SYMLINK, the answer is 'abort' — never 'install' —
 * no matter what the build said, because `npm ci` through a symlink reaches
 * back into the serving tree and wipes it.
 *
 * Fixture table (design-concept INV-6):
 *   (a) exit!=0 + module-resolution signature + no local node_modules
 *                                                       => install-then-retry
 *   (b) same, but a local node_modules already present   => fail
 *   (c) exit!=0 without the signature                   => fail
 *   (d) exit 0                                           => proceed
 *   (e) node_modules is a symlink                        => abort
 *   (f) lockfileChanged                                  => install-then-retry
 *   (g) pre-build call, lockfile unchanged               => proceed
 *
 * Issue #4533 tightens what "local node_modules already present" MEANS: a
 * tool-cache-only directory (`.vite`, `.cache/jiti` — exactly what the
 * ladder's earlier test/typecheck rungs leave behind) must NOT read as a
 * real install, and `MODULE_RESOLUTION_SIGNATURE` gains Next 16 Turbopack's
 * "Could not find the Next.js package" phrasing. See the `probeNodeModules`
 * describe block below for the fixture-level coverage of that probe.
 *
 * Test-authoring rules (CLAUDE.md): NEW top-level describes with their own
 * lifecycle; `beforeEach` for per-case state; pure fs, no Redis/scheduler.
 *
 * Single-file run:
 *   node --experimental-strip-types --test --test-force-exit \
 *     test/verify-install-decision.test.mts
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  decideLocalInstall,
  probeNodeModules,
  INSTALL_MARKERS,
  MODULE_RESOLUTION_SIGNATURE,
} from "../scripts/target/verify-install-decision.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const LEAF_CLI = join(REPO_ROOT, "scripts", "target", "verify-install-decision.ts");

/** A realistic module-resolution failure (matches every signature variant). */
const MODULE_NOT_FOUND_OUTPUT = [
  "⚠ Compiled with problems:",
  "error: Module not found: Can't resolve 'react'",
  '  > 1 | import React from "react"',
  "",
].join("\n");

function baseInput() {
  return {
    lockfileChanged: false,
    localNodeModulesPresent: false,
    localNodeModulesIsSymlink: false,
    buildExitCode: null as number | null,
    buildOutput: "",
  };
}

describe("decideLocalInstall (pure decision leaf, issue #4526)", () => {
  test("(a) red build + resolution signature + no local node_modules => install-then-retry", () => {
    const d = decideLocalInstall({
      ...baseInput(),
      buildExitCode: 1,
      buildOutput: MODULE_NOT_FOUND_OUTPUT,
    });
    assert.equal(d.action, "install-then-retry");
    assert.ok(d.reason.length > 0, "every decision carries a reason");
  });

  test("(b) red build + signature but local node_modules ALREADY present => fail", () => {
    // An install would not help — the resolver already has a local root, so
    // the failure is real. This is also what bounds the retry: after ONE
    // result-driven install the leaf can never return install-then-retry
    // again (INV-4).
    const d = decideLocalInstall({
      ...baseInput(),
      localNodeModulesPresent: true,
      buildExitCode: 1,
      buildOutput: MODULE_NOT_FOUND_OUTPUT,
    });
    assert.equal(d.action, "fail");
  });

  test("(c) red build WITHOUT the signature => fail", () => {
    const d = decideLocalInstall({
      ...baseInput(),
      buildExitCode: 1,
      buildOutput: "SyntaxError: Unexpected token 'export' (at src/foo.ts:3:1)",
    });
    assert.equal(d.action, "fail");
  });

  test("(d) green build => proceed", () => {
    const d = decideLocalInstall({ ...baseInput(), buildExitCode: 0, buildOutput: "" });
    assert.equal(d.action, "proceed");
  });

  test("(e) node_modules is a SYMLINK => abort, never install (the #4175 class)", () => {
    // The symlink abort outranks EVERYTHING — including the lockfile trigger
    // and a screaming module-not-found build — because an install through a
    // symlink writes through it into the serving tree.
    for (const extra of [
      {},
      { lockfileChanged: true },
      { buildExitCode: 1, buildOutput: MODULE_NOT_FOUND_OUTPUT },
      { lockfileChanged: true, buildExitCode: 1, buildOutput: MODULE_NOT_FOUND_OUTPUT },
    ]) {
      const d = decideLocalInstall({
        ...baseInput(),
        localNodeModulesIsSymlink: true,
        ...extra,
      });
      assert.equal(d.action, "abort", `symlink must abort even with ${JSON.stringify(extra)}`);
    }
  });

  test("(f) lockfileChanged => install-then-retry BEFORE the build (the #4177 trigger, kept)", () => {
    const d = decideLocalInstall({ ...baseInput(), lockfileChanged: true });
    assert.equal(d.action, "install-then-retry");
    // ...and regardless of an already-red build's output:
    const d2 = decideLocalInstall({
      ...baseInput(),
      lockfileChanged: true,
      buildExitCode: 1,
      buildOutput: "some unrelated failure",
    });
    assert.equal(d2.action, "install-then-retry");
  });

  test("(g) pre-build call with unchanged lockfile => proceed (defer to the build result)", () => {
    const d = decideLocalInstall(baseInput());
    assert.equal(d.action, "proceed");
  });

  test("every resolver/bundler phrasing of the signature matches", () => {
    for (const line of [
      "Module not found: Can't resolve 'react'",
      "Error: Cannot find module 'next'",
      "node:internal/modules/cjs/loader:1146 throw err; ERR_MODULE_NOT_FOUND",
      "Can't resolve './lib/foo'",
      // Next 16's Turbopack binary (issue #4533) — verified verbatim against
      // next@16.3.5's native @next/swc-linux-x64-gnu output.
      "Could not find the Next.js package (next/package.json)",
    ]) {
      assert.match(
        line,
        MODULE_RESOLUTION_SIGNATURE,
        `signature must match: ${line}`,
      );
      const d = decideLocalInstall({
        ...baseInput(),
        buildExitCode: 1,
        buildOutput: line,
      });
      assert.equal(d.action, "install-then-retry", `signature variant must trigger: ${line}`);
    }
    // Case-insensitivity (webpack/Next print "Module not found"; vite prints
    // "Failed to resolve" — intentionally NOT in the signature, it also fires
    // on plain bad relative imports).
    assert.doesNotMatch("failed to resolve import", MODULE_RESOLUTION_SIGNATURE);
  });

  test("a green build with a changed lockfile still installs first (INV-4 ordering)", () => {
    // The lockfile-diff trigger is pre-typecheck: the leaf cannot know the
    // build result yet, and a changed lockfile means the ancestor node_modules
    // no longer matches the declared dependency set.
    const d = decideLocalInstall({
      ...baseInput(),
      lockfileChanged: true,
      buildExitCode: 0,
      buildOutput: "",
    });
    assert.equal(d.action, "install-then-retry");
  });
});

describe("verify-install-decision.ts CLI wrapper (issue #4526)", () => {
  let work: string;
  let appDir: string;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "vid-"));
    appDir = join(work, "web");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, "package.json"), '{"name":"fixture"}');
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  function runCli(args: string[]) {
    return spawnSync("node", [LEAF_CLI, ...args], { encoding: "utf-8" });
  }

  test("probes node_modules presence + symlink from --app-dir", () => {
    // No local node_modules + failing build + signature log => install-then-retry.
    const log = join(work, "build.log");
    writeFileSync(log, MODULE_NOT_FOUND_OUTPUT);
    const r = runCli(["--app-dir", appDir, "--build-exit", "1", "--build-log", log]);
    assert.equal(r.status, 0, `CLI failed: ${r.stderr}`);
    assert.equal(JSON.parse(r.stdout).action, "install-then-retry");

    // An EMPTY worktree-local node_modules is not a real install (issue #4533,
    // INV-1/INV-8) — the same failure still => install-then-retry.
    mkdirSync(join(appDir, "node_modules"));
    const rEmpty = runCli(["--app-dir", appDir, "--build-exit", "1", "--build-log", log]);
    assert.equal(rEmpty.status, 0, `CLI failed: ${rEmpty.stderr}`);
    assert.equal(JSON.parse(rEmpty.stdout).action, "install-then-retry");

    // Once a REAL package lands in node_modules, the same failure => fail.
    mkdirSync(join(appDir, "node_modules", "react"));
    const r2 = runCli(["--app-dir", appDir, "--build-exit", "1", "--build-log", log]);
    assert.equal(r2.status, 0, `CLI failed: ${r2.stderr}`);
    assert.equal(JSON.parse(r2.stdout).action, "fail");

    // With node_modules as a SYMLINK => abort (never install).
    rmSync(join(appDir, "node_modules"), { recursive: true, force: true });
    const elsewhere = join(work, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(appDir, "node_modules"), "dir");
    const r3 = runCli(["--app-dir", appDir, "--build-exit", "1", "--build-log", log]);
    assert.equal(r3.status, 0, `CLI failed: ${r3.stderr}`);
    assert.equal(JSON.parse(r3.stdout).action, "abort");
  });

  test("(INV-2) cache-only node_modules (.vite, .cache/jiti) driven through the CLI => install-then-retry; same fixture + a real package => fail", () => {
    // The literal fixture INV-2 names: a worktree-local node_modules holding
    // ONLY tool-cache entries left behind by the ladder's earlier
    // test/typecheck rungs (issue #4533) — driven end-to-end through the CLI
    // (never the raw probeNodeModules return value) to the actual decision.
    // (PR body's Design-concept reconciliation INV-2 line now cites this test by name.)
    const log = join(work, "build.log");
    writeFileSync(log, MODULE_NOT_FOUND_OUTPUT);

    mkdirSync(join(appDir, "node_modules", ".vite"), { recursive: true });
    mkdirSync(join(appDir, "node_modules", ".cache", "jiti"), { recursive: true });
    const rCacheOnly = runCli(["--app-dir", appDir, "--build-exit", "1", "--build-log", log]);
    assert.equal(rCacheOnly.status, 0, `CLI failed: ${rCacheOnly.stderr}`);
    assert.equal(
      JSON.parse(rCacheOnly.stdout).action,
      "install-then-retry",
      "a cache-only node_modules must not read as a real install",
    );

    // The SAME fixture, now with a real package dir added alongside the
    // cache entries => a genuine install exists => fail.
    mkdirSync(join(appDir, "node_modules", "react"), { recursive: true });
    const rReal = runCli(["--app-dir", appDir, "--build-exit", "1", "--build-log", log]);
    assert.equal(rReal.status, 0, `CLI failed: ${rReal.stderr}`);
    assert.equal(JSON.parse(rReal.stdout).action, "fail");
  });

  test("--lockfile-changed true wins pre-build; --build-exit none defers", () => {
    const r = runCli(["--app-dir", appDir, "--lockfile-changed", "true", "--build-exit", "none"]);
    assert.equal(r.status, 0, `CLI failed: ${r.stderr}`);
    assert.equal(JSON.parse(r.stdout).action, "install-then-retry");

    const r2 = runCli(["--app-dir", appDir, "--lockfile-changed", "false", "--build-exit", "none"]);
    assert.equal(r2.status, 0, `CLI failed: ${r2.stderr}`);
    assert.equal(JSON.parse(r2.stdout).action, "proceed");
  });

  test("stdout is a single JSON line carrying {action, reason}", () => {
    const r = runCli(["--app-dir", appDir, "--build-exit", "0"]);
    assert.equal(r.status, 0, `CLI failed: ${r.stderr}`);
    const lines = r.stdout.trim().split("\n");
    assert.equal(lines.length, 1, "exactly one stdout line");
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.action, "proceed");
    assert.equal(typeof parsed.reason, "string");
    assert.ok(parsed.reason.length > 0);
  });

  test("usage errors exit 2 (missing --app-dir, bad --build-exit)", () => {
    const noDir = runCli(["--build-exit", "0"]);
    assert.equal(noDir.status, 2, "missing --app-dir must exit 2");
    const badExit = runCli(["--app-dir", appDir, "--build-exit", "zero"]);
    assert.equal(badExit.status, 2, "non-numeric --build-exit must exit 2");
    const badFlag = runCli(["--app-dir", appDir, "--nonsense"]);
    assert.equal(badFlag.status, 2, "unknown flag must exit 2");
  });

  test("a missing --build-log file is a loud usage error, not a silent empty output", () => {
    const r = runCli([
      "--app-dir", appDir,
      "--build-exit", "1",
      "--build-log", join(work, "does-not-exist.log"),
    ]);
    assert.equal(r.status, 2, "missing build log must exit 2 rather than decide on ''");
    assert.match(r.stderr, /build-log/i);
  });
});

describe("probeNodeModules (issue #4533 — 'present' means a REAL install, never bare directory existence)", () => {
  let work: string;
  let appDir: string;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "vid-probe-"));
    appDir = join(work, "web");
    mkdirSync(appDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  test("absent node_modules => present=false, isSymlink=false", () => {
    const probe = probeNodeModules(appDir);
    assert.deepEqual(probe, { present: false, isSymlink: false });
  });

  test("empty node_modules dir => present=false (no real install)", () => {
    mkdirSync(join(appDir, "node_modules"));
    const probe = probeNodeModules(appDir);
    assert.deepEqual(probe, { present: false, isSymlink: false });
  });

  test("cache-only node_modules (.vite, .cache/jiti) => present=false", () => {
    mkdirSync(join(appDir, "node_modules", ".vite"), { recursive: true });
    mkdirSync(join(appDir, "node_modules", ".cache", "jiti"), { recursive: true });
    mkdirSync(join(appDir, "node_modules", ".vite-temp"), { recursive: true });
    const probe = probeNodeModules(appDir);
    assert.deepEqual(probe, { present: false, isSymlink: false });
  });

  test("marker-only node_modules (e.g. .package-lock.json) => present=true", () => {
    for (const marker of INSTALL_MARKERS) {
      const nm = join(appDir, "node_modules");
      rmSync(nm, { recursive: true, force: true });
      mkdirSync(nm);
      writeFileSync(join(nm, marker), "");
      const probe = probeNodeModules(appDir);
      assert.equal(probe.present, true, `marker ${marker} must count as a real install`);
      assert.equal(probe.isSymlink, false);
    }
  });

  test("real-package node_modules => present=true", () => {
    mkdirSync(join(appDir, "node_modules", "react"), { recursive: true });
    const probe = probeNodeModules(appDir);
    assert.deepEqual(probe, { present: true, isSymlink: false });
  });

  test("@scope-only node_modules => present=true (a scoped package is a real install)", () => {
    mkdirSync(join(appDir, "node_modules", "@scope", "pkg"), { recursive: true });
    const probe = probeNodeModules(appDir);
    assert.deepEqual(probe, { present: true, isSymlink: false });
  });

  test("node_modules as a SYMLINK => present=true, isSymlink=true, without reading through it", () => {
    const elsewhere = join(work, "elsewhere");
    // Populate the link target with a cache-only shape; if the probe ever
    // read through the link it would (wrongly) report present=false.
    mkdirSync(join(elsewhere, ".vite"), { recursive: true });
    symlinkSync(elsewhere, join(appDir, "node_modules"), "dir");
    const probe = probeNodeModules(appDir);
    assert.deepEqual(probe, { present: true, isSymlink: true });
  });

  test("a DANGLING symlink at node_modules => present=true, isSymlink=true", () => {
    symlinkSync(join(work, "does-not-exist"), join(appDir, "node_modules"), "dir");
    const probe = probeNodeModules(appDir);
    assert.deepEqual(probe, { present: true, isSymlink: true });
  });

  test("a plain FILE at node_modules (not a directory, not a symlink) => present=true, isSymlink=false", () => {
    writeFileSync(join(appDir, "node_modules"), "not a directory");
    const probe = probeNodeModules(appDir);
    assert.deepEqual(probe, { present: true, isSymlink: false });
  });

  test("never throws for any fixture shape", () => {
    // Re-assert the "never throws" contract (INV-7) across every shape above
    // in one place, independent of the individual assertions.
    const shapes: Array<() => void> = [
      () => {},
      () => mkdirSync(join(appDir, "node_modules")),
      () => mkdirSync(join(appDir, "node_modules", ".cache"), { recursive: true }),
      () => writeFileSync(join(appDir, "node_modules"), "x"),
      () => symlinkSync(join(work, "nope"), join(appDir, "node_modules"), "dir"),
    ];
    for (const setup of shapes) {
      rmSync(join(appDir, "node_modules"), { recursive: true, force: true });
      setup();
      assert.doesNotThrow(() => probeNodeModules(appDir));
    }
  });
});

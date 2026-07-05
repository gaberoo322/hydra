/**
 * test/build-spritesheet.test.mts — golden test for the dashboard
 * sprite-sheet generator at dashboard/scripts/build-spritesheet.js.
 *
 * The script is deterministic: same input dir → same output PNG bytes +
 * same manifest JSON. We invoke it via child_process and compare
 * byte-for-byte against checked-in fixtures.
 *
 * Fixtures (test/fixtures/):
 *   - sprite-input/01-red.png   — 4x4 solid red RGBA
 *   - sprite-input/02-blue.png  — 4x4 solid blue RGBA
 *   - sprite-golden.png         — expected 8x4 horizontal-strip output
 *   - sprite-golden.json        — expected manifest
 *
 * Slice 1 of the /now-pixel epic (#642, child #643). The whole point of
 * the golden is that the generator's output stays stable across CI runs
 * and Node patch versions — without this, every dependency bump silently
 * resnaps the sprite-sheet binary diff.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const script = path.join(repoRoot, "dashboard/scripts/build-spritesheet.js");
const fixtures = path.join(repoRoot, "test/fixtures");

/**
 * The generator imports `pngjs`, a `dashboard/`-scoped runtime dependency
 * (declared in dashboard/package.json, installed into dashboard/node_modules).
 * CI runs `npm ci` in dashboard/, so the module resolves and this whole test
 * runs at full strength — including the byte-for-byte golden assertion below.
 *
 * A git worktree, however, does not carry dashboard/node_modules (the
 * .claude/worktrees/* layout relies on Node's upward directory walk to the
 * MAIN tree's root node_modules, which does NOT contain the dashboard-scoped
 * pngjs). So `node dashboard/scripts/build-spritesheet.js` there dies with
 * ERR_MODULE_NOT_FOUND before it emits a single byte — a pure module-resolution
 * failure, not encoder byte-drift. That misdiagnosed "golden-byte drift" flake
 * false-failed this suite in worktrees 3× (issue #2881) while CI stayed green.
 *
 * Guard the environment precondition instead of weakening the assertion: if the
 * generator's own pngjs dependency is not resolvable from the script's location,
 * the generator cannot run here at all, so skip cleanly with a clear reason. The
 * golden bytes are genuinely stable (pngjs is deterministic across environments,
 * verified: the same fixtures produce byte-equal output wherever pngjs resolves),
 * so we keep the strict byte comparison as coverage where it can actually run.
 */
function spritesheetDepsResolvable(): boolean {
  try {
    // Resolve exactly as the script would: relative to its own location, so we
    // exercise the same dashboard/node_modules → root node_modules walk Node
    // uses when the generator runs.
    createRequire(script).resolve("pngjs");
    return true;
  } catch {
    return false;
  }
}

const depsResolvable = spritesheetDepsResolvable();
const skipReason = depsResolvable
  ? false
  : "generator dependency 'pngjs' not resolvable from " +
    "dashboard/scripts/ (dashboard/node_modules absent — e.g. a git worktree " +
    "without a dashboard install); generator cannot run, so skipping. This is a " +
    "worktree-environment gap, NOT byte-drift — CI installs dashboard deps and " +
    "runs this test at full strength (issue #2881).";

function runScript(inDir: string, outPng: string, outManifest: string): void {
  execFileSync(
    process.execPath,
    [script, "--in", inDir, "--out", outPng, "--manifest", outManifest],
    { stdio: "pipe" },
  );
}

test("build-spritesheet: two-frame horizontal strip matches golden bytes", { skip: skipReason }, () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "spritesheet-"));
  try {
    const outPng = path.join(tmp, "out.png");
    const outJson = path.join(tmp, "out.json");
    runScript(path.join(fixtures, "sprite-input"), outPng, outJson);

    const actualPng = readFileSync(outPng);
    const goldenPng = readFileSync(path.join(fixtures, "sprite-golden.png"));
    assert.ok(
      actualPng.equals(goldenPng),
      `spritesheet PNG drifted from golden (actual ${actualPng.length}B vs golden ${goldenPng.length}B)`,
    );

    const actualManifest = readFileSync(outJson, "utf8");
    const goldenManifest = readFileSync(
      path.join(fixtures, "sprite-golden.json"),
      "utf8",
    );
    assert.equal(actualManifest, goldenManifest);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("build-spritesheet: trivial single-frame case produces a 1-frame strip", { skip: skipReason }, () => {
  // Acceptance criterion #4: "handles the trivial single-frame case (produces
  // a 1-frame strip)." Use a fresh tmpdir with one PNG to keep the test self-
  // contained. We parse the manifest and check shape; the script's
  // determinism is already covered by the golden test above.
  const tmp = mkdtempSync(path.join(tmpdir(), "spritesheet-solo-"));
  try {
    const inDir = path.join(tmp, "in");
    mkdirSync(inDir);
    copyFileSync(
      path.join(fixtures, "sprite-input/01-red.png"),
      path.join(inDir, "solo.png"),
    );

    const outPng = path.join(tmp, "out.png");
    const outJson = path.join(tmp, "out.json");
    runScript(inDir, outPng, outJson);

    const manifest = JSON.parse(readFileSync(outJson, "utf8"));
    assert.equal(manifest.frameCount, 1);
    assert.equal(manifest.frames.length, 1);
    assert.equal(manifest.frames[0].name, "solo.png");
    assert.equal(manifest.frames[0].x, 0);
    assert.equal(manifest.width, manifest.frames[0].w);
    assert.equal(manifest.height, manifest.frames[0].h);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

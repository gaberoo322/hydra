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
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const script = path.join(repoRoot, "dashboard/scripts/build-spritesheet.js");
const fixtures = path.join(repoRoot, "test/fixtures");

function runScript(inDir: string, outPng: string, outManifest: string): void {
  execFileSync(
    process.execPath,
    [script, "--in", inDir, "--out", outPng, "--manifest", outManifest],
    { stdio: "pipe" },
  );
}

test("build-spritesheet: two-frame horizontal strip matches golden bytes", () => {
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

test("build-spritesheet: trivial single-frame case produces a 1-frame strip", () => {
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

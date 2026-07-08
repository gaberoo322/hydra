/**
 * Unit tests for the Target Manifest leaf loader (epic #3014, ADR-0026,
 * issue #3015).
 *
 * `loadManifest(rootDir)` reads `<rootDir>/.hydra/manifest.json`, `JSON.parse`s
 * it, and validates it against `TargetManifestSchema`, returning
 * `{ ok: true, manifest } | { ok: false, errors }` on EVERY path and never
 * throwing.
 *
 * The six-fixture matrix (design-concept fa402239):
 *   (1) valid full manifest                                    => { ok: true }
 *   (2) missing file (ENOENT, fail-CLOSED — the outcomes.ts    => { ok: false }
 *       inversion)
 *   (3) malformed JSON                                         => { ok: false }
 *   (4) schema-invalid (mutationKillFloor as a string)         => { ok: false }
 *   (5) empty surface WITHOUT acknowledgedNoRiskSurface        => { ok: false }
 *   (6) empty surface WITH acknowledgedNoRiskSurface:true      => { ok: true }
 *
 * Test-authoring rules (CLAUDE.md): a NEW top-level `describe` with its own
 * lifecycle; per-case temp-dir isolation via `beforeEach`/`afterEach` so no case
 * leaks fixture state into a sibling. No Redis, no scheduler — pure fs. This file
 * touches no shared-connection teardown.
 *
 * Single-file run:
 *   node --experimental-strip-types --test --test-force-exit \
 *     test/target-manifest.test.mts
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManifest } from "../src/target/manifest.ts";

/** A valid manifest object reused (and mutated per case) across fixtures. */
function validManifest() {
  return {
    version: 1,
    verify: {
      install: "npm ci",
      test: "npm test",
      typecheck: "npm run typecheck",
      build: "npm run build",
      appSubdir: "web",
    },
    riskCritical: {
      surface: ["src/betting/execution.ts"],
      mutationKillFloor: 0.6,
      acknowledgedNoRiskSurface: false,
    },
  };
}

describe("loadManifest (Target Manifest leaf loader, #3015)", () => {
  let rootDir: string;

  beforeEach(() => {
    // Fresh temp dir per case so fixtures never leak across sibling tests.
    rootDir = mkdtempSync(join(tmpdir(), "target-manifest-test-"));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  /** Write `<rootDir>/.hydra/manifest.json` with the given raw string. */
  function writeManifest(raw: string): void {
    const dir = join(rootDir, ".hydra");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), raw, "utf-8");
  }

  test("(1) valid full manifest => { ok: true, manifest }", () => {
    writeManifest(JSON.stringify(validManifest()));
    const result = loadManifest(rootDir);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.manifest.version, 1);
      assert.equal(result.manifest.verify.appSubdir, "web");
      assert.deepEqual(result.manifest.riskCritical.surface, ["src/betting/execution.ts"]);
    }
  });

  test("(2) missing file => { ok: false, errors } (fail-CLOSED, the outcomes.ts inversion)", () => {
    // No manifest written — ENOENT must fail closed, NOT return an empty-ok.
    const result = loadManifest(rootDir);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.length > 0);
      assert.ok(
        result.errors.every((e) => e.startsWith("[target-manifest]")),
        "errors are [target-manifest]-prefixed",
      );
      assert.ok(
        result.errors.some((e) => e.includes("not found")),
        "the missing-file error mentions the file was not found",
      );
    }
  });

  test("(3) malformed JSON => { ok: false, errors }", () => {
    writeManifest("{ this is not valid json ]");
    const result = loadManifest(rootDir);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.length > 0);
      assert.ok(
        result.errors.some((e) => e.includes("invalid JSON")),
        "the malformed-JSON error mentions invalid JSON",
      );
    }
  });

  test("(4) schema-invalid (mutationKillFloor as a string) => { ok: false, errors }", () => {
    const bad = validManifest();
    // @ts-expect-error deliberately wrong type to exercise schema validation
    bad.riskCritical.mutationKillFloor = "not-a-number";
    writeManifest(JSON.stringify(bad));
    const result = loadManifest(rootDir);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.length > 0);
      assert.ok(
        result.errors.some((e) => e.includes("mutationKillFloor")),
        "the schema error names the offending field path",
      );
    }
  });

  test("(5) empty surface WITHOUT acknowledgedNoRiskSurface => { ok: false } @ riskCritical.surface", () => {
    const m = validManifest();
    m.riskCritical.surface = [];
    // acknowledgedNoRiskSurface left false → risk gate must not be silently disabled.
    writeManifest(JSON.stringify(m));
    const result = loadManifest(rootDir);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(
        result.errors.some((e) => e.includes("riskCritical.surface")),
        "the cross-field error nests to the riskCritical.surface path",
      );
    }
  });

  test("(6) empty surface WITH acknowledgedNoRiskSurface:true => { ok: true }", () => {
    const m = validManifest();
    m.riskCritical.surface = [];
    m.riskCritical.acknowledgedNoRiskSurface = true;
    writeManifest(JSON.stringify(m));
    const result = loadManifest(rootDir);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.manifest.riskCritical.surface, []);
      assert.equal(result.manifest.riskCritical.acknowledgedNoRiskSurface, true);
    }
  });

  test("never throws on any path (missing, malformed, schema-invalid, valid)", () => {
    // (a) missing
    assert.doesNotThrow(() => loadManifest(rootDir));
    // (b) malformed
    writeManifest("}{");
    assert.doesNotThrow(() => loadManifest(rootDir));
    // (c) schema-invalid (missing required top-level version)
    const noVersion: any = validManifest();
    delete noVersion.version;
    writeManifest(JSON.stringify(noVersion));
    assert.doesNotThrow(() => loadManifest(rootDir));
    // (d) valid
    writeManifest(JSON.stringify(validManifest()));
    assert.doesNotThrow(() => loadManifest(rootDir));
  });

  test("appSubdir may be '' for a repo-root target => { ok: true }", () => {
    const m = validManifest();
    m.verify.appSubdir = "";
    writeManifest(JSON.stringify(m));
    const result = loadManifest(rootDir);
    assert.equal(result.ok, true);
  });

  test("unknown top-level key => { ok: false } (schema is .strict())", () => {
    const m: any = validManifest();
    m.unexpectedKey = "boom";
    writeManifest(JSON.stringify(m));
    const result = loadManifest(rootDir);
    assert.equal(result.ok, false);
  });

  test("float version => { ok: false } (version must be an integer)", () => {
    const m = validManifest();
    m.version = 1.5;
    writeManifest(JSON.stringify(m));
    const result = loadManifest(rootDir);
    assert.equal(result.ok, false);
  });
});

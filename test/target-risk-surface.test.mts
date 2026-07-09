/**
 * Regression tests for the Target risk-surface resolver
 * (epic #3014, ADR-0026, issue #3018).
 *
 * `loadRiskSurface(rootDir)` reads `<rootDir>/.hydra/manifest.json` via the leaf
 * `loadManifest` and returns the manifest's `riskCritical.surface` +
 * `verify.appSubdir` as a discriminated result object. It NEVER throws and fails
 * CLOSED on a missing/malformed manifest — the gate scripts (mutation-check,
 * target-risk-core-check, ...) depend on that fail-closed contract so a config
 * error can never silently disable the keystone risk gate.
 *
 * These tests exercise the resolver against a real temp-dir manifest (the same
 * on-disk shape the synced gate reads in a Target worktree) — hermetic, no real
 * betting checkout.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadRiskSurface,
  resolveManifestRoot,
} from "../scripts/target/target-risk-surface.ts";

/** A well-formed betting-shaped manifest (mirrors hydra-betting's real one). */
function validManifest() {
  return {
    version: 1,
    verify: {
      install: "npm ci --prefer-offline",
      test: "npm run test:raw",
      typecheck: "npm run typecheck",
      build: "npm run build",
      appSubdir: "web",
    },
    riskCritical: {
      surface: [
        "src/lib/providers/",
        "src/lib/execution/",
        "src/lib/staking/",
        "src/lib/bet-math/",
        "src/lib/arbitrage/",
        "src/lib/markets/",
        "src/bin/",
      ],
      mutationKillFloor: 60,
    },
  };
}

describe("loadRiskSurface — manifest-sourced risk surface (issue #3018)", () => {
  let rootDir: string;

  before(() => {
    rootDir = mkdtempSync(join(tmpdir(), "risk-surface-test-"));
  });
  after(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  function writeManifest(obj: unknown): void {
    const dir = join(rootDir, ".hydra");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(obj), "utf-8");
  }

  test("valid manifest → { ok:true, surface, appSubdir } from the manifest", () => {
    writeManifest(validManifest());
    const result = loadRiskSurface(rootDir);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.surface, [
        "src/lib/providers/",
        "src/lib/execution/",
        "src/lib/staking/",
        "src/lib/bet-math/",
        "src/lib/arbitrage/",
        "src/lib/markets/",
        "src/bin/",
      ]);
      assert.equal(result.appSubdir, "web");
    }
  });

  test("missing manifest → { ok:false } (fail-closed, never throws)", () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), "risk-surface-empty-"));
    try {
      const result = loadRiskSurface(emptyRoot);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.errors.length > 0);
        assert.ok(result.errors.some((e) => e.includes("[target-manifest]")));
      }
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  test("malformed JSON → { ok:false } (fail-closed)", () => {
    const dir = join(rootDir, ".hydra");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), "{ not json", "utf-8");
    const result = loadRiskSurface(rootDir);
    assert.equal(result.ok, false);
  });

  test("schema-invalid manifest (empty surface, no ack) → { ok:false }", () => {
    const m = validManifest();
    m.riskCritical.surface = [];
    writeManifest(m);
    const result = loadRiskSurface(rootDir);
    // An empty surface without acknowledgedNoRiskSurface:true fails validation
    // (ADR-0026 decision 7 — the risk gate can never be silently disabled).
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((e) => e.includes("riskCritical.surface")));
    }
  });
});

describe("resolveManifestRoot — env override precedence (issue #3018)", () => {
  const KEY = "TARGET_MANIFEST_ROOT";
  let saved: string | undefined;

  before(() => {
    saved = process.env[KEY];
  });
  after(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  test("TARGET_MANIFEST_ROOT wins when set", () => {
    process.env[KEY] = "/some/worktree/root";
    assert.equal(resolveManifestRoot(), "/some/worktree/root");
  });

  test("an empty TARGET_MANIFEST_ROOT is treated as unset (falls back)", () => {
    process.env[KEY] = "";
    // Falls back to getTargetWorkspace(); we only assert it does NOT return "".
    assert.notEqual(resolveManifestRoot(), "");
  });
});

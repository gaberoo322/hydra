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
import {
  collectTargetFacts,
  renderShell,
  toRepoRelative,
} from "../scripts/target/print-target-facts.ts";
import { fileURLToPath } from "node:url";

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

// ---------------------------------------------------------------------------
// print-target-facts.ts (issue #4411, item (2) of wayfinder ticket #4324 on
// map #4313) — the seam every hydra-target-* / hydra-wire-or-retire playbook
// resolves identity + risk-surface facts through, instead of a hardcoded
// `hydra-betting` literal. New top-level describe with its own lifecycle
// (temp env vars only — no shared Redis to piggyback on).
// ---------------------------------------------------------------------------
describe("print-target-facts — the playbook identity + risk-surface seam (issue #4411)", () => {
  const FIXTURE_ROOT = fileURLToPath(
    new URL("./fixtures/target-manifest-fixture/", import.meta.url),
  ).replace(/\/$/, "");

  const ENV_KEYS = [
    "HYDRA_TARGET_NAME",
    "HYDRA_PROJECT_WORKSPACE",
    "HYDRA_TARGET_GITHUB_REPO",
    "HYDRA_TARGET_WEB_URL",
    "TARGET_MANIFEST_ROOT",
  ] as const;
  let saved: Record<string, string | undefined>;

  before(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  });
  after(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  function setFixtureEnv(): void {
    process.env.HYDRA_TARGET_NAME = "csb";
    process.env.HYDRA_PROJECT_WORKSPACE = FIXTURE_ROOT;
    process.env.HYDRA_TARGET_GITHUB_REPO = "gaberoo322/csb";
    process.env.HYDRA_TARGET_WEB_URL = "http://localhost:4444";
    process.env.TARGET_MANIFEST_ROOT = FIXTURE_ROOT;
  }

  test("toRepoRelative joins appSubdir onto a stripped surface entry; '' is the identity", () => {
    assert.equal(toRepoRelative("web", "src/lib/execution/"), "web/src/lib/execution/");
    assert.equal(toRepoRelative("web/", "src/bin/"), "web/src/bin/");
    assert.equal(toRepoRelative("", "src/lib/execution/"), "src/lib/execution/");
  });

  test("collectTargetFacts resolves identity + manifest surface from the fixture manifest", () => {
    setFixtureEnv();
    const facts = collectTargetFacts(FIXTURE_ROOT);
    assert.equal(facts.name, "csb");
    assert.equal(facts.githubRepo, "gaberoo322/csb");
    assert.equal(facts.workspace, FIXTURE_ROOT);
    assert.equal(facts.serviceName, "csb-web.service");
    assert.equal(facts.webUrl, "http://localhost:4444");
    assert.equal(facts.manifest.ok, true);
    if (facts.manifest.ok) {
      assert.equal(facts.manifest.appSubdir, "web");
      assert.deepEqual(facts.manifest.surface, ["src/lib/execution/", "src/bin/"]);
      assert.deepEqual(facts.manifest.surfaceRepoRelative, [
        "web/src/lib/execution/",
        "web/src/bin/",
      ]);
    }
  });

  test("collectTargetFacts fails closed ({ok:false, errors}) on an unresolvable manifest root", () => {
    setFixtureEnv();
    const facts = collectTargetFacts("/nonexistent/target-manifest-root");
    assert.equal(facts.manifest.ok, false);
    if (!facts.manifest.ok) {
      assert.ok(facts.manifest.errors.length > 0);
    }
  });

  test("renderShell emits every TARGET_* export plus a JSON-encoded risk surface", () => {
    setFixtureEnv();
    const facts = collectTargetFacts(FIXTURE_ROOT);
    const rendered = renderShell(facts);
    assert.ok(rendered, "expected shell output for a resolved manifest");
    assert.match(rendered!, /export TARGET_NAME='csb'/);
    assert.match(rendered!, /export TARGET_GH_REPO='gaberoo322\/csb'/);
    assert.match(rendered!, new RegExp(`export TARGET_WS='${FIXTURE_ROOT.replace(/\//g, "\\/")}'`));
    assert.match(rendered!, /export TARGET_SERVICE='csb-web\.service'/);
    assert.match(rendered!, /export TARGET_WEB_URL='http:\/\/localhost:4444'/);
    assert.match(rendered!, /export TARGET_APP_SUBDIR='web'/);
    assert.match(rendered!, /export TARGET_APP_DIR='.*\/web'/);
    const surfaceLine = rendered!.split("\n").find((l) => l.startsWith("export TARGET_RISK_SURFACE_JSON="));
    assert.ok(surfaceLine, "expected a TARGET_RISK_SURFACE_JSON export line");
    const jsonLiteral = surfaceLine!.slice("export TARGET_RISK_SURFACE_JSON='".length, -1);
    assert.deepEqual(JSON.parse(jsonLiteral), ["web/src/lib/execution/", "web/src/bin/"]);
  });

  test("renderShell returns null (nothing exportable) when the manifest is unresolved — fail closed", () => {
    setFixtureEnv();
    const facts = collectTargetFacts("/nonexistent/target-manifest-root");
    assert.equal(renderShell(facts), null);
  });

  test("shell-quoting is safe against an embedded single quote (POSIX-safe escaping)", () => {
    setFixtureEnv();
    process.env.HYDRA_TARGET_NAME = "csb's-fork";
    const facts = collectTargetFacts(FIXTURE_ROOT);
    const rendered = renderShell(facts);
    assert.ok(rendered);
    // `csb's-fork` must round-trip through a POSIX shell unscathed.
    assert.match(rendered!, /export TARGET_NAME='csb'\\''s-fork'/);
  });
});

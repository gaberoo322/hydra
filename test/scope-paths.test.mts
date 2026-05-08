/**
 * Scope path validation tests (issue #170).
 *
 * Regression: planner sometimes scopes files to `src/lib/...` instead of
 * `web/src/lib/...`, or confuses orchestrator files with target project files.
 * The executor runs in a hydra-betting worktree and can't find the files,
 * wasting an entire cycle.
 *
 * validateScopePaths checks that every file in scopeBoundary.in exists in the
 * target project workspace before the executor runs.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateScopePaths } from "../src/cycle-helpers.ts";

// Create a temp directory simulating a project workspace
function createTempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "scope-paths-test-"));
  // Create some files to simulate a project structure
  mkdirSync(join(dir, "web", "src", "lib"), { recursive: true });
  mkdirSync(join(dir, "web", "src", "app"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "web", "src", "lib", "db.ts"), "// db");
  writeFileSync(join(dir, "web", "src", "lib", "auth.ts"), "// auth");
  writeFileSync(join(dir, "web", "src", "app", "page.tsx"), "// page");
  writeFileSync(join(dir, "src", "index.ts"), "// index");
  writeFileSync(join(dir, "package.json"), "{}");
  return dir;
}

describe("validateScopePaths", () => {
  let workspace: string;

  test("setup", () => {
    workspace = createTempWorkspace();
  });

  test("returns valid for empty scopeIn", () => {
    const result = validateScopePaths([], workspace);
    assert.equal(result.valid, true);
    assert.deepEqual(result.missingFiles, []);
    assert.deepEqual(result.hints, []);
  });

  test("returns valid for undefined scopeIn", () => {
    const result = validateScopePaths(undefined as any, workspace);
    assert.equal(result.valid, true);
  });

  test("returns valid when all files exist", () => {
    const result = validateScopePaths(
      ["web/src/lib/db.ts", "web/src/app/page.tsx", "package.json"],
      workspace,
    );
    assert.equal(result.valid, true);
    assert.deepEqual(result.missingFiles, []);
  });

  test("rejects plans with non-existent file paths", () => {
    const result = validateScopePaths(
      ["src/nonexistent.ts"],
      workspace,
    );
    assert.equal(result.valid, false);
    assert.deepEqual(result.missingFiles, ["src/nonexistent.ts"]);
  });

  test("rejection message names the missing file(s)", () => {
    const result = validateScopePaths(
      ["src/nonexistent.ts", "web/src/missing.tsx"],
      workspace,
    );
    assert.equal(result.valid, false);
    assert.equal(result.missingFiles.length, 2);
    assert.ok(result.missingFiles.includes("src/nonexistent.ts"));
    assert.ok(result.missingFiles.includes("web/src/missing.tsx"));
  });

  test("detects src/ vs web/src/ confusion and provides hint", () => {
    // src/lib/db.ts doesn't exist at that path, but web/src/lib/db.ts does
    const result = validateScopePaths(
      ["src/lib/db.ts"],
      workspace,
    );
    assert.equal(result.valid, false);
    assert.deepEqual(result.missingFiles, ["src/lib/db.ts"]);
    assert.equal(result.hints.length, 1);
    assert.ok(
      result.hints[0].includes("web/src/lib/db.ts"),
      `hint should mention web/src/lib/db.ts, got: ${result.hints[0]}`,
    );
    assert.ok(
      result.hints[0].includes("web/ prefix"),
      `hint should mention web/ prefix confusion, got: ${result.hints[0]}`,
    );
  });

  test("no hint when web/ prefixed path also doesn't exist", () => {
    const result = validateScopePaths(
      ["src/totally-fake.ts"],
      workspace,
    );
    assert.equal(result.valid, false);
    assert.deepEqual(result.missingFiles, ["src/totally-fake.ts"]);
    assert.deepEqual(result.hints, []);
  });

  test("mixed valid and invalid paths — reports only missing ones", () => {
    const result = validateScopePaths(
      ["web/src/lib/db.ts", "src/nonexistent.ts", "package.json"],
      workspace,
    );
    assert.equal(result.valid, false);
    assert.deepEqual(result.missingFiles, ["src/nonexistent.ts"]);
  });

  test("reproduces issue #170: src/lib/auth.ts instead of web/src/lib/auth.ts", () => {
    const result = validateScopePaths(
      ["src/lib/auth.ts"],
      workspace,
    );
    assert.equal(result.valid, false);
    assert.deepEqual(result.missingFiles, ["src/lib/auth.ts"]);
    assert.equal(result.hints.length, 1);
    assert.ok(result.hints[0].includes("web/src/lib/auth.ts"));
  });

  test("cleanup", () => {
    rmSync(workspace, { recursive: true, force: true });
  });
});

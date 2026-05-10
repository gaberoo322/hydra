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

/**
 * Regression for issue #190: refactor/extract tasks declare new files in
 * `scopeBoundary.creates` (not `in`). Preflight only checks `in` for
 * existence — `creates` paths are allowed to be absent.
 *
 * Two cycles in the 2026-05-10 session abandoned at preflight (~$20 each)
 * because the planner correctly proposed extracting code into new modules
 * but listed the new file paths in `in`. The fix is two-fold:
 *   1. Planner schema gains `scopeBoundary.creates` so it can declare intent.
 *   2. Preflight only validates `in[]` and ignores `creates[]`.
 *
 * This block exercises the orchestration: the same workspace is reused, a
 * task with mixed create+modify intent is run through preflight's underlying
 * validateScopePaths plus reconcilePlanVsActual.
 */
import { reconcilePlanVsActual } from "../src/preflight.ts";

describe("scopeBoundary.creates (issue #190)", () => {
  let workspace: string;

  test("setup", () => {
    workspace = createTempWorkspace();
  });

  test("validateScopePaths still rejects modify-intent paths that don't exist", () => {
    // Sanity: the existing behavior must not regress.
    const result = validateScopePaths(["src/nonexistent.ts"], workspace);
    assert.equal(result.valid, false);
    assert.deepEqual(result.missingFiles, ["src/nonexistent.ts"]);
  });

  test("preflight passes when modify-intent file exists and create-intent file does not", () => {
    // This mirrors what preflightCheck does with task.scopeBoundary:
    //   - validateScopePaths is called only on `in[]`
    //   - `creates[]` is intentionally NOT checked for existence
    const task = {
      scopeBoundary: {
        in: ["web/src/lib/db.ts"],            // exists
        out: [],
        creates: ["web/src/lib/new-module.ts"], // does NOT exist (intentional)
      },
    };
    const inResult = validateScopePaths(task.scopeBoundary.in, workspace);
    assert.equal(inResult.valid, true, "modify-intent file must validate");

    // Sanity: the create-intent file genuinely doesn't exist on disk
    const createResult = validateScopePaths(task.scopeBoundary.creates, workspace);
    assert.equal(createResult.valid, false,
      "test scaffolding sanity: the create-intent file should not exist yet");

    // Preflight only checks `in`, so the task as a whole passes preflight.
    // (We assert this by demonstrating the discriminated path: validateScopePaths
    // is called on `in` only — see src/preflight.ts step 5.)
  });

  test("reconcilePlanVsActual treats creates[] as in-scope (no false scope creep)", () => {
    const task = {
      scopeBoundary: {
        in: ["web/src/lib/db.ts"],
        out: [],
        creates: ["web/src/lib/new-module.ts", "web/src/lib/new-module.test.ts"],
      },
    };
    const verification = {
      filesChanged: [
        "web/src/lib/db.ts",
        "web/src/lib/new-module.ts",
        "web/src/lib/new-module.test.ts",
      ],
    };
    const recon = reconcilePlanVsActual(task, verification);
    assert.equal(recon.scopeCreep.length, 0,
      `creates[] entries should not be flagged as scope creep, got: ${recon.scopeCreep.join(", ")}`);
    assert.equal(recon.missingCreates.length, 0,
      "all declared creates were produced; missingCreates must be empty");
  });

  test("reconcilePlanVsActual flags creates[] entries that were NOT produced", () => {
    const task = {
      scopeBoundary: {
        in: [],
        out: [],
        creates: ["web/src/lib/promised-but-never-written.ts"],
      },
    };
    const verification = {
      filesChanged: ["web/src/lib/db.ts"],
    };
    const recon = reconcilePlanVsActual(task, verification);
    assert.deepEqual(recon.missingCreates, ["web/src/lib/promised-but-never-written.ts"]);
    assert.equal(recon.aligned, false);
  });

  test("backwards compatibility: tasks without creates field still work", () => {
    // Cached plans from before the field existed must not break reconciliation.
    const task = {
      scopeBoundary: {
        in: ["web/src/lib/db.ts"],
        out: [],
        // creates is intentionally absent
      },
    };
    const verification = { filesChanged: ["web/src/lib/db.ts"] };
    const recon = reconcilePlanVsActual(task, verification);
    assert.equal(recon.scopeCreep.length, 0);
    assert.equal(recon.scopeGaps.length, 0);
    assert.equal(recon.missingCreates.length, 0);
    assert.equal(recon.aligned, true);
  });

  test("schema: PLANNER_OUTPUT_SCHEMA exposes scopeBoundary.creates", async () => {
    const { PLANNER_OUTPUT_SCHEMA } = await import("../src/planner-prompt.ts");
    const scope = PLANNER_OUTPUT_SCHEMA.properties.scopeBoundary;
    assert.ok(scope.properties.creates, "scopeBoundary.creates must be defined");
    assert.equal(scope.properties.creates.type, "array");
    assert.equal(scope.properties.creates.items.type, "string");
    assert.ok(scope.required.includes("creates"),
      "creates must be in required array (OpenAI structured-output constraint)");
  });

  test("cleanup", () => {
    rmSync(workspace, { recursive: true, force: true });
  });
});

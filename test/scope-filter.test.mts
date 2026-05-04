/**
 * Scope creep filter tests (issue #58).
 *
 * Regression: every executor merge included ~14 auto-generated files outside
 * the planned scope (CSS, layout, drizzle journal, etc.). The scope filter
 * identifies and cleans out-of-scope file changes before verification runs.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { identifyOutOfScopeFiles } from "../src/pipeline-steps.ts";

describe("identifyOutOfScopeFiles", () => {
  test("returns empty when scopeIn is empty", () => {
    const result = identifyOutOfScopeFiles(["src/foo.ts", "src/bar.ts"], []);
    assert.deepEqual(result, []);
  });

  test("returns empty when scopeIn is undefined", () => {
    const result = identifyOutOfScopeFiles(["src/foo.ts"], undefined as any);
    assert.deepEqual(result, []);
  });

  test("returns empty when all changed files are in scope", () => {
    const result = identifyOutOfScopeFiles(
      ["src/auth.ts", "src/middleware.ts"],
      ["src/auth.ts", "src/middleware.ts"],
    );
    assert.deepEqual(result, []);
  });

  test("identifies files outside planned scope", () => {
    const result = identifyOutOfScopeFiles(
      ["src/auth.ts", "web/src/app/globals.css", "web/drizzle/meta/_journal.json"],
      ["src/auth.ts"],
    );
    assert.deepEqual(result, ["web/src/app/globals.css", "web/drizzle/meta/_journal.json"]);
  });

  test("excludes test files from cleanup (tests are always allowed)", () => {
    const result = identifyOutOfScopeFiles(
      ["src/auth.ts", "src/auth.test.ts", "src/unrelated.test.ts"],
      ["src/auth.ts"],
    );
    assert.deepEqual(result, []);
  });

  test("handles web/ prefix mismatch between scope and changed files", () => {
    // Scope says "src/lib/db/schema.ts" but git diff shows "web/src/lib/db/schema.ts"
    const result = identifyOutOfScopeFiles(
      ["web/src/lib/db/schema.ts", "web/src/app/globals.css"],
      ["src/lib/db/schema.ts"],
    );
    assert.deepEqual(result, ["web/src/app/globals.css"]);
  });

  test("handles directory prefix matching", () => {
    // Scope says "src/components/" and executor changed a file inside it
    const result = identifyOutOfScopeFiles(
      ["src/components/nav.tsx", "src/unrelated/foo.ts"],
      ["src/components/"],
    );
    assert.deepEqual(result, ["src/unrelated/foo.ts"]);
  });

  test("reproduces issue #58 scenario: 1-file scope, 16-file commit", () => {
    const changedFiles = [
      "web/src/lib/db/schema.ts",              // planned scope
      "web/drizzle/meta/_journal.json",          // scope creep
      "web/src/app/globals.css",                 // scope creep
      "web/src/app/layout.tsx",                  // scope creep
      "web/src/app/homepage-tradingview-overview.tsx", // scope creep
      "web/src/app/markets/page.tsx",            // scope creep
      "web/src/app/markets/page.test.tsx",       // test file (allowed)
      "web/src/app/page.tsx",                    // scope creep
      "web/src/app/venue-orders/page.tsx",       // scope creep
      "web/src/app/venue-orders/preview/page.tsx", // scope creep
      "web/src/bin/kalshi-reconcile-runner.ts",  // scope creep
      "web/src/components/nav.tsx",              // scope creep
      "web/src/components/ui/button.tsx",        // scope creep
    ];
    const scopeIn = ["web/src/lib/db/schema.ts"];

    const outOfScope = identifyOutOfScopeFiles(changedFiles, scopeIn);

    // The planned file and test file should NOT be in the out-of-scope list
    assert.ok(!outOfScope.includes("web/src/lib/db/schema.ts"), "planned file should not be cleaned");
    assert.ok(!outOfScope.includes("web/src/app/markets/page.test.tsx"), "test file should not be cleaned");

    // All the scope creep files should be identified
    assert.ok(outOfScope.includes("web/drizzle/meta/_journal.json"));
    assert.ok(outOfScope.includes("web/src/app/globals.css"));
    assert.ok(outOfScope.includes("web/src/app/layout.tsx"));
    assert.ok(outOfScope.includes("web/src/components/nav.tsx"));
    assert.ok(outOfScope.includes("web/src/components/ui/button.tsx"));

    assert.equal(outOfScope.length, 11, "should identify 11 out-of-scope files (13 total - 1 planned - 1 test)");
  });

  test("returns empty when changedFiles is empty", () => {
    const result = identifyOutOfScopeFiles([], ["src/auth.ts"]);
    assert.deepEqual(result, []);
  });

  test("handles multiple scope files correctly", () => {
    const result = identifyOutOfScopeFiles(
      ["src/auth.ts", "src/middleware.ts", "src/db.ts", "src/config.ts"],
      ["src/auth.ts", "src/middleware.ts", "src/db.ts"],
    );
    assert.deepEqual(result, ["src/config.ts"]);
  });
});

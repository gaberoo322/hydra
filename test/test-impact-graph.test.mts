/**
 * Regression tests for src/test-impact-graph.ts (issue #341).
 *
 * Covers parseImports, resolveImport, buildImportGraph, selectAffectedTests,
 * and decideTestSelection. All buildImportGraph tests use readFileImpl
 * injection so nothing touches the real filesystem.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseImports,
  resolveImport,
  buildImportGraph,
  selectAffectedTests,
  decideTestSelection,
  type ImportGraph,
} from "../src/test-impact-graph.ts";

// -------------------------------------------------------------------------
// parseImports
// -------------------------------------------------------------------------

describe("parseImports", () => {
  test("extracts ES module 'import ... from' specifier", () => {
    const src = `import { foo } from "./bar.ts";\nimport bar from '../baz.js';`;
    assert.deepEqual(parseImports(src), ["./bar.ts", "../baz.js"]);
  });

  test("extracts side-effect import (import 'x')", () => {
    const src = `import "./side-effect.ts";`;
    assert.deepEqual(parseImports(src), ["./side-effect.ts"]);
  });

  test("extracts dynamic import", () => {
    const src = `const m = await import("./lazy.ts");`;
    assert.deepEqual(parseImports(src), ["./lazy.ts"]);
  });

  test("extracts CommonJS require", () => {
    const src = `const x = require("./cjs.js");`;
    assert.deepEqual(parseImports(src), ["./cjs.js"]);
  });

  test("extracts export ... from", () => {
    const src = `export { foo } from "./re-export.ts";`;
    assert.deepEqual(parseImports(src), ["./re-export.ts"]);
  });

  test("ignores imports in block comments", () => {
    const src = `/* import { fake } from "./not-real.ts"; */\nimport real from "./real.ts";`;
    assert.deepEqual(parseImports(src), ["./real.ts"]);
  });

  test("ignores imports in line comments", () => {
    const src = `// import { fake } from "./not-real.ts";\nimport real from "./real.ts";`;
    assert.deepEqual(parseImports(src), ["./real.ts"]);
  });

  test("returns empty array for empty source", () => {
    assert.deepEqual(parseImports(""), []);
    assert.deepEqual(parseImports(null as any), []);
  });

  test("handles mixed quote styles", () => {
    const src = `import a from "./a.ts"; import b from './b.ts';`;
    assert.deepEqual(parseImports(src), ["./a.ts", "./b.ts"]);
  });
});

// -------------------------------------------------------------------------
// resolveImport
// -------------------------------------------------------------------------

describe("resolveImport", () => {
  function makeExists(known: string[]): (rel: string) => boolean {
    const set = new Set(known);
    return (r) => set.has(r);
  }

  test("returns null for bare module spec (node:fs)", () => {
    const result = resolveImport("node:fs", "src/a.ts", "/project", {
      fileExists: () => true,
    });
    assert.equal(result, null);
  });

  test("returns null for bare module spec (npm package)", () => {
    const result = resolveImport("express", "src/a.ts", "/project", {
      fileExists: () => true,
    });
    assert.equal(result, null);
  });

  test("resolves relative import with extension already attached", () => {
    const result = resolveImport("./b.ts", "src/a.ts", "/project", {
      fileExists: makeExists(["src/b.ts"]),
    });
    assert.equal(result, "src/b.ts");
  });

  test("resolves relative import by adding .ts extension", () => {
    const result = resolveImport("./b", "src/a.ts", "/project", {
      fileExists: makeExists(["src/b.ts"]),
    });
    assert.equal(result, "src/b.ts");
  });

  test("resolves relative import to index file", () => {
    const result = resolveImport("./helpers", "src/a.ts", "/project", {
      fileExists: makeExists(["src/helpers/index.ts"]),
    });
    assert.equal(result, "src/helpers/index.ts");
  });

  test("resolves parent directory import", () => {
    const result = resolveImport("../shared/util", "src/lib/a.ts", "/project", {
      fileExists: makeExists(["src/shared/util.ts"]),
    });
    assert.equal(result, "src/shared/util.ts");
  });

  test("returns null when relative target does not exist", () => {
    const result = resolveImport("./missing", "src/a.ts", "/project", {
      fileExists: () => false,
    });
    assert.equal(result, null);
  });

  test("resolves alias import via aliasRoots", () => {
    const result = resolveImport("@/lib/foo", "src/a.ts", "/project", {
      aliasRoots: new Map([["@/", "src"]]),
      fileExists: makeExists(["src/lib/foo.ts"]),
    });
    assert.equal(result, "src/lib/foo.ts");
  });

  test("returns null for alias import when target missing", () => {
    const result = resolveImport("@/lib/missing", "src/a.ts", "/project", {
      aliasRoots: new Map([["@/", "src"]]),
      fileExists: () => false,
    });
    assert.equal(result, null);
  });

  test("prefers .ts over .js when both could exist", () => {
    const result = resolveImport("./mod", "src/a.ts", "/project", {
      fileExists: makeExists(["src/mod.ts", "src/mod.js"]),
    });
    assert.equal(result, "src/mod.ts");
  });

  test("falls through to .mts extension", () => {
    const result = resolveImport("./mod", "src/a.ts", "/project", {
      fileExists: makeExists(["src/mod.mts"]),
    });
    assert.equal(result, "src/mod.mts");
  });
});

// -------------------------------------------------------------------------
// buildImportGraph
// -------------------------------------------------------------------------

describe("buildImportGraph", () => {
  function fakeFs(files: Record<string, string>) {
    return async (absPath: string) => {
      // Strip project root prefix for lookup.
      const rel = absPath.replace(/^\/project\//, "");
      if (rel in files) return files[rel];
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
  }

  test("builds closure for single test importing one source", async () => {
    const files = {
      "test/a.test.mts": `import { add } from "../src/math.ts";`,
      "src/math.ts": `export function add(a: number, b: number) { return a + b; }`,
    };
    const graph = await buildImportGraph(
      {
        projectDir: "/project",
        testFiles: ["test/a.test.mts"],
        readFileImpl: fakeFs(files),
      },
      { allFiles: new Set(Object.keys(files)) },
    );

    const closure = graph.get("test/a.test.mts");
    assert.ok(closure, "should have a closure entry");
    assert.equal(closure?.has("src/math.ts"), true);
    // Test file itself should not appear in its own closure.
    assert.equal(closure?.has("test/a.test.mts"), false);
  });

  test("transitively closes through multi-hop imports", async () => {
    const files = {
      "test/a.test.mts": `import { foo } from "../src/foo.ts";`,
      "src/foo.ts": `import { bar } from "./bar.ts"; export const foo = bar;`,
      "src/bar.ts": `import { baz } from "./baz.ts"; export const bar = baz;`,
      "src/baz.ts": `export const baz = 1;`,
    };
    const graph = await buildImportGraph(
      {
        projectDir: "/project",
        testFiles: ["test/a.test.mts"],
        readFileImpl: fakeFs(files),
      },
      { allFiles: new Set(Object.keys(files)) },
    );

    const closure = graph.get("test/a.test.mts");
    assert.equal(closure?.has("src/foo.ts"), true);
    assert.equal(closure?.has("src/bar.ts"), true);
    assert.equal(closure?.has("src/baz.ts"), true);
  });

  test("handles cycles without infinite loop", async () => {
    const files = {
      "test/a.test.mts": `import { foo } from "../src/foo.ts";`,
      "src/foo.ts": `import { bar } from "./bar.ts"; export const foo = 1;`,
      "src/bar.ts": `import { foo } from "./foo.ts"; export const bar = 1;`,
    };
    const graph = await buildImportGraph(
      {
        projectDir: "/project",
        testFiles: ["test/a.test.mts"],
        readFileImpl: fakeFs(files),
      },
      { allFiles: new Set(Object.keys(files)) },
    );
    const closure = graph.get("test/a.test.mts");
    assert.equal(closure?.has("src/foo.ts"), true);
    assert.equal(closure?.has("src/bar.ts"), true);
  });

  test("silently skips bare module specs (express, node:fs)", async () => {
    const files = {
      "test/a.test.mts": `import "node:fs"; import "express"; import "../src/x.ts";`,
      "src/x.ts": `export const x = 1;`,
    };
    const graph = await buildImportGraph(
      {
        projectDir: "/project",
        testFiles: ["test/a.test.mts"],
        readFileImpl: fakeFs(files),
      },
      { allFiles: new Set(Object.keys(files)) },
    );
    const closure = graph.get("test/a.test.mts");
    assert.equal(closure?.has("src/x.ts"), true);
    assert.equal(closure?.has("node:fs"), false);
    assert.equal(closure?.has("express"), false);
  });

  test("tolerates read errors by treating imports as empty", async () => {
    const readImpl = async (absPath: string) => {
      if (absPath.endsWith("a.test.mts")) {
        return `import "../src/missing.ts";`;
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    const graph = await buildImportGraph(
      {
        projectDir: "/project",
        testFiles: ["test/a.test.mts"],
        readFileImpl: readImpl,
      },
      { allFiles: new Set(["test/a.test.mts", "src/missing.ts"]) },
    );
    // Test was readable; src/missing.ts is in allFiles but unreadable. Closure
    // should still include it (it was resolved before read), but downstream
    // imports of src/missing.ts cannot be traversed.
    const closure = graph.get("test/a.test.mts");
    assert.equal(closure?.has("src/missing.ts"), true);
  });
});

// -------------------------------------------------------------------------
// selectAffectedTests
// -------------------------------------------------------------------------

describe("selectAffectedTests", () => {
  function makeGraph(map: Record<string, string[]>): ImportGraph {
    const g: ImportGraph = new Map();
    for (const [k, v] of Object.entries(map)) g.set(k, new Set(v));
    return g;
  }

  test("returns null for empty changed files (caller falls back)", () => {
    const graph = makeGraph({ "test/a.test.mts": ["src/a.ts"] });
    assert.equal(selectAffectedTests([], graph), null);
  });

  test("selects tests that transitively depend on changed file", () => {
    const graph = makeGraph({
      "test/a.test.mts": ["src/a.ts", "src/shared.ts"],
      "test/b.test.mts": ["src/b.ts"],
      "test/c.test.mts": ["src/shared.ts"],
    });
    const selected = selectAffectedTests(["src/shared.ts"], graph);
    assert.deepEqual(selected?.sort(), ["test/a.test.mts", "test/c.test.mts"]);
  });

  test("selects only one test for a unique-dependency change (success criterion: 1-file diff)", () => {
    const graph = makeGraph({
      "test/a.test.mts": ["src/a.ts"],
      "test/b.test.mts": ["src/b.ts"],
      "test/c.test.mts": ["src/c.ts"],
    });
    const selected = selectAffectedTests(["src/a.ts"], graph);
    assert.deepEqual(selected, ["test/a.test.mts"]);
  });

  test("selects test when the test file itself is in changedFiles", () => {
    const graph = makeGraph({
      "test/a.test.mts": ["src/a.ts"],
      "test/b.test.mts": ["src/b.ts"],
    });
    const selected = selectAffectedTests(["test/a.test.mts"], graph);
    assert.deepEqual(selected, ["test/a.test.mts"]);
  });

  test("returns null when selection saturates >=90% (success criterion: 100-file diff falls back)", () => {
    // 10 tests, all depending on widely-imported config file. Changing config
    // would select all 10 → saturation → null.
    const graph = makeGraph({
      "test/t01.test.mts": ["src/config.ts"],
      "test/t02.test.mts": ["src/config.ts"],
      "test/t03.test.mts": ["src/config.ts"],
      "test/t04.test.mts": ["src/config.ts"],
      "test/t05.test.mts": ["src/config.ts"],
      "test/t06.test.mts": ["src/config.ts"],
      "test/t07.test.mts": ["src/config.ts"],
      "test/t08.test.mts": ["src/config.ts"],
      "test/t09.test.mts": ["src/config.ts"],
      "test/t10.test.mts": ["src/config.ts"],
    });
    const selected = selectAffectedTests(["src/config.ts"], graph);
    assert.equal(selected, null);
  });

  test("returns empty array when no test depends on the changed file (success criterion: safety-net)", () => {
    const graph = makeGraph({
      "test/a.test.mts": ["src/a.ts"],
      "test/b.test.mts": ["src/b.ts"],
    });
    const selected = selectAffectedTests(["src/orphan.ts"], graph);
    assert.deepEqual(selected, []);
  });

  test("custom fullSuiteFallbackRatio governs saturation threshold", () => {
    const graph = makeGraph({
      "test/a.test.mts": ["src/shared.ts"],
      "test/b.test.mts": ["src/shared.ts"],
      "test/c.test.mts": ["src/unrelated.ts"],
    });
    // 2/3 ~= 67% selected. With ratio 0.5, must return null.
    const selected = selectAffectedTests(["src/shared.ts"], graph, {
      fullSuiteFallbackRatio: 0.5,
    });
    assert.equal(selected, null);
    // With default ratio 0.9, 2/3 is under threshold, return the selection.
    const selected2 = selectAffectedTests(["src/shared.ts"], graph);
    assert.deepEqual(selected2?.sort(), ["test/a.test.mts", "test/b.test.mts"]);
  });
});

// -------------------------------------------------------------------------
// decideTestSelection
// -------------------------------------------------------------------------

describe("decideTestSelection", () => {
  function makeGraph(map: Record<string, string[]>): ImportGraph {
    const g: ImportGraph = new Map();
    for (const [k, v] of Object.entries(map)) g.set(k, new Set(v));
    return g;
  }

  test("no diff → full-suite with no-diff reason", () => {
    const graph = makeGraph({ "test/a.test.mts": ["src/a.ts"] });
    const decision = decideTestSelection([], graph);
    assert.equal(decision.mode, "full-suite");
    if (decision.mode === "full-suite") {
      assert.match(decision.reason, /no-diff/);
    }
  });

  test("saturation → full-suite with saturation reason", () => {
    const graph = makeGraph({
      "test/a.test.mts": ["src/shared.ts"],
      "test/b.test.mts": ["src/shared.ts"],
    });
    // 100% selected.
    const decision = decideTestSelection(["src/shared.ts"], graph);
    assert.equal(decision.mode, "full-suite");
    if (decision.mode === "full-suite") {
      assert.match(decision.reason, /saturation/);
    }
  });

  test("empty selection → full-suite with safety-net reason", () => {
    const graph = makeGraph({
      "test/a.test.mts": ["src/a.ts"],
    });
    const decision = decideTestSelection(["src/orphan.ts"], graph);
    assert.equal(decision.mode, "full-suite");
    if (decision.mode === "full-suite") {
      assert.match(decision.reason, /safety-net/);
    }
  });

  test("normal selection → incremental with test list", () => {
    const graph = makeGraph({
      "test/a.test.mts": ["src/a.ts"],
      "test/b.test.mts": ["src/b.ts"],
      "test/c.test.mts": ["src/c.ts"],
    });
    const decision = decideTestSelection(["src/a.ts"], graph);
    assert.equal(decision.mode, "incremental");
    if (decision.mode === "incremental") {
      assert.deepEqual(decision.tests, ["test/a.test.mts"]);
      assert.match(decision.reason, /incremental/);
    }
  });
});

/**
 * Regression tests for src/repo-map.ts — regex-based TypeScript parser.
 *
 * Tests export extraction, import edge extraction, and graph construction
 * using inline fixture strings. No I/O required — all functions are pure.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseExports,
  parseImports,
  buildImportGraph,
  computePageRank,
  selectScopeNeighbors,
  formatRepoMap,
  hashFileTree,
  clearRepoMapCache,
} from "../src/repo-map.ts";
import type { ExportedSymbol, ImportEdge, SymbolDetail } from "../src/repo-map.ts";

// ---------------------------------------------------------------------------
// parseExports
// ---------------------------------------------------------------------------

describe("repo-map parseExports()", () => {
  test("extracts exported function", () => {
    const result = parseExports("export function greet(name: string) {}");
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "greet");
    assert.equal(result[0].kind, "function");
  });

  test("extracts exported async function", () => {
    const result = parseExports("export async function fetchData() {}");
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "fetchData");
    assert.equal(result[0].kind, "function");
  });

  test("extracts exported class", () => {
    const result = parseExports("export class Router {}");
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "Router");
    assert.equal(result[0].kind, "class");
  });

  test("extracts exported const", () => {
    const result = parseExports("export const MAX_RETRIES = 3;");
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "MAX_RETRIES");
    assert.equal(result[0].kind, "const");
  });

  test("extracts exported let and var", () => {
    const result = parseExports(
      "export let counter = 0;\nexport var legacy = true;",
    );
    assert.equal(result.length, 2);
    assert.equal(result[0].name, "counter");
    assert.equal(result[0].kind, "let");
    assert.equal(result[1].name, "legacy");
    assert.equal(result[1].kind, "var");
  });

  test("extracts exported type", () => {
    const result = parseExports("export type Config = { port: number };");
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "Config");
    assert.equal(result[0].kind, "type");
  });

  test("extracts exported interface", () => {
    const result = parseExports("export interface Handler { handle(): void }");
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "Handler");
    assert.equal(result[0].kind, "interface");
  });

  test("extracts exported enum", () => {
    const result = parseExports("export enum Status { OK, ERR }");
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "Status");
    assert.equal(result[0].kind, "enum");
  });

  test("extracts export default function", () => {
    const result = parseExports("export default function main() {}");
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "main");
    assert.equal(result[0].kind, "default");
  });

  test("extracts export default class", () => {
    const result = parseExports("export default class App {}");
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "App");
    assert.equal(result[0].kind, "default");
  });

  test("extracts named export braces", () => {
    const result = parseExports("export { foo, bar, baz };");
    assert.equal(result.length, 3);
    const names = result.map((r) => r.name);
    assert.deepEqual(names, ["foo", "bar", "baz"]);
  });

  test("extracts re-export from another module", () => {
    const result = parseExports("export { X, Y } from './other';");
    assert.equal(result.length, 2);
    assert.equal(result[0].kind, "re-export");
    assert.equal(result[1].kind, "re-export");
  });

  test("extracts aliased re-export", () => {
    const result = parseExports(
      "export { internal as external } from './lib';",
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "external");
    assert.equal(result[0].kind, "re-export");
  });

  test("handles mixed exports in one file", () => {
    const source = `
      export function alpha() {}
      export class Beta {}
      export const GAMMA = 1;
      export type Delta = string;
      export interface Epsilon {}
      export default function omega() {}
      export { zeta } from './z';
    `;
    const result = parseExports(source);
    const names = result.map((r) => r.name).sort();
    assert.deepEqual(names, [
      "Beta",
      "Delta",
      "Epsilon",
      "GAMMA",
      "alpha",
      "omega",
      "zeta",
    ]);
  });

  test("returns empty array for source with no exports", () => {
    const result = parseExports("const x = 1;\nfunction foo() {}");
    assert.equal(result.length, 0);
  });
});

// ---------------------------------------------------------------------------
// parseImports
// ---------------------------------------------------------------------------

describe("repo-map parseImports()", () => {
  test("extracts default import", () => {
    const result = parseImports("import express from 'express';");
    assert.equal(result.length, 1);
    assert.equal(result[0].source, "express");
    assert.deepEqual(result[0].symbols, ["express"]);
  });

  test("extracts named imports", () => {
    const result = parseImports(
      "import { Router, Request } from 'express';",
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].source, "express");
    assert.deepEqual(result[0].symbols, ["Router", "Request"]);
  });

  test("extracts namespace import", () => {
    const result = parseImports("import * as path from 'node:path';");
    assert.equal(result.length, 1);
    assert.equal(result[0].source, "node:path");
    assert.deepEqual(result[0].symbols, ["path"]);
  });

  test("extracts side-effect import", () => {
    const result = parseImports("import './polyfill';");
    assert.equal(result.length, 1);
    assert.equal(result[0].source, "./polyfill");
    assert.deepEqual(result[0].symbols, []);
  });

  test("extracts re-export from", () => {
    const result = parseImports("export { foo, bar } from './utils';");
    assert.equal(result.length, 1);
    assert.equal(result[0].source, "./utils");
    assert.deepEqual(result[0].symbols, ["foo", "bar"]);
  });

  test("extracts export * from", () => {
    const result = parseImports("export * from './types';");
    assert.equal(result.length, 1);
    assert.equal(result[0].source, "./types");
    assert.deepEqual(result[0].symbols, []);
  });

  test("extracts import type", () => {
    const result = parseImports(
      "import type { Config } from './config';",
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].source, "./config");
    assert.deepEqual(result[0].symbols, ["Config"]);
  });

  test("handles aliased imports", () => {
    const result = parseImports(
      "import { foo as bar, baz as qux } from './lib';",
    );
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].symbols, ["bar", "qux"]);
  });

  test("returns empty array for source with no imports", () => {
    const result = parseImports("const x = 1;");
    assert.equal(result.length, 0);
  });
});

// ---------------------------------------------------------------------------
// buildImportGraph
// ---------------------------------------------------------------------------

describe("repo-map buildImportGraph()", () => {
  test("builds edges for relative imports", () => {
    const files = new Map<string, string>([
      ["src/index.ts", "import { greet } from './utils';"],
      ["src/utils.ts", "export function greet() {}"],
    ]);

    const graph = buildImportGraph(files);

    // Exports
    assert.equal(graph.exports.get("src/utils.ts")!.length, 1);
    assert.equal(graph.exports.get("src/utils.ts")![0].name, "greet");

    // Edges
    assert.deepEqual(graph.edges.get("src/index.ts"), ["src/utils.ts"]);
    assert.deepEqual(graph.edges.get("src/utils.ts"), []);
  });

  test("resolves .ts extension automatically", () => {
    const files = new Map<string, string>([
      ["src/app.ts", "import { run } from './runner';"],
      ["src/runner.ts", "export function run() {}"],
    ]);

    const graph = buildImportGraph(files);
    assert.deepEqual(graph.edges.get("src/app.ts"), ["src/runner.ts"]);
  });

  test("resolves index.ts for directory imports", () => {
    const files = new Map<string, string>([
      ["src/main.ts", "import { init } from './lib';"],
      ["src/lib/index.ts", "export function init() {}"],
    ]);

    const graph = buildImportGraph(files);
    assert.deepEqual(graph.edges.get("src/main.ts"), ["src/lib/index.ts"]);
  });

  test("ignores non-relative (package) imports", () => {
    const files = new Map<string, string>([
      ["src/server.ts", "import express from 'express';\nimport { handler } from './handler';"],
      ["src/handler.ts", "export function handler() {}"],
    ]);

    const graph = buildImportGraph(files);
    // Only the relative import becomes an edge
    assert.deepEqual(graph.edges.get("src/server.ts"), ["src/handler.ts"]);
  });

  test("deduplicates edges when a file is imported multiple times", () => {
    const files = new Map<string, string>([
      [
        "src/a.ts",
        "import { x } from './b';\nimport { y } from './b';",
      ],
      ["src/b.ts", "export const x = 1;\nexport const y = 2;"],
    ]);

    const graph = buildImportGraph(files);
    assert.deepEqual(graph.edges.get("src/a.ts"), ["src/b.ts"]);
  });

  test("handles multi-file graph with transitive imports", () => {
    const files = new Map<string, string>([
      ["src/a.ts", "import { B } from './b';"],
      ["src/b.ts", "import { C } from './c';\nexport class B {}"],
      ["src/c.ts", "export class C {}"],
    ]);

    const graph = buildImportGraph(files);
    assert.deepEqual(graph.edges.get("src/a.ts"), ["src/b.ts"]);
    assert.deepEqual(graph.edges.get("src/b.ts"), ["src/c.ts"]);
    assert.deepEqual(graph.edges.get("src/c.ts"), []);
  });

  test("handles re-export edges", () => {
    const files = new Map<string, string>([
      ["src/index.ts", "export { foo } from './foo';"],
      ["src/foo.ts", "export function foo() {}"],
    ]);

    const graph = buildImportGraph(files);
    assert.deepEqual(graph.edges.get("src/index.ts"), ["src/foo.ts"]);
  });

  test("returns empty graph for empty input", () => {
    const graph = buildImportGraph(new Map());
    assert.equal(graph.exports.size, 0);
    assert.equal(graph.edges.size, 0);
  });
});

// ---------------------------------------------------------------------------
// Fixture graph for PageRank / scope / format tests
// ---------------------------------------------------------------------------

/**
 * Build a fixture graph:
 *
 *   src/index.ts  -->  src/api.ts  -->  src/handler.ts
 *                  -->  src/utils.ts
 *   src/api.ts    -->  src/utils.ts
 *   src/handler.ts -->  src/utils.ts
 *   src/cli.ts    -->  src/utils.ts
 *
 * utils.ts is the most imported (4 importers), then api.ts (1 importer).
 */
function buildFixtureGraph() {
  const files = new Map<string, string>([
    [
      "src/index.ts",
      `import { createApp } from './api';
       import { log } from './utils';
       export function main() {}`,
    ],
    [
      "src/api.ts",
      `import { handle } from './handler';
       import { log } from './utils';
       export function createApp() {}`,
    ],
    [
      "src/handler.ts",
      `import { log } from './utils';
       export function handle() {}`,
    ],
    [
      "src/utils.ts",
      `export function log() {}
       export function format() {}`,
    ],
    [
      "src/cli.ts",
      `import { log } from './utils';
       export function runCli() {}`,
    ],
  ]);
  return buildImportGraph(files);
}

// ---------------------------------------------------------------------------
// computePageRank
// ---------------------------------------------------------------------------

describe("repo-map computePageRank()", () => {
  test("ranks most-imported file highest", () => {
    const graph = buildFixtureGraph();
    const scores = computePageRank(graph);

    // utils.ts is imported by 4 files — should have the highest score
    const utilsScore = scores.get("src/utils.ts")!;
    const cliScore = scores.get("src/cli.ts")!;
    const indexScore = scores.get("src/index.ts")!;

    assert.ok(utilsScore > cliScore, "utils should rank above cli");
    assert.ok(utilsScore > indexScore, "utils should rank above index");
  });

  test("returns empty map for empty graph", () => {
    const graph = buildImportGraph(new Map());
    const scores = computePageRank(graph);
    assert.equal(scores.size, 0);
  });

  test("all files get a positive score", () => {
    const graph = buildFixtureGraph();
    const scores = computePageRank(graph);

    for (const [, score] of scores) {
      assert.ok(score > 0, "every file should have a positive score");
    }
  });
});

// ---------------------------------------------------------------------------
// selectScopeNeighbors
// ---------------------------------------------------------------------------

describe("repo-map selectScopeNeighbors()", () => {
  test("returns neighbors of scope files sorted by score", () => {
    const graph = buildFixtureGraph();
    // Scope = just api.ts; neighbors should include handler, utils, index
    const result = selectScopeNeighbors(graph, ["src/api.ts"]);

    const files = result.map((r) => r.file);
    assert.ok(files.includes("src/utils.ts"), "utils should be a neighbor");
    assert.ok(files.includes("src/handler.ts"), "handler should be a neighbor");
    assert.ok(files.includes("src/index.ts"), "index should be a neighbor");
    assert.ok(!files.includes("src/api.ts"), "scope file excluded from neighbors");
  });

  test("respects topN limit", () => {
    const graph = buildFixtureGraph();
    const result = selectScopeNeighbors(graph, ["src/api.ts"], 2);
    assert.ok(result.length <= 2, "should return at most topN results");
  });

  test("highest-ranked neighbor is utils.ts", () => {
    const graph = buildFixtureGraph();
    const result = selectScopeNeighbors(graph, ["src/api.ts"]);
    assert.equal(result[0].file, "src/utils.ts", "utils should rank first among neighbors");
  });

  test("returns empty for scope files not in graph", () => {
    const graph = buildFixtureGraph();
    const result = selectScopeNeighbors(graph, ["src/nonexistent.ts"]);
    assert.equal(result.length, 0);
  });
});

// ---------------------------------------------------------------------------
// formatRepoMap
// ---------------------------------------------------------------------------

describe("repo-map formatRepoMap()", () => {
  test("formats lines as file — export (imported by N files)", () => {
    const graph = buildFixtureGraph();
    const ranked = [{ file: "src/utils.ts", score: 1 }];
    const output = formatRepoMap(graph, ranked);

    assert.ok(output.includes("src/utils.ts"), "should include file path");
    assert.ok(output.includes("log"), "should include export name");
    assert.ok(output.includes("imported by 4 files"), "should include importer count");
  });

  test("enforces token budget", () => {
    const graph = buildFixtureGraph();
    const scores = computePageRank(graph);
    const allFiles = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([file, score]) => ({ file, score }));

    // Very tight budget: ~25 tokens = ~100 chars — should fit only 1 line
    const output = formatRepoMap(graph, allFiles, 25);
    const lines = output.split("\n");
    assert.ok(lines.length <= 2, `token budget should limit output, got ${lines.length} lines`);
  });

  test("always includes at least one line", () => {
    const graph = buildFixtureGraph();
    const ranked = [{ file: "src/utils.ts", score: 1 }];
    // Budget of 1 token is impossibly small but should still include 1 line
    const output = formatRepoMap(graph, ranked, 1);
    assert.ok(output.length > 0, "should include at least one line");
  });

  test("default budget fits a reasonable number of files", () => {
    const graph = buildFixtureGraph();
    const scores = computePageRank(graph);
    const allFiles = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([file, score]) => ({ file, score }));

    // Default 1500 token budget should fit all 5 files in our small fixture
    const output = formatRepoMap(graph, allFiles);
    const lines = output.split("\n");
    assert.equal(lines.length, 5, "default budget should fit all 5 fixture files");
  });
});

// ---------------------------------------------------------------------------
// hashFileTree
// ---------------------------------------------------------------------------

describe("repo-map hashFileTree()", () => {
  test("produces consistent hash for same file tree", () => {
    const tree = "src/a.ts\nsrc/b.ts\nsrc/c.ts";
    const h1 = hashFileTree(tree);
    const h2 = hashFileTree(tree);
    assert.equal(h1, h2);
  });

  test("produces same hash regardless of line order", () => {
    const tree1 = "src/b.ts\nsrc/a.ts\nsrc/c.ts";
    const tree2 = "src/a.ts\nsrc/c.ts\nsrc/b.ts";
    assert.equal(hashFileTree(tree1), hashFileTree(tree2));
  });

  test("produces different hash when files change", () => {
    const tree1 = "src/a.ts\nsrc/b.ts";
    const tree2 = "src/a.ts\nsrc/b.ts\nsrc/c.ts";
    assert.notEqual(hashFileTree(tree1), hashFileTree(tree2));
  });

  test("ignores empty lines", () => {
    const tree1 = "src/a.ts\n\nsrc/b.ts\n";
    const tree2 = "src/a.ts\nsrc/b.ts";
    assert.equal(hashFileTree(tree1), hashFileTree(tree2));
  });

  test("returns a hex string", () => {
    const hash = hashFileTree("src/a.ts");
    assert.ok(/^[0-9a-f]{64}$/.test(hash), "should be a 64-char hex SHA-256");
  });
});

// ---------------------------------------------------------------------------
// clearRepoMapCache
// ---------------------------------------------------------------------------

describe("repo-map clearRepoMapCache()", () => {
  test("does not throw when called", () => {
    assert.doesNotThrow(() => clearRepoMapCache());
  });
});

// ---------------------------------------------------------------------------
// Symbol detail extraction (via parseExports)
// ---------------------------------------------------------------------------

describe("repo-map symbol detail — function arity", () => {
  test("extracts arity for zero-param function", () => {
    const result = parseExports("export function init() {}");
    assert.equal(result[0].detail?.arity, 0);
  });

  test("extracts arity for single-param function", () => {
    const result = parseExports("export function greet(name: string) {}");
    assert.equal(result[0].detail?.arity, 1);
  });

  test("extracts arity for multi-param function", () => {
    const result = parseExports("export function add(a: number, b: number, c: number) { return a + b + c; }");
    assert.equal(result[0].detail?.arity, 3);
  });

  test("extracts arity for async function", () => {
    const result = parseExports("export async function fetchData(url: string, opts: RequestInit) {}");
    assert.equal(result[0].detail?.arity, 2);
  });

  test("handles params with default values and destructuring", () => {
    const result = parseExports("export function configure({ port, host }: Config, retries = 3) {}");
    assert.equal(result[0].detail?.arity, 2);
  });
});

describe("repo-map symbol detail — interface fields", () => {
  test("extracts field names from interface", () => {
    const result = parseExports(`export interface Config {
      port: number;
      host: string;
      debug: boolean;
    }`);
    assert.equal(result[0].name, "Config");
    assert.deepEqual(result[0].detail?.fields, ["port", "host", "debug"]);
  });

  test("limits fields to first 5", () => {
    const result = parseExports(`export interface Big {
      a: number;
      b: number;
      c: number;
      d: number;
      e: number;
      f: number;
      g: number;
    }`);
    assert.equal(result[0].detail?.fields?.length, 5);
    assert.deepEqual(result[0].detail?.fields, ["a", "b", "c", "d", "e"]);
  });

  test("handles optional fields", () => {
    const result = parseExports(`export interface Opts {
      timeout?: number;
      retries?: number;
    }`);
    assert.deepEqual(result[0].detail?.fields, ["timeout", "retries"]);
  });

  test("handles readonly fields", () => {
    const result = parseExports(`export interface State {
      readonly id: string;
      readonly name: string;
    }`);
    assert.deepEqual(result[0].detail?.fields, ["id", "name"]);
  });
});

describe("repo-map symbol detail — type fields", () => {
  test("extracts field names from type alias with object shape", () => {
    const result = parseExports(`export type Options = {
      verbose: boolean;
      output: string;
    };`);
    assert.equal(result[0].name, "Options");
    assert.deepEqual(result[0].detail?.fields, ["verbose", "output"]);
  });

  test("no fields for non-object type alias", () => {
    const result = parseExports("export type ID = string;");
    assert.equal(result[0].name, "ID");
    assert.equal(result[0].detail, undefined);
  });
});

describe("repo-map symbol detail — class methods", () => {
  test("extracts method names from class", () => {
    const result = parseExports(`export class Router {
      addRoute(path: string) {}
      removeRoute(path: string) {}
      match(url: string) {}
    }`);
    assert.equal(result[0].name, "Router");
    assert.deepEqual(result[0].detail?.methods, ["addRoute", "removeRoute", "match"]);
  });

  test("handles visibility modifiers", () => {
    const result = parseExports(`export class Service {
      public start() {}
      private stop() {}
      protected restart() {}
    }`);
    assert.deepEqual(result[0].detail?.methods, ["start", "stop", "restart"]);
  });

  test("handles async and static methods", () => {
    const result = parseExports(`export class DB {
      static create() {}
      async query(sql: string) {}
    }`);
    assert.deepEqual(result[0].detail?.methods, ["create", "query"]);
  });

  test("skips constructor", () => {
    const result = parseExports(`export class App {
      constructor(opts: any) {}
      run() {}
    }`);
    assert.deepEqual(result[0].detail?.methods, ["run"]);
  });
});

// ---------------------------------------------------------------------------
// formatRepoMap with symbol detail
// ---------------------------------------------------------------------------

describe("repo-map formatRepoMap() symbol detail", () => {
  function buildDetailFixtureGraph() {
    const files = new Map<string, string>([
      [
        "src/handler.ts",
        `export function handle(req: Request, res: Response) {}
         export interface HandlerOpts {
           timeout: number;
           retries: number;
           verbose: boolean;
         }
         export class HandlerClass {
           process() {}
           validate() {}
         }`,
      ],
      [
        "src/utils.ts",
        `import { handle } from './handler';
         export function log(msg: string) {}`,
      ],
    ]);
    return buildImportGraph(files);
  }

  test("shows symbol detail for scope files", () => {
    const graph = buildDetailFixtureGraph();
    const ranked = [
      { file: "src/handler.ts", score: 1 },
      { file: "src/utils.ts", score: 0.5 },
    ];
    const output = formatRepoMap(graph, ranked, 2000, ["src/handler.ts"]);

    // Scope file should have symbol sub-items
    assert.ok(output.includes("  fn handle(2)"), "should show function arity for scope file");
    assert.ok(output.includes("  HandlerOpts fields: timeout, retries, verbose"), "should show interface fields");
    assert.ok(output.includes("  HandlerClass methods: process, validate"), "should show class methods");
  });

  test("does NOT show symbol detail for neighbor files", () => {
    const graph = buildDetailFixtureGraph();
    const ranked = [
      { file: "src/handler.ts", score: 1 },
      { file: "src/utils.ts", score: 0.5 },
    ];
    // Only handler.ts is in scope — utils.ts is a neighbor
    const output = formatRepoMap(graph, ranked, 2000, ["src/handler.ts"]);

    // utils.ts line should NOT have sub-items
    const utilsLineIdx = output.split("\n").findIndex((l) => l.includes("src/utils.ts"));
    assert.ok(utilsLineIdx >= 0, "utils.ts should appear in output");
    const nextLine = output.split("\n")[utilsLineIdx + 1];
    // Next line should either be undefined or not start with "  " (no sub-items)
    assert.ok(
      nextLine === undefined || !nextLine.startsWith("  "),
      "neighbor file should not have symbol detail",
    );
  });

  test("no symbol detail when scopeFiles is not provided", () => {
    const graph = buildDetailFixtureGraph();
    const ranked = [{ file: "src/handler.ts", score: 1 }];
    const output = formatRepoMap(graph, ranked, 2000);

    // Should not contain any indented sub-items
    const hasSubItems = output.split("\n").some((l) => l.startsWith("  "));
    assert.ok(!hasSubItems, "should not show symbol detail without scopeFiles");
  });
});

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
} from "../src/repo-map.ts";
import type { ExportedSymbol, ImportEdge } from "../src/repo-map.ts";

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

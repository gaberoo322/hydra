/**
 * test/cost-layers.test.mts — the src/cost layer drift guard (ADR-0042
 * Decision 3, issue #4783; layer model resolved in #4704).
 *
 * This is the BLOCKING enforcer of ADR-0042's purity-ordered layer table
 * (Decision 1): it runs in the required `test` job and reddens any PR that
 * lets `src/cost/` drift off the table. The `.dependency-cruiser.cjs` rule
 * family named `cost-layer-*` is its ADVISORY visual twin (severity "warn",
 * advisory lane cannot block), and `src/cost/CONTEXT.md` mirrors the table for
 * humans — all three are edited together.
 *
 * The five checks (ADR-0042 Decision 3):
 *   1. every `src/cost/*.ts` file sits in exactly one layer — a new file fails
 *      until someone classifies it, a deleted file fails until its row goes;
 *   2. every import inside `src/cost/`, value OR type, points to the same
 *      layer or a lower one (type-only back-edges are NOT exempt — that is the
 *      route by which the first upward edge arrived);
 *   3. L1-L3 import no VALUES from across the purity line: `node:fs*`,
 *      `node:child_process`, `node:net`, `node:http(s)`, `../redis/*` or
 *      `../transcript-store` (`process.env` and `../logger.ts` are allowed;
 *      type-only imports from `../redis/*` are allowed);
 *   4. value imports inside `src/cost/` form no cycles;
 *   5. code in `src/` and `scripts/` may import L1-L2 `src/cost` files
 *      directly; L3 and above only through `index.ts` (`test/` is exempt).
 *
 * HOW IMPORTS ARE PARSED: the TypeScript compiler API (`typescript`, already a
 * devDependency) via `ts.createSourceFile`, walking ImportDeclaration,
 * ExportDeclaration-with-moduleSpecifier and dynamic `import()` call
 * expressions — never a regex, which misses type-only clauses, multi-line
 * import blocks and comment false-matches. Type-only-ness is CLAUSE-level
 * only: `import type …` / `export type … from` are type-only; every other
 * form — including `import { type X }` with all-inline-type specifiers,
 * side-effect `import "x"` and dynamic `import()` — counts as a VALUE import.
 * Check 2 counts both kinds; checks 3 and 4 count values only.
 *
 * This file deliberately imports NO `src/` module (it reads sources from
 * disk), so test-file-sprawl-guard's primary-subject resolution maps it to no
 * subject. There is no exception/allow list anywhere in here (ADR-0042
 * Decision 5): an upward edge is cleared by moving vocabulary DOWN, never by
 * blessing it in this table.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import ts from "typescript";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const COST_DIR_REL = "src/cost";

// ---------------------------------------------------------------------------
// The layer table — ADR-0042 Decision 1, minus `transcript-fold` (slice #4791
// adds that file and its L3 row together). Ranks order by purity: a file may
// import only from its own layer or a LOWER one, the barrel sitting on top.
// `src/cost/CONTEXT.md` mirrors this table; edit both together.
// ---------------------------------------------------------------------------

type Layer = "L1" | "L2" | "L3" | "L4" | "L5" | "L6" | "barrel";

const LAYER_RANK: Readonly<Record<Layer, number>> = {
  L1: 1,
  L2: 2,
  L3: 3,
  L4: 4,
  L5: 5,
  L6: 6,
  barrel: 7,
};

/** Basenames (no `.ts`) per layer, bottom-up. */
const COST_LAYERS: Readonly<Record<Layer, readonly string[]>> = {
  L1: ["token-math", "token-breakdown", "types", "oauth-meter-shape"],
  L2: ["config"],
  L3: ["eligibility", "snapshot-assembly"],
  L4: ["oauth-usage", "oauth-read-cache", "transcript-scan", "surrogate", "usage-by-issue"],
  L5: ["usage-tracker", "eligibility-usage"],
  L6: ["cost-by-class", "cost-per-merged-pr", "class-cost-efficiency", "weighted-quota-estimate"],
  barrel: ["index"],
};

/** basename (no extension) -> layer, for lookup. */
const LAYER_OF: ReadonlyMap<string, Layer> = new Map(
  (Object.keys(COST_LAYERS) as Layer[]).flatMap((layer) =>
    COST_LAYERS[layer].map((name) => [name, layer] as const),
  ),
);

/**
 * The purity line's exact forbidden-module list (ADR-0042 Decision 2 — an
 * exact list, do not widen it). Matched after stripping a leading `node:`.
 */
const FORBIDDEN_NODE_MODULES: ReadonlySet<string> = new Set([
  "fs",
  "fs/promises",
  "child_process",
  "net",
  "http",
  "https",
]);

// ---------------------------------------------------------------------------
// Import extraction — TypeScript compiler API, no regex (see file header)
// ---------------------------------------------------------------------------

type ImportEdge = {
  /** The raw module specifier exactly as written. */
  specifier: string;
  /** Clause-level classification: `import type` / `export type ... from` only. */
  kind: "value" | "type";
  /** 1-based line of the statement (of the dynamic call for `import()`). */
  line: number;
};

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/**
 * Parse every module reference in one TypeScript/JavaScript source: static
 * imports, `export … from` re-exports, and dynamic `import()` calls wherever
 * they sit. Comments and string contents never produce edges — the parser
 * reads syntax, not text.
 */
function parseImports(source: string, fileName: string, scriptKind: ts.ScriptKind): ImportEdge[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, scriptKind);
  const edges: ImportEdge[] = [];

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      edges.push({
        specifier: stmt.moduleSpecifier.text,
        kind: stmt.importClause?.isTypeOnly === true ? "type" : "value",
        line: lineOf(sf, stmt),
      });
    } else if (
      ts.isExportDeclaration(stmt) &&
      stmt.moduleSpecifier !== undefined &&
      ts.isStringLiteral(stmt.moduleSpecifier)
    ) {
      edges.push({
        specifier: stmt.moduleSpecifier.text,
        kind: stmt.isTypeOnly ? "type" : "value",
        line: lineOf(sf, stmt),
      });
    }
  }

  // Dynamic `import("...")` may sit anywhere (function bodies, expressions) —
  // walk the whole tree. Always a VALUE reference (ADR-0042 / grill INV-4).
  const walk = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      edges.push({
        specifier: (node.arguments[0] as ts.StringLiteral).text,
        kind: "value",
        line: lineOf(sf, node),
      });
    }
    node.forEachChild(walk);
  };
  walk(sf);

  return edges;
}

// ---------------------------------------------------------------------------
// Path resolution — repo-relative posix, deterministic
// ---------------------------------------------------------------------------

/**
 * Resolve a relative specifier imported by `fromRel` (repo-relative, posix) to
 * a repo-relative posix path, or null when it is not relative or escapes the
 * repo root.
 */
function resolveSpecifier(fromRel: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const joined = posix.normalize(posix.join(posix.dirname(fromRel), spec));
  if (joined.startsWith("..") || posix.isAbsolute(joined)) return null;
  return joined;
}

/**
 * Normalise a resolved path into a concrete `src/cost/*.ts` file path, or null
 * when the target is outside `src/cost/`. A bare directory reference to
 * `src/cost` is the barrel (`src/cost/index.ts`); extension-less targets get
 * `.ts` appended (NodeNext + rewriteRelativeImportExtensions make both rare).
 */
function costTargetOf(resolved: string): string | null {
  if (resolved === COST_DIR_REL) return `${COST_DIR_REL}/index.ts`;
  if (!resolved.startsWith(`${COST_DIR_REL}/`)) return null;
  return resolved.endsWith(".ts") ? resolved : `${resolved}.ts`;
}

/** `src/cost/usage-tracker.ts` -> `usage-tracker` (null outside src/cost). */
function costBasename(fileRel: string): string | null {
  if (!fileRel.startsWith(`${COST_DIR_REL}/`) || !fileRel.endsWith(".ts")) return null;
  return posix.basename(fileRel, ".ts");
}

// ---------------------------------------------------------------------------
// Tree walking + edge collection
// ---------------------------------------------------------------------------

/**
 * Recursively list files under a repo-relative directory, filtered by
 * extension and relative sub-path predicate. Deterministic (sorted).
 */
function walkFiles(
  dirRel: string,
  keep: (rel: string, ext: string) => boolean,
): string[] {
  const out: string[] = [];
  const visit = (absDir: string, relDir: string): void => {
    for (const entry of readdirSync(absDir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const rel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        visit(join(absDir, entry.name), rel);
      } else if (entry.isFile()) {
        const ext = posix.extname(entry.name).slice(1);
        if (keep(rel, ext)) out.push(rel);
      }
    }
  };
  visit(join(REPO_ROOT, dirRel), dirRel);
  return out;
}

function readRel(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf8");
}

/** Parse every `src/cost/*.ts` file (non-recursive, `.d.ts` excluded). */
function costFileEdges(): Map<string, ImportEdge[]> {
  const files = readdirSync(join(REPO_ROOT, COST_DIR_REL))
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
    .sort()
    .map((f) => `${COST_DIR_REL}/${f}`);
  return new Map(files.map((f) => [f, parseImports(readRel(f), f, ts.ScriptKind.TS)]));
}

/**
 * Parse every file OUTSIDE `src/cost/` that the outside edge (check 5) walks:
 * every `.ts` file under `src/` (except `src/cost/` itself and `.d.ts`
 * artifacts) and every `.ts`/`.mts`/`.mjs`/`.js` file under `scripts/`.
 * `test/` and `dashboard/` are not walked.
 */
function outsideEdges(): { file: string; edges: ImportEdge[] }[] {
  const srcFiles = walkFiles("src", (rel, ext) =>
    ext === "ts" &&
    !rel.endsWith(".d.ts") &&
    !rel.startsWith(`${COST_DIR_REL}/`),
  );
  const scriptExts = new Set(["ts", "mts", "mjs", "js"]);
  const scriptFiles = walkFiles("scripts", (_rel, ext) => scriptExts.has(ext));
  return [...srcFiles, ...scriptFiles]
    .sort()
    .map((file) => ({
      file,
      edges: parseImports(readRel(file), file, ts.ScriptKind.TS),
    }));
}

// ---------------------------------------------------------------------------
// Value-import cycle detection (three-colour DFS, deterministic)
// ---------------------------------------------------------------------------

function findValueCycles(graph: Map<string, string[]>): string[][] {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const cycles: string[][] = [];

  const dfs = (node: string, path: string[]): void => {
    color.set(node, GRAY);
    path.push(node);
    for (const next of graph.get(node) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) {
        const start = path.indexOf(next);
        cycles.push([...path.slice(start), next]);
      } else if (c === WHITE) {
        dfs(next, path);
      }
    }
    path.pop();
    color.set(node, BLACK);
  };

  for (const node of [...graph.keys()].sort()) {
    if ((color.get(node) ?? WHITE) === WHITE) dfs(node, []);
  }
  return cycles;
}

// ---------------------------------------------------------------------------
// The five checks
// ---------------------------------------------------------------------------

describe("src/cost layer drift guard (ADR-0042)", () => {
  test("check 1 - every src/cost/*.ts file sits in exactly one layer", () => {
    const onDisk = [...readdirSync(join(REPO_ROOT, COST_DIR_REL))]
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
      .map((f) => f.replace(/\.ts$/, ""))
      .sort();

    const tableRows = (Object.keys(COST_LAYERS) as Layer[]).flatMap((layer) =>
      COST_LAYERS[layer].map((name) => ({ name, layer })),
    );
    const listedIn = new Map<string, Layer[]>();
    for (const { name, layer } of tableRows) {
      const layers = listedIn.get(name);
      if (layers === undefined) listedIn.set(name, [layer]);
      else layers.push(layer);
    }

    const duplicated = [...listedIn.entries()]
      .filter(([, layers]) => layers.length > 1)
      .map(([name, layers]) => `${name} (listed in ${layers.join(" AND ")})`)
      .sort();
    const unclassified = onDisk.filter((f) => !listedIn.has(f)).map((f) => `${COST_DIR_REL}/${f}.ts`);
    const stale = [...listedIn.keys()]
      .filter((f) => !onDisk.includes(f))
      .map((f) => `${COST_DIR_REL}/${f}.ts (still listed in ${listedIn.get(f)!.join("/")})`)
      .sort();

    assert.deepEqual(
      { duplicated, unclassified, stale },
      { duplicated: [], unclassified: [], stale: [] },
      `src/cost layer table drift (ADR-0042 Decisions 1+3):\n` +
        (unclassified.length > 0
          ? `  unclassified (add to COST_LAYERS here AND the table in src/cost/CONTEXT.md):\n` +
            unclassified.map((f) => `    ${f}`).join("\n") +
            `\n  Classify the file by purity — do not skip this by deleting the file's row.\n`
          : "") +
        (stale.length > 0
          ? `  stale rows (file deleted/renamed — remove the row here AND in src/cost/CONTEXT.md):\n` +
            stale.map((f) => `    ${f}`).join("\n") +
            `\n`
          : "") +
        (duplicated.length > 0
          ? `  duplicated (exactly one layer per file — ADR-0042 Decision 3 item 1):\n` +
            duplicated.map((f) => `    ${f}`).join("\n")
          : ""),
    );
  });

  test("check 2 - every intra-src/cost import (value or type) points same-layer or down", () => {
    const violations: string[] = [];
    for (const [file, edges] of costFileEdges()) {
      const fromName = costBasename(file)!;
      const fromLayer = LAYER_OF.get(fromName);
      assert.ok(fromLayer !== undefined, `${file} must be classified (check 1 guards this)`);
      for (const edge of edges) {
        const resolved = resolveSpecifier(file, edge.specifier);
        if (resolved === null) continue;
        const target = costTargetOf(resolved);
        if (target === null || target === file) continue;
        const toName = costBasename(target);
        const toLayer = toName === null ? undefined : LAYER_OF.get(toName);
        if (toLayer === undefined || toName === null) continue; // not a table file — check 1 owns that
        if (LAYER_RANK[toLayer] > LAYER_RANK[fromLayer]) {
          violations.push(
            `${file}:${edge.line} ${edge.kind}-imports "${edge.specifier}" ` +
              `(${target}, ${toLayer}) from ${fromLayer} — imports must point same-layer or DOWN ` +
              `(ADR-0042 Decision 1; type-only back-edges are NOT exempt). Clear it by moving ` +
              `vocabulary DOWN (Decision 5), never by blessing it in the table.`,
          );
        }
      }
    }
    assert.deepEqual(
      violations,
      [],
      `${violations.length} upward intra-src/cost import edge(s) (ADR-0042 Decision 1):\n` +
        violations.map((v) => `  ${v}`).join("\n"),
    );
  });

  test("check 3 - L1-L3 import no values across the purity line", () => {
    const violations: string[] = [];
    for (const [file, edges] of costFileEdges()) {
      const fromLayer = LAYER_OF.get(costBasename(file)!);
      assert.ok(fromLayer !== undefined, `${file} must be classified (check 1 guards this)`);
      if (LAYER_RANK[fromLayer] > LAYER_RANK.L3) continue; // purity line is L1-L3 only
      for (const edge of edges) {
        if (edge.kind !== "value") continue; // type-only ../redis/* is allowed (Decision 2)
        const bare = edge.specifier.replace(/^node:/, "");
        let reason: string | null = null;
        if (FORBIDDEN_NODE_MODULES.has(bare)) {
          reason = `node module "${edge.specifier}"`;
        } else {
          const resolved = resolveSpecifier(file, edge.specifier);
          if (resolved !== null) {
            if (resolved.startsWith("src/redis/")) {
              reason = `redis adapter ${resolved}`;
            } else if (resolved === "src/transcript-store.ts") {
              reason = `transcript store ${resolved}`;
            }
          }
        }
        if (reason !== null) {
          violations.push(
            `${file}:${edge.line} VALUE-imports ${reason} from ${fromLayer} — L1-L3 sit below ` +
              `the purity line: no value imports of node:fs*, node:child_process, node:net, ` +
              `node:http(s), ../redis/* or ../transcript-store (ADR-0042 Decision 2). ` +
              `process.env and ../logger.ts are allowed; type-only ../redis/* imports are allowed.`,
          );
        }
      }
    }
    assert.deepEqual(
      violations,
      [],
      `${violations.length} purity-line breach(es) (ADR-0042 Decision 2):\n` +
        violations.map((v) => `  ${v}`).join("\n"),
    );
  });

  test("check 4 - no value-import cycles inside src/cost", () => {
    const graph = new Map<string, string[]>();
    for (const [file, edges] of costFileEdges()) {
      const targets = new Set<string>();
      for (const edge of edges) {
        if (edge.kind !== "value") continue; // cycles are a value-import concern (Decision 3)
        const resolved = resolveSpecifier(file, edge.specifier);
        if (resolved === null) continue;
        const target = costTargetOf(resolved);
        if (target !== null && target !== file) {
          const toName = costBasename(target);
          if (toName !== null && LAYER_OF.has(toName)) targets.add(target);
        }
      }
      graph.set(file, [...targets].sort());
    }
    const cycles = findValueCycles(graph);
    assert.deepEqual(
      cycles,
      [],
      `${cycles.length} value-import cycle(s) inside src/cost (ADR-0042 Decision 3 item 4):\n` +
        cycles.map((c) => `  ${c.join(" -> ")}`).join("\n"),
    );
  });

  test("check 5 - src/ and scripts/ import src/cost only via index.ts or L1-L2 files", () => {
    const violations: string[] = [];
    for (const { file, edges } of outsideEdges()) {
      for (const edge of edges) {
        const resolved = resolveSpecifier(file, edge.specifier);
        if (resolved === null) continue;
        const target = costTargetOf(resolved);
        if (target === null) continue;
        const toName = costBasename(target);
        if (toName === null || toName === "index") continue; // the barrel IS the sanctioned route
        const toLayer = LAYER_OF.get(toName);
        if (toLayer === undefined) continue; // unknown target — check 1 owns classification
        if (LAYER_RANK[toLayer] > LAYER_RANK.L2) {
          violations.push(
            `${file}:${edge.line} imports "${edge.specifier}" (${target}, ${toLayer}) directly ` +
              `from outside src/cost — outside code may import L1-L2 files directly; L3 and ` +
              `above only through src/cost/index.ts (ADR-0042 Decision 4). test/ is exempt.`,
          );
        }
      }
    }
    assert.deepEqual(
      violations,
      [],
      `${violations.length} barrel-contract breach(es) (ADR-0042 Decision 4):\n` +
        violations.map((v) => `  ${v}`).join("\n"),
    );
  });
});

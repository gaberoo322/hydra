#!/usr/bin/env -S npx tsx
/**
 * Generated-inventories runner (issue #4589 — the inventory-pipeline tracer
 * bullet per the #4542 resolution, ADR-0034 §10).
 *
 *   npm run docs:inventories            write every family file + counts.json
 *   npm run docs:inventories -- --check write nothing; exit 1 with a per-family
 *                                       added/removed listing when a committed
 *                                       file is missing or differs, else exit 0
 *
 * The extractor (scripts/docs/inventories/routes.ts) is the one extraction
 * truth — this runner only builds the families, serializes them through the
 * shared envelope, and writes or compares. counts.json is computed from the
 * in-memory inventories this run just built, never hand-typed.
 *
 * Stdlib-only (ADR-0005): no dependency is added; `npx tsx` is the same
 * pinned-runner lane every other scripts/*.ts npm script uses.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serializeInventory } from "./inventories/envelope.ts";
import type { CountRow, CountsInventory, RouteRow, RoutesInventory } from "./inventories/envelope.ts";
import { extractRoutes } from "./inventories/routes.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Deterministic counts: rows sorted by family then metric; derived, never typed. */
function buildCounts(routes: RoutesInventory): CountsInventory {
  const routers = new Set(routes.rows.map((r) => r.source.path));
  const rows: CountRow[] = [
    { family: "routes", metric: "routers", value: routers.size },
    { family: "routes", metric: "routes", value: routes.rows.length },
  ];
  rows.sort((a, b) => (a.family === b.family ? (a.metric < b.metric ? -1 : 1) : a.family < b.family ? -1 : 1));
  return { family: "counts", schemaVersion: 1, generatedFrom: ["docs/generated/routes.json"], rows };
}

/** The `METHOD path` listing shape for a routes row. */
export function routeRowLabel(row: RouteRow): string {
  return `${row.method} ${row.path}`;
}

/** The `family/metric = value` listing shape for a counts row. */
export function countRowLabel(row: CountRow): string {
  return `${row.family}/${row.metric} = ${row.value}`;
}

/** Multiset added/removed diff between committed and fresh row labels (sorted). */
export function diffLabelMultiset(committed: string[], fresh: string[]): { added: string[]; removed: string[] } {
  const count = new Map<string, number>();
  for (const label of committed) count.set(label, (count.get(label) ?? 0) + 1);
  for (const label of fresh) count.set(label, (count.get(label) ?? 0) - 1);
  const added: string[] = [];
  const removed: string[] = [];
  for (const [label, n] of count) {
    for (let i = 0; i < Math.abs(n); i += 1) {
      if (n < 0) added.push(label);
      else if (n > 0) removed.push(label);
    }
  }
  return { added: added.sort(), removed: removed.sort() };
}

interface FamilyOutput {
  file: string;
  serialize: () => string;
  labels: () => string[];
}

function main(): void {
  const check = process.argv.includes("--check");

  const routes = extractRoutes(REPO_ROOT);
  const counts = buildCounts(routes);
  const outputs: FamilyOutput[] = [
    {
      file: "docs/generated/routes.json",
      serialize: () => serializeInventory(routes),
      labels: () => routes.rows.map(routeRowLabel),
    },
    {
      file: "docs/generated/counts.json",
      serialize: () => serializeInventory(counts),
      labels: () => counts.rows.map(countRowLabel),
    },
  ];

  if (!check) {
    mkdirSync(resolve(REPO_ROOT, "docs", "generated"), { recursive: true });
    for (const out of outputs) {
      writeFileSync(resolve(REPO_ROOT, out.file), out.serialize());
      console.log(`[docs-inventories] wrote ${out.file}`);
    }
    return;
  }

  let failed = false;
  for (const out of outputs) {
    const abs = resolve(REPO_ROOT, out.file);
    if (!existsSync(abs)) {
      console.error(`[docs-inventories] ${out.file}: MISSING`);
      failed = true;
      continue;
    }
    const committedRaw = readFileSync(abs, "utf8");
    const fresh = out.serialize();
    if (committedRaw === fresh) {
      console.log(`[docs-inventories] ${out.file}: OK`);
      continue;
    }
    failed = true;
    let committedLabels: string[] = [];
    try {
      committedLabels = ((JSON.parse(committedRaw).rows ?? []) as Array<RouteRow | CountRow>).map((row) =>
        "method" in row ? routeRowLabel(row as RouteRow) : countRowLabel(row as CountRow),
      );
    } catch {
      committedLabels = [];
    }
    const { added, removed } = diffLabelMultiset(committedLabels, out.labels());
    console.error(`[docs-inventories] ${out.file}: DRIFT`);
    for (const a of added) console.error(`  + ${a}`);
    for (const r of removed) console.error(`  - ${r}`);
    if (added.length === 0 && removed.length === 0) {
      console.error("  (row content identical — envelope fields differ; regenerate)");
    }
  }
  if (failed) {
    console.error("Fix: npm run docs:inventories");
    process.exitCode = 1;
  }
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  main();
}

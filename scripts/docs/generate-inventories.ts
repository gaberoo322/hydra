#!/usr/bin/env -S npx tsx
/**
 * Generated-inventories runner (issue #4589 — the inventory-pipeline tracer
 * bullet per the #4542 resolution, ADR-0034 §10; family registry #4594).
 *
 *   npm run docs:inventories            write every family file + counts.json
 *   npm run docs:inventories -- --check write nothing; exit 1 with a per-family
 *                                       added/removed listing when a committed
 *                                       file is missing or differs, else exit 0
 *
 * Each extractor (scripts/docs/inventories/<family>.ts) is its family's one
 * extraction truth — this runner only iterates the FAMILIES registry, builds
 * the families, serializes them through the shared envelope, and writes or
 * compares. counts.json is computed from the in-memory inventories this run
 * just built, never hand-typed.
 *
 * Stdlib-only (ADR-0005): no dependency is added; `npx tsx` is the same
 * pinned-runner lane every other scripts/*.ts npm script uses.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serializeInventory } from "./inventories/envelope.ts";
import type { CountRow, CountsInventory, Inventory, RouteRow, RoutesInventory } from "./inventories/envelope.ts";
import { choreRowLabel, extractChores } from "./inventories/chores.ts";
import { ciGateRowLabel, extractCiGates } from "./inventories/ci-gates.ts";
import { configRowLabel, extractConfig } from "./inventories/config.ts";
import { envVarRowLabel, extractEnvVars } from "./inventories/env-vars.ts";
import { extractPages, pageRowLabel } from "./inventories/pages.ts";
import { extractRedisKeys, redisKeyRowLabel } from "./inventories/redis-keys.ts";
import { extractRoutes } from "./inventories/routes.ts";
import { extractSchemas, schemaRowLabel } from "./inventories/schemas.ts";
import { extractStreams, streamRowLabel } from "./inventories/streams.ts";
import { extractTierPaths, tierPathRowLabel } from "./inventories/tier-paths.ts";
import { extractUnitsScripts, unitScriptRowLabel } from "./inventories/units-scripts.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** What a family extractor may depend on: the routes inventory, built once per run. */
export interface FamilyContext {
  routes: RoutesInventory;
}

/**
 * One registry entry per family (#4594). The runner's write mode, `--check`
 * (including its added/removed label diff), buildCounts and the drift test all
 * iterate THIS list — adding a family is one entry here, so the runner and the
 * test can never disagree about which families exist.
 */
export interface FamilyEntry {
  family: string;
  /** Repo-relative committed file: docs/generated/<family>.json. */
  file: string;
  extract: (repoRoot: string, ctx: FamilyContext) => Inventory<unknown>;
  /** The per-row listing label used by `--check` and the drift message. */
  label: (row: unknown) => string;
}

function entry<Row>(
  family: string,
  extract: (repoRoot: string, ctx: FamilyContext) => Inventory<Row>,
  label: (row: Row) => string,
): FamilyEntry {
  return {
    family,
    file: `docs/generated/${family}.json`,
    extract: extract as (repoRoot: string, ctx: FamilyContext) => Inventory<unknown>,
    label: label as (row: unknown) => string,
  };
}

/** The `METHOD path` listing shape for a routes row. */
export function routeRowLabel(row: RouteRow): string {
  return `${row.method} ${row.path}`;
}

/** The `family/metric = value` listing shape for a counts row. */
export function countRowLabel(row: CountRow): string {
  return `${row.family}/${row.metric} = ${row.value}`;
}

/** The single family registry. `routes` is first: later families join through its rows. */
export const FAMILIES: readonly FamilyEntry[] = Object.freeze([
  entry("routes", (_root, ctx) => ctx.routes, routeRowLabel),
  entry("redis-keys", (root, ctx) => extractRedisKeys(root, ctx.routes.rows), redisKeyRowLabel),
  entry("streams", (root, ctx) => extractStreams(root, ctx.routes.rows), streamRowLabel),
  entry("schemas", (root, ctx) => extractSchemas(root, ctx.routes.rows), schemaRowLabel),
  entry("tier-paths", (root) => extractTierPaths(root), tierPathRowLabel),
  entry("chores", (root) => extractChores(root), choreRowLabel),
  entry("env-vars", (root) => extractEnvVars(root), envVarRowLabel),
  entry("pages", (root) => extractPages(root), pageRowLabel),
  entry("config", (root) => extractConfig(root), configRowLabel),
  entry("ci-gates", (root) => extractCiGates(root), ciGateRowLabel),
  entry("units-scripts", (root) => extractUnitsScripts(root), unitScriptRowLabel),
]);

/** counts.json is derived FROM the families, so it follows the registry rather than sitting in it. */
export const COUNTS_FILE = "docs/generated/counts.json";

/** Build every registered family's inventory, in registry order. */
export function buildAllInventories(repoRoot: string): Map<string, Inventory<unknown>> {
  const ctx: FamilyContext = { routes: extractRoutes(repoRoot) };
  const out = new Map<string, Inventory<unknown>>();
  for (const fam of FAMILIES) out.set(fam.family, fam.extract(repoRoot, ctx));
  return out;
}

/**
 * Per-family derived metrics beyond `<family>/rows` (#4595): each is a row
 * predicate, so every value is COUNTED from the inventory, never typed.
 */
const FAMILY_METRICS: Record<string, Array<[string, (row: unknown) => boolean]>> = {
  pages: [["in-nav", (r) => (r as { inNav?: boolean }).inNav === true]],
  config: [
    ["unread", (r) => (r as { unread?: boolean }).unread === true],
    ["missing-sections", (r) => (r as { kind?: string; exists?: boolean }).kind === "section" && (r as { exists?: boolean }).exists === false],
  ],
  "ci-gates": [["required", (r) => (r as { required?: boolean }).required === true]],
};

/**
 * Deterministic counts: rows sorted by family then metric; derived, never
 * typed. routes/routers + routes/routes are unchanged; every family adds
 * `<family>/rows`, redis-keys adds `redis-keys/retired`, and FAMILY_METRICS
 * adds pages/in-nav, config/unread, config/missing-sections, ci-gates/required. generatedFrom
 * lists every docs/generated/<family>.json it derives from.
 */
export function buildCounts(inventories: Map<string, Inventory<unknown>>): CountsInventory {
  const rows: CountRow[] = [];
  const routes = inventories.get("routes") as RoutesInventory | undefined;
  if (routes) {
    const routers = new Set(routes.rows.map((r) => r.source.path));
    rows.push({ family: "routes", metric: "routers", value: routers.size });
    rows.push({ family: "routes", metric: "routes", value: routes.rows.length });
  }
  for (const [family, inv] of inventories) {
    rows.push({ family, metric: "rows", value: inv.rows.length });
    if (family === "redis-keys") {
      const retired = (inv.rows as Array<{ retired?: boolean }>).filter((r) => r.retired === true).length;
      rows.push({ family, metric: "retired", value: retired });
    }
    for (const [metric, count] of FAMILY_METRICS[family] ?? []) {
      rows.push({ family, metric, value: (inv.rows as unknown[]).filter(count).length });
    }
  }
  rows.sort((a, b) => (a.family === b.family ? (a.metric < b.metric ? -1 : 1) : a.family < b.family ? -1 : 1));
  const generatedFrom = [...inventories.keys()].map((f) => `docs/generated/${f}.json`).sort();
  return { family: "counts", schemaVersion: 1, generatedFrom, rows };
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
  label: (row: unknown) => string;
}

function main(): void {
  const check = process.argv.includes("--check");

  const inventories = buildAllInventories(REPO_ROOT);
  const counts = buildCounts(inventories);
  const outputs: FamilyOutput[] = FAMILIES.map((fam) => {
    const inv = inventories.get(fam.family) as Inventory<unknown>;
    return {
      file: fam.file,
      serialize: () => serializeInventory(inv),
      labels: () => inv.rows.map(fam.label),
      label: fam.label,
    };
  });
  outputs.push({
    file: COUNTS_FILE,
    serialize: () => serializeInventory(counts),
    labels: () => counts.rows.map(countRowLabel),
    label: (row) => countRowLabel(row as CountRow),
  });

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
      committedLabels = ((JSON.parse(committedRaw).rows ?? []) as unknown[]).map((row) => out.label(row));
    } catch (err) {
      /* intentional: committedRaw is an unparseable/legacy committed file; falling back to an
       * empty label list only degrades the DRIFT diagnostic's added/removed listing below —
       * `failed` is already true and the exit code is unaffected. */
      console.error(`[docs-inventories] ${out.file}: could not parse committed rows for diff — ${err}`);
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

/**
 * redis-keys family extractor (issue #4594 — docs-epic 8/13, per the #4542
 * families table and ADR-0034 §10).
 *
 * One row per member of the imported key-builder object in src/redis/keys.ts
 * (keys inlined in other src/redis/*.ts adapters are out of this slice). The
 * pattern is the builder invoked with `{param}` placeholders; call sites are
 * member-access tokens in src/ + scripts/ outside keys.ts with comments
 * stripped; accessors are the Redis Adapters (src/redis/*.ts) among them.
 * Homes join through the routes inventory at ONE direct import hop.
 *
 * Retired families (REF-02/03/04) are a declared list: each emits a
 * `retired: true` row ONLY while a src/redis/*.ts adapter still references the
 * literal in CODE — a comment mention never counts.
 *
 * Read-only: src/redis/keys.ts is imported (it has no runtime-dep imports) and
 * never modified. Stdlib-only (ADR-0005). Fail-loud (CLAUDE.md).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { redisKeys } from "../../../src/redis/keys.ts";
import type { RedisKeyRow, RedisKeysInventory, RouteRow } from "./envelope.ts";
import { extractRoutes } from "./routes.ts";
import { byString, fail, lineOf, relativeImports, serveJoin, stripComments, walkFiles } from "./scan.ts";
import type { JoinRoute, SourceFile } from "./scan.ts";

const KEYS_FILE = "src/redis/keys.ts";

const GENERATED_FROM = ["src/redis/keys.ts", "src/**/*.ts", "scripts/**/*.ts", "docs/generated/routes.json"];

/** REF-02/03/04 retired families — declared, never discovered. */
export const RETIRED_FAMILIES: readonly string[] = Object.freeze([
  "hydra:cycle:{id}:agents",
  "hydra:cycle:{id}:costs",
  "hydra:proposals:*",
  "hydra:plans:cache",
  "hydra:pattern-detector:cooldowns",
  "hydra:workspace:lock",
  "hydra:specs:*",
  "hydra:scheduler:daily-spend",
]);

/**
 * Parameter names of a builder from Function.prototype.toString. Handles
 * `() =>`, `(a, b) =>`, `a =>` and `function (a) {`; type annotations and
 * defaults (whatever survives transpilation) are dropped. Fails loud when a
 * parameter name cannot be parsed.
 */
export function parseParams(name: string, fn: (...args: string[]) => unknown): string[] {
  const text = Function.prototype.toString.call(fn);
  let list: string;
  const paren = text.match(/^\s*(?:async\s+)?(?:function\b[^(]*)?\(([^)]*)\)/);
  if (paren) {
    list = paren[1];
  } else {
    const bare = text.match(/^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/);
    if (!bare) fail(`${KEYS_FILE}: cannot parse the parameter list of builder "${name}"`);
    list = bare[1];
  }
  const params: string[] = [];
  for (const raw of list.split(",")) {
    const part = raw.trim();
    if (part === "") continue;
    const m = part.match(/^([A-Za-z_$][\w$]*)\s*(?:[:=?].*)?$/s);
    if (!m) fail(`${KEYS_FILE}: cannot parse parameter "${part}" of builder "${name}"`);
    params.push(m[1]);
  }
  return params;
}

/** A retired literal as a code matcher: `{x}` and `*` match a template hole or a literal tail. */
function retiredMatcher(pattern: string): RegExp {
  const hole = "(?:\\$\\{[^}]*\\}|[^\"'`\\s]*)";
  let re = "";
  for (const part of pattern.split(/(\{[^}]+\}|\*)/)) {
    if (part === "") continue;
    if (part === "*" || /^\{[^}]+\}$/.test(part)) re += hole;
    else re += part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(re, "g");
}

const ADAPTER_RE = /^src\/redis\/[^/]+\.ts$/;
const ROUTER_RE = /^src\/api\/[^/]+\.ts$/;

export interface RedisKeyInputs {
  /** The imported key-builder object. */
  builders: Record<string, unknown>;
  /** Raw text of src/redis/keys.ts (for each builder's source line). */
  keysSource: string;
  /** Every scanned src/**\/*.ts + scripts/**\/*.ts file EXCEPT keys.ts, raw text. */
  files: SourceFile[];
  /** Routes rows for the home join. */
  routes: JoinRoute[];
}

/** Pure row-builder: injected inputs in, sorted rows out. */
export function buildRedisKeyRows(inputs: RedisKeyInputs): RedisKeyRow[] {
  const stripped = inputs.files
    .filter((f) => f.path !== KEYS_FILE)
    .map((f) => ({ path: f.path, code: stripComments(f.src) }));

  // Router file → the set of repo-relative files it directly imports.
  const routerImports = new Map<string, Set<string>>();
  for (const f of stripped) {
    if (!ROUTER_RE.test(f.path)) continue;
    routerImports.set(f.path, new Set(relativeImports(f.path, f.code).map((i) => i.target)));
  }
  const servingFor = (accessors: string[]): Set<string> => {
    const serving = new Set<string>();
    for (const [router, targets] of routerImports) {
      if (accessors.some((a) => targets.has(a))) serving.add(router);
    }
    return serving;
  };

  // Tally every member-access token in one pass.
  const tokenRe = new RegExp(`\\bredisKeys\\.([A-Za-z_$][\\w$]*)`, "g");
  const counts = new Map<string, number>();
  const filesByBuilder = new Map<string, Set<string>>();
  for (const f of stripped) {
    for (const m of f.code.matchAll(tokenRe)) {
      counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
      const set = filesByBuilder.get(m[1]) ?? new Set<string>();
      set.add(f.path);
      filesByBuilder.set(m[1], set);
    }
  }

  const rows: RedisKeyRow[] = [];
  for (const [builder, fn] of Object.entries(inputs.builders)) {
    if (typeof fn !== "function") fail(`${KEYS_FILE}: member "${builder}" is not a builder function`);
    const params = parseParams(builder, fn as (...args: string[]) => unknown);
    const pattern = (fn as (...args: string[]) => unknown)(...params.map((p) => `{${p}}`));
    if (typeof pattern !== "string") fail(`${KEYS_FILE}: builder "${builder}" returned a non-string`);
    const at = inputs.keysSource.search(new RegExp(`^[ \\t]*${builder.replace(/\$/g, "\\$")}\\s*:`, "m"));
    if (at === -1) fail(`${KEYS_FILE}: no "${builder}:" line found for builder "${builder}"`);
    const accessors = [...(filesByBuilder.get(builder) ?? new Set<string>())].filter((p) => ADAPTER_RE.test(p)).sort(byString);
    const { servedBy, home } = serveJoin(inputs.routes, servingFor(accessors));
    rows.push({
      builder,
      pattern,
      params,
      callSites: counts.get(builder) ?? 0,
      accessors,
      servedBy,
      home,
      retired: false,
      source: { path: KEYS_FILE, line: lineOf(inputs.keysSource, at) },
    });
  }

  for (const pattern of RETIRED_FAMILIES) {
    const re = retiredMatcher(pattern);
    const refs: Array<{ path: string; line: number }> = [];
    for (const f of stripped) {
      if (!ADAPTER_RE.test(f.path)) continue;
      for (const m of f.code.matchAll(re)) refs.push({ path: f.path, line: lineOf(f.code, m.index ?? 0) });
    }
    if (refs.length === 0) continue; // retired and unreferenced in code → no row
    refs.sort((a, b) => (a.path === b.path ? a.line - b.line : byString(a.path, b.path)));
    const accessors = [...new Set(refs.map((r) => r.path))].sort(byString);
    const { servedBy, home } = serveJoin(inputs.routes, servingFor(accessors));
    rows.push({
      builder: null,
      pattern,
      params: [...pattern.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]),
      callSites: refs.length,
      accessors,
      servedBy,
      home,
      retired: true,
      source: refs[0],
    });
  }

  rows.sort((a, b) => byString(redisKeyRowLabel(a), redisKeyRowLabel(b)));
  return rows;
}

/** The listing/sort label of a redis-keys row: the builder, or `retired <pattern>`. */
export function redisKeyRowLabel(row: RedisKeyRow): string {
  return row.builder ?? `retired ${row.pattern}`;
}

/** Every scanned file for the call-site tally: src/**\/*.ts + scripts/**\/*.ts. */
export function listCodeFiles(repoRoot: string): SourceFile[] {
  const isTs = (n: string): boolean => n.endsWith(".ts");
  return [...walkFiles(repoRoot, "src", isTs), ...walkFiles(repoRoot, "scripts", isTs)].map((path) => ({
    path,
    src: readFileSync(join(repoRoot, path), "utf8"),
  }));
}

export function extractRedisKeys(repoRoot: string, routes?: RouteRow[]): RedisKeysInventory {
  const rows = buildRedisKeyRows({
    builders: redisKeys as Record<string, unknown>,
    keysSource: readFileSync(join(repoRoot, KEYS_FILE), "utf8"),
    files: listCodeFiles(repoRoot),
    routes: routes ?? extractRoutes(repoRoot).rows,
  });
  return { family: "redis-keys", schemaVersion: 1, generatedFrom: GENERATED_FROM, rows };
}

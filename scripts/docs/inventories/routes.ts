/**
 * Routes family extractor (issue #4589 — inventory-pipeline tracer bullet per
 * the #4542 resolution; rules ratified on #4545 and encoded here).
 *
 * `extractRoutes(repoRoot)` is the ONE extraction truth: the runner
 * (scripts/docs/generate-inventories.ts) and the drift test
 * (test/generated-inventories-drift.test.mts) both call it, so a committed
 * docs/generated/routes.json can never disagree with a fresh run for a reason
 * other than genuine drift.
 *
 * Sources read (never written):
 *   - src/api.ts + src/api/*.ts (minus route-helpers.ts) — route registrations
 *   - dashboard/src/** — consumer call sites and the App.jsx page map
 *
 * Stdlib-only (ADR-0005). This module never reads CONTEXT-MAP.md — the Area →
 * CONTEXT-MAP row join is slice #4596's, not the extractor's.
 *
 * Extraction is FAIL-LOUD by design (CLAUDE.md): a computed route path, an
 * unknown `@stability` value, or a router that is never mounted in src/api.ts
 * throws — none of them silently degrade into a wrong-but-green catalogue.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { RouteRow, RoutesInventory, Stability } from "./envelope.ts";

/** Extraction errors throw with this prefix so tests and humans can tell them from I/O failures. */
function fail(message: string): never {
  throw new Error(`[docs-inventories] ${message}`);
}

function toPosix(p: string): string {
  return p.split("\\").join("/");
}

/** 1-based line number of the character at `index` in `src`. */
function lineOf(src: string, index: number): number {
  return src.slice(0, index).split("\n").length;
}

// ---------------------------------------------------------------------------
// Server side: route registrations, mounts, stability, areas
// ---------------------------------------------------------------------------

/** The registry recipe made newline-tolerant: the path literal may sit on the line after the `(`. */
const VERB_RE = /\b(router|app|api)\.(get|post|put|patch|delete)\(/g;

interface Registration {
  method: string;
  /** Full path INCLUDING the /api prefix (routers mount at the bare /api base). */
  path: string;
  /** 1-based line of the `router.<verb>(` token. */
  line: number;
}

function extractRegistrations(relFile: string, src: string): Registration[] {
  const out: Registration[] = [];
  for (const m of src.matchAll(VERB_RE)) {
    const at = m.index ?? 0;
    const line = lineOf(src, at);
    const rest = src.slice(at + m[0].length);
    const lead = rest.match(/^\s*/);
    const after = rest.slice(lead ? lead[0].length : 0);
    const quote = after[0];
    if (quote !== '"' && quote !== "'" && quote !== "`") {
      fail(
        `${relFile}:${line}: ${m[0].slice(0, -1)} is not followed by a path literal — computed route paths are an extraction error`,
      );
    }
    const close = after.indexOf(quote, 1);
    if (close === -1) {
      fail(`${relFile}:${line}: unterminated path literal after ${m[0].slice(0, -1)}`);
    }
    out.push({ method: m[2].toUpperCase(), path: `/api${after.slice(1, close)}`, line });
  }
  return out;
}

/**
 * `@stability` grammar (ADR-0024 §3 as amended by #4587): the annotation sits
 * somewhere inside the contiguous `//` comment block immediately above the
 * registration — a blank or code line ends the block. Absent = stable. Any
 * value other than deprecated/experimental is an extraction error: a typo must
 * never silently read as stable.
 */
function readStability(
  relFile: string,
  lines: string[],
  regLine: number,
): { stability: Stability; note: string | null } {
  for (let i = regLine - 2; i >= 0; i -= 1) {
    const text = lines[i].trim();
    if (!text.startsWith("//")) break; // blank or code line ends the contiguous block
    const m = text.match(/@stability\s+(\S+)/);
    if (!m) continue;
    const value = m[1];
    if (value !== "deprecated" && value !== "experimental") {
      fail(`${relFile}:${i + 1}: unknown @stability value "${value}" (expected deprecated|experimental)`);
    }
    const after = text.slice(text.indexOf(m[0]) + m[0].length);
    const dash = after.indexOf("—");
    const note = dash === -1 ? null : after.slice(dash + 1).trim();
    return { stability: value, note: note && note.length > 0 ? note : null };
  }
  return { stability: "stable", note: null };
}

/** Factories called as `api.use(<factory>(` in src/api.ts — the mounted set. */
function mountedFactories(apiSrc: string): Set<string> {
  const mounted = new Set<string>();
  for (const m of apiSrc.matchAll(/\bapi\.use\(\s*(\w+)\s*\(/g)) {
    mounted.add(m[1]);
  }
  return mounted;
}

/** Router factory exports (`export function createXRouter(`) of one router file. */
function routerFactories(src: string): string[] {
  return [...src.matchAll(/export function (create\w+Router)\s*\(/g)].map((m) => m[1]);
}

/**
 * Areas (finding 1, ratified): the sorted distinct set of the router file's
 * FIRST-PARTY import targets — `from "<relative>"` specifiers only, so package
 * and node: imports never appear — collapsed to `src/<dir>/` for directory
 * modules and `src/<file>.ts` for top-level files. Redis accessors, schemas
 * and type-only imports all count; `src/api/` siblings (route-helpers) do not.
 */
function extractAreas(repoRoot: string, relFile: string, src: string): string[] {
  const areas = new Set<string>();
  const dirAbs = join(repoRoot, dirnameOf(relFile));
  for (const m of src.matchAll(/\bfrom\s+["'](\.[^"']+)["']/g)) {
    const target = toPosix(relative(repoRoot, resolve(dirAbs, m[1])));
    if (!target.startsWith("src/")) continue;
    if (target.startsWith("src/api/")) continue;
    const parts = target.split("/");
    areas.add(parts.length <= 2 ? target : `${parts[0]}/${parts[1]}/`);
  }
  return [...areas].sort();
}

/** posix-style dirname over repo-relative forward-slash paths. */
function dirnameOf(relPath: string): string {
  const i = relPath.lastIndexOf("/");
  return i === -1 ? "." : relPath.slice(0, i);
}

/** src/api.ts + src/api/*.ts, minus the non-router helper. */
function listRouterFiles(repoRoot: string): string[] {
  const files = ["src/api.ts"];
  const dir = join(repoRoot, "src", "api");
  for (const entry of readdirSync(dir)) {
    if (entry.endsWith(".ts")) files.push(`src/api/${entry}`);
  }
  return files.filter((f) => f !== "src/api/route-helpers.ts").sort();
}

// ---------------------------------------------------------------------------
// Dashboard side: consumers, page map, homes
// ---------------------------------------------------------------------------

/** The four dashboard call forms (INV-8); the first argument must be a literal. */
const CALL_RE = /\b(?:useApi|usePageItems|apiFetch|fetch)\(\s*(["'`])([^"'`]*)\1/g;

/**
 * Normalise a call-site literal to a matchable path pattern: strip a leading
 * `${API_BASE}`, then a leading `/api`, then the `?query` suffix. Returns null
 * when the literal is not a path-shaped first argument — notably useApi.js's
 * own `fetch(`${API_BASE}${path}`)`, whose remainder starts with `${`, not `/`.
 */
function normalizeCallLiteral(raw: string): string | null {
  let s = raw;
  if (s.startsWith("${API_BASE}")) s = s.slice("${API_BASE}".length);
  if (!s.startsWith("/")) return null;
  if (s.startsWith("/api")) s = s.slice("/api".length);
  if (!s.startsWith("/")) return null;
  const q = s.indexOf("?");
  if (q !== -1) s = s.slice(0, q);
  return s.length > 1 ? s : null;
}

function segmentsOf(pattern: string): string[] {
  return pattern.split("/").filter((s) => s.length > 0);
}

/** A whole-segment `${…}` template hole — matches any `:param` route segment. */
function isTemplateSeg(seg: string): boolean {
  return seg.startsWith("${") && seg.endsWith("}");
}

/** Path-only match (a GET and a POST on one path share consumers). */
function patternMatchesRoute(patternSegs: string[], routePath: string): boolean {
  const routeSegs = segmentsOf(routePath.slice("/api".length));
  if (patternSegs.length !== routeSegs.length) return false;
  return routeSegs.every((rs, idx) => {
    const cs = patternSegs[idx];
    return isTemplateSeg(cs) ? rs.startsWith(":") : rs === cs;
  });
}

function listDashboardFiles(repoRoot: string): string[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(join(abs, entry.name), childRel);
      } else if (/\.(js|jsx|ts|tsx)$/.test(entry.name)) {
        out.push(`dashboard/src/${childRel}`);
      }
    }
  };
  walk(join(repoRoot, "dashboard", "src"), "");
  return out.sort();
}

/** Import-name → repo-relative specifier target, from App.jsx's relative imports. */
function appImportMap(appSrc: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of appSrc.matchAll(/import\s+([^"']+?)\s+from\s+["'](\.[^"']+)["']/g)) {
    const spec = m[2];
    for (const name of m[1].match(/[A-Za-z_$][\w$]*/g) ?? []) {
      if (name === "type") continue;
      map.set(name, `dashboard/src/${spec.slice(2)}`);
    }
  }
  return map;
}

interface PageCandidate {
  /** The page route's own path (never contains `:`). */
  path: string;
  /** Repo-relative dashboard/src file rendering it. */
  file: string;
}

/**
 * Home candidates in App.jsx source order (finding 2, ratified): a page route
 * with a `:param` is never a home, a redirect (`<Navigate>` inline or via an
 * App.jsx-defined component whose body renders one) is never a home. An inline
 * element component (e.g. NowRoute) resolves through the first App.jsx-imported
 * component its body renders (NowRoute → NowConsole → /now).
 */
function homeCandidates(appSrc: string): PageCandidate[] {
  const imports = appImportMap(appSrc);
  const firstUpperCaseTag = (text: string): string | null => {
    const m = text.match(/<([A-Z][\w$]*)/);
    return m ? m[1] : null;
  };
  const resolveInline = (name: string): { redirect: boolean; file: string | null } => {
    const defAt = appSrc.search(new RegExp(`function\\s+${name}\\s*\\(`));
    if (defAt === -1) return { redirect: false, file: null };
    const bodyStart = appSrc.indexOf("{", appSrc.indexOf(")", defAt));
    const bodyEnd = appSrc.indexOf("\n}", bodyStart);
    const body = appSrc.slice(bodyStart, bodyEnd === -1 ? undefined : bodyEnd);
    if (body.includes("<Navigate")) return { redirect: true, file: null };
    const tag = firstUpperCaseTag(body);
    return { redirect: false, file: tag && imports.has(tag) ? imports.get(tag) ?? null : null };
  };

  const candidates: PageCandidate[] = [];
  for (const m of appSrc.matchAll(/<Route\s+path="([^"]+)"\s+element=\{([\s\S]*?)\}\s*\/>/g)) {
    const path = m[1];
    if (path.includes(":")) continue; // a :param detail page is never a home
    const element = m[2];
    if (element.includes("<Navigate")) continue; // a redirect route is never a home
    const tag = firstUpperCaseTag(element);
    if (!tag) continue;
    if (imports.has(tag)) {
      candidates.push({ path, file: imports.get(tag) ?? "" });
      continue;
    }
    const inline = resolveInline(tag);
    if (inline.redirect || !inline.file) continue;
    candidates.push({ path, file: inline.file });
  }
  return candidates;
}

/** Reverse-reachable set of `start` over the dashboard/src relative-import graph (start included). */
function reachableFrom(start: string, graph: Map<string, string[]>): Set<string> {
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const next of graph.get(cur) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------
// The one extraction truth
// ---------------------------------------------------------------------------

const GENERATED_FROM = ["src/api.ts", "src/api/*.ts", "dashboard/src/**"];

export function extractRoutes(repoRoot: string): RoutesInventory {
  // --- server side ---------------------------------------------------------
  const apiSrc = readFileSync(join(repoRoot, "src", "api.ts"), "utf8");
  const mounted = mountedFactories(apiSrc);

  const rows: RouteRow[] = [];
  for (const relFile of listRouterFiles(repoRoot)) {
    const src = readFileSync(join(repoRoot, relFile), "utf8");
    const registrations = extractRegistrations(relFile, src);
    if (registrations.length === 0) continue;
    if (relFile !== "src/api.ts") {
      const factories = routerFactories(src);
      if (factories.length === 0) {
        fail(`${relFile}: registers routes but exports no createXRouter factory — cannot verify the src/api.ts mount`);
      }
      if (!factories.some((f) => mounted.has(f))) {
        fail(`${relFile}: registers routes but is never mounted in src/api.ts — an unmounted router is an extraction error, not a warning`);
      }
    }
    const lines = src.split("\n");
    const areas = extractAreas(repoRoot, relFile, src);
    for (const reg of registrations) {
      const { stability, note } = readStability(relFile, lines, reg.line);
      rows.push({
        method: reg.method,
        path: reg.path,
        stability,
        stabilityNote: note,
        consumers: [],
        home: "",
        areas,
        source: { path: relFile, line: reg.line },
      });
    }
  }
  rows.sort((a, b) =>
    a.source.path === b.source.path ? a.source.line - b.source.line : a.source.path < b.source.path ? -1 : 1,
  );

  // --- dashboard side ------------------------------------------------------
  const files = listDashboardFiles(repoRoot);
  const contents = new Map<string, string>();
  for (const file of files) {
    contents.set(file, readFileSync(join(repoRoot, file), "utf8"));
  }

  const consumerFilesByPath = new Map<string, Set<string>>();
  for (const file of files) {
    for (const m of contents.get(file).matchAll(CALL_RE)) {
      const pattern = normalizeCallLiteral(m[2]);
      if (!pattern) continue;
      const segs = segmentsOf(pattern);
      for (const row of rows) {
        if (patternMatchesRoute(segs, row.path)) {
          const set = consumerFilesByPath.get(row.path) ?? new Set<string>();
          set.add(file);
          consumerFilesByPath.set(row.path, set);
        }
      }
    }
  }

  const graph = new Map<string, string[]>();
  const fileSet = new Set(files);
  for (const file of files) {
    const edges: string[] = [];
    for (const m of contents.get(file).matchAll(/\bfrom\s+["'](\.[^"']+)["']/g)) {
      const target = normalizeRel(dirnameOf(file), m[1]);
      if (fileSet.has(target)) edges.push(target);
    }
    graph.set(file, edges);
  }

  const appSrcDash = contents.get("dashboard/src/App.jsx");
  if (appSrcDash === undefined) {
    fail("dashboard/src/App.jsx is missing — the home map cannot be built");
  }
  const candidates = homeCandidates(appSrcDash);
  const closures = new Map<string, Set<string>>();
  const closureOf = (file: string): Set<string> => {
    let c = closures.get(file);
    if (!c) {
      c = reachableFrom(file, graph);
      closures.set(file, c);
    }
    return c;
  };

  const homeByPath = new Map<string, string>();
  for (const row of rows) {
    const consumers = consumerFilesByPath.get(row.path) ?? new Set<string>();
    let home: string | null = null;
    for (const cand of candidates) {
      const closure = closureOf(cand.file);
      if ([...consumers].some((c) => closure.has(c))) {
        home = cand.path;
        break;
      }
    }
    homeByPath.set(row.path, home ?? row.path); // no consumer page → the route's own /api path
  }

  for (const row of rows) {
    row.consumers = [...(consumerFilesByPath.get(row.path) ?? new Set<string>())].sort();
    row.home = homeByPath.get(row.path) ?? row.path;
  }

  return { family: "routes", schemaVersion: 1, generatedFrom: GENERATED_FROM, rows };
}

/** Resolve a relative specifier against its importer's directory into a repo-relative path. */
function normalizeRel(dirRel: string, spec: string): string {
  const parts = (dirRel === "." ? [] : dirRel.split("/")).concat(spec.split("/"));
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

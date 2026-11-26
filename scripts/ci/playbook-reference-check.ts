#!/usr/bin/env -S npx tsx
/**
 * Playbook reference check — issue #5499 (parent epic #5492).
 *
 * # The gap this closes
 *
 * Operator playbooks cite repository paths, Orchestrator API routes, npm
 * scripts, ADR numbers and code symbols. The existing skill guards are
 * structural (class ↔ skill mapping, `@include` wiring, the size ratchet, the
 * install mirror); none of them notices when a cited thing is deleted or
 * renamed, so a playbook keeps instructing agents to use it. This check
 * extracts every such reference from every playbook and fragment and fails
 * when one does not resolve, unless it is recorded in a SHRINK-ONLY baseline:
 *
 *   - unresolved reference not in the baseline     → FAIL (fix the playbook,
 *                                                     or mark an illustrative
 *                                                     example, see below)
 *   - baseline entry that now resolves or is gone  → FAIL (lower the baseline
 *                                                     with --write-baseline)
 *
 * # What is resolved
 *
 *   path    a repo-rooted file or directory cite            → the working tree
 *   route   an `/api/...` cite                              → docs/generated/routes.json
 *   npm     an `npm run <script>` cite                      → package.json scripts
 *   adr     an `ADR-NNNN` cite                              → docs/generated/adrs.json
 *   superseded-adr  the same cite, when the inventory marks that ADR `superseded`
 *   symbol  a code identifier attributed to a cited file    → that file's text
 *
 * A symbol is attributed only by an attribution phrase ("`sym` in `file`",
 * "`file`'s `sym`"); two code spans joined by a comma or "and" are a list.
 *
 * Target-side references are NOT checked, because the Target repo is not in
 * this checkout: an `npm run` cite in a Target playbook (basename starting
 * `hydra-target-` / `target-`) or on a line that says `Target-side` or reads a
 * `TARGET_` variable, and a route on the Target's own base URL
 * (`$TARGET_WEB_URL/api/...`).
 *
 * # Illustrative examples
 *
 * A placeholder path in a good/bad sample is not a claim about the repo. A path
 * or route with a metasyntactic segment (`foo`, `bar`, `baz`, `qux`)
 * is skipped automatically. Mark any other illustration instead of baselining
 * it:
 *
 *   one line:  put `ref-check: example` anywhere on the line (an HTML comment
 *              in prose, a `#` comment in a shell block)
 *   a block:   `<!-- ref-check: example-start -->` … `<!-- ref-check: example-end -->`
 *              (a start with no end exempts nothing)
 *
 * # Why a test, not a workflow
 *
 * The check runs from test/playbook-reference-check.test.mts inside the
 * required `test` job, so it can block a merge. A sibling workflow could not.
 *
 * Usage:
 *   npx tsx scripts/ci/playbook-reference-check.ts                    # check
 *   npx tsx scripts/ci/playbook-reference-check.ts --write-baseline   # (re)seed
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { defineRatchet, runIfCli } from "./ratchet.ts";
import { REPO_ROOT, escapeRegExp } from "./seam-check-lib.ts";

const PLAYBOOKS_REL = "docs/operator-playbooks";
const FRAGMENTS_REL = `${PLAYBOOKS_REL}/_fragments`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReferenceKind = "path" | "route" | "npm" | "adr" | "superseded-adr" | "symbol";

/** One thing a playbook cites. */
export interface Reference {
  kind: ReferenceKind;
  /** Stable identity: the path, route, script name, ADR number, or `file#symbol`. */
  ref: string;
  /** 1-based line in the playbook. */
  line: number;
}

/** Everything the resolver needs to know about the repository. */
export interface World {
  /** True when a repo-relative file or directory exists. */
  pathExists(relPath: string): boolean;
  /** Text of a repo-relative file, or null when it cannot be read. */
  fileText(relPath: string): string | null;
  /** Route paths from the generated route inventory (`/api/x/:id`). */
  routes: readonly string[];
  /** Script names from the Orchestrator package manifest. */
  npmScripts: ReadonlySet<string>;
  /** ADR numbers (`"0005"`) from the generated ADR inventory. */
  adrNumbers: ReadonlySet<string>;
  /** Numbers of the ADRs whose inventory status is `superseded`. */
  supersededAdrs: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// Extraction (pure)
// ---------------------------------------------------------------------------

/** The opt-out marker. `-start` / `-end` suffixes open and close a block. */
export const EXAMPLE_MARKER = "ref-check: example";
const MARKER_SRC = EXAMPLE_MARKER.replace(": ", ":\\s*");
const EXAMPLE_LINE = new RegExp(`${MARKER_SRC}(?!-)`);
const EXAMPLE_START = new RegExp(`${MARKER_SRC}-start`);
const EXAMPLE_END = new RegExp(`${MARKER_SRC}-end`);

/**
 * Metasyntactic names (`src/foo.ts`, `src/foo/bar.ts`, `/api/foo`) are
 * illustrations by construction and are never references.
 */
const METASYNTACTIC = /^(?:foo|bar|baz|qux)$/i;
function hasPlaceholderSegment(pathOrRoute: string): boolean {
  return pathOrRoute.split("/").some((seg) => METASYNTACTIC.test(seg.split(".")[0]));
}

/**
 * 0-based indexes of the lines inside a closed example block, markers included.
 * A start marker with no end marker opens nothing, so a forgotten end cannot
 * switch the check off for the rest of the file.
 */
function exampleBlockLines(lines: readonly string[]): Set<number> {
  const inside = new Set<number>();
  let start = -1;
  lines.forEach((line, i) => {
    if (start === -1 && EXAMPLE_START.test(line)) start = i;
    else if (start !== -1 && EXAMPLE_END.test(line)) {
      for (let j = start; j <= i; j++) inside.add(j);
      start = -1;
    }
  });
  return inside;
}

const ROOTS = "src|scripts|test|docs|config|\\.github|dashboard|evals";
const FILE_EXT = "ts|mts|tsx|jsx|js|mjs|py|sh|md|json|ya?ml|toml";
/** A repo-rooted cite, optionally written under the main checkout's absolute path. */
const ROOTED =
  "(?:(?<=~/hydra/)|(?<=\\$HOME/hydra/)|(?<=/home/gabe/hydra/)|(?<![\\w/.~$}>-]))";
const PATH_RE = new RegExp(
  `${ROOTED}((?:${ROOTS})/[\\w./-]*\\.(?:${FILE_EXT}))(?![\\w/-])`,
  "g",
);
/** A directory cite is only trusted inside a code span. */
const DIR_RE = new RegExp(`\`((?:${ROOTS})/(?:[\\w.-]+/)*)\``, "g");
const ROUTE_RE = /(?<![A-Za-z_.])\/api\/[\w/\-:{}$<>.]*/g;
const NPM_RE = /npm run ([\w:.-]+)/g;
const ADR_RE = /ADR-(\d{4})(?!\d)/g;

const SYMBOL_EXT = /\.(?:ts|mts|tsx|js|mjs|py|sh)$/;
const IDENT = "[A-Za-z_][A-Za-z0-9_]*(?:\\(\\))?";
const CODE_PATH = `(?:${ROOTS})/[\\w./-]+`;
/**
 * Only an attribution phrase ties a symbol to a file: "`sym` in `file`",
 * "`sym` (in `file`)", "`sym` entry in `file`", "`file`'s `sym`",
 * "`file` — the `sym`". A comma or "and" between the two code spans is a list,
 * not an attribution, and is never matched.
 */
const SYMBOL_GAP = " (?:\\((?:in |from )?|(?:[a-z]+ ){0,2}(?:in|from|of|inside) )";
const PATH_GAP = "(?:'s | (?:\\(|— |: )?(?:the |its |exports |imports |defines )?)";
const SYMBOL_THEN_PATH = new RegExp(`\`(${IDENT})\`${SYMBOL_GAP}\`(${CODE_PATH})\``, "g");
const PATH_THEN_SYMBOL = new RegExp(`\`(${CODE_PATH})\`${PATH_GAP}\`(${IDENT})\``, "g");

/** Paths that are templates or placeholders, not cites. */
function isTemplatePath(path: string, next: string): boolean {
  return (
    hasPlaceholderSegment(path) ||
    path.includes("NNNN") ||
    path.includes("..") ||
    next === "*" ||
    next === "<" ||
    next === "$" ||
    next === "{"
  );
}

/**
 * True when an identifier is shaped like a code symbol rather than an ordinary
 * word: it is called (`name()`), or it is multi-part (`UPPER_SNAKE`,
 * `snake_case`, `camelCase`). A bare lowercase word such as `model` is not.
 */
export function looksLikeSymbol(ident: string): boolean {
  if (ident.endsWith("()")) return true;
  if (ident.includes("_")) return /[A-Za-z]/.test(ident);
  return /^[a-z]+[A-Z]/.test(ident);
}

/**
 * The symbols one prose line ties to a source file through an attribution
 * phrase (the two attribution regexes above), each in its bare and `()` form.
 * The vocabulary ratchet's `symbol-cite` shape skips these: an attributed
 * symbol is resolve-checked by this check, an unattributed one is counted there.
 */
export function attributedSymbols(line: string): Set<string> {
  const out = new Set<string>();
  const addSym = (ident: string): void => {
    out.add(ident);
    out.add(ident.replace("()", ""));
  };
  for (const m of line.matchAll(SYMBOL_THEN_PATH)) {
    if (looksLikeSymbol(m[1]) && SYMBOL_EXT.test(m[2])) addSym(m[1]);
  }
  for (const m of line.matchAll(PATH_THEN_SYMBOL)) {
    if (looksLikeSymbol(m[2]) && SYMBOL_EXT.test(m[1])) addSym(m[2]);
  }
  return out;
}

function isTargetPlaybook(file: string): boolean {
  const base = file.slice(file.lastIndexOf("/") + 1);
  return base.startsWith("hydra-target-") || base.startsWith("target-");
}

/** Trim characters that end a sentence or a placeholder rather than a route. */
function cleanRoute(raw: string): string {
  let route = raw.replace(/[/.:$<{-]+$/, "");
  // `/api/health.deployedSha` cites a field of the response, not a route.
  route = route.replace(/\.[A-Za-z]\w*$/, "");
  return route;
}

/**
 * Extract every reference from one playbook's text. `file` is the playbook's
 * repo-relative path; it only decides whether `npm run` cites are Target-side.
 */
export function extractReferences(file: string, text: string): Reference[] {
  const refs: Reference[] = [];
  const seen = new Set<string>();
  const add = (kind: ReferenceKind, ref: string, line: number): void => {
    const key = `${kind} ${ref}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ kind, ref, line });
  };

  const targetPlaybook = isTargetPlaybook(file);
  const lines = text.split("\n");
  const inExampleBlock = exampleBlockLines(lines);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    if (inExampleBlock.has(i) || EXAMPLE_LINE.test(line)) continue;

    for (const m of line.matchAll(PATH_RE)) {
      const next = line[m.index + m[0].length] ?? "";
      if (!isTemplatePath(m[1], next)) add("path", m[1], lineNo);
    }
    for (const m of line.matchAll(DIR_RE)) {
      if (!isTemplatePath(m[1], "")) add("path", m[1], lineNo);
    }

    for (const m of line.matchAll(ROUTE_RE)) {
      const before = line.slice(0, m.index);
      if (/TARGET_WEB_URL[}"']*$/.test(before)) continue;
      const route = cleanRoute(m[0]);
      if (route.length > "/api".length && !hasPlaceholderSegment(route)) add("route", route, lineNo);
    }

    const targetLine = targetPlaybook || /\bTarget-side\b|TARGET_/.test(line);
    if (!targetLine) {
      for (const m of line.matchAll(NPM_RE)) add("npm", m[1].replace(/[.:-]+$/, ""), lineNo);
    }

    for (const m of line.matchAll(ADR_RE)) {
      add("adr", m[1], lineNo);
      add("superseded-adr", m[1], lineNo);
    }

    for (const m of line.matchAll(SYMBOL_THEN_PATH)) {
      if (looksLikeSymbol(m[1]) && SYMBOL_EXT.test(m[2])) {
        add("symbol", `${m[2]}#${m[1].replace("()", "")}`, lineNo);
      }
    }
    for (const m of line.matchAll(PATH_THEN_SYMBOL)) {
      if (looksLikeSymbol(m[2]) && SYMBOL_EXT.test(m[1])) {
        add("symbol", `${m[1]}#${m[2].replace("()", "")}`, lineNo);
      }
    }
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Resolution (pure over a World)
// ---------------------------------------------------------------------------

const PLACEHOLDER = /\$|<|\{|^:/;

/**
 * True when a cited route matches an inventory route, or is a whole-segment
 * prefix of one (a cite of a route family). A segment holding a placeholder on
 * either side matches anything.
 */
export function routeResolves(cited: string, routes: readonly string[]): boolean {
  const want = cited.split("/").filter(Boolean);
  return routes.some((route) => {
    const have = route.split("/").filter(Boolean);
    if (want.length > have.length) return false;
    return want.every(
      (seg, i) => seg === have[i] || PLACEHOLDER.test(seg) || have[i].startsWith(":"),
    );
  });
}

/** True when the reference resolves against the repository. */
export function resolves(ref: Reference, world: World): boolean {
  switch (ref.kind) {
    case "path":
      return world.pathExists(ref.ref);
    case "route":
      return routeResolves(ref.ref, world.routes);
    case "npm":
      return world.npmScripts.has(ref.ref);
    case "adr":
      return world.adrNumbers.has(ref.ref);
    case "superseded-adr":
      return !world.supersededAdrs.has(ref.ref);
    case "symbol": {
      const hash = ref.ref.lastIndexOf("#");
      const path = ref.ref.slice(0, hash);
      const symbol = ref.ref.slice(hash + 1);
      const text = world.fileText(path);
      // A missing file is reported once, as the `path` reference.
      if (text === null) return true;
      return new RegExp(`(?<![\\w$])${escapeRegExp(symbol)}(?![\\w$])`).test(text);
    }
  }
}

/** The unresolved references of one playbook. */
export function findUnresolved(file: string, text: string, world: World): Reference[] {
  return extractReferences(file, text).filter((ref) => !resolves(ref, world));
}

// ---------------------------------------------------------------------------
// Baseline comparison (pure)
// ---------------------------------------------------------------------------

export function entryOf(ref: Pick<Reference, "kind" | "ref">): string {
  return `${ref.kind} ${ref.ref}`;
}

// ---------------------------------------------------------------------------
// Repository adapter
// ---------------------------------------------------------------------------

/** Repo-relative paths of every playbook and fragment, sorted. */
export function listPlaybooks(root: string = REPO_ROOT): string[] {
  const out: string[] = [];
  for (const dir of [PLAYBOOKS_REL, FRAGMENTS_REL]) {
    for (const name of readdirSync(join(root, dir))) {
      if (name.endsWith(".md") && name !== "README.md") out.push(`${dir}/${name}`);
    }
  }
  return out.sort();
}

interface InventoryRows<T> {
  rows: T[];
}

/** The real repository as a World. */
export function repoWorld(root: string = REPO_ROOT): World {
  const readJson = <T>(rel: string): T =>
    JSON.parse(readFileSync(join(root, rel), "utf8")) as T;
  const routes = readJson<InventoryRows<{ path: string }>>("docs/generated/routes.json");
  const adrs = readJson<InventoryRows<{ number: string; status: string }>>("docs/generated/adrs.json");
  const pkg = readJson<{ scripts?: Record<string, string> }>("package.json");
  const texts = new Map<string, string | null>();
  return {
    pathExists: (rel) => existsSync(join(root, rel)),
    fileText: (rel) => {
      if (!texts.has(rel)) {
        let text: string | null = null;
        try {
          text = readFileSync(join(root, rel), "utf8");
        } catch {
          /* intentional: an unreadable cited file is reported as the `path` reference */
        }
        texts.set(rel, text);
      }
      return texts.get(rel) ?? null;
    },
    routes: routes.rows.map((r) => r.path),
    npmScripts: new Set(Object.keys(pkg.scripts ?? {})),
    adrNumbers: new Set(adrs.rows.map((r) => r.number)),
    supersededAdrs: new Set(adrs.rows.filter((r) => r.status === "superseded").map((r) => r.number)),
  };
}

/** Unresolved references for every playbook in the repository. */
export function scanRepo(root: string = REPO_ROOT): Record<string, Reference[]> {
  const world = repoWorld(root);
  const out: Record<string, Reference[]> = {};
  for (const file of listPlaybooks(root)) {
    const found = findUnresolved(file, readFileSync(join(root, file), "utf8"), world);
    if (found.length > 0) out[file] = found;
  }
  return out;
}

/** One `<playbook>\t<kind> <ref>` string per unresolved reference (extractReferences dedupes per file). */
export function measureRows(root: string = REPO_ROOT): string[] {
  const rows: string[] = [];
  for (const [file, refs] of Object.entries(scanRepo(root))) {
    for (const r of refs) rows.push(`${file}\t${entryOf(r)}`);
  }
  return rows;
}

export const referenceRatchet = defineRatchet({
  id: "playbook-reference-check",
  baseline: "scripts/ci/playbook-reference-baseline.json",
  shape: "set",
  polarity: "ceiling",
  enforcement: "required",
  measure: async (root) => measureRows(root),
  help: [
    "Update the playbook to cite what exists now (or delete the cite).",
    `If the reference is an illustrative placeholder, mark the line with \`${EXAMPLE_MARKER}\` (see the header of scripts/ci/playbook-reference-check.ts).`,
    "By kind: path = no such file or directory; route = not in docs/generated/routes.json; npm = not in package.json scripts; adr = not in docs/generated/adrs.json; superseded-adr = cite the ADR that replaced it, or mark a deliberate historical cite as an example; symbol = the named file does not contain the identifier.",
    "The row names the playbook, kind and reference, not the line: grep the playbook for the reference to find it.",
  ],
});

runIfCli(import.meta.url, referenceRatchet);

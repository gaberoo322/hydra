#!/usr/bin/env -S npx tsx
/**
 * Lifecycle-Seam check — direct state-label write ratchet (ADR-0047 D3/D7,
 * issue #5311).
 *
 * Issue lifecycle state labels are written through ONE seam:
 * `scripts/lifecycle.ts` over `src/lifecycle/`. This is the blocking backstop
 * that freezes drift: it counts "write sites" — places in playbooks, `src/` and
 * `scripts/` that write a lifecycle state label (or an unresolvable label
 * operand) directly — per file, and a shrink-only baseline
 * (`test/fixtures/lifecycle-seam-baseline.json`) tolerates today's sites.
 *
 * It is blocking because `test/lifecycle-seam-check.test.mts` runs the live
 * scan inside `npm test` (the REQUIRED `test` job); `ci.yml` is untouched.
 *
 * State names are imported from `src/lifecycle/` (`OPEN_STATES`), never copied.
 *
 * CLI (convenience only):
 *   npx tsx scripts/ci/lifecycle-seam-check.ts              # report
 *   npx tsx scripts/ci/lifecycle-seam-check.ts --seed       # write fixture iff absent
 *   npx tsx scripts/ci/lifecycle-seam-check.ts --shrink-baseline
 *
 * There is no tool path that grows a baseline row.
 *
 * The scanner is a best-effort heuristic behind a shrink-only ratchet, not a
 * sound analysis (#5359 round-4 ruling). Beyond plain flags and calls it counts:
 * create-context short `-l`; unresolvable flag operands (`{x}` placeholders,
 * `"--add-label " + x` concatenation, a trailing `=`); generic / optional calls
 * (`addIssueLabel<T>(`, `f?.(`); and one-hop aliases/wrappers of the seam
 * functions (`import { F as x }`, `const w = F ?? ...`, `const w = (..) => F(..)`).
 *
 * Not counted (documented evasions) — each is pinned by a synthetic test:
 *  - python `%`-formatting / `.format()` where the placeholder is not a brace
 *    at operand position (`"--add-label %s" % x`);
 *  - arity-changing wrappers (`const w = (l) => addIssueLabel(N, l); w("x")`):
 *    the wrapper definition line is counted, its calls are not;
 *  - two-hop aliases and `export { F as x }` re-exports from another module;
 *  - flags assembled from a separately-bound string (`const FLAG = "--add-label"`);
 *  - `.github/workflows/**` (ADR-0047 D1).
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { ORCH_BOARD_LABELS } from "../../src/board-labels.ts";
import { OPEN_STATES } from "../../src/lifecycle/index.ts";
import { REPO_ROOT, isCliEntrypoint, stripComments } from "./seam-check-lib.ts";

export { REPO_ROOT };

/** The scanner's state vocabulary: exactly the 13 label states (`closed` is no label). */
export const LIFECYCLE_STATE_NAMES: readonly string[] = [...OPEN_STATES];
const STATE_SET: ReadonlySet<string> = new Set(LIFECYCLE_STATE_NAMES);

export const LIFECYCLE_SEAM_BASELINE_REL = "test/fixtures/lifecycle-seam-baseline.json";

/** The one fix message every new-site failure names. */
export const LIFECYCLE_FIX_COMMAND =
  "npx tsx scripts/lifecycle.ts advance <issue> <to> [--evidence k=v] [--reason R --rationale T]";
export const LIFECYCLE_SHRINK_COMMAND =
  "npx tsx scripts/ci/lifecycle-seam-check.ts --shrink-baseline";

/** Exemptions: the ONLY carve-outs, one reason each. */
export const LIFECYCLE_EXEMPTIONS: ReadonlyArray<{
  matches: (relPath: string) => boolean;
  reason: string;
}> = [
  { matches: (p) => p.startsWith("src/lifecycle/"), reason: "the seam itself" },
  { matches: (p) => p === "src/github/issues.ts", reason: "label-write transport definition" },
  { matches: (p) => p === "src/github/issue-actions.ts", reason: "label-write transport definition" },
  { matches: (p) => p === "src/github/prs.ts", reason: "label-write transport definition" },
  { matches: (p) => p === "scripts/lifecycle.ts", reason: "the CLI adapter over the seam" },
  { matches: (p) => p === "scripts/ci/lifecycle-seam-check.ts", reason: "this checker" },
  {
    matches: (p) =>
      /^docs\/operator-playbooks\/(?:_fragments\/)?hydra-target-[^/]*\.md$/.test(p) ||
      p === "docs/operator-playbooks/hydra-wire-or-retire.md" ||
      p === "docs/operator-playbooks/hydra-design-qa.md",
    reason: "Target-scope playbooks: ADR-0047 scopes the seam to the Orchestrator board",
  },
];

export function isExemptPath(relPath: string): boolean {
  return LIFECYCLE_EXEMPTIONS.some((e) => e.matches(relPath));
}

// ---------------------------------------------------------------------------
// Detection — pure functions
// ---------------------------------------------------------------------------

const STATE_TOKEN_RE = new RegExp(
  `(?<![A-Za-z0-9_-])(?:${LIFECYCLE_STATE_NAMES.map((s) => s.replace(/[-]/g, "\\-")).join("|")})(?![A-Za-z0-9_-])`,
);

function operandIsSite(operand: string, identifierIsVariable: boolean): boolean {
  if (operand.includes("$") || operand.includes("{")) return true;
  if (identifierIsVariable && /^[A-Za-z_][\w.]*$/.test(operand)) return true;
  return STATE_TOKEN_RE.test(operand);
}

/** `gh api` as a shell command or an argv list (`"gh", ["api", ...]`). */
const GH_API_RE = /\bgh\b["'\s,[]*\bapi\b|["']api["']\s*,/;
/** Label flags: `--add-label` / `--remove-label` / `--label`, and short `-l` (own token only). */
const FLAG_NAME_SRC = String.raw`--(?:add-|remove-)?label|(?<![^\s"',])-l(?=[\s="',]|$)`;
const FLAG_RE = new RegExp(
  String.raw`(?:${FLAG_NAME_SRC})(?:(["']?\s*,\s*)|[ =]+)(?:"([^"]*)"|'([^']*)'|([^\s"')\]]+))`,
  "g",
);
/** `"--add-label " + x` / `"--add-label=" + x`: the operand lives outside the literal. */
const CONCAT_RE = new RegExp(String.raw`(?:${FLAG_NAME_SRC})[ =]*["']\s*\+`, "g");
/** `"--add-label="` (flag literal closes right after `=`) or a flag `=` ending the logical line. */
const TRAILING_EQ_RE = new RegExp(
  String.raw`(["'])(?:${FLAG_NAME_SRC})=\1|(?:${FLAG_NAME_SRC})=\s*$`,
  "g",
);
/** Bare `--label` / `-l` write only on create commands (elsewhere they are list filters). */
function isCreateOnlyFlag(matched: string): boolean {
  return /^["']?(?:--label|-l)(?![\w-])/.test(matched);
}
/** Bare `--label` only writes state on create commands (elsewhere it is a list filter). */
const CREATE_CMD_RE = /\bcreate\b/;
/** A bare `--label` is a create-time write when `create` appears within 300 chars before it (same or earlier line). */
function inCreateContext(text: string, idx: number): boolean {
  return CREATE_CMD_RE.test(text.slice(Math.max(0, idx - 300), idx));
}

/** Join backslash-continued physical lines; each logical line keeps its first physical line number. */
function logicalLines(text: string): Array<{ line: number; text: string; offset: number }> {
  const phys = text.split(/\r?\n/);
  const out: Array<{ line: number; text: string; offset: number }> = [];
  let acc = 0;
  const physOffsets = phys.map((p) => {
    const o = acc;
    acc += p.length + 1;
    return o;
  });
  for (let i = 0; i < phys.length; i++) {
    const start = i;
    let cur = phys[i]!;
    while (/\\\s*$/.test(cur) && i + 1 < phys.length) {
      cur = cur.replace(/\\\s*$/, " ") + phys[++i]!.trimStart();
    }
    out.push({ line: start + 1, text: cur, offset: physOffsets[start]! });
  }
  return out;
}

/** Line grammar for markdown / shell / python / mjs. Returns 1-based site line numbers. */
export function scanTextSites(text: string): number[] {
  const sites: number[] = [];
  for (const { line: lineNo, text: line, offset } of logicalLines(text)) {
    let hit = false;
    for (const m of line.matchAll(FLAG_RE)) {
      if (isCreateOnlyFlag(m[0]) && !inCreateContext(text, offset + (m.index ?? 0))) continue;
      const argList = m[1] !== undefined; // `"--add-label", x` list form
      const quoted = m[2] ?? m[3];
      const operand = quoted ?? m[4] ?? "";
      const bareIdentifier = quoted === undefined && argList;
      if (bareIdentifier && operand) {
        hit = true; // list form, non-literal operand (`labelFor(x)`, `labels[i]`): fail closed
        continue;
      }
      for (const part of operand.split(",")) {
        if (part && operandIsSite(part, bareIdentifier)) hit = true;
      }
    }
    for (const re of [CONCAT_RE, TRAILING_EQ_RE]) {
      for (const m of line.matchAll(re)) {
        if (isCreateOnlyFlag(m[0]) && !inCreateContext(text, offset + (m.index ?? 0))) continue;
        hit = true; // operand not inside the literal: unresolvable, fail closed
      }
    }
    if (!hit && GH_API_RE.test(line) && (/\/labels\b/.test(line) || /labels\[\]=/.test(line))) {
      const isWrite =
        /(?:-X|--method)["',= ]+(?:POST|PUT|PATCH|DELETE)\b/i.test(line) ||
        /(?:-[fF]|--field|--raw-field)["',= ]*["']?labels\[\]=/.test(line) ||
        /--input\b/.test(line);
      if (isWrite) {
        const operands: string[] = [];
        const tail = /\/labels\/?([^\s"',]*)/.exec(line);
        if (tail && tail[1]) operands.push(tail[1]);
        for (const f of line.matchAll(/labels\[\]=([^\s"',]+)/g)) operands.push(f[1]!);
        if (/--input\b/.test(line) || operands.some((o) => operandIsSite(o, false))) hit = true;
      }
    }
    if (hit) sites.push(lineNo);
  }
  // Argv list form with the flag and its operand on separate physical lines (prettier-formatted).
  const seen = new Set(sites);
  for (const m of text.matchAll(FLAG_RE)) {
    if (m[1] === undefined || !m[0].includes("\n")) continue; // single-line matches handled above
    if (isCreateOnlyFlag(m[0]) && !inCreateContext(text, m.index!)) continue;
    const quoted = m[2] ?? m[3];
    const operand = quoted ?? m[4] ?? "";
    const isSite =
      quoted === undefined ? operand !== "" : operand.split(",").some((p) => p && operandIsSite(p, false));
    const line = text.slice(0, m.index!).split("\n").length;
    if (isSite && !seen.has(line)) {
      seen.add(line);
      sites.push(line);
    }
  }
  return sites.sort((a, b) => a - b);
}

/** Split `text` on top-level commas, honouring nesting and string literals. */
function splitTop(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      cur += c;
      if (c === "\\") cur += text[++i] ?? "";
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      cur += c;
    } else if ("([{".includes(c)) {
      depth++;
      cur += c;
    } else if (")]}".includes(c)) {
      depth--;
      cur += c;
    } else if (c === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function matchParen(s: string, open: number): number {
  let depth = 0;
  let quote = "";
  for (let i = open; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return -1;
}

/** Does this one-hop-resolved label expression make a site? (fail closed) */
function tsOperandIsSite(expr: string, consts: Map<string, string>): boolean {
  const e = expr.trim();
  const lit = /^["'`]([^"'`$]*)["'`]$/.exec(e);
  if (lit) return STATE_SET.has(lit[1]!);
  const board = /^ORCH_BOARD_LABELS\.(\w+)$/.exec(e);
  if (board) {
    const v = (ORCH_BOARD_LABELS as Record<string, string>)[board[1]!];
    return v === undefined ? true : STATE_SET.has(v);
  }
  if (/^[A-Za-z_$][\w$]*$/.test(e) && consts.has(e)) return STATE_SET.has(consts.get(e)!);
  return true;
}

/** Is `name` also bound as a function parameter or destructured binding anywhere in the file? */
function isShadowedBinding(src: string, name: string): boolean {
  const n = name.replace(/\$/g, "\\$");
  const destructure = new RegExp(`\\b(?:const|let|var)\\s*[{\\[][^=;]*(?<![\\w$])${n}(?![\\w$])[^=;]*[}\\]]\\s*=`);
  if (destructure.test(src)) return true;
  if (new RegExp(`(?<![\\w$.])${n}\\s*=>`).test(src)) return true; // bare single-parameter arrow
  const params = new RegExp(`\\(((?:[^()]|\\([^()]*\\))*(?<![\\w$.])${n}(?![\\w$])(?:[^()]|\\([^()]*\\))*)\\)\\s*(?::[^{=;]+)?(?:=>|\\{)`, "g");
  for (const m of src.matchAll(params)) {
    const before = src.slice(Math.max(0, m.index! - 8), m.index!);
    if (/\b(?:if|while|for|switch|catch|with)\s*$/.test(before)) continue; // control flow, not params
    return true;
  }
  return false;
}

/** Module-scope consts only (column 0); a name declared more than once anywhere is unresolvable. */
function collectConsts(src: string): Map<string, string> {
  const consts = new Map<string, string>();
  for (const m of src.matchAll(/^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)(?:\s*:\s*[^=]+)?\s*=\s*([^;\n]+)/gm)) {
    const name = m[1]!;
    const decls = src.match(new RegExp(`\\b(?:const|let|var)\\s+${name.replace(/\$/g, "\\$")}\\b`, "g"));
    if (decls && decls.length > 1) continue;
    if (isShadowedBinding(src, name)) continue;
    const rhs = m[2]!.trim();
    const lit = /^["'`]([^"'`$]*)["'`]$/.exec(rhs);
    if (lit) {
      consts.set(m[1]!, lit[1]!);
      continue;
    }
    const board = /^ORCH_BOARD_LABELS\.(\w+)$/.exec(rhs);
    if (board) {
      const v = (ORCH_BOARD_LABELS as Record<string, string>)[board[1]!];
      if (v !== undefined) consts.set(m[1]!, v);
    }
  }
  return consts;
}

const SEAM_FNS = ["addIssueLabel", "removeIssueLabel", "editIssueLabels"] as const;
const IDENT = "[A-Za-z_$][\\w$]*";
const escId = (n: string) => n.replace(/\$/g, "\\$");

/** End index of a `const x = <init>` initializer: `;` at depth 0, or a newline that does not continue the expression. */
function initializerEnd(src: string, start: number): number {
  let depth = 0;
  let quote = "";
  const limit = Math.min(src.length, start + 1500);
  for (let i = start; i < limit; i++) {
    const c = src[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      if (--depth < 0) return i;
    } else if (c === ";" && depth === 0) return i;
    else if (c === "\n" && depth === 0) {
      const prev = src.slice(start, i).trimEnd();
      const next = src.slice(i).trimStart();
      if (!/(?:[?|&,:+(]|=>)$/.test(prev) && !/^[?|&.:]/.test(next)) return i;
    }
  }
  return limit;
}

/**
 * One-hop wrappers of the seam functions, file-wide: `import { F as x }`, or
 * `const|let|var x [: T] = <init>` whose initializer mentions F as a bare
 * reference or inside an arrow body (`=>` before `F(`). A direct call result
 * (`const r = await F(..)`) is not a wrapper. Returns wrapper name -> seam fn.
 */
function collectWrappers(src: string): Map<string, string> {
  const wrappers = new Map<string, string>();
  const reserved = new Set<string>(SEAM_FNS);
  for (const f of SEAM_FNS) {
    const imp = new RegExp(`import\\s*(?:type\\s*)?\\{[^}]*?(?<![\\w$])${f}\\s+as\\s+(${IDENT})`, "g");
    for (const m of src.matchAll(imp)) if (!reserved.has(m[1]!)) wrappers.set(m[1]!, f);
  }
  const declRe = new RegExp(`\\b(?:const|let|var)\\s+(${IDENT})\\s*(?::(?:=>|[^=;])+?)?=(?![=>])`, "g");
  for (const m of src.matchAll(declRe)) {
    const name = m[1]!;
    if (reserved.has(name)) continue;
    const start = m.index! + m[0].length + (/^\s*/.exec(src.slice(m.index! + m[0].length))?.[0].length ?? 0);
    const init = src.slice(start, initializerEnd(src, start));
    const arrowAt = init.indexOf("=>");
    for (const f of SEAM_FNS) {
      const bare = new RegExp(`(?<![\\w$])${f}(?![\\w$])(?!\\s*(?:<[^()]*>)?\\s*(?:\\?\\.)?\\()`);
      const call = new RegExp(`(?<![\\w$])${f}\\s*(?:<[^()]*>)?\\s*(?:\\?\\.)?\\s*\\(`);
      const callAt = init.search(call);
      if (bare.test(init) || (arrowAt !== -1 && callAt !== -1 && arrowAt < callAt)) {
        wrappers.set(name, f);
        break;
      }
    }
  }
  return wrappers;
}

/** Call grammar for `src/` and `scripts/*.ts`. Returns 1-based site line numbers (one per site). */
export function scanTsSites(source: string): number[] {
  const src = stripComments(source);
  const consts = collectConsts(src);
  const wrappers = collectWrappers(src);
  const sites: number[] = [];
  const lineOf = (idx: number) => src.slice(0, idx).split("\n").length;
  const names = [...SEAM_FNS, ...wrappers.keys()].map(escId).join("|");
  const callRe = new RegExp(`(?<![\\w$])(${names})\\s*(?:<[^()]*>)?\\s*(?:\\?\\.)?\\s*\\(`, "g");
  for (const m of src.matchAll(callRe)) {
    if (/\bfunction\s+$/.test(src.slice(Math.max(0, m.index! - 12), m.index!))) continue;
    const open = m.index! + m[0].length - 1;
    const close = matchParen(src, open);
    const args = splitTop(src.slice(open + 1, close === -1 ? undefined : close));
    const line = lineOf(m.index!);
    const second = (args[1] ?? "").trim();
    const wrapped = wrappers.get(m[1]!);
    if (wrapped !== undefined && args.length < 2) continue; // arity-changing wrapper: documented non-count
    const fn = wrapped ?? m[1]!;
    if (fn !== "editIssueLabels") {
      if (tsOperandIsSite(second, consts)) sites.push(line);
      continue;
    }
    if (!second.startsWith("{")) {
      sites.push(line); // pass-through object: unresolvable
      continue;
    }
    for (const prop of splitTop(second.replace(/^\{/, "").replace(/\}\s*$/, ""))) {
      const kv = /^\s*(add|remove)\s*:\s*([\s\S]*)$/.exec(prop);
      if (!kv) {
        // shorthand, spread, computed key or any other shape: unresolvable, fail closed
        if (prop.trim()) sites.push(line);
        continue;
      }
      const val = kv[2]!.trim();
      if (val.startsWith("[")) {
        for (const el of splitTop(val.replace(/^\[/, "").replace(/\]\s*$/, ""))) {
          if (tsOperandIsSite(el, consts)) sites.push(line);
        }
      } else sites.push(line);
    }
  }
  return sites;
}

/** Sites in one file (exempt paths and non-surfaces yield none). */
export function scanFileSites(relPath: string, text: string): number[] {
  if (isExemptPath(relPath)) return [];
  if (TS_LIKE_RE.test(relPath)) {
    // Call grammar plus the text grammar over comment-stripped source (argv-style `gh` shell-outs).
    // The call grammar counts per site; text-grammar lines it already covers are not double-counted.
    const calls = scanTsSites(text);
    const seen = new Set(calls);
    const extra = scanTextSites(stripComments(text)).filter((l) => !seen.has(l));
    return [...calls, ...extra].sort((a, b) => a - b);
  }
  return scanTextSites(text);
}

// ---------------------------------------------------------------------------
// Tree walk + baseline ratchet
// ---------------------------------------------------------------------------

export interface FileSites {
  count: number;
  lines: number[];
}
export type Observed = Record<string, FileSites>;

export interface LifecycleBaseline {
  rule: "lifecycle-seam";
  note: string;
  files: Record<string, number>;
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".worktrees", "dist"]);

const TS_LIKE_RE = /\.(?:ts|mts|cts|tsx|js|cjs|mjs)$/;

export function isSurface(rel: string): boolean {
  if (rel.startsWith("docs/operator-playbooks/") || rel.startsWith("docs/agents/")) {
    return rel.endsWith(".md");
  }
  if (rel.startsWith("src/")) return TS_LIKE_RE.test(rel);
  if (rel.startsWith("scripts/")) return TS_LIKE_RE.test(rel) || /\.(?:sh|py)$/.test(rel);
  return false;
}

async function walk(root: string, dir: string, out: string[], isScanRoot = false): Promise<void> {
  let entries;
  try {
    entries = await readdir(join(root, dir), { withFileTypes: true });
  } catch (err) {
    // A missing scan root has no sites; any other failure must not fail open.
    if ((err as NodeJS.ErrnoException).code === "ENOENT" && isScanRoot) return;
    throw new Error(`[lifecycle-seam-check] cannot read dir ${dir}: ${String(err)}`, { cause: err });
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) await walk(root, rel, out);
    else if (e.isFile() && isSurface(rel)) out.push(rel);
  }
}

/** Walk the scan surfaces under `root` (fs walk, no git) and count sites per file. */
export async function scanLifecycleSeam(root: string = REPO_ROOT): Promise<Observed> {
  const files: string[] = [];
  for (const top of ["docs/operator-playbooks", "docs/agents", "src", "scripts"]) {
    await walk(root, top, files, true);
  }
  const observed: Observed = {};
  for (const rel of files.sort()) {
    if (isExemptPath(rel)) continue;
    let text: string;
    try {
      text = await readFile(join(root, rel), "utf8");
    } catch (err) {
      throw new Error(`[lifecycle-seam-check] cannot read ${rel}: ${String(err)}`, { cause: err });
    }
    const lines = scanFileSites(rel, text);
    if (lines.length > 0) observed[rel] = { count: lines.length, lines };
  }
  return observed;
}

export async function loadLifecycleBaseline(
  root: string = REPO_ROOT,
): Promise<LifecycleBaseline> {
  return parseLifecycleBaseline(await readFile(join(root, LIFECYCLE_SEAM_BASELINE_REL), "utf8"));
}

/** Pure shape check of the baseline JSON text; throws on a malformed baseline. */
export function parseLifecycleBaseline(raw: string): LifecycleBaseline {
  const parsed = JSON.parse(raw) as Partial<LifecycleBaseline> | null;
  const files = parsed?.files;
  if (
    !parsed ||
    parsed.rule !== "lifecycle-seam" ||
    typeof files !== "object" ||
    files === null ||
    !Object.values(files).every((n) => Number.isInteger(n) && n >= 0)
  ) {
    throw new Error(`[lifecycle-seam-check] malformed baseline ${LIFECYCLE_SEAM_BASELINE_REL}`);
  }
  return parsed as LifecycleBaseline;
}

export interface RatchetVerdict {
  ok: boolean;
  messages: string[];
  total: number;
}

/** Shrink-only verdict. An unlisted file has baseline 0. */
export function checkLifecycleRatchet(
  observed: Observed,
  baseline: Pick<LifecycleBaseline, "files">,
): RatchetVerdict {
  const messages: string[] = [];
  let total = 0;
  for (const [file, { count, lines }] of Object.entries(observed)) {
    total += count;
    const allowed = baseline.files[file] ?? 0;
    if (count > allowed) {
      messages.push(
        `new direct state-label write in ${file} (${count} sites, baseline ${allowed}; lines ${lines.join(", ")}). ` +
          `Route the transition through the lifecycle seam: ${LIFECYCLE_FIX_COMMAND} (scripts/lifecycle.ts)`,
      );
    }
  }
  for (const [file, allowed] of Object.entries(baseline.files)) {
    const seen = observed[file]?.count ?? 0;
    if (seen < allowed) {
      messages.push(
        `baseline is stale — shrink it: ${file} now has ${seen} sites (baseline ${allowed}). ` +
          `Run: ${LIFECYCLE_SHRINK_COMMAND}`,
      );
    }
  }
  return { ok: messages.length === 0, messages, total };
}

function serializeBaseline(files: Record<string, number>): string {
  const sorted: Record<string, number> = {};
  for (const k of Object.keys(files).sort()) if (files[k]! > 0) sorted[k] = files[k]!;
  const b: LifecycleBaseline = {
    rule: "lifecycle-seam",
    note: `Shrink-only ratchet (ADR-0047, #5311): per-file count of direct lifecycle state-label write sites. Never raise a row; migrate the site to scripts/lifecycle.ts then run: ${LIFECYCLE_SHRINK_COMMAND}`,
    files: sorted,
  };
  return JSON.stringify(b, null, 2) + "\n";
}

async function cli(): Promise<number> {
  const observed = await scanLifecycleSeam(REPO_ROOT);
  const path = join(REPO_ROOT, LIFECYCLE_SEAM_BASELINE_REL);
  const argv = process.argv;
  if (argv.includes("--seed")) {
    let exists = true;
    try {
      await readFile(path, "utf8");
    } catch (err) {
      /* intentional: ENOENT is the only state in which --seed may write */
      exists = (err as NodeJS.ErrnoException).code !== "ENOENT";
    }
    if (exists) {
      console.error(`[lifecycle-seam-check] --seed refused: ${relative(REPO_ROOT, path)} already exists`);
      return 1;
    }
    const files: Record<string, number> = {};
    for (const [f, s] of Object.entries(observed)) files[f] = s.count;
    await writeFile(path, serializeBaseline(files));
    console.log(`[lifecycle-seam-check] seeded ${Object.keys(files).length} files`);
    return 0;
  }
  if (argv.includes("--shrink-baseline")) {
    const baseline = await loadLifecycleBaseline(REPO_ROOT);
    const grown = Object.entries(observed).filter(([f, s]) => s.count > (baseline.files[f] ?? 0));
    if (grown.length > 0) {
      console.error(
        `[lifecycle-seam-check] --shrink-baseline refused (nothing written); new sites in: ${grown.map(([f]) => f).join(", ")}`,
      );
      return 1;
    }
    const files: Record<string, number> = {};
    for (const [f, allowed] of Object.entries(baseline.files)) {
      const n = Math.min(observed[f]?.count ?? 0, allowed);
      if (n > 0) files[f] = n;
    }
    await writeFile(path, serializeBaseline(files));
    console.log(`[lifecycle-seam-check] baseline now ${Object.keys(files).length} files`);
    return 0;
  }
  const verdict = checkLifecycleRatchet(observed, await loadLifecycleBaseline(REPO_ROOT));
  if (!verdict.ok) {
    for (const m of verdict.messages) console.error(`[lifecycle-seam-check] ${m}`);
    return 1;
  }
  console.log(`[lifecycle-seam-check] OK — ${verdict.total} known sites, no new ones.`);
  return 0;
}

if (isCliEntrypoint(import.meta.url)) {
  cli().then(
    (code) => process.exit(code),
    (err) => {
      console.error("[lifecycle-seam-check] crash:", err);
      process.exit(2);
    },
  );
}

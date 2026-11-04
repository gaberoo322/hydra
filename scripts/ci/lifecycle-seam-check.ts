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
  { matches: (p) => p.startsWith("src/github/"), reason: "label-write transport definitions" },
  { matches: (p) => p === "scripts/lifecycle.ts", reason: "the CLI adapter over the seam" },
  { matches: (p) => p === "scripts/ci/lifecycle-seam-check.ts", reason: "this checker" },
  {
    matches: (p) => p.startsWith("scripts/claude-hooks/"),
    reason: "command-text guards that match label commands but never write",
  },
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
  if (operand.includes("$")) return true;
  if (identifierIsVariable && /^[A-Za-z_][\w.]*$/.test(operand)) return true;
  return STATE_TOKEN_RE.test(operand);
}

const FLAG_RE =
  /--(?:add|remove)-label(?:(["']?\s*,\s*)|[ =]+)(?:"([^"]*)"|'([^']*)'|([^\s"',)\]]+))/g;

/** Line grammar for markdown / shell / python / mjs. Returns 1-based site line numbers. */
export function scanTextSites(text: string): number[] {
  const sites: number[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let hit = false;
    for (const m of line.matchAll(FLAG_RE)) {
      const argList = m[1] !== undefined; // `"--add-label", x` list form
      const quoted = m[2] ?? m[3];
      const operand = quoted ?? m[4] ?? "";
      const bareIdentifier = quoted === undefined && argList;
      for (const part of operand.split(",")) {
        if (part && operandIsSite(part, bareIdentifier)) hit = true;
      }
    }
    if (!hit && /\bgh\s+api\b/.test(line) && /\/labels\b/.test(line)) {
      const isWrite =
        /(?:-X|--method)[ =]+(?:POST|PUT|PATCH|DELETE)\b/i.test(line) || /-[fF]\s+labels\[\]=/.test(line);
      if (isWrite) {
        const operands: string[] = [];
        const tail = /\/labels\/?([^\s"']*)/.exec(line);
        if (tail && tail[1]) operands.push(tail[1]);
        for (const f of line.matchAll(/labels\[\]=([^\s"']+)/g)) operands.push(f[1]!);
        if (operands.some((o) => operandIsSite(o, false))) hit = true;
      }
    }
    if (hit) sites.push(i + 1);
  }
  return sites;
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

function collectConsts(src: string): Map<string, string> {
  const consts = new Map<string, string>();
  for (const m of src.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)(?:\s*:\s*[^=]+)?\s*=\s*([^;\n]+)/g)) {
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

/** Call grammar for `src/` and `scripts/*.ts`. Returns 1-based site line numbers (one per site). */
export function scanTsSites(source: string): number[] {
  const src = stripComments(source);
  const consts = collectConsts(src);
  const sites: number[] = [];
  const lineOf = (idx: number) => src.slice(0, idx).split("\n").length;
  const callRe = /\b(addIssueLabel|removeIssueLabel|editIssueLabels)\s*\(/g;
  for (const m of src.matchAll(callRe)) {
    if (/\bfunction\s+$/.test(src.slice(Math.max(0, m.index! - 12), m.index!))) continue;
    const open = m.index! + m[0].length - 1;
    const close = matchParen(src, open);
    const args = splitTop(src.slice(open + 1, close === -1 ? undefined : close));
    const line = lineOf(m.index!);
    const second = (args[1] ?? "").trim();
    if (m[1] !== "editIssueLabels") {
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
        if (/^\s*(add|remove)\s*$/.test(prop)) sites.push(line); // shorthand
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
  if (relPath.endsWith(".ts")) return scanTsSites(text);
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

function isSurface(rel: string): boolean {
  if (rel.startsWith("docs/operator-playbooks/") || rel.startsWith("docs/agents/")) {
    return rel.endsWith(".md");
  }
  if (rel.startsWith("src/")) return rel.endsWith(".ts");
  if (rel.startsWith("scripts/")) return /\.(?:ts|mjs|sh|py)$/.test(rel);
  return false;
}

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(join(root, dir), { withFileTypes: true });
  } catch (err) {
    console.warn(`[lifecycle-seam-check] cannot read dir ${dir}, skipped:`, err);
    return;
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
    await walk(root, top, files);
  }
  const observed: Observed = {};
  for (const rel of files.sort()) {
    if (isExemptPath(rel)) continue;
    let text: string;
    try {
      text = await readFile(join(root, rel), "utf8");
    } catch (err) {
      console.warn(`[lifecycle-seam-check] cannot read ${rel}, skipped:`, err);
      continue;
    }
    const lines = scanFileSites(rel, text);
    if (lines.length > 0) observed[rel] = { count: lines.length, lines };
  }
  return observed;
}

export async function loadLifecycleBaseline(
  root: string = REPO_ROOT,
): Promise<LifecycleBaseline> {
  const raw = await readFile(join(root, LIFECYCLE_SEAM_BASELINE_REL), "utf8");
  return JSON.parse(raw) as LifecycleBaseline;
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

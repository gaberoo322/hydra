/**
 * scripts/ci/test-source-read-scan.ts — detect test files that READ CODE PATHS,
 * and compare them against a kind-tagged fixture (issue #5262, ADR-0046), plus a
 * shrink-only per-SITE pin count (issue #5487, ADR-0046 Decision 4).
 *
 * # Why
 *
 * CODING_STANDARDS.md § Tests `STD-TEST-RUN-THE-CODE`: a test asserts through
 * the module's interface; it may read repo text only as input to code it runs,
 * or as a sanctioned drift-guard / invariant-lint / dashboard-pin. A
 * substring/regex assertion over code that can run goes red on a
 * behaviour-preserving refactor. This module is the mechanical half of that
 * rule: it finds the files that read code, and the required test
 * (`test/test-source-read-ratchet.test.mts`) fails when a code-reading file is
 * not in `test/fixtures/test-source-read-baseline.json` under a sanctioned kind.
 *
 * # Detection is per FILE and gates only CODE paths
 *
 * A test file is a code reader iff (a) it calls a filesystem read
 * (`readFileSync` / `readFile` / `readdirSync` / `readdir`) AND (b) it contains
 * a string literal that resolves under `src/`, `scripts/`, `bin/` or
 * `dashboard/src/`, or ends in `.sh` / `.py` / `.mjs`. Reads of `docs/`,
 * `config/`, `.github/`, `CLAUDE.md`, `CONTEXT.md`, playbooks, `*.md` and
 * `test/fixtures` are never gated. `import` statements never count as reads,
 * and comments are stripped before scanning.
 *
 * # Grandfathered rows only shrink
 *
 * The test cannot see history (reading git state or GITHUB_EVENT_PATH from the
 * suite is the coupling #4132 removed), so "grandfathered rows only shrink" is
 * the reviewer's rule under STD-TEST-RUN-THE-CODE. What is enforced here: every
 * row names a known kind, an existing file, and a file that still reads code.
 *
 * # Per-SITE pin counts (issue #5487)
 *
 * The file-level gate alone lets a file already in the fixture grow any number of
 * NEW regex / substring / `indexOf` pins over code. `pinSitesOf` counts, per test
 * file, the assertion sites whose subject is bound (in the same file) from a read
 * of a CODE path (`code`, STD-TEST-RUN-THE-CODE) or of a prompt / playbook path
 * (`prompt`, STD-TEST-PIN-PHRASE: `indexOf` block-order pins and step-number
 * pins). The fixture's sibling `pinSites` map holds the baseline; counts are
 * shrink-only: observed > baseline is `pin-count-grew`, observed < baseline is
 * `pin-count-stale` (regenerate with `--write-baseline`). Helper-function
 * returns, loop variables and destructured reads are NOT tracked (documented
 * undercount - those stay the Standards reviewer's). Long-sentence prompt pins
 * are reported as advisory only and never counted.
 *
 * CLI: `npx tsx scripts/ci/test-source-read-scan.ts [--write-baseline | --init]`.
 *
 * Pure / result-object style: nothing here throws on malformed input.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./test-subject-map.ts";
import { REPO_ROOT, isCliEntrypoint, writeJsonBaseline } from "./seam-check-lib.ts";

/** The closed set of sanctioned kinds a fixture row may carry. */
export const READ_KINDS = ["drift-guard", "invariant-lint", "dashboard-pin", "behaviour", "grandfathered"] as const;
export type ReadKind = (typeof READ_KINDS)[number];

/** The rule id every failure message prints. */
export const RULE_ID = "STD-TEST-RUN-THE-CODE";

/** The rule id the `prompt` pin counter serves. */
export const PROMPT_RULE_ID = "STD-TEST-PIN-PHRASE";

/** Per-file pin-site counts: `code` pins over code reads, `prompt` pins over playbook reads. */
export interface PinCounts {
  code: number;
  prompt: number;
}

/** `fixture.files`: test file (repo-relative) -> kind; `pinSites`: shrink-only per-site counts. */
export interface ReadBaseline {
  note?: string;
  files: Record<string, string>;
  pinSites?: Record<string, Partial<PinCounts>>;
}

export interface ReadViolation {
  file: string;
  code:
    | "unlisted-reader"
    | "unknown-kind"
    | "stale-missing-file"
    | "stale-no-longer-reads"
    | "pin-count-grew"
    | "pin-count-stale";
  message: string;
}

export const WRITE_COMMAND = "npx tsx scripts/ci/test-source-read-scan.ts --write-baseline";
export const BASELINE_REL = "test/fixtures/test-source-read-baseline.json";

const FS_READ_RE = /\b(?:readFileSync|readFile|readdirSync|readdir)\s*\(/;
/** Static and dynamic import specifiers are not reads. */
const IMPORT_FROM_RE = /(?:^|\n)\s*(?:import|export)\b[^;'"`]*?\bfrom\s*(["'])[^"'\n]*\1\s*;?/g;
const BARE_IMPORT_RE = /(?:^|\n)\s*import\s*(["'])[^"'\n]*\1\s*;?/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*(["'`])[^"'`\n]*\1\s*\)/g;
const LITERAL_RE = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
/** A literal that is, or sits under, a code root. */
const CODE_ROOT_RE = /(?:^|\/)(?:src|scripts|bin|dashboard\/src)(?:\/|$)/;
const CODE_EXT_RE = /\.(?:sh|py|mjs)$/;

/** Does this string-literal body resolve to a code path? */
export function isCodePathLiteral(body: string): boolean {
  if (/^(?:https?:)?\/\//.test(body)) return false;
  return CODE_ROOT_RE.test(body) || CODE_EXT_RE.test(body);
}

/** Source with comments and import specifiers blanked out. */
function scannable(source: string): string {
  return stripComments(source)
    .replace(IMPORT_FROM_RE, "\n")
    .replace(BARE_IMPORT_RE, "\n")
    .replace(DYNAMIC_IMPORT_RE, "import()");
}

/** Does the test file read a code path? Pure. */
export function readsCodePath(source: string): boolean {
  const code = scannable(source);
  if (!FS_READ_RE.test(code)) return false;
  for (const m of code.matchAll(LITERAL_RE)) {
    if (isCodePathLiteral(m[2])) return true;
  }
  return false;
}

/** A literal that is, or sits under, a prompt / playbook path. */
export function isPromptPathLiteral(body: string): boolean {
  if (/^(?:https?:)?\/\//.test(body)) return false;
  return /\.md$/i.test(body) || /(?:^|\/)docs\/operator-playbooks\//.test(body) || /(?:^|\/)\.claude\/skills\//.test(body);
}

/** 1 for every character inside a string / template literal (quotes included). */
function stringMask(code: string): Uint8Array {
  const mask = new Uint8Array(code.length);
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch !== '"' && ch !== "'" && ch !== "`") {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < code.length) {
      const c = code[j];
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (c === ch || (c === "\n" && ch !== "`")) break;
      j++;
    }
    mask.fill(1, i, Math.min(j, code.length - 1) + 1);
    i = j + 1;
  }
  return mask;
}

/** Index of the `)` matching the `(` at `open`, skipping string contents; -1 if unbalanced. */
function matchingParen(code: string, open: number, mask: Uint8Array): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (mask[i]) continue;
    if (code[i] === "(") depth++;
    else if (code[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

type PinKind = "code" | "prompt";

/** Classify a read's argument text: code path wins, then prompt path; identifiers hop one constant. */
function kindOfArgs(args: string, consts: Map<string, PinKind>): PinKind | null {
  let sawPrompt = false;
  for (const m of args.matchAll(LITERAL_RE)) {
    if (isCodePathLiteral(m[2])) return "code";
    if (isPromptPathLiteral(m[2])) sawPrompt = true;
  }
  if (sawPrompt) return "prompt";
  for (const m of args.replace(LITERAL_RE, '""').matchAll(/[A-Za-z_$][\w$]*/g)) {
    const k = consts.get(m[0]);
    if (k) return k;
  }
  return null;
}

const CONST_RE = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*([^;]*);/g;
const BIND_PREFIX_RE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*(?:await\s+)?(?:[A-Za-z_$][\w$]*\.)?$/;
const INLINE_ASSERT_PREFIX_RE = /(?:\bassert\.(?:match|doesNotMatch)|(?<![\w.$])(?:match|doesNotMatch)|\.test)\(\s*$/;
const READ_CHAIN_RE = /^(?:\s*\.\s*(?:toString|trim)\(\s*\))*/;
const INLINE_METHOD_RE = /^\s*\.(?:includes|indexOf|match|search|matchAll)\(/;
const STEP_RE = /\bstep\s*\d+/i;

function escapeRe(id: string): string {
  return id.replace(/[$]/g, "\\$&");
}

/** Statement text from `from` to the next `;` (or end). */
function statementFrom(code: string, from: number): string {
  const end = code.indexOf(";", from);
  return code.slice(from, end === -1 ? code.length : end);
}

/** A literal of >= 12 words, or a regex with >= 11 `\s+` joins: the advisory sentence-pin heuristic. */
function hasLongSentence(stmt: string): boolean {
  for (const m of stmt.matchAll(LITERAL_RE)) {
    if (m[2].split(/\s+/).filter(Boolean).length >= 12) return true;
  }
  return (stmt.match(/\\s\+/g) ?? []).length >= 11;
}

interface PinAnalysis extends PinCounts {
  advisory: number;
}

function analyzePins(source: string): PinAnalysis {
  const out: PinAnalysis = { code: 0, prompt: 0, advisory: 0 };
  const code = scannable(source);
  const mask = stringMask(code);
  const seen = new Set<string>();

  const consts = new Map<string, PinKind>();
  for (const m of code.matchAll(CONST_RE)) {
    if (mask[m.index!] || /\b(?:readFileSync|readFile)\s*\(/.test(m[2])) continue;
    const k = kindOfArgs(m[2], new Map());
    if (k) consts.set(m[1], k);
  }

  const record = (kind: PinKind, at: number, isIndexOf: boolean): void => {
    const key = `${kind}:${at}`;
    if (seen.has(key)) return;
    const stmt = statementFrom(code, at);
    if (kind === "code") {
      seen.add(key);
      out.code++;
    } else if (isIndexOf || STEP_RE.test(stmt)) {
      seen.add(key);
      out.prompt++;
    } else if (hasLongSentence(stmt)) {
      seen.add(key);
      out.advisory++;
    }
  };

  const bound = new Map<string, Set<PinKind>>();
  for (const m of code.matchAll(/\b(?:readFileSync|readFile)\s*\(/g)) {
    if (mask[m.index!]) continue;
    const open = m.index! + m[0].length - 1;
    const close = matchingParen(code, open, mask);
    if (close === -1) continue;
    const kind = kindOfArgs(code.slice(open + 1, close), consts);
    if (!kind) continue;
    const rest = code.slice(close + 1);
    const afterChain = rest.slice(READ_CHAIN_RE.exec(rest)![0].length);
    const prefix = code.slice(Math.max(0, m.index! - 160), m.index!);
    const bind = BIND_PREFIX_RE.exec(prefix);
    if (bind && /^\s*(?:;|\n|$)/.test(afterChain)) {
      const set = bound.get(bind[1]) ?? new Set<PinKind>();
      set.add(kind);
      bound.set(bind[1], set);
      continue;
    }
    if (INLINE_METHOD_RE.test(afterChain)) {
      record(kind, m.index!, /^\s*\.indexOf\(/.test(afterChain));
    } else if (INLINE_ASSERT_PREFIX_RE.test(prefix)) {
      record(kind, m.index!, false);
    }
  }

  for (const [id, kinds] of bound) {
    const v = escapeRe(id);
    const shapes: Array<[RegExp, boolean]> = [
      [new RegExp(`\\bassert\\.(?:match|doesNotMatch)\\(\\s*${v}\\s*,`, "g"), false],
      [new RegExp(`(?<![\\w.$])(?:match|doesNotMatch)\\(\\s*${v}\\s*,`, "g"), false],
      [new RegExp(`(?<![\\w.$])${v}\\.includes\\(`, "g"), false],
      [new RegExp(`(?<![\\w.$])${v}\\.indexOf\\(`, "g"), true],
      [new RegExp(`(?<![\\w.$])${v}\\.(?:match|search|matchAll)\\(`, "g"), false],
      [new RegExp(`\\.test\\(\\s*${v}\\s*\\)`, "g"), false],
    ];
    for (const [re, isIndexOf] of shapes) {
      for (const m of code.matchAll(re)) {
        if (mask[m.index!]) continue;
        for (const kind of kinds) record(kind, m.index!, isIndexOf);
      }
    }
  }
  return out;
}

/** Per-site pin counts of one test file's source. Pure; never throws. */
export function pinSitesOf(source: string): PinCounts {
  const { code, prompt } = analyzePins(source);
  return { code, prompt };
}

/** Advisory-only count of long-sentence prompt pins (never counted, never failed). */
export function advisoryPromptSites(source: string): number {
  return analyzePins(source).advisory;
}

/** Non-zero pin counts per `test/*.test.mts` file (repo-relative), sorted by path. */
export function scanPinSites(repoRoot: string): Record<string, PinCounts> {
  const dir = join(repoRoot, "test");
  const out: Record<string, PinCounts> = {};
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".test.mts")) continue;
    let src: string;
    try {
      src = readFileSync(join(dir, name), "utf8");
    } catch (err) {
      console.error(`[test-source-read-scan] cannot read test/${name}:`, err);
      continue;
    }
    const c = pinSitesOf(src);
    if (c.code > 0 || c.prompt > 0) out[`test/${name}`] = c;
  }
  return out;
}

/** The repo-relative `test/*.test.mts` files that read a code path, sorted. */
export function scanTestReaders(repoRoot: string): string[] {
  const dir = join(repoRoot, "test");
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".test.mts")) continue;
    let src: string;
    try {
      src = readFileSync(join(dir, name), "utf8");
    } catch (err) {
      console.error(`[test-source-read-scan] cannot read test/${name}:`, err);
      continue;
    }
    if (readsCodePath(src)) out.push(`test/${name}`);
  }
  return out;
}

/** The exact fixture line a reviewer adds to sanction a reader. */
export function fixtureLine(file: string, kind: ReadKind | string): string {
  return `    ${JSON.stringify(file)}: ${JSON.stringify(kind)}`;
}

/**
 * Compare the live readers against the fixture.
 *
 * @param readers files the scanner found reading a code path
 * @param baseline the parsed fixture
 * @param fileExists predicate over a repo-relative path
 */
export function checkReadRatchet(
  readers: readonly string[],
  baseline: ReadBaseline,
  fileExists: (path: string) => boolean,
  observedPins?: Record<string, PinCounts>,
): ReadViolation[] {
  const violations: ReadViolation[] = [];
  const rows = baseline && typeof baseline.files === "object" && baseline.files ? baseline.files : {};
  const readerSet = new Set(readers);
  const kinds = READ_KINDS as readonly string[];

  for (const file of readers) {
    if (!(file in rows)) {
      violations.push({
        file,
        code: "unlisted-reader",
        message:
          `${file} reads a code path but is not in test/fixtures/test-source-read-baseline.json (${RULE_ID}).\n` +
          `  Prefer running the code over reading it. If a read is truly the right test, add ONE line to "files" ` +
          `with a sanctioned kind (${READ_KINDS.join(" | ")}):\n${fixtureLine(file, "behaviour")},`,
      });
    }
  }
  for (const [file, kind] of Object.entries(rows)) {
    if (!kinds.includes(kind)) {
      violations.push({
        file,
        code: "unknown-kind",
        message: `${file}: kind ${JSON.stringify(kind)} is not one of ${READ_KINDS.join(" | ")} (${RULE_ID}).`,
      });
    }
    if (!fileExists(file)) {
      violations.push({
        file,
        code: "stale-missing-file",
        message: `${file} no longer exists - delete its row from the fixture (${RULE_ID}).`,
      });
    } else if (!readerSet.has(file)) {
      violations.push({
        file,
        code: "stale-no-longer-reads",
        message: `${file} no longer reads a code path - delete its row from the fixture (stale row; ${RULE_ID}).`,
      });
    }
  }
  if (observedPins) violations.push(...checkPinSites(observedPins, baseline));
  return violations;
}

const COUNTERS: Array<[keyof PinCounts, string]> = [
  ["code", RULE_ID],
  ["prompt", PROMPT_RULE_ID],
];

/** Shrink-only per-(file, counter) comparison. Absent baseline file or counter = 0. */
export function checkPinSites(observed: Record<string, PinCounts>, baseline: ReadBaseline): ReadViolation[] {
  const violations: ReadViolation[] = [];
  const base = baseline && typeof baseline.pinSites === "object" && baseline.pinSites ? baseline.pinSites : {};
  const files = [...new Set([...Object.keys(observed), ...Object.keys(base)])].sort();
  for (const file of files) {
    for (const [counter, rule] of COUNTERS) {
      const seen = observed[file]?.[counter] ?? 0;
      const allowed = base[file]?.[counter] ?? 0;
      if (seen > allowed) {
        violations.push({
          file,
          code: "pin-count-grew",
          message:
            `${file}: ${seen} \`${counter}\` pin site(s), baseline allows ${allowed} (${rule}).\n` +
            `  A regex / substring / indexOf assertion over a ${counter === "code" ? "code" : "playbook / prompt"} read was added. ` +
            `Run the code (or the renderer) and assert on its output instead. Do NOT raise the baseline.`,
        });
      } else if (seen < allowed) {
        violations.push({
          file,
          code: "pin-count-stale",
          message:
            `${file}: ${seen} \`${counter}\` pin site(s), baseline records ${allowed} (${rule}) - shrink it with: ${WRITE_COMMAND}`,
        });
      }
    }
  }
  return violations;
}

export type BaselineWritePlan =
  | { ok: true; next: ReadBaseline }
  | { ok: false; refusals: ReadViolation[] };

/**
 * Pure write/refuse decision behind `--write-baseline` / `--init` (INV-3).
 * `--write-baseline` never raises a count: any growth refuses. `--init` is the
 * only growth path. Only `pinSites` is rewritten; the `files` rows are untouched.
 */
export function planBaselineWrite(
  observed: Record<string, PinCounts>,
  baseline: ReadBaseline,
  init: boolean,
): BaselineWritePlan {
  const grew = checkPinSites(observed, baseline).filter((v) => v.code === "pin-count-grew");
  if (!init && grew.length > 0) return { ok: false, refusals: grew };
  return { ok: true, next: { ...baseline, pinSites: observed } };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const init = args.includes("--init");
  const write = init || args.includes("--write-baseline");
  const baseline = JSON.parse(readFileSync(join(REPO_ROOT, BASELINE_REL), "utf8")) as ReadBaseline;
  const observed = scanPinSites(REPO_ROOT);
  const violations = checkPinSites(observed, baseline);
  if (write) {
    const plan = planBaselineWrite(observed, baseline, init);
    if (!plan.ok) {
      for (const v of plan.refusals) console.error(v.message);
      console.error("test-source-read-scan: refusing to grow the baseline (use --init only to seed).");
      return 1;
    }
    await writeJsonBaseline(join(REPO_ROOT, BASELINE_REL), plan.next);
    console.log(`test-source-read-scan: wrote pinSites for ${Object.keys(observed).length} file(s).`);
    return 0;
  }
  const dir = join(REPO_ROOT, "test");
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".test.mts")) continue;
    const n = advisoryPromptSites(readFileSync(join(dir, name), "utf8"));
    if (n > 0) console.log(`advisory: test/${name}: ${n} long-sentence prompt pin(s) (${PROMPT_RULE_ID}, not counted)`);
  }
  for (const v of violations) console.error(v.message);
  if (violations.length > 0) return 1;
  console.log(`test-source-read-scan: OK (${Object.keys(observed).length} file(s) with pin sites).`);
  return 0;
}

if (isCliEntrypoint(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error("test-source-read-scan: crashed:", err);
      process.exit(2);
    },
  );
}

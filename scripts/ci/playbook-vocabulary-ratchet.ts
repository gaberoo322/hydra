#!/usr/bin/env -S npx tsx
/**
 * Playbook vocabulary ratchet (issue #5500, epic #5492).
 *
 * The playbook authoring standard (CODING_STANDARDS.md, the STD-PLAYBOOK-* rules) says a
 * playbook describes current behaviour, points at a fact's home instead of
 * copying it, and reads the Target's shape from the Target facts seam. This
 * module counts the mechanically detectable breaches of that standard in every
 * operator playbook and fragment, and caps each count per file with a
 * shrink-only baseline. It enforces STD-PLAYBOOK-POINT-DONT-RESTATE,
 * STD-PLAYBOOK-CURRENT-BEHAVIOUR, STD-PLAYBOOK-TARGET-SEAM and
 * STD-PLAYBOOK-LOGIC-IN-SCRIPTS.
 *
 * Ten banned shapes:
 *
 *   status      a status or history phrase: "not yet", "currently", "formerly",
 *               "no longer", "used to", "until #N", a rollout label
 *   line-cite   a file-and-line-number cite into a source file
 *   target      a hardcoded Target name; detection is delegated to
 *               target-coupling-check.ts, which owns the token list
 *   avoid-term  a term CONTEXT.md lists under _Avoid_ and marks retired; the
 *               list is parsed from CONTEXT.md at run time, never restated here
 *   issue-cite  a bare `#NNN` issue or PR number in prose (not in a fenced
 *               block; a `Closes #N`-style template token is exempt by token)
 *   back-compat a retention or back-compat phrase: "kept for", "legacy",
 *               "retained", "previously", "back-compat", "Phase B"
 *   shell-lines the lines inside fenced shell blocks (bash, sh, zsh, shell),
 *               one hit per block carrying its line count
 *   symbol-cite a code symbol copied into prose: a SCREAMING_SNAKE constant, a
 *               camelCase() call or a .dotted.field path (not in a fenced
 *               block; a `$VAR`/`${VAR}` shell read, a filename or glob, and a
 *               symbol tied to its file by an attribution phrase are exempt)
 *   invariant-cite an `INV-<n>` or `INV-<A>` invariant id in prose (not in a
 *               fenced block; the label that opens a definition bullet is
 *               exempt by token: that bullet is the invariant's home)
 *   process-meta PR-process meta-commentary: a closed list of phrases such as
 *               "tracked as a follow-up" or "out of scope for this PR" (not in
 *               a fenced block)
 *
 * A line that starts with `Historical:` (the existing playbook provenance
 * convention, HISTORICAL_EXEMPT_RE) is exempt from every shape. The exemption
 * covers that physical line only: the continuation lines of a hard-wrapped note
 * are counted, so a provenance note is written on one line. It does not apply
 * to shell-lines, which counts a whole fenced block, not a line.
 *
 * The baseline (scripts/ci/playbook-vocabulary-baseline.json) holds one count
 * per file per shape. A count above its baseline fails; a count below it fails
 * too until the baseline is lowered, so a removed phrase cannot creep back.
 *
 * The functions that decide are pure. The filesystem is touched only by
 * `scanRepo`, `loadBaseline` and `main`. Run by
 * test/playbook-vocabulary-ratchet.test.mts in the required suite.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { InvalidArgumentError } from "../../src/errors.ts";
import { attributedSymbols, listPlaybooks } from "./playbook-reference-check.ts";
import {
  REPO_ROOT,
  compareCountRows,
  escapeRegExp,
  formatStaleAdvice,
  isCliEntrypoint,
  loadJsonBaseline,
  mergeCountRows,
  resolveListFlag,
  runBaselineRatchet,
  type CountDelta,
} from "./seam-check-lib.ts";
import { HISTORICAL_EXEMPT_RE, classifyFile } from "./target-coupling-check.ts";

export const BASELINE_REL = "scripts/ci/playbook-vocabulary-baseline.json";
export const STANDARD_REL = "CODING_STANDARDS.md";
export const WRITE_BASELINE_CMD = "npx tsx scripts/ci/playbook-vocabulary-ratchet.ts --write-baseline";

export const SHAPES = ["status", "line-cite", "target", "avoid-term", "issue-cite", "back-compat", "shell-lines", "symbol-cite", "invariant-cite", "process-meta"] as const;
export type Shape = (typeof SHAPES)[number];

/** One banned-shape occurrence. `line` is 1-based. */
export interface Hit {
  shape: Shape;
  line: number;
  phrase: string;
  /** Weight of this hit in the per-shape count; absent means 1 (shell-lines sets the block size). */
  count?: number;
}

export type ShapeCounts = Partial<Record<Shape, number>>;

export interface Baseline {
  note: string;
  files: Record<string, ShapeCounts>;
}

/** A file whose count for one shape differs from its baseline. */
export interface Delta {
  file: string;
  shape: Shape;
  count: number;
  baseline: number;
  /** Every hit of this shape in the file (which of them is new is unknowable). */
  hits: Hit[];
}

export interface Comparison {
  exceeded: Delta[];
  stale: Delta[];
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Status and history phrases. "used to" is excluded after a passive auxiliary
 * ("is used to compute"), where it states purpose and not history.
 */
const STATUS_RE = new RegExp(
  [
    "\\bnot yet\\b",
    "\\bcurrently\\b",
    "\\bformerly\\b",
    "\\bno longer\\b",
    "(?<!\\b(?:is|are|be|been|being|was|were|get|gets|got) )\\bused to\\b",
    "\\b(?:until|once|after|when) (?:issue |PR )?#\\d+(?: (?:lands|merges|ships|is merged|is fixed))?",
    "\\b(?:shadow|enforce)[- ]mode\\b",
    "\\brollout\\b",
  ].join("|"),
  "gi",
);

/** `src/foo.ts:42`, `scripts/x.py:10-20` — a line cite into a source file. */
const LINE_CITE_RE = /[\w./-]+\.(?:ts|mts|tsx|jsx|js|mjs|py|sh):\d+(?:-\d+)?/g;

/** `#1234`, `issue #1234`, `PR #1234`, `per #1234`: 3 to 5 literal digits, so `#N` placeholders never match. */
const ISSUE_CITE_RE = /(?:\b(?:issue|PR|per) )?#\d{3,5}\b/g;

/** A template token the issue-tracker contract needs literally; removed before the issue-cite scan. */
const TEMPLATE_TOKEN_RE = /(?:Closes|Fixes|Resolves|Refs?|Part of|Blocked by|Parent)\s*:?\s*#\d+/g;

/** Retention and back-compat phrasing (closed list). */
const BACK_COMPAT_RE = /\bkept for\b|\blegacy\b|\bretained\b|\bpreviously\b|\bback-compat(?:ible|ibility)?\b/gi;
const PHASE_RE = /\b[Pp]hase [A-Z]\b/g;

/**
 * symbol-cite token forms. (i) a constant of 2+ segments, not behind `$` or `{`
 * (a shell variable read) and not a filename stem; (ii) a camelCase call; (iii) a
 * `.dotted.field` path of 2+ segments, not a filename or glob.
 */
const CONST_TOKEN_RE = /(?<![\w${])[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+(?!\w)(?!\.[a-z])/g;
const CALL_TOKEN_RE = /(?<!\w)[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\(\)/g;
const FIELD_TOKEN_RE = /(?<![\w/*.])\.[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+/g;
const FILE_EXT_TAIL_RE = /\.(?:ts|mts|tsx|js|mjs|md|json|yml|yaml|py|sh|toml|txt|tap)$/;

/** An invariant id: `INV-` plus one to three digits or one capital letter. */
const INVARIANT_ID = "INV-(?:\\d{1,3}|[A-Z])";
const INVARIANT_RE = new RegExp(`\\b${INVARIANT_ID}\\b`, "g");
/** The label that opens a definition bullet (`- **INV-A** — ...`); removed by token before the scan. */
const INVARIANT_DEFINITION_RE = new RegExp(
  `^(\\s*(?:>\\s*)*(?:[-*+]|\\d+\\.)\\s+)\\**${INVARIANT_ID}\\**(?=\\s*[\\u2014:-])`,
);

/** PR-process meta-commentary (closed list); bare "follow-up" and "this PR" are live procedure and never match. */
const PROCESS_META_RE = new RegExp(
  [
    "\\btracked (?:as a (?:separate )?follow-up|separately)\\b",
    "\\bseparate follow-up\\b",
    "\\bin a (?:separate |later )?follow-up (?:PR|issue|slice|change)\\b",
    "\\bout of scope for this (?:PR|change|issue|slice)\\b",
    "\\bin scope (?:of|for) this (?:PR|change|issue|slice)\\b",
    "\\bthis PR['\u2019]s scope\\b",
  ].join("|"),
  "gi",
);

const SHELL_INFO = new Set(["bash", "sh", "zsh", "shell"]);

/** A CommonMark fence line, optionally inside blockquote prefixes. */
const FENCE_RE = /^\s*(?:>\s*)*(`{3,}|~{3,})(.*)$/;

/** Split on `sep` at parenthesis depth 0. */
function splitTopLevel(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/**
 * The retired terms CONTEXT.md lists under `_Avoid_`. An item qualifies when
 * its parenthetical note says "retired"; a single ordinary lowercase word
 * ("digest", "spec") is left out because it also has live everyday uses.
 */
export function parseAvoidTerms(contextMd: string): string[] {
  const terms = new Set<string>();
  for (const line of contextMd.split("\n")) {
    const m = /^_Avoid_:\s*(.*)$/.exec(line);
    if (!m) continue;
    for (const item of splitTopLevel(m[1], ",")) {
      const paren = item.indexOf("(");
      if (paren === -1 || !/\bretired\b/i.test(item.slice(paren))) continue;
      for (const raw of item.slice(0, paren).split(" / ")) {
        const term = raw.trim().replace(/^["'`]+|["'`]+$/g, "").replace(/\(\)$/, "").trim();
        if (term.length < 3 || /^[a-z]+$/.test(term)) continue;
        terms.add(term);
      }
    }
  }
  return [...terms].sort();
}

function avoidRegex(terms: readonly string[]): RegExp | null {
  if (terms.length === 0) return null;
  const alt = [...terms].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|");
  return new RegExp(`(?<![\\w-])(?:${alt})(?![\\w-])`, "gi");
}

/** Every banned-shape hit in one playbook, in line order. */
export function findHits(file: string, text: string, avoidTerms: readonly string[]): Hit[] {
  const hits: Hit[] = [];
  const avoid = avoidRegex(avoidTerms);
  let fence: { char: string; len: number; info: string; line: number; lines: number } | null = null;
  const closeFence = (): void => {
    if (fence && SHELL_INFO.has(fence.info) && fence.lines > 0) {
      hits.push({
        shape: "shell-lines",
        line: fence.line,
        phrase: `${fence.info} fence, ${fence.lines} lines`,
        count: fence.lines,
      });
    }
    fence = null;
  };
  text.split("\n").forEach((line, i) => {
    const fm = FENCE_RE.exec(line);
    if (fm) {
      const marker = fm[1];
      const rest = fm[2].trim();
      if (fence) {
        if (marker[0] === fence.char && marker.length >= fence.len && rest === "") closeFence();
        else fence.lines++;
        return;
      }
      if (!(marker[0] === "`" && rest.includes("`"))) {
        fence = { char: marker[0], len: marker.length, info: (rest.split(/\s+/)[0] ?? "").toLowerCase(), line: i + 1, lines: 0 };
        return;
      }
    }
    if (fence) {
      fence.lines++;
    }
    const inFence = fence !== null;
    if (HISTORICAL_EXEMPT_RE.test(line)) return;
    const scan = (shape: Shape, re: RegExp | null, subject: string = line): void => {
      if (!re) return;
      for (const m of subject.matchAll(re)) hits.push({ shape, line: i + 1, phrase: m[0] });
    };
    scan("status", STATUS_RE);
    scan("line-cite", LINE_CITE_RE);
    scan("avoid-term", avoid);
    if (!inFence) {
      scan("issue-cite", ISSUE_CITE_RE, line.replace(TEMPLATE_TOKEN_RE, ""));
      scan("back-compat", BACK_COMPAT_RE);
      scan("back-compat", PHASE_RE);
      scan("invariant-cite", INVARIANT_RE, line.replace(INVARIANT_DEFINITION_RE, "$1"));
      scan("process-meta", PROCESS_META_RE);
      const attributed = attributedSymbols(line);
      for (const re of [CONST_TOKEN_RE, CALL_TOKEN_RE, FIELD_TOKEN_RE]) {
        for (const m of line.matchAll(re)) {
          const tok = m[0];
          if (re === FIELD_TOKEN_RE && FILE_EXT_TAIL_RE.test(tok)) continue;
          if (attributed.has(tok)) continue;
          hits.push({ shape: "symbol-cite", line: i + 1, phrase: tok });
        }
      }
    }
  });
  closeFence(); // an unclosed fence runs to the end of the file
  // The Target token list lives in target-coupling-check.ts; it applies the
  // same Historical: exemption itself.
  for (const v of classifyFile(file, text, "playbooks")) {
    if (v.severity === "name") hits.push({ shape: "target", line: v.line, phrase: v.token });
  }
  return hits.sort((a, b) => a.line - b.line || SHAPES.indexOf(a.shape) - SHAPES.indexOf(b.shape));
}

export function countByShape(hits: readonly Hit[]): ShapeCounts {
  const counts: ShapeCounts = {};
  for (const h of hits) counts[h.shape] = (counts[h.shape] ?? 0) + (h.count ?? 1);
  return counts;
}

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

const shapeCounts = (found: Record<string, Hit[]>): Record<string, ShapeCounts> => {
  const out: Record<string, ShapeCounts> = {};
  for (const [file, hits] of Object.entries(found)) out[file] = countByShape(hits);
  return out;
};

export function compareAgainstBaseline(found: Record<string, Hit[]>, baseline: Baseline): Comparison {
  const cmp = compareCountRows(shapeCounts(found), baseline.files, SHAPES);
  const toDelta = (d: CountDelta<Shape>): Delta => ({
    file: d.file,
    shape: d.key,
    count: d.count,
    baseline: d.baseline,
    hits: (found[d.file] ?? []).filter((h) => h.shape === d.key),
  });
  return { exceeded: cmp.exceeded.map(toDelta), stale: cmp.stale.map(toDelta) };
}

export function buildBaseline(found: Record<string, Hit[]>): Baseline {
  return {
    note:
      `Shrink-only per-file counts of banned playbook vocabulary (issue #5500). ` +
      `Never raise a count: rewrite the sentence per ${STANDARD_REL}. Lower with ${WRITE_BASELINE_CMD}.`,
    files: mergeCountRows({}, shapeCounts(found), SHAPES),
  };
}

/**
 * Re-seed only the named shapes' rows: every other key and the note stay as
 * they are, a file row is added only when a named shape is non-zero there and
 * dropped only when it ends up empty (STD-BASELINE-EDIT-ROWS).
 */
export function mergeBaselineForShapes(existing: Baseline, found: Record<string, Hit[]>, shapes: readonly Shape[]): Baseline {
  return { note: existing.note, files: mergeCountRows(existing.files, shapeCounts(found), SHAPES, { keys: shapes }) };
}

/** Parse a `--shape a,b` argument; an unknown name throws. */
export function parseShapeArg(arg: string): Shape[] {
  const out: Shape[] = [];
  for (const name of arg.split(",").map((n) => n.trim()).filter(Boolean)) {
    if (!(SHAPES as readonly string[]).includes(name)) {
      throw new InvalidArgumentError(`unknown shape "${name}"; expected one of ${SHAPES.join(", ")}`);
    }
    out.push(name as Shape);
  }
  if (out.length === 0) throw new InvalidArgumentError(`--shape needs at least one shape name; expected one of ${SHAPES.join(", ")}`);
  return out;
}

/**
 * Resolve the writer's `--shape` filter from argv: `undefined` = rewrite every
 * shape. A `--shape` with no/empty value, or given without `--write-baseline`,
 * throws instead of silently doing nothing.
 */
export function resolveShapeFilter(argv: readonly string[]): Shape[] | undefined {
  const names = resolveListFlag(argv, "--shape", "--shape needs a value");
  return names === undefined ? undefined : parseShapeArg(names.join(","));
}

/** Empty string when clean. */
export function formatReport(cmp: Comparison): string {
  const out: string[] = [];
  if (cmp.exceeded.length > 0) {
    out.push("Banned playbook vocabulary above the baseline:");
    for (const d of cmp.exceeded) {
      out.push(`  ${d.file}: ${d.shape} count ${d.count} > baseline ${d.baseline}`);
      for (const h of d.hits) out.push(`    ${d.file}:${h.line}  ${h.shape}  "${h.phrase}"`);
    }
    if (cmp.exceeded.some((d) => d.shape === "symbol-cite")) {
      out.push(
        "symbol-cite fix: attribute the symbol to its file with an attribution phrase (so playbook-reference-check resolves it), or name the fact's home without copying the symbol.",
      );
    }
    if (cmp.exceeded.some((d) => d.shape === "invariant-cite")) {
      out.push(
        "invariant-cite fix: name the invariant's home (the design-concept artifact, or the assert_invariants.py docstring) instead of copying the invariant id.",
      );
    }
    out.push(
      `Fix: rewrite the sentence so it states current behaviour and points at the fact's home (${STANDARD_REL}, STD-PLAYBOOK-*). ` +
        "A provenance note kept on one line may start it with `Historical:`; a wrapped continuation line is counted. Do not raise the baseline.",
    );
  }
  if (cmp.stale.length > 0) {
    out.push("Counts now below the baseline (lower the baseline so they cannot creep back):");
    for (const d of cmp.stale) out.push(`  ${d.file}: ${d.shape} count ${d.count} < baseline ${d.baseline}`);
    out.push(formatStaleAdvice({ baselineRel: BASELINE_REL, rowAction: "lower the listed counts to the printed values" }));
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Repository adapter
// ---------------------------------------------------------------------------

export function scanRepo(root: string = REPO_ROOT): Record<string, Hit[]> {
  const avoidTerms = parseAvoidTerms(readFileSync(join(root, "CONTEXT.md"), "utf8"));
  const out: Record<string, Hit[]> = {};
  for (const file of listPlaybooks(root)) {
    const hits = findHits(file, readFileSync(join(root, file), "utf8"), avoidTerms);
    if (hits.length > 0) out[file] = hits;
  }
  return out;
}

export async function loadBaseline(root: string = REPO_ROOT): Promise<Baseline> {
  return loadJsonBaseline<Baseline>(join(root, BASELINE_REL), { note: "unseeded", files: {} }, { strict: true });
}

async function main(): Promise<void> {
  const code = await runBaselineRatchet({
    name: "playbook-vocabulary-ratchet",
    baselineRel: BASELINE_REL,
    scan: () => scanRepo(),
    load: () => loadBaseline(),
    build: buildBaseline,
    merge: mergeBaselineForShapes,
    filter: resolveShapeFilter,
    compare: compareAgainstBaseline,
    report: formatReport,
  });
  if (code !== 0) process.exit(code);
}

if (isCliEntrypoint(import.meta.url)) {
  await main();
}

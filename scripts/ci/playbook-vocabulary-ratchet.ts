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
 * The same detector also backs the ADR-corpus ratchet (`adrVocabularyRatchet`,
 * ADR-0037 Decision 7), exported below with its own baseline; the CLI entry
 * runs the playbook ratchet.
 *
 * Thirteen banned shapes:
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
 *   step-cite   a step or gate number copied into prose: `Step 0.6`,
 *               `child-step 7a`, `Gate 1`. Scanned on every line, fenced or
 *               not; the label that opens a heading or definition bullet is
 *               exempt by token and the rest of that line is still scanned
 *   mktemp-no-trap a `mktemp` call inside a fenced shell block (bash, sh, zsh,
 *               shell) that has no `trap` word anywhere in the block: a trailing
 *               `rm -f` is skipped by an early `|| exit`, so only a `trap ... EXIT`
 *               cleans up on every path. One hit per `mktemp` call
 *   count-before-const a cardinal word (one to twelve) or digit run directly
 *               before a SCREAMING_SNAKE constant (not in a fenced block): the
 *               count restates the constant's home and drifts when it changes
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

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { attributedSymbols, listPlaybooks } from "./playbook-reference-check.ts";
import { defineRatchet, runIfCli } from "./ratchet.ts";
import { REPO_ROOT, escapeRegExp } from "./seam-check-lib.ts";
import { HISTORICAL_EXEMPT_RE, classifyFile } from "./target-coupling-check.ts";

export const STANDARD_REL = "CODING_STANDARDS.md";

export const SHAPES = ["status", "line-cite", "target", "avoid-term", "issue-cite", "back-compat", "shell-lines", "symbol-cite", "invariant-cite", "process-meta", "step-cite", "mktemp-no-trap", "count-before-const"] as const;
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

/** A step or gate number: `Step 0.6`, `child-step 7a`, `parent-Step 2`, `Gate 1`. */
const STEP_LABEL = "(?:(?:child-|parent-)?[Ss]tep \\d+(?:\\.\\d+)*[a-z]?|Gate \\d+)";
const STEP_CITE_RE = new RegExp(`\\b${STEP_LABEL}\\b`, "g");
/** The step or gate label that opens a heading or definition bullet; removed by token before the scan. */
const STEP_DEFINITION_RE = new RegExp(
  `^(\\s*(?:>\\s*)*(?:#{1,6}\\s+|(?:[-*+]|\\d+\\.)\\s+)?\\**)${STEP_LABEL}(?=\\**\\s*(?:[:.\\u2014\\u2013-]|'s|$))`,
);

/** A `mktemp` command word; a `trap` word anywhere in the same fenced shell block discharges every mktemp in it. */
const MKTEMP_RE = /\bmktemp\b/g;
const TRAP_RE = /\btrap\b/;

/** A count before a constant: a cardinal word (one to twelve) or digit run, a space, an optional backtick, then a SCREAMING_SNAKE constant with an underscore. A `#NNNN` digit run never matches. */
const CARDINALS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const COUNT_BEFORE_CONST_RE = new RegExp(
  `(?<![#\\w.])(?:(?:${CARDINALS.map((w) => `[${w[0]}${w[0].toUpperCase()}]${w.slice(1)}`).join("|")})|\\d+) \`?${CONST_TOKEN_RE.source}`,
  "g",
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
  let fence: { char: string; len: number; info: string; line: number; lines: number; mktemps: Hit[]; trap: boolean } | null = null;
  const closeFence = (): void => {
    if (fence && SHELL_INFO.has(fence.info) && !fence.trap) hits.push(...fence.mktemps);
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
        fence = { char: marker[0], len: marker.length, info: (rest.split(/\s+/)[0] ?? "").toLowerCase(), line: i + 1, lines: 0, mktemps: [], trap: false };
        return;
      }
    }
    if (fence) {
      fence.lines++;
    }
    const inFence = fence !== null;
    if (fence && TRAP_RE.test(line)) fence.trap = true;
    if (HISTORICAL_EXEMPT_RE.test(line)) return;
    if (fence) {
      for (const m of line.matchAll(MKTEMP_RE)) fence.mktemps.push({ shape: "mktemp-no-trap", line: i + 1, phrase: m[0] });
    }
    const scan = (shape: Shape, re: RegExp | null, subject: string = line): void => {
      if (!re) return;
      for (const m of subject.matchAll(re)) hits.push({ shape, line: i + 1, phrase: m[0] });
    };
    scan("status", STATUS_RE);
    scan("line-cite", LINE_CITE_RE);
    scan("avoid-term", avoid);
    scan("step-cite", STEP_CITE_RE, line.replace(STEP_DEFINITION_RE, "$1"));
    if (!inFence) {
      scan("issue-cite", ISSUE_CITE_RE, line.replace(TEMPLATE_TOKEN_RE, ""));
      scan("back-compat", BACK_COMPAT_RE);
      scan("back-compat", PHASE_RE);
      scan("invariant-cite", INVARIANT_RE, line.replace(INVARIANT_DEFINITION_RE, "$1"));
      scan("process-meta", PROCESS_META_RE);
      scan("count-before-const", COUNT_BEFORE_CONST_RE);
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

/** One `<playbook>\t<shape>` row per file per shape, valued at the shape's count (shell-lines: weighted lines). */
export function measureRows(root: string = REPO_ROOT): Record<string, number> {
  const rows: Record<string, number> = {};
  for (const [file, hits] of Object.entries(scanRepo(root))) {
    for (const [shape, n] of Object.entries(countByShape(hits))) {
      if (n > 0) rows[`${file}\t${shape}`] = n;
    }
  }
  return rows;
}

export const vocabularyRatchet = defineRatchet({
  id: "playbook-vocabulary-ratchet",
  baseline: "scripts/ci/playbook-vocabulary-baseline.json",
  shape: "counted",
  polarity: "ceiling",
  enforcement: "required",
  measure: async (root) => measureRows(root),
  help: [
    `Rewrite the sentence so it states current behaviour and points at the fact's home (${STANDARD_REL}, STD-PLAYBOOK-*). A provenance note kept on one line may start it with \`Historical:\`; a wrapped continuation line is counted.`,
    "symbol-cite: attribute the symbol to its file with an attribution phrase (so playbook-reference-check resolves it), or name the fact's home without copying the symbol.",
    "invariant-cite: name the invariant's home (the design-concept artifact, or the assert_invariants.py docstring) instead of copying the invariant id.",
    "step-cite: name the step by what it does, or link its heading, instead of copying its number (a step number drifts on every insertion or retitle).",
    "mktemp-no-trap: add `trap 'rm -f \"$TMP\"' EXIT` in the same fenced block, right after the mktemp; a trailing `rm -f` is skipped by an early `|| exit`.",
    "count-before-const: drop the number (\"the VERIFIER_CORE_PATHS files\"); the constant's home owns the count (STD-PLAYBOOK-POINT-DONT-RESTATE).",
    "To find the hit, diff the named playbook against master; findHits(file, text, avoidTerms) lists every hit with its line.",
  ],
});

// ---------------------------------------------------------------------------
// ADR corpus (issue #5682): the same detector over docs/adr, two shapes only
// ---------------------------------------------------------------------------

/** The shapes counted over an ADR; status / back-compat prose is legitimate in Status and Consequences, issue-cite is provenance. */
export const ADR_SHAPES = ["invariant-cite", "symbol-cite"] as const satisfies readonly Shape[];

/** The numbered ADR files, `docs/adr/<4 digits>-*.md` (never README.md), sorted. */
export function listAdrs(root: string = REPO_ROOT): string[] {
  return readdirSync(join(root, "docs/adr"))
    .filter((f) => /^\d{4}-.*\.md$/.test(f))
    .sort()
    .map((f) => `docs/adr/${f}`);
}

/** One `<adr>\t<shape>` row per ADR per counted shape, valued at the count; zero-count rows absent. */
export function measureAdrRows(root: string = REPO_ROOT): Record<string, number> {
  const avoidTerms = parseAvoidTerms(readFileSync(join(root, "CONTEXT.md"), "utf8"));
  const rows: Record<string, number> = {};
  for (const file of listAdrs(root)) {
    const hits = findHits(file, readFileSync(join(root, file), "utf8"), avoidTerms).filter((h) =>
      (ADR_SHAPES as readonly string[]).includes(h.shape),
    );
    for (const [shape, n] of Object.entries(countByShape(hits))) {
      if (n > 0) rows[`${file}\t${shape}`] = n;
    }
  }
  return rows;
}

export const adrVocabularyRatchet = defineRatchet({
  id: "adr-vocabulary-ratchet",
  baseline: "scripts/ci/adr-vocabulary-baseline.json",
  shape: "counted",
  polarity: "ceiling",
  enforcement: "required",
  measure: async (root) => measureAdrRows(root),
  help: [
    "An ADR points at the home of an invariant or symbol instead of copying it (ADR-0037 Decision 7): name the artifact or file that owns it, not its INV id, constant or field path.",
    "An in-file definition bullet (`- **INV-A** \u2014 ...`) is exempt; a count below its baseline row must be lowered in the same PR.",
    "To find the hit, run findHits(file, text, avoidTerms) over the named ADR and keep invariant-cite / symbol-cite.",
  ],
});

runIfCli(import.meta.url, vocabularyRatchet);

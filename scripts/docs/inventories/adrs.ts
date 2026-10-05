/**
 * ADRs family extractor (issue #4593 — docs-epic slice 7, per the #4544
 * resolution and ADR-0037).
 *
 * `extractAdrs(repoRoot, corpusRows)` is the ONE extraction truth for
 * docs/generated/adrs.json: one row per docs/adr/NNNN-*.md corpus member,
 * carrying the header facts in all THREE in-use Status spellings (never
 * rewritten — ADR-0037 forbids a corpus-wide reformat), the roster's
 * hand-authored Decision / Read-when cells, and a text-scan citation index.
 *
 * The roster table in docs/adr/README.md is generated IN PLACE: the runner
 * splices a fresh table between the two adr-roster HTML-comment markers, so
 * the prose around it stays hand-authored. The only hand-authored input read
 * back from the README is each row's Decision and Read-when cell, keyed by
 * number — the Status cell is always the file's own statusLine (parity by
 * construction), and the link target is never read.
 *
 * Every pure builder takes injected text (never the live tree), so fixture
 * tests pin the rules without touching docs/. Stdlib-only (ADR-0005); no
 * parameter properties, no enums (the runner is --experimental-strip-types).
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AdrRow, AdrStatus, AdrStatusDialect, AdrsInventory, CorpusRow } from "./envelope.ts";
import { CORPUS_SOURCES } from "./corpus.ts";

/** The roster file whose table the runner regenerates in place (#4593). */
export const ADR_ROSTER_FILE = "docs/adr/README.md";

/** The in-place splice markers (#4593): exactly one of each, around the table. */
export const ROSTER_BEGIN_MARKER = "<!-- adr-roster:begin -->";
export const ROSTER_END_MARKER = "<!-- adr-roster:end -->";

/** The generated table's own header — the shape test/adr-roster.test.mts pins. */
const ROSTER_HEADER = "| ADR | Status | Decision | Read when |";
const ROSTER_SEPARATOR = "|---|---|---|---|";

/** The closed status vocabulary (ADR-0037 Decision 5). */
const STATUS_VOCABULARY: readonly AdrStatus[] = [
  "proposed",
  "accepted",
  "deprecated",
  "superseded",
  "superseded-in-part",
];

/** A status declaration "sits above the body" — same window as adr-roster's declaresStatus. */
const HEAD_WINDOW = 30;

/** Extraction errors throw with this prefix so tests and humans can tell them from I/O failures. */
function fail(message: string): never {
  throw new Error(`[docs-inventories] ${message}`);
}

// ---------------------------------------------------------------------------
// Header parse (pure — takes the file's text)
// ---------------------------------------------------------------------------

/** The parsed head of one ADR file: everything before the roster join. */
export interface AdrHeader {
  number: string;
  title: string;
  /** 1-based line of the H1 (the row's source line). */
  h1Line: number;
  status: AdrStatus;
  /** The declaration verbatim, joined to one line — never rewritten. */
  statusLine: string;
  statusDialect: AdrStatusDialect;
  date: string | null;
  /** ADR-NNNN numbers after "supersedes" (statusLine or a head "Supersedes:" line), pre-symmetry. */
  supersedesRaw: string[];
  /** ADR-NNNN numbers after "superseded by" / "superseded-in-part by", pre-symmetry. */
  supersededByRaw: string[];
}

/** The first `# ` heading outside a code fence: its text and 1-based line. */
function firstH1(source: string): { text: string; line: number } | null {
  let fence: string | null = null;
  const lines = source.split(/\r?\n/);
  const fm = source.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  const skip = fm ? fm[0].split(/\r?\n/).length - 1 : 0; // frontmatter is never a heading
  for (let i = skip; i < lines.length; i += 1) {
    const f = lines[i].match(/^\s{0,3}(`{3,}|~{3,})/);
    if (f) {
      if (fence === null) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const h = lines[i].match(/^#\s+(.+?)\s*#*\s*$/);
    if (h) return { text: h[1], line: i + 1 };
  }
  return null;
}

/** The status line, verbatim, from the first of the three spellings present. */
function readStatus(lines: string[]): { statusLine: string; dialect: AdrStatusDialect } | null {
  // (a) YAML frontmatter `status:`
  if (lines[0]?.trim() === "---") {
    const close = lines.slice(1).findIndex((l) => l.trim() === "---");
    if (close !== -1) {
      const fmLine = lines
        .slice(1, close + 1)
        .find((l) => /^status\s*:\s*\S/i.test(l.trim()));
      if (fmLine) return { statusLine: fmLine.trim().replace(/^status\s*:\s*/i, "").trim(), dialect: "frontmatter" };
    }
  }
  const head = lines.slice(0, HEAD_WINDOW);
  // (b) an inline `Status:` line
  const inline = head.find((l) => /^\s*(?:\*\*)?\s*status\s*(?:\*\*)?\s*:\s*\S/i.test(l));
  if (inline) return { statusLine: inline.replace(/^\s*(?:\*\*)?\s*status\s*(?:\*\*)?\s*:\s*/i, "").trim(), dialect: "inline" };
  // (c) a `## Status` section — its first paragraph is the status (ADR-0006)
  const secIdx = head.findIndex((l) => /^#{2,}\s+status\b/i.test(l));
  if (secIdx !== -1) {
    const para: string[] = [];
    for (const l of lines.slice(secIdx + 1)) {
      if (!l.trim()) {
        if (para.length) break;
        continue;
      }
      if (/^#{1,6}\s/.test(l)) break;
      para.push(l.trim());
    }
    if (para.length) return { statusLine: para.join(" "), dialect: "section" };
  }
  return null;
}

/** The leading token of a status line, mapped onto the closed vocabulary. */
function statusToken(path: string, statusLine: string): AdrStatus {
  const token = statusLine.split(/\s+/)[0].replace(/[.,;:]+$/, "").toLowerCase();
  const hit = STATUS_VOCABULARY.find((s) => s === token);
  if (!hit) {
    fail(
      `ADR ${path}: status leading token "${token}" is not in the closed vocabulary ` +
        `(${STATUS_VOCABULARY.join(" | ")}).\nFix: the leading word of the Status declaration must be one of those — ` +
        `annotations belong after it, in parentheses.`,
    );
  }
  return hit;
}

/** Every ADR-NNNN token in `text`, on word boundaries. */
function adrNumbersIn(text: string): string[] {
  return [...text.matchAll(/\bADR-(\d{4})\b/g)].map((m) => m[1]);
}

/**
 * Parse one ADR file's head. Pure: `filename` only keys the errors and the
 * number; `source` is the file's full text.
 */
export function parseAdrHeader(filename: string, source: string): AdrHeader {
  const numberMatch = basename(filename).match(/^(\d{4})-/);
  if (!numberMatch) fail(`ADR file "${filename}" is not an NNNN-slug.md file`);
  const h1 = firstH1(source);
  if (!h1) fail(`ADR ${filename}: no H1 heading outside a code fence`);
  const title = h1.text.replace(/^ADR-\d{4}:\s*/, "");
  const lines = source.split(/\r?\n/);
  const status = readStatus(lines);
  if (!status) {
    fail(
      `ADR ${filename}: no Status declaration in any of the three accepted spellings ` +
        `(YAML frontmatter "status:", an inline "Status:" line, or a "## Status" section).\nFix: add ONE — ` +
        `ADR-0037 Decision 5 makes Status mandatory.`,
    );
  }
  const { statusLine, dialect } = status;

  // Date: a head "Date: YYYY-MM-DD" line, else the date directly after the status word.
  let date: string | null = null;
  const dateLine = lines
    .slice(0, HEAD_WINDOW)
    .find((l) => /^\s*date\s*:\s*\d{4}-\d{2}-\d{2}/i.test(l));
  if (dateLine) date = dateLine.trim().match(/\d{4}-\d{2}-\d{2}/)![0];
  else {
    const m = statusLine.match(/^\S+\s+(\d{4}-\d{2}-\d{2})\b/);
    if (m) date = m[1];
  }

  // Relations — read from the status line (and a head "Supersedes:" line); never the reverse of git.
  const supersededByRaw: string[] = [];
  for (const m of statusLine.matchAll(/superseded(?:-in-part)?\s+by\s+([^.;]*)/gi)) {
    supersededByRaw.push(...adrNumbersIn(m[1]));
  }
  const supersedesRaw: string[] = [];
  for (const m of statusLine.matchAll(/\bsupersedes\b\s+([^.;]*)/gi)) {
    supersedesRaw.push(...adrNumbersIn(m[1]));
  }
  const supersedesLine = lines.slice(0, HEAD_WINDOW).find((l) => /^\s*supersedes\s*:\s*\S/i.test(l));
  if (supersedesLine) supersedesRaw.push(...adrNumbersIn(supersedesLine));

  return {
    number: numberMatch[1],
    title,
    h1Line: h1.line,
    status: statusToken(filename, statusLine),
    statusLine,
    statusDialect: dialect,
    date,
    supersedesRaw: [...new Set(supersedesRaw)].sort(),
    supersededByRaw: [...new Set(supersededByRaw)].sort(),
  };
}

// ---------------------------------------------------------------------------
// Roster parse / render / splice (pure — takes the README's text)
// ---------------------------------------------------------------------------

/** The hand-authored input read back from the README, keyed by 4-digit number. */
export type RosterInput = Map<string, { decision: string; readWhen: string }>;

/** Split a table row on unescaped pipes; `\|` stays literal in the cell. */
function splitRow(line: string): string[] {
  return line
    .replace(/\\\|/g, "\u0000")
    .split("|")
    .map((c) => c.replace(/\u0000/g, "\\|").trim());
}

const ROSTER_ROW_RE = /^\|\s*\[(\d{4})\]\(/;
const BEGIN_RE = /<!--\s*adr-roster:begin\s*-->/;
const END_RE = /<!--\s*adr-roster:end\s*-->/;

/** The marker line indices (0-based): each marker exactly once, begin before end. */
function markerLineIndices(markdown: string): { begin: number; end: number } {
  const lines = markdown.split(/\r?\n/);
  const begins: number[] = [];
  const ends: number[] = [];
  lines.forEach((l, i) => {
    if (BEGIN_RE.test(l)) begins.push(i);
    if (END_RE.test(l)) ends.push(i);
  });
  if (begins.length === 0 || ends.length === 0) {
    fail(
      `${ADR_ROSTER_FILE} is missing its "${begins.length === 0 ? ROSTER_BEGIN_MARKER : ROSTER_END_MARKER}" marker.\n` +
        `Fix: wrap the roster table in the two adr-roster markers — npm run docs:inventories regenerates only what sits between them.`,
    );
  }
  if (begins.length > 1) fail(`${ADR_ROSTER_FILE}: "${ROSTER_BEGIN_MARKER}" appears ${begins.length} times — exactly one is allowed`);
  if (ends.length > 1) fail(`${ADR_ROSTER_FILE}: "${ROSTER_END_MARKER}" appears ${ends.length} times — exactly one is allowed`);
  if (begins[0] >= ends[0]) fail(`${ADR_ROSTER_FILE}: the begin marker must precede the end marker`);
  return { begin: begins[0], end: ends[0] };
}

/**
 * Read the hand-authored Decision / Read-when cells from the committed roster.
 * The Status cell and the link target are NEVER read — status comes from each
 * ADR file's own declaration, so roster/file parity holds by construction.
 */
export function parseRosterInput(markdown: string): RosterInput {
  const { begin, end } = markerLineIndices(markdown);
  const lines = markdown.split(/\r?\n/);
  const rows: RosterInput = new Map();
  lines.forEach((line, i) => {
    if (!ROSTER_ROW_RE.test(line)) return;
    if (i < begin || i > end) {
      fail(
        `${ADR_ROSTER_FILE}: a roster row sits OUTSIDE the adr-roster markers (line ${i + 1}).\n` +
          `Fix: move it between the markers — rows outside them are never regenerated and go stale.`,
      );
    }
    const cells = splitRow(line);
    if (cells.length !== 6) {
      fail(
        `${ADR_ROSTER_FILE}: roster row has ${cells.length - 2} cells (expected 4) — a literal "|" must be escaped as "\\|".\n  ${line}`,
      );
    }
    const number = line.match(ROSTER_ROW_RE)![1];
    if (rows.has(number)) {
      fail(`${ADR_ROSTER_FILE}: duplicate roster row for ADR-${number}.\nFix: keep one row per ADR — the roster is the routing layer (ADR-0037 Decision 6).`);
    }
    // `| a | b | c | d |`.split("|") => ["", a, b, c, d, ""] — data cells are 1..4.
    const decision = cells[3];
    const readWhen = cells[4];
    if (!decision || !readWhen) {
      fail(
        `${ADR_ROSTER_FILE}: ADR-${number}'s ${!decision ? "Decision" : "Read when"} cell is empty.\n` +
        `Fix: every row needs both — the roster is the routing layer (ADR-0037 Decision 6).`,
      );
    }
    rows.set(number, { decision, readWhen });
  });
  return rows;
}

/** Escape unescaped pipes so a statusLine cannot break its table cell. */
function escapeCellPipes(text: string): string {
  return text.replace(/(?<!\\)\|/g, "\\|");
}

/** The `ADR-NNNN [status]` listing shape for an adrs row. */
export function adrRowLabel(row: AdrRow): string {
  return `ADR-${row.number} [${row.status}]`;
}

/** The generated roster table, marker to marker: header, separator, one row per ADR in number order. */
export function renderRosterTable(rows: AdrRow[]): string {
  const body = rows.map(
    (r) => `| [${r.number}](./${basename(r.file)}) | ${escapeCellPipes(r.statusLine)} | ${r.decision} | ${r.readWhen} |`,
  );
  return [ROSTER_BEGIN_MARKER, ROSTER_HEADER, ROSTER_SEPARATOR, ...body, ROSTER_END_MARKER].join("\n");
}

/**
 * Splice the fresh table between the markers. Every byte outside the markers
 * is preserved verbatim — the README's prose stays hand-authored.
 */
export function spliceRoster(markdown: string, table: string): string {
  const { begin, end } = markerLineIndices(markdown);
  const lines = markdown.split(/\r?\n/);
  return [...lines.slice(0, begin), ...table.split("\n"), ...lines.slice(end + 1)].join("\n");
}

/** The committed README with a fresh table spliced in — the runner's byte truth for the roster. */
export function renderRosterReadme(committedReadme: string, rows: AdrRow[]): string {
  return spliceRoster(committedReadme, renderRosterTable(rows));
}

// ---------------------------------------------------------------------------
// Citation text scan (pure over injected member texts)
// ---------------------------------------------------------------------------

/** member path -> every ADR number its raw text cites on a word boundary. */
export function citationsByText(members: Array<{ path: string; text: string }>): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const { path, text } of members) {
    for (const m of String(text).matchAll(/\bADR-(\d{4})\b/g)) {
      const prior = index.get(m[1]) ?? [];
      if (!prior.includes(path)) prior.push(path);
      index.set(m[1], prior);
    }
  }
  return index;
}

// ---------------------------------------------------------------------------
// The family extractor
// ---------------------------------------------------------------------------

/** One row per docs/adr/NNNN-*.md corpus member, in number order. */
export function extractAdrs(repoRoot: string, corpusRows: CorpusRow[]): AdrsInventory {
  const byNumber = new Map<string, { corpus: CorpusRow; header: AdrHeader }>();
  for (const corpus of corpusRows) {
    if (corpus.tier !== "adr") continue;
    const header = parseAdrHeader(corpus.path, readFileSync(join(repoRoot, corpus.path), "utf8"));
    const prior = byNumber.get(header.number);
    if (prior) {
      fail(
        `duplicate ADR number ${header.number}: ${prior.corpus.path} and ${corpus.path}.\n` +
        `Fix: RENUMBER the newer file — every ADR-NNNN citation resolves through this number.`,
      );
    }
    byNumber.set(header.number, { corpus, header });
  }

  const rosterPath = join(repoRoot, ADR_ROSTER_FILE);
  if (!existsSync(rosterPath)) fail(`${ADR_ROSTER_FILE} is missing — the roster is generated in place from it`);
  const roster = parseRosterInput(readFileSync(rosterPath, "utf8"));

  for (const [number, { corpus }] of byNumber) {
    if (!roster.has(number)) {
      fail(
        `ADR file ${corpus.path} has no row in ${ADR_ROSTER_FILE}.\nFix: add a roster row (number, one-sentence decision, "read when") — ADR-0037 Decision 6 makes the roster the routing layer.`,
      );
    }
  }
  for (const number of roster.keys()) {
    if (!byNumber.has(number)) {
      fail(
        `${ADR_ROSTER_FILE} has a row for ADR-${number} but no docs/adr/${number}-*.md file exists.\nFix: correct the number, or drop the row if the ADR was renumbered.`,
      );
    }
  }

  // Relations: symmetric by construction — an edge exists iff both ends record it.
  const supersedes = new Map<string, Set<string>>([...byNumber.keys()].map((n) => [n, new Set<string>()]));
  const supersededBy = new Map<string, Set<string>>([...byNumber.keys()].map((n) => [n, new Set<string>()]));
  let relationSource = "";
  const link = (from: string, to: string): void => {
    // `to` supersedes `from`. Both endpoints must be real ADRs: a supersedes
    // edge's `from` is the CITED number, so it can name a nonexistent ADR.
    for (const n of [from, to]) {
      if (!byNumber.has(n)) {
        fail(
          `${relationSource} cites ADR-${n} in a supersedes relation (ADR-${to} supersedes ADR-${from}), but no such ADR exists.\nFix: correct the number in the Status line.`,
        );
      }
    }
    supersededBy.get(from)!.add(to);
    supersedes.get(to)!.add(from);
  };
  for (const [number, { header }] of byNumber) {
    relationSource = byNumber.get(number)!.corpus.path;
    for (const target of header.supersedesRaw) link(target, number);
    for (const target of header.supersededByRaw) link(number, target);
  }

  // Citations: one text scan over every corpus member (all tiers), self excluded.
  const citations = citationsByText(
    corpusRows.map((r) => ({ path: r.path, text: readFileSync(join(repoRoot, r.path), "utf8") })),
  );

  const rows: AdrRow[] = [...byNumber.keys()].sort().map((number) => {
    const { corpus, header } = byNumber.get(number)!;
    const input = roster.get(number)!;
    return {
      number,
      file: corpus.path,
      route: corpus.route,
      title: header.title,
      status: header.status,
      statusLine: header.statusLine,
      statusDialect: header.statusDialect,
      date: header.date,
      supersedes: [...supersedes.get(number)!].sort(),
      supersededBy: [...supersededBy.get(number)!].sort(),
      decision: input.decision,
      readWhen: input.readWhen,
      citedBy: (citations.get(number) ?? []).filter((p) => p !== corpus.path).sort(),
      source: { path: corpus.path, line: header.h1Line },
    };
  });

  return {
    family: "adrs",
    schemaVersion: 1,
    generatedFrom: ["docs/adr/*.md", ...CORPUS_SOURCES.map((s) => s.glob).filter((g) => g !== "docs/adr/*.md")],
    rows,
  };
}

#!/usr/bin/env -S npx tsx
/**
 * Playbook duplicate ratchet (issue #5587, epic #5492).
 *
 * STD-PLAYBOOK-ONE-HOME (CODING_STANDARDS.md) says a rule two playbooks share
 * lives in one fragment. This module counts, per playbook source file, the
 * passages that the file shares verbatim with another playbook source file, and
 * caps each count with a shrink-only baseline.
 *
 * A hit is a MAXIMAL run of at least `MIN_SPAN_TOKENS` consecutive normalised
 * prose tokens that also occurs, as the same token run, in at least one other
 * source file. A file's count is the number of such runs it holds; a run counts
 * once per holding file, whatever its length and however many partners hold it.
 *
 * Tokens are maximal runs of [a-z0-9_-] after lowercasing; a token with no
 * alphanumeric character is dropped. Exempt text contributes no tokens: the
 * leading YAML frontmatter, every fenced block, HTML comment lines and
 * `@include` lines. The scan set is `listPlaybooks()` (operator playbooks plus
 * `_fragments/`), never the compiled SKILL.md files, where an `@include`
 * legitimately expands one fragment into many skills. Repetition inside one
 * file is out of scope, and there is no `Historical:` exemption.
 *
 * The baseline (scripts/ci/playbook-duplicate-baseline.json) holds one span
 * count per file. A count above its baseline fails; a count below it fails too
 * until the baseline is lowered; a file absent from the baseline is capped at 0.
 *
 * The functions that decide are pure. The filesystem is touched only by
 * `scanRepo`, `loadBaseline` and `main`. Run by
 * test/playbook-duplicate-ratchet.test.mts in the required suite.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { InvalidArgumentError } from "../../src/errors.ts";
import { listPlaybooks } from "./playbook-reference-check.ts";
import {
  REPO_ROOT,
  buildRowBaseline,
  compareCountRows,
  formatStaleAdvice,
  isCliEntrypoint,
  loadJsonBaseline,
  mergeCountRows,
  resolveListFlag,
  runBaselineRatchet,
  type CountDelta,
} from "./seam-check-lib.ts";

export const BASELINE_REL = "scripts/ci/playbook-duplicate-baseline.json";
export const STANDARD_REL = "CODING_STANDARDS.md";
export const WRITE_BASELINE_CMD = "npx tsx scripts/ci/playbook-duplicate-ratchet.ts --write-baseline";
/** Shortest shared token run that counts as a duplicated passage. */
export const MIN_SPAN_TOKENS = 12;

export interface Token {
  text: string;
  /** 1-based source line. */
  line: number;
}

/** One maximal shared run held by `file`. */
export interface Span {
  file: string;
  /** Line of the span's first token. */
  line: number;
  tokens: number;
  partners: string[];
  head: string[];
}

export interface Baseline {
  note: string;
  files: Record<string, { spans: number }>;
}

export interface Delta {
  file: string;
  count: number;
  baseline: number;
  spans: Span[];
}

export interface Comparison {
  exceeded: Delta[];
  stale: Delta[];
}

/** A CommonMark fence line, optionally inside blockquote prefixes. */
const FENCE_RE = /^\s*(?:>\s*)*(`{3,}|~{3,})(.*)$/;
const INCLUDE_RE = /^\s*@include\b/;
const TOKEN_RE = /[a-z0-9_-]+/g;

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** Normalised prose tokens of one source file, exempt text removed. */
export function tokenise(text: string): Token[] {
  const out: Token[] = [];
  const lines = text.split("\n");
  let i = 0;
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((l, n) => n > 0 && l.trim() === "---");
    if (close !== -1) i = close + 1;
  }
  let fence: { char: string; len: number } | null = null;
  let inComment = false;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const fm = FENCE_RE.exec(line);
    if (fm) {
      const marker = fm[1];
      const rest = fm[2].trim();
      if (fence) {
        if (marker[0] === fence.char && marker.length >= fence.len && rest === "") fence = null;
        continue;
      }
      if (!(marker[0] === "`" && rest.includes("`"))) {
        fence = { char: marker[0], len: marker.length };
        continue;
      }
    }
    if (fence) continue;
    const trimmed = line.trim();
    if (inComment) {
      if (trimmed.includes("-->")) inComment = false;
      continue;
    }
    if (trimmed.startsWith("<!--")) {
      if (!trimmed.includes("-->")) inComment = true;
      continue;
    }
    if (INCLUDE_RE.test(line)) continue;
    for (const m of line.toLowerCase().matchAll(TOKEN_RE)) {
      if (/[a-z0-9]/.test(m[0])) out.push({ text: m[0], line: i + 1 });
    }
  }
  return out;
}

/** Map every K-token window to the set of files holding it. */
export function buildIndex(tokensByFile: Record<string, Token[]>, k: number = MIN_SPAN_TOKENS): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const [file, tokens] of Object.entries(tokensByFile)) {
    for (let i = 0; i + k <= tokens.length; i++) {
      const key = windowKey(tokens, i, k);
      let holders = index.get(key);
      if (!holders) index.set(key, (holders = new Set()));
      holders.add(file);
    }
  }
  return index;
}

function windowKey(tokens: readonly Token[], start: number, k: number): string {
  let key = tokens[start].text;
  for (let j = 1; j < k; j++) key += " " + tokens[start + j].text;
  return key;
}

/**
 * Maximal shared runs held by `file`. Consecutive shared windows merge into one
 * span while at least one partner file stays common to them all.
 */
export function findSpans(
  file: string,
  tokens: readonly Token[],
  index: ReadonlyMap<string, ReadonlySet<string>>,
  k: number = MIN_SPAN_TOKENS,
): Span[] {
  const spans: Span[] = [];
  let cur: { start: number; end: number; partners: Set<string> } | null = null;
  const flush = (): void => {
    if (!cur) return;
    spans.push({
      file,
      line: tokens[cur.start].line,
      tokens: cur.end - cur.start + k,
      partners: [...cur.partners].sort(),
      head: tokens.slice(cur.start, cur.start + k).map((t) => t.text),
    });
    cur = null;
  };
  for (let i = 0; i + k <= tokens.length; i++) {
    const holders = index.get(windowKey(tokens, i, k));
    const partners = new Set<string>();
    for (const h of holders ?? []) if (h !== file) partners.add(h);
    if (partners.size === 0) {
      flush();
      continue;
    }
    if (cur) {
      const common = new Set([...cur.partners].filter((p) => partners.has(p)));
      if (common.size > 0) {
        cur.end = i;
        cur.partners = common;
        continue;
      }
      flush();
    }
    cur = { start: i, end: i, partners };
  }
  flush();
  return spans;
}

/** Spans of every file, from the file texts keyed by repo-relative path. */
export function scanTexts(texts: Record<string, string>, k: number = MIN_SPAN_TOKENS): Record<string, Span[]> {
  const tokensByFile: Record<string, Token[]> = {};
  for (const file of Object.keys(texts).sort()) tokensByFile[file] = tokenise(texts[file]);
  const index = buildIndex(tokensByFile, k);
  const out: Record<string, Span[]> = {};
  for (const [file, tokens] of Object.entries(tokensByFile)) {
    const spans = findSpans(file, tokens, index, k);
    if (spans.length > 0) out[file] = spans;
  }
  return out;
}

export function countSpans(found: Record<string, Span[]>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [file, spans] of Object.entries(found)) if (spans.length > 0) counts[file] = spans.length;
  return counts;
}

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

const SPAN_KEYS = ["spans"] as const;

const spanCounts = (found: Record<string, Span[]>): Record<string, { spans?: number }> => {
  const out: Record<string, { spans?: number }> = {};
  for (const [file, spans] of Object.entries(found)) out[file] = { spans: spans.length };
  return out;
};

export function compareAgainstBaseline(found: Record<string, Span[]>, baseline: Baseline): Comparison {
  const cmp = compareCountRows(spanCounts(found), baseline.files, SPAN_KEYS);
  const toDelta = (d: CountDelta<"spans">): Delta => ({ file: d.file, count: d.count, baseline: d.baseline, spans: found[d.file] ?? [] });
  return { exceeded: cmp.exceeded.map(toDelta), stale: cmp.stale.map(toDelta) };
}

export function buildBaseline(found: Record<string, Span[]>): Baseline {
  const rows: Record<string, { spans: number }> = {};
  for (const [file, spans] of Object.entries(found)) rows[file] = { spans: spans.length };
  return buildRowBaseline(
    rows,
    `Shrink-only per-file counts of playbook passages shared verbatim with another playbook source (issue #5587). ` +
      `Never raise a count: move the passage into a _fragments/ file per ${STANDARD_REL} STD-PLAYBOOK-ONE-HOME. ` +
      `Lower with ${WRITE_BASELINE_CMD} [--files a.md,b.md].`,
    (row) => row.spans === 0,
  );
}

/** Re-seed only the named files' rows; every other row and the note stay as they are. */
export function mergeBaselineForFiles(existing: Baseline, found: Record<string, Span[]>, files: readonly string[]): Baseline {
  const rows = mergeCountRows(existing.files, spanCounts(found), SPAN_KEYS, { files }) as Record<string, { spans: number }>;
  return { note: existing.note, files: rows };
}

/**
 * Resolve the writer's `--files a.md,b.md` filter from argv: `undefined` = rewrite
 * every row. `--files` without `--write-baseline`, or with no/empty value, throws.
 */
export function resolveFilesFilter(argv: readonly string[]): string[] | undefined {
  const names = resolveListFlag(argv, "--files", "--files needs a comma-separated value");
  if (names !== undefined && names.length === 0) throw new InvalidArgumentError("--files needs at least one file name");
  return names;
}

/** Empty string when clean. */
export function formatReport(cmp: Comparison): string {
  const out: string[] = [];
  if (cmp.exceeded.length > 0) {
    out.push("Playbook passages duplicated across files above the baseline:");
    for (const d of cmp.exceeded) {
      out.push(`  ${d.file}: duplicated spans ${d.count} > baseline ${d.baseline}`);
      for (const s of d.spans) {
        out.push(`    ${s.file}:${s.line}  ${s.tokens} tokens  also in ${s.partners.join(", ")}  "${s.head.join(" ")}"`);
      }
    }
    out.push(
      `Fix (${STANDARD_REL} STD-PLAYBOOK-ONE-HOME): move the passage into a _fragments/ file and @include it from every holder. Do not raise the baseline.`,
    );
  }
  if (cmp.stale.length > 0) {
    out.push("Counts now below the baseline (lower the baseline so they cannot creep back):");
    for (const d of cmp.stale) {
      const partners = [...new Set(d.spans.flatMap((s) => s.partners))];
      out.push(`  ${d.file}: duplicated spans ${d.count} < baseline ${d.baseline}${partners.length ? ` (still shared with ${partners.join(", ")})` : ""}`);
    }
    out.push(formatStaleAdvice({ baselineRel: BASELINE_REL, rowAction: "lower the listed counts to the printed values" }));
    out.push(`A removed copy lowers its partner's row too; rewrite only the named rows with ${WRITE_BASELINE_CMD} --files <a.md,b.md>.`);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Repository adapter
// ---------------------------------------------------------------------------

export function scanRepo(root: string = REPO_ROOT): Record<string, Span[]> {
  const texts: Record<string, string> = {};
  for (const file of listPlaybooks(root)) texts[file] = readFileSync(join(root, file), "utf8");
  return scanTexts(texts);
}

export async function loadBaseline(root: string = REPO_ROOT): Promise<Baseline> {
  return loadJsonBaseline<Baseline>(join(root, BASELINE_REL), { note: "unseeded", files: {} }, { strict: true });
}

async function main(): Promise<void> {
  const code = await runBaselineRatchet({
    name: "playbook-duplicate-ratchet",
    baselineRel: BASELINE_REL,
    scan: () => scanRepo(),
    load: () => loadBaseline(),
    build: buildBaseline,
    merge: mergeBaselineForFiles,
    filter: resolveFilesFilter,
    compare: compareAgainstBaseline,
    report: formatReport,
  });
  if (code !== 0) process.exit(code);
}

if (isCliEntrypoint(import.meta.url)) {
  await main();
}

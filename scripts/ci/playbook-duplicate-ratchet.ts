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
 * file is not a cross-file hit, and there is no `Historical:` exemption.
 *
 * The intra-file arm counts a passage one file states twice. A window of
 * `MIN_SPAN_TOKENS` tokens whose key starts at two or more offsets of the same
 * file is a self-repeated window; consecutive ones merge into one maximal
 * intra-span while at least one repeat distance stays common. A span counts
 * once when an identical token run starts earlier in the file (the first
 * occurrence is the passage's home), so a passage stated three times counts 2.
 * Its rows are keyed `<file>\tintra` in the same baseline; the bare `<file>`
 * rows keep the cross-file meaning.
 *
 * The baseline (scripts/ci/playbook-duplicate-baseline.json) holds one span
 * count per file. A count above its baseline fails; a count below it fails too
 * until the baseline is lowered; a file absent from the baseline is capped at 0.
 *
 * The functions that decide are pure. The filesystem is touched only by
 * `readTexts`, `scanRepo`, `loadBaseline` and `main`. Run by
 * test/playbook-duplicate-ratchet.test.mts in the required suite.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listPlaybooks } from "./playbook-reference-check.ts";
import { defineRatchet, runIfCli } from "./ratchet.ts";
import { REPO_ROOT } from "./seam-check-lib.ts";

export const STANDARD_REL = "CODING_STANDARDS.md";
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

/**
 * Maximal self-repeated runs of one file. A span is returned only when an
 * identical token run starts earlier in the file; the first occurrence is the
 * home and is not a hit.
 */
export function findIntraSpans(file: string, tokens: readonly Token[], k: number = MIN_SPAN_TOKENS): Span[] {
  const offsets = new Map<string, number[]>();
  for (let i = 0; i + k <= tokens.length; i++) {
    const key = windowKey(tokens, i, k);
    const list = offsets.get(key);
    if (list) list.push(i);
    else offsets.set(key, [i]);
  }
  const spans: Span[] = [];
  let cur: { start: number; end: number; deltas: Set<number> } | null = null;
  const flush = (): void => {
    if (!cur) return;
    if ([...cur.deltas].some((d) => d < 0)) {
      spans.push({
        file,
        line: tokens[cur.start].line,
        tokens: cur.end - cur.start + k,
        partners: [file],
        head: tokens.slice(cur.start, cur.start + k).map((t) => t.text),
      });
    }
    cur = null;
  };
  for (let i = 0; i + k <= tokens.length; i++) {
    const list = offsets.get(windowKey(tokens, i, k)) ?? [];
    // Repeat distances: the signed offset from this window to every other start of its key.
    const deltas = new Set(list.filter((o) => o !== i).map((o) => o - i));
    if (deltas.size === 0) {
      flush();
      continue;
    }
    if (cur) {
      const common = new Set([...cur.deltas].filter((d) => deltas.has(d)));
      if (common.size > 0) {
        cur.end = i;
        cur.deltas = common;
        continue;
      }
      flush();
    }
    cur = { start: i, end: i, deltas };
  }
  flush();
  return spans;
}

/** Intra-file spans of every file, from the file texts keyed by repo-relative path. */
export function scanIntraTexts(texts: Record<string, string>, k: number = MIN_SPAN_TOKENS): Record<string, Span[]> {
  const out: Record<string, Span[]> = {};
  for (const file of Object.keys(texts).sort()) {
    const spans = findIntraSpans(file, tokenise(texts[file]), k);
    if (spans.length > 0) out[file] = spans;
  }
  return out;
}

/** The baseline rows: bare `<file>` for cross-file spans, `<file>\tintra` for self-repeated ones. */
export function measureTexts(texts: Record<string, string>, k: number = MIN_SPAN_TOKENS): Record<string, number> {
  const rows: Record<string, number> = { ...countSpans(scanTexts(texts, k)) };
  for (const [file, n] of Object.entries(countSpans(scanIntraTexts(texts, k)))) rows[`${file}\tintra`] = n;
  return rows;
}

export function countSpans(found: Record<string, Span[]>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [file, spans] of Object.entries(found)) if (spans.length > 0) counts[file] = spans.length;
  return counts;
}

// ---------------------------------------------------------------------------
// Repository adapter
// ---------------------------------------------------------------------------

export function readTexts(root: string = REPO_ROOT): Record<string, string> {
  const texts: Record<string, string> = {};
  for (const file of listPlaybooks(root)) texts[file] = readFileSync(join(root, file), "utf8");
  return texts;
}

export function scanRepo(root: string = REPO_ROOT): Record<string, Span[]> {
  return scanTexts(readTexts(root));
}

export const duplicateRatchet = defineRatchet({
  id: "playbook-duplicate-ratchet",
  baseline: "scripts/ci/playbook-duplicate-baseline.json",
  shape: "counted",
  polarity: "ceiling",
  enforcement: "required",
  // One bare row per playbook (cross-file spans) and one `<file>\tintra` row (self-repeated spans).
  measure: async (root) => measureTexts(readTexts(root)),
  help: [
    `Move the passage into a _fragments/ file and @include it from every holder (${STANDARD_REL} STD-PLAYBOOK-ONE-HOME).`,
    "A `<file>` + TAB + `intra` row: a passage the file states twice; delete the later copy and point at the first (STD-PLAYBOOK-ONE-HOME).",
    "A removed copy also lowers its partner playbook's row; tighten that row too.",
    "To find the span, diff the named playbook against master; scanTexts(texts) lists every span with its line and partners.",
  ],
});

runIfCli(import.meta.url, duplicateRatchet);

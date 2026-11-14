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
 * STD-PLAYBOOK-CURRENT-BEHAVIOUR and STD-PLAYBOOK-TARGET-SEAM.
 *
 * Four banned shapes:
 *
 *   status      a status or history phrase: "not yet", "currently", "formerly",
 *               "no longer", "used to", "until #N", a rollout label
 *   line-cite   a file-and-line-number cite into a source file
 *   target      a hardcoded Target name; detection is delegated to
 *               target-coupling-check.ts, which owns the token list
 *   avoid-term  a term CONTEXT.md lists under _Avoid_ and marks retired; the
 *               list is parsed from CONTEXT.md at run time, never restated here
 *
 * A line that starts with `Historical:` (the existing playbook provenance
 * convention, HISTORICAL_EXEMPT_RE) is exempt from every shape. The exemption
 * covers that physical line only: the continuation lines of a hard-wrapped note
 * are counted, so a provenance note is written on one line.
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
import { listPlaybooks } from "./playbook-reference-check.ts";
import { REPO_ROOT, isCliEntrypoint, loadJsonBaseline, writeJsonBaseline } from "./seam-check-lib.ts";
import { HISTORICAL_EXEMPT_RE, classifyFile } from "./target-coupling-check.ts";

export const BASELINE_REL = "scripts/ci/playbook-vocabulary-baseline.json";
export const STANDARD_REL = "CODING_STANDARDS.md";
export const WRITE_BASELINE_CMD = "npx tsx scripts/ci/playbook-vocabulary-ratchet.ts --write-baseline";

export const SHAPES = ["status", "line-cite", "target", "avoid-term"] as const;
export type Shape = (typeof SHAPES)[number];

/** One banned-shape occurrence. `line` is 1-based. */
export interface Hit {
  shape: Shape;
  line: number;
  phrase: string;
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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
  text.split("\n").forEach((line, i) => {
    if (HISTORICAL_EXEMPT_RE.test(line)) return;
    const scan = (shape: Shape, re: RegExp | null): void => {
      if (!re) return;
      for (const m of line.matchAll(re)) hits.push({ shape, line: i + 1, phrase: m[0] });
    };
    scan("status", STATUS_RE);
    scan("line-cite", LINE_CITE_RE);
    scan("avoid-term", avoid);
  });
  // The Target token list lives in target-coupling-check.ts; it applies the
  // same Historical: exemption itself.
  for (const v of classifyFile(file, text, "playbooks")) {
    if (v.severity === "name") hits.push({ shape: "target", line: v.line, phrase: v.token });
  }
  return hits.sort((a, b) => a.line - b.line || SHAPES.indexOf(a.shape) - SHAPES.indexOf(b.shape));
}

export function countByShape(hits: readonly Hit[]): ShapeCounts {
  const counts: ShapeCounts = {};
  for (const h of hits) counts[h.shape] = (counts[h.shape] ?? 0) + 1;
  return counts;
}

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

export function compareAgainstBaseline(found: Record<string, Hit[]>, baseline: Baseline): Comparison {
  const exceeded: Delta[] = [];
  const stale: Delta[] = [];
  const files = new Set([...Object.keys(found), ...Object.keys(baseline.files)]);
  for (const file of [...files].sort()) {
    const hits = found[file] ?? [];
    const counts = countByShape(hits);
    for (const shape of SHAPES) {
      const count = counts[shape] ?? 0;
      const allowed = baseline.files[file]?.[shape] ?? 0;
      if (count === allowed) continue;
      const delta = { file, shape, count, baseline: allowed, hits: hits.filter((h) => h.shape === shape) };
      (count > allowed ? exceeded : stale).push(delta);
    }
  }
  return { exceeded, stale };
}

export function buildBaseline(found: Record<string, Hit[]>): Baseline {
  const files: Record<string, ShapeCounts> = {};
  for (const file of Object.keys(found).sort()) {
    const counts = countByShape(found[file]);
    const ordered: ShapeCounts = {};
    for (const shape of SHAPES) if (counts[shape]) ordered[shape] = counts[shape];
    if (Object.keys(ordered).length > 0) files[file] = ordered;
  }
  return {
    note:
      `Shrink-only per-file counts of banned playbook vocabulary (issue #5500). ` +
      `Never raise a count: rewrite the sentence per ${STANDARD_REL}. Lower with ${WRITE_BASELINE_CMD}.`,
    files,
  };
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
    out.push(
      `Fix: rewrite the sentence so it states current behaviour and points at the fact's home (${STANDARD_REL}, STD-PLAYBOOK-*). ` +
        "A provenance note kept on one line may start it with `Historical:`; a wrapped continuation line is counted. Do not raise the baseline.",
    );
  }
  if (cmp.stale.length > 0) {
    out.push("Counts now below the baseline (lower the baseline so they cannot creep back):");
    for (const d of cmp.stale) out.push(`  ${d.file}: ${d.shape} count ${d.count} < baseline ${d.baseline}`);
    out.push(`Fix: ${WRITE_BASELINE_CMD}`);
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
  const found = scanRepo();
  if (process.argv.includes("--write-baseline")) {
    await writeJsonBaseline(join(REPO_ROOT, BASELINE_REL), buildBaseline(found));
    console.log(`[playbook-vocabulary-ratchet] wrote ${BASELINE_REL}`);
    return;
  }
  const report = formatReport(compareAgainstBaseline(found, await loadBaseline()));
  if (report) {
    console.error(report);
    process.exit(1);
  }
  console.log("[playbook-vocabulary-ratchet] OK");
}

if (isCliEntrypoint(import.meta.url)) {
  await main();
}

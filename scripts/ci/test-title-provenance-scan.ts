#!/usr/bin/env -S npx tsx
/**
 * Test-title provenance ratchet — STD-TEST-OWN-FEATURE check rung (issue #5511).
 *
 * A test pins its own feature. Titles and comments that narrate QA-round
 * history ("round 4", "fix-forward", "re-review", "added by #N") describe the
 * review, not the behaviour, and every in-repo precedent invites the next agent
 * to copy it. This scan finds them in `test/*.test.mts` and compares the hits
 * to a shrink-only baseline (`test/fixtures/test-title-provenance-baseline.json`).
 *
 * Key = kind TAB file TAB whitespace-normalised text — never a line number, so
 * unrelated edits above a hit do not churn the baseline. Blocking because
 * `test/test-title-provenance-ratchet.test.mts` runs the live scan inside the
 * required `test` job; `ci.yml` is untouched.
 *
 * Grammar: exactly six literal patterns (PROVENANCE_PATTERNS), applied to (a)
 * the first string-literal argument of describe/it/test (single line) and (b)
 * `//` and block comment text. A plain issue reference never matches.
 *
 * Fails closed: an unreadable test file or an unparseable fixture is an error.
 *
 * CLI (convenience only):
 *   npx tsx scripts/ci/test-title-provenance-scan.ts                  # report
 *   npx tsx scripts/ci/test-title-provenance-scan.ts --files <paths>  # new keys among those files only
 *   npx tsx scripts/ci/test-title-provenance-scan.ts --write-baseline # shrink the baseline
 *   npx tsx scripts/ci/test-title-provenance-scan.ts --init           # one-shot seed, may grow
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  REPO_ROOT,
  isCliEntrypoint,
  listTrackedFiles,
  loadJsonBaseline,
  writeJsonBaseline,
} from "./seam-check-lib.ts";
import { stripComments } from "./test-subject-map.ts";

export const PROVENANCE_BASELINE_REL = "test/fixtures/test-title-provenance-baseline.json";
export const PROVENANCE_WRITE_COMMAND =
  "npx tsx scripts/ci/test-title-provenance-scan.ts --write-baseline";

/** The whole grammar: six literal patterns, nothing file-name-dependent. */
export const PROVENANCE_PATTERNS: readonly RegExp[] = [
  /\b[Rr]ound[- ]?\d+\b/,
  /\bQA round\b/,
  /\bfix-forward\b/,
  /\bre-review\b/,
  /\badded by #\d+/,
  /\bprior finding\b/,
];

export type ProvenanceKind = "title" | "comment";

export interface ProvenanceHit {
  kind: ProvenanceKind;
  file: string;
  text: string;
}

/** Collapse whitespace runs so re-indentation does not change the key. */
export function normaliseText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Stable string key for a hit (location-free). */
export function hitKey(h: ProvenanceHit): string {
  return `${h.kind}\t${h.file}\t${normaliseText(h.text)}`;
}

export function matchesProvenance(text: string): boolean {
  return PROVENANCE_PATTERNS.some((re) => re.test(text));
}

const TITLE_CALL = /(?<![.\w$])(?:describe|it|test)(?:\.(?:skip|only|todo))?\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g;

/**
 * Comment text per line: the characters `stripComments` blanked out. It is
 * length-preserving (comment chars become spaces, newlines kept), so a comment
 * char is a position where the stripped source has a space and the original
 * does not.
 */
export function commentLines(source: string): string[] {
  const stripped = stripComments(source);
  const src = source.split("\n");
  const str = stripped.split("\n");
  const out: string[] = [];
  for (let i = 0; i < src.length; i++) {
    const a = src[i] ?? "";
    const b = str[i] ?? "";
    let text = "";
    for (let j = 0; j < a.length; j++) {
      if (b[j] === " " && a[j] !== " ") text += a[j];
      else if (text && text.at(-1) !== " ") text += " ";
    }
    const t = normaliseText(text);
    if (t) out.push(t);
  }
  return out;
}

/** Scan one test file's source. Pure. */
export function scanSource(file: string, source: string): ProvenanceHit[] {
  const hits: ProvenanceHit[] = [];
  const stripped = stripComments(source);
  // Whole-source scan: `\(\s*` spans newlines, so a prettier-wrapped
  // `it(\n  "title"` is found too.
  TITLE_CALL.lastIndex = 0;
  for (let m = TITLE_CALL.exec(stripped); m; m = TITLE_CALL.exec(stripped)) {
    const title = m[2] ?? "";
    if (matchesProvenance(title)) hits.push({ kind: "title", file, text: title });
  }
  for (const c of commentLines(source)) {
    if (matchesProvenance(c)) hits.push({ kind: "comment", file, text: c });
  }
  return hits;
}

export interface RatchetDiff {
  newKeys: string[];
  staleKeys: string[];
}

function countKeys(keys: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
  return m;
}

/** Multiset diff of scanned keys against baseline keys. Pure. */
export function diffKeys(scanned: string[], baseline: string[]): RatchetDiff {
  const have = countKeys(scanned);
  const allowed = countKeys(baseline);
  const newKeys: string[] = [];
  const staleKeys: string[] = [];
  for (const [k, n] of have) {
    for (let i = 0; i < n - (allowed.get(k) ?? 0); i++) newKeys.push(k);
  }
  for (const [k, n] of allowed) {
    for (let i = 0; i < n - (have.get(k) ?? 0); i++) staleKeys.push(k);
  }
  return { newKeys: newKeys.sort(), staleKeys: staleKeys.sort() };
}

export type ScanResult = { ok: true; keys: string[] } | { ok: false; error: string };

/** Scan test files (default: every tracked test/*.test.mts). Never throws. */
export async function scanTestFiles(files?: string[]): Promise<ScanResult> {
  const list = files ?? (await listTrackedFiles(["test/*.test.mts"])).sort();
  const keys: string[] = [];
  for (const rel of list) {
    let source: string;
    try {
      source = await readFile(join(REPO_ROOT, rel), "utf8");
    } catch (err) {
      /* intentional: the read error is returned in the result object (STD-VERIFY-NEVER-THROW); callers fail closed */
      return { ok: false, error: `could not read ${rel}: ${(err as Error).message}` };
    }
    for (const h of scanSource(rel, source)) keys.push(hitKey(h));
  }
  return { ok: true, keys };
}

interface BaselineShape {
  note?: string;
  hits: string[];
}

/** Strict load: a corrupt fixture throws (the live test fails closed on it). */
export async function loadProvenanceBaseline(): Promise<BaselineShape> {
  const b = await loadJsonBaseline<BaselineShape>(
    join(REPO_ROOT, PROVENANCE_BASELINE_REL),
    { hits: [] },
    { strict: true },
  );
  if (!b || !Array.isArray(b.hits)) {
    throw new Error(`${PROVENANCE_BASELINE_REL} is not {note, hits: string[]}`);
  }
  return b;
}

/** Human message for a failing diff; names the rule and both exits. Pure. */
export function formatFailure(diff: RatchetDiff): string {
  return [
    `STD-TEST-OWN-FEATURE ratchet: ${diff.newKeys.length} new QA-history provenance title/comment hit(s) not in ${PROVENANCE_BASELINE_REL}:`,
    ...diff.newKeys.map((k) => `  - ${k.split("\t").join(" | ").slice(0, 300)}`),
    "Fix (default): rename the title/comment to the behaviour it pins, not the review round or sibling issue that prompted it.",
    "Exception: if the test's SUBJECT is QA-round semantics, add the printed key to the fixture by hand in the same PR; the Standards reviewer judges it.",
    `Do NOT regenerate to absorb a new hit. After renaming legacy hits, shrink with: ${PROVENANCE_WRITE_COMMAND}`,
  ].join("\n");
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const init = args.includes("--init");
  const write = args.includes("--write-baseline") || init;
  const fi = args.indexOf("--files");
  const only = fi >= 0 ? args.slice(fi + 1).filter((a) => !a.startsWith("--")) : undefined;
  const scan = await scanTestFiles(only);
  if (scan.ok === false) {
    console.error(`test-title-provenance: ${scan.error}`);
    return 2;
  }
  const baseline = await loadProvenanceBaseline();
  const relevant = only
    ? baseline.hits.filter((k) => only.includes(k.split("\t")[1] ?? ""))
    : baseline.hits;
  const diff = diffKeys(scan.keys, relevant);
  if (write && !only) {
    if (!init && diff.newKeys.length > 0) {
      console.error(formatFailure(diff));
      console.error("test-title-provenance: refusing to grow the baseline (use --init only to seed).");
      return 1;
    }
    await writeJsonBaseline(join(REPO_ROOT, PROVENANCE_BASELINE_REL), {
      note: `Shrink-only STD-TEST-OWN-FEATURE baseline (issue #5511). Regenerate with: ${PROVENANCE_WRITE_COMMAND}`,
      hits: [...scan.keys].sort(),
    });
    console.log(`test-title-provenance: wrote ${scan.keys.length} baseline hit(s).`);
    return 0;
  }
  if (diff.newKeys.length > 0) {
    console.error(formatFailure(diff));
    return 1;
  }
  console.log(
    `test-title-provenance: OK (${scan.keys.length} tolerated legacy hit(s)${diff.staleKeys.length ? `, ${diff.staleKeys.length} stale — run ${PROVENANCE_WRITE_COMMAND}` : ""}).`,
  );
  return 0;
}

if (isCliEntrypoint(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error("test-title-provenance: crashed:", err);
      process.exit(2);
    },
  );
}

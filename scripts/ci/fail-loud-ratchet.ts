#!/usr/bin/env -S npx tsx
/**
 * Fail-loud ratchet — STD-CATCH-FAIL-LOUD blocking backstop (issue #5424).
 *
 * The three ast-grep rules (`fail-loud-catch` TS, `fail-loud-except-py` Python,
 * `fail-loud-devnull-sh` shell) were advisory only: a silent catch still reached
 * QA and cost a review round. This script scans the git-tracked `.ts .mts .py
 * .sh` files under `src/`, `scripts/` and `test/` with those rules and compares
 * the hits to a shrink-only baseline (`test/fixtures/fail-loud-baseline.json`).
 *
 * Key = (ruleId, file, whitespace-normalised match text) — NOT a line number.
 * An untouched legacy hit stays tolerated; any new OR edited silent catch /
 * except / `|| true` swallow is a new key and fails. It is blocking because
 * `test/fail-loud-ratchet.test.mts` runs the live scan inside `npm test` (the
 * REQUIRED `test` job); `ci.yml` is untouched.
 *
 * Fails closed: if ast-grep cannot be spawned, exits non-zero, or emits
 * unparsable JSON the scan reports an error — never a skip.
 *
 * CLI (convenience only):
 *   npx tsx scripts/ci/fail-loud-ratchet.ts                  # report
 *   npx tsx scripts/ci/fail-loud-ratchet.ts --write-baseline # shrink the baseline
 *   npx tsx scripts/ci/fail-loud-ratchet.ts --init           # (re)seed, may grow
 *
 * `--write-baseline` refuses to add keys that are not already in the baseline.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { AST_GREP_SPEC } from "../ast-search.ts";
import {
  REPO_ROOT,
  isCliEntrypoint,
  listTrackedFiles,
  loadJsonBaseline,
  writeJsonBaseline,
} from "./seam-check-lib.ts";

export const FAIL_LOUD_BASELINE_REL = "test/fixtures/fail-loud-baseline.json";
export const FAIL_LOUD_RULE_IDS = [
  "fail-loud-catch",
  "fail-loud-except-py",
  "fail-loud-devnull-sh",
] as const;
export const FAIL_LOUD_WRITE_COMMAND =
  "npx tsx scripts/ci/fail-loud-ratchet.ts --write-baseline";

/** A single hit, keyed independently of line numbers. */
export interface FailLoudHit {
  ruleId: string;
  file: string;
  text: string;
}

interface RawHit {
  ruleId?: string;
  file?: string;
  text?: string;
}

/** Collapse all whitespace runs so re-indentation does not change the key. */
export function normaliseText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Stable string key for a hit. */
export function hitKey(h: FailLoudHit): string {
  return `${h.ruleId}\t${h.file}\t${normaliseText(h.text)}`;
}

/** Map the raw `ast-grep scan --json=compact` array to hits. Pure. */
export function toHits(raw: RawHit[]): FailLoudHit[] {
  return raw
    .filter((r) => typeof r.ruleId === "string" && typeof r.file === "string")
    .map((r) => ({ ruleId: r.ruleId as string, file: r.file as string, text: r.text ?? "" }));
}

/** Build the npx argv for the scan. Pure. */
export function buildScanArgs(files: string[]): string[] {
  return [
    "--yes",
    "-p",
    AST_GREP_SPEC,
    "ast-grep",
    "scan",
    "--filter",
    `^(${FAIL_LOUD_RULE_IDS.join("|")})$`,
    "--json=compact",
    ...files,
  ];
}

/** Multiset of keys (key -> count). */
function countKeys(keys: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
  return m;
}

export interface RatchetDiff {
  /** Keys present in the scan beyond what the baseline tolerates. */
  newKeys: string[];
  /** Baseline keys no longer hit (fixed) — a shrink opportunity. */
  staleKeys: string[];
}

/** Multiset diff of scanned keys against the baseline keys. Pure. */
export function diffKeys(scanned: string[], baseline: string[]): RatchetDiff {
  const have = countKeys(scanned);
  const allowed = countKeys(baseline);
  const newKeys: string[] = [];
  const staleKeys: string[] = [];
  for (const [k, n] of have) {
    const extra = n - (allowed.get(k) ?? 0);
    for (let i = 0; i < extra; i++) newKeys.push(k);
  }
  for (const [k, n] of allowed) {
    const missing = n - (have.get(k) ?? 0);
    for (let i = 0; i < missing; i++) staleKeys.push(k);
  }
  return { newKeys: newKeys.sort(), staleKeys: staleKeys.sort() };
}

export type ScanResult = { ok: true; keys: string[] } | { ok: false; error: string };

/** Run ast-grep over the tracked files. Never throws; failures are returned. */
export async function scanTrackedFiles(): Promise<ScanResult> {
  const files = (
    await listTrackedFiles(
      // A git pathspec `*` crosses `/`, so `src/*.ts` covers nested dirs too
      // (`src/**/*.ts` would NOT match top-level files).
      ["src", "scripts", "test"].flatMap((d) => ["ts", "mts", "py", "sh"].map((e) => `${d}/*.${e}`)),
    )
  ).sort();
  const result = spawnSync("npx", buildScanArgs(files), {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) {
    return { ok: false, error: `could not spawn ast-grep via npx: ${result.error.message}` };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      error: `ast-grep exited ${result.status}: ${(result.stderr ?? "").trim().slice(0, 2000)}`,
    };
  }
  let raw: RawHit[];
  try {
    raw = JSON.parse(result.stdout || "[]") as RawHit[];
  } catch (err) {
    /* intentional: the parse error is returned in the result object (STD-VERIFY-NEVER-THROW) and the caller fails closed on it */
    return { ok: false, error: `unparsable ast-grep JSON: ${(err as Error).message}` };
  }
  if (!Array.isArray(raw)) return { ok: false, error: "ast-grep JSON was not an array" };
  return { ok: true, keys: toHits(raw).map(hitKey) };
}

interface BaselineShape {
  note?: string;
  hits: string[];
}

export async function loadFailLoudBaseline(): Promise<BaselineShape> {
  return loadJsonBaseline<BaselineShape>(join(REPO_ROOT, FAIL_LOUD_BASELINE_REL), { hits: [] });
}

/** Human message for a failing diff; names the fix. Pure. */
export function formatFailure(diff: RatchetDiff): string {
  return [
    `STD-CATCH-FAIL-LOUD ratchet: ${diff.newKeys.length} new silent catch/except/\`|| true\` hit(s) not in ${FAIL_LOUD_BASELINE_REL}:`,
    ...diff.newKeys.map((k) => `  - ${k.split("\t").join(" | ").slice(0, 300)}`),
    "Fix: log with context or rethrow, or annotate `/* intentional: <reason> */` (TS) / `# intentional: <reason>` (Python, shell).",
    `Do NOT add the hit to the baseline. After fixing legacy hits, shrink it with: ${FAIL_LOUD_WRITE_COMMAND}`,
  ].join("\n");
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const init = args.includes("--init");
  const write = args.includes("--write-baseline") || init;
  const scan = await scanTrackedFiles();
  if (scan.ok === false) {
    console.error(`fail-loud-ratchet: ${scan.error}`);
    return 2;
  }
  const baseline = await loadFailLoudBaseline();
  const diff = diffKeys(scan.keys, baseline.hits);
  if (write) {
    if (!init && diff.newKeys.length > 0) {
      console.error(formatFailure(diff));
      console.error("fail-loud-ratchet: refusing to grow the baseline (use --init only to seed).");
      return 1;
    }
    await writeJsonBaseline(join(REPO_ROOT, FAIL_LOUD_BASELINE_REL), {
      note: `Shrink-only STD-CATCH-FAIL-LOUD baseline (issue #5424). Regenerate with: ${FAIL_LOUD_WRITE_COMMAND}`,
      hits: [...scan.keys].sort(),
    });
    console.log(`fail-loud-ratchet: wrote ${scan.keys.length} baseline hit(s).`);
    return 0;
  }
  if (diff.newKeys.length > 0) {
    console.error(formatFailure(diff));
    return 1;
  }
  console.log(
    `fail-loud-ratchet: OK (${scan.keys.length} tolerated legacy hit(s)${diff.staleKeys.length ? `, ${diff.staleKeys.length} stale — run ${FAIL_LOUD_WRITE_COMMAND}` : ""}).`,
  );
  return 0;
}

if (isCliEntrypoint(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error("fail-loud-ratchet: crashed:", err);
      process.exit(2);
    },
  );
}

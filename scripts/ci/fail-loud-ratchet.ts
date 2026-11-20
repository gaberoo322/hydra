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
 * The baseline is a sorted {key: count} object and the comparison lives in
 * scripts/ci/ratchet.ts (shape `counted`, ceiling).
 *
 * CLI (convenience only):
 *   npx tsx scripts/ci/fail-loud-ratchet.ts                  # report
 *   npx tsx scripts/ci/fail-loud-ratchet.ts --write-baseline # shrink the baseline (refuses growth; --allow-grow to seed)
 */

import { spawnSync } from "node:child_process";
import { AST_GREP_SPEC } from "../ast-search.ts";
import { GateInvariantError } from "../../src/errors.ts";
import { defineRatchet, runIfCli } from "./ratchet.ts";
import { REPO_ROOT, listTrackedFiles } from "./seam-check-lib.ts";

export const FAIL_LOUD_BASELINE_REL = "test/fixtures/fail-loud-baseline.json";
export const FAIL_LOUD_RULE_IDS = [
  "fail-loud-catch",
  "fail-loud-catch-src",
  "fail-loud-except-py",
  "fail-loud-devnull-sh",
] as const;

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

export const failLoudRatchet = defineRatchet({
  id: "fail-loud-ratchet",
  baseline: FAIL_LOUD_BASELINE_REL,
  shape: "counted",
  polarity: "ceiling",
  // INV-4 exception (disclosed in PR #5681 body): hint, not fail. Migration parity (INV-8): the pre-Ratchet script only hinted on stale rows.
  stale: "hint",
  enforcement: "required",
  async measure() {
    const scan = await scanTrackedFiles();
    if (scan.ok === false) throw new GateInvariantError(`ast-grep scan failed: ${scan.error}`);
    return scan.keys;
  },
});

runIfCli(import.meta.url, failLoudRatchet);

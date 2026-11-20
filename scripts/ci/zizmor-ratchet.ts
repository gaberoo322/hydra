#!/usr/bin/env -S npx tsx
/**
 * zizmor finding ratchet (issue #5640).
 *
 * Caps the number of zizmor findings per workflow file per ident with a
 * shrink-only baseline (scripts/ci/zizmor-baseline.json), so a new
 * `unpinned-uses`, `excessive-permissions`, `template-injection` ... finding
 * fails instead of being re-found by a reviewer each time a workflow is touched.
 *
 * PURE: this module reads zizmor json-v1 findings from `--input <path>`
 * (default `zizmor-results.json`, the file the advisory scan step writes) and
 * compares or writes the baseline. It never runs the scanner and never touches
 * the network, so the required `test` job can unit-test it on inline fixture
 * JSON and the live comparison stays in the advisory-checks.yml lane (a
 * downloaded binary inside the required gate is the ambient poison-pill class).
 *
 * Exit codes: 0 clean (or a successful write), 1 a finding count above its
 * baseline (or a refused, growing write), 2 a missing or unparseable input.
 *
 *   npx tsx scripts/ci/zizmor-ratchet.ts --input zizmor-results.json
 *   bash scripts/zizmor-scan.sh > /tmp/z.json   # exit 11-14 means findings
 *   npx tsx scripts/ci/zizmor-ratchet.ts --input /tmp/z.json --write-baseline [--files a,b]
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { InvalidArgumentError } from "../../src/errors.ts";
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
  type RowBaseline,
} from "./seam-check-lib.ts";

export const BASELINE_REL = "scripts/ci/zizmor-baseline.json";
export const DEFAULT_INPUT = "zizmor-results.json";
export const UNKNOWN_FILE = "<unknown>";
export const WRITE_BASELINE_CMD = "npx tsx scripts/ci/zizmor-ratchet.ts --input <json> --write-baseline";

/** One workflow file's finding counts, keyed by zizmor ident. */
export type IdentCounts = Record<string, number>;
export type Baseline = RowBaseline<IdentCounts>;
export type Found = Record<string, IdentCounts>;

export interface Comparison {
  exceeded: CountDelta<string>[];
  stale: CountDelta<string>[];
}

/** Raised for an input that is missing or is not a zizmor json-v1 array (CLI exit 2). */
export class ZizmorInputError extends Error {
  readonly code = "zizmor-input-invalid" as const;
  constructor(message: string) {
    super(message);
    this.name = "ZizmorInputError";
  }
}

interface RawFinding {
  ident?: unknown;
  ignored?: unknown;
  locations?: Array<{ symbolic?: { key?: { Local?: { verbatim_path?: unknown } } } }>;
}

/**
 * zizmor reports the path it was handed, which the wrapper makes absolute, so the
 * raw value differs per checkout. Key rows by the repo-relative `.github/...` tail.
 */
export function repoRelative(path: string): string {
  const at = path.lastIndexOf(".github/workflows/");
  return at === -1 ? path : path.slice(at);
}

/** Count json-v1 findings per `locations[0]` workflow path x ident; `ignored: true` findings are skipped. */
export function countFindings(findings: unknown): Found {
  if (!Array.isArray(findings)) throw new ZizmorInputError("zizmor json-v1 input must be a JSON array");
  const out: Found = {};
  for (const f of findings as RawFinding[]) {
    if (f === null || typeof f !== "object" || typeof f.ident !== "string") {
      throw new ZizmorInputError("zizmor finding without a string `ident`");
    }
    if (f.ignored === true) continue;
    const path = f.locations?.[0]?.symbolic?.key?.Local?.verbatim_path;
    const file = typeof path === "string" && path ? repoRelative(path) : UNKNOWN_FILE;
    out[file] = out[file] ?? {};
    out[file][f.ident] = (out[file][f.ident] ?? 0) + 1;
  }
  return out;
}

/** The ratcheted keys: every ident seen in the findings or the baseline, sorted. */
function identKeys(found: Found, baseline: Record<string, IdentCounts>): string[] {
  const keys = new Set<string>();
  for (const row of [...Object.values(found), ...Object.values(baseline)]) {
    for (const k of Object.keys(row)) keys.add(k);
  }
  return [...keys].sort();
}

export function compareAgainstBaseline(found: Found, baseline: Baseline): Comparison {
  return compareCountRows(found, baseline.files, identKeys(found, baseline.files));
}

export function buildBaseline(found: Found): Baseline {
  const rows: Found = {};
  for (const [file, row] of Object.entries(found)) {
    const sorted: IdentCounts = {};
    for (const k of Object.keys(row).sort()) sorted[k] = row[k]!;
    rows[file] = sorted;
  }
  return buildRowBaseline(
    rows,
    `Shrink-only per-workflow zizmor finding counts by ident (issue #5640). ` +
      `Never raise a count: fix the finding. Lower with ${WRITE_BASELINE_CMD}.`,
    (row) => Object.keys(row).length === 0,
  );
}

/** Scoped re-seed (STD-BASELINE-EDIT-ROWS): only the named workflow files' rows take fresh counts. */
export function mergeBaselineForFiles(existing: Baseline, found: Found, files: readonly string[]): Baseline {
  const keys = identKeys(found, existing.files);
  return { note: existing.note, files: mergeCountRows(existing.files, found, keys, { files }) };
}

/** Empty string when clean. */
export function formatReport(cmp: Comparison): string {
  const out: string[] = [];
  if (cmp.exceeded.length > 0) {
    out.push("zizmor findings above the baseline:");
    for (const d of cmp.exceeded) out.push(`  ${d.file}: ${d.key} count ${d.count} > baseline ${d.baseline}`);
    out.push("Fix: resolve the finding (see zizmor-results.json). Do not raise the baseline.");
  }
  if (cmp.stale.length > 0) {
    out.push("Counts now below the baseline (lower the baseline so they cannot creep back):");
    for (const d of cmp.stale) out.push(`  ${d.file}: ${d.key} count ${d.count} < baseline ${d.baseline}`);
    out.push(formatStaleAdvice({ baselineRel: BASELINE_REL, rowAction: "lower the listed counts to the printed values" }));
  }
  return out.join("\n");
}

/** `--input <path>`; defaults to zizmor-results.json. */
export function resolveInputPath(argv: readonly string[]): string {
  const at = argv.indexOf("--input");
  if (at === -1) return DEFAULT_INPUT;
  const value = argv[at + 1];
  if (value === undefined || value.startsWith("--")) throw new InvalidArgumentError("--input needs a path");
  return value;
}

/** Read and count the json-v1 findings at `path`; a missing or unparseable file is a ZizmorInputError. */
export function loadFindings(path: string): Found {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new ZizmorInputError(`cannot read zizmor input ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ZizmorInputError(`zizmor input ${path} is not valid JSON: ${(err as Error).message}`);
  }
  return countFindings(parsed);
}

export async function loadBaseline(root: string = REPO_ROOT): Promise<Baseline> {
  return loadJsonBaseline<Baseline>(join(root, BASELINE_REL), { note: "unseeded", files: {} }, { strict: true });
}

async function main(): Promise<void> {
  let found: Found;
  try {
    found = loadFindings(resolveInputPath(process.argv));
  } catch (err) {
    if (err instanceof ZizmorInputError || err instanceof InvalidArgumentError) {
      console.error(`[zizmor-ratchet] ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
  const code = await runBaselineRatchet({
    name: "zizmor-ratchet",
    baselineRel: BASELINE_REL,
    scan: () => found,
    load: () => loadBaseline(),
    build: buildBaseline,
    merge: mergeBaselineForFiles,
    filter: (argv) => resolveListFlag(argv, "--files", "--files needs a value"),
    compare: compareAgainstBaseline,
    report: formatReport,
    failHeadline: "[zizmor-ratchet] FAIL",
  });
  if (code !== 0) process.exit(code);
}

if (isCliEntrypoint(import.meta.url)) {
  await main();
}

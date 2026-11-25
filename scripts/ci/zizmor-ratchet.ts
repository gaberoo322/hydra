#!/usr/bin/env -S npx tsx
/**
 * zizmor finding ratchet (issue #5640), on the Ratchet module (#5656).
 *
 * Caps the number of zizmor findings per workflow file per ident with a
 * shrink-only counted baseline (scripts/ci/zizmor-baseline.json: a flat sorted
 * `{"<workflow-path>\t<ident>": n}` object), so a new `unpinned-uses`,
 * `excessive-permissions`, `template-injection` ... finding fails instead of
 * being re-found by a reviewer each time a workflow is touched.
 *
 * PURE: `measure` reads zizmor json-v1 findings from `<root>/zizmor-results.json`
 * (the file the advisory scan step writes); `--input <path>` narrows a CHECK run
 * to another findings file. It never runs the scanner and never touches the
 * network, so the required `test` job can unit-test it on inline fixture JSON
 * and the live comparison stays in the advisory-checks.yml lane (a downloaded
 * binary inside the required gate is the ambient poison-pill class).
 *
 * Exit codes (the Ratchet module's): 0 clean, 1 a finding count above its
 * baseline, 2 a missing or unparseable input or a usage error.
 *
 *   npx tsx scripts/ci/zizmor-ratchet.ts --input zizmor-results.json
 *   bash scripts/zizmor-scan.sh > zizmor-results.json   # exit 11-14 means findings
 *   npx tsx scripts/ci/zizmor-ratchet.ts --write-baseline
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { InvalidArgumentError } from "../../src/errors.ts";
import { defineRatchet, runIfCli, type RatchetRows } from "./ratchet.ts";

export const BASELINE_REL = "scripts/ci/zizmor-baseline.json";
export const DEFAULT_INPUT = "zizmor-results.json";
export const UNKNOWN_FILE = "<unknown>";

/** One workflow file's finding counts, keyed by zizmor ident. */
export type IdentCounts = Record<string, number>;
export type Found = Record<string, IdentCounts>;

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

/** Flatten per-file ident counts to the ratchet's counted rows: `<workflow-path>\t<ident>` -> n. */
export function toRows(found: Found): Record<string, number> {
  const rows: Record<string, number> = {};
  for (const [file, idents] of Object.entries(found)) {
    for (const [ident, n] of Object.entries(idents)) rows[`${file}\t${ident}`] = n;
  }
  return rows;
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

const measureFrom =
  (path: string) =>
  async (): Promise<RatchetRows> =>
    toRows(loadFindings(path));

export const zizmorRatchet = defineRatchet({
  id: "zizmor-ratchet",
  baseline: BASELINE_REL,
  shape: "counted",
  polarity: "ceiling",
  stale: "hint",
  enforcement: "advisory",
  measure: (root) => measureFrom(join(root, DEFAULT_INPUT))(),
  help: ["Resolve the finding (see zizmor-results.json). Do not raise the baseline."],
  extra: {
    flags: ["--input"],
    scope(argv) {
      const at = argv.indexOf("--input");
      if (at === -1) return undefined;
      const value = argv[at + 1];
      if (value === undefined || value.startsWith("--")) throw new InvalidArgumentError("--input needs a path");
      // A narrowed CHECK run: another findings file, every baseline row still in play.
      return { measure: measureFrom(value), keep: () => true };
    },
  },
});

runIfCli(import.meta.url, zizmorRatchet);

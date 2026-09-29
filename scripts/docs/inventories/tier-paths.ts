/**
 * tier-paths family extractor (issue #4594 — docs-epic 8/13, per the #4542
 * families table and ADR-0034 §10).
 *
 * T4 rows come from the IMPORTED Verifier Core list (VERIFIER_CORE_PATHS,
 * src/untouchable.ts). T1/T2 rows come from text-scanning the module-private
 * TIER_1_PREFIXES / TIER_2_PREFIXES / TIER_2_FILES frozen literals in
 * src/tier-classifier.ts — they are not exported and the file is Verifier Core
 * (T4), so it is READ, never modified. One T3 default row closes the ladder.
 *
 * Every scanned or imported entry is VERIFIED through the imported
 * classifyChange: a prefix is probed as `<prefix>__tier_probe__`, a file as
 * itself, and the returned tier must equal the row's tier. A mismatch or an
 * empty scanned list throws, so a regex that silently misses a tier can never
 * produce a green catalogue.
 *
 * Stdlib-only (ADR-0005). Fail-loud (CLAUDE.md).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyChange } from "../../../src/tier-classifier.ts";
import { VERIFIER_CORE_PATHS } from "../../../src/untouchable.ts";
import type { TierPathRow, TierPathsInventory } from "./envelope.ts";
import { fail, lineOf, stripComments } from "./scan.ts";

const CLASSIFIER_FILE = "src/tier-classifier.ts";
const UNTOUCHABLE_FILE = "src/untouchable.ts";

const GENERATED_FROM = ["src/untouchable.ts", "src/tier-classifier.ts"];

export const TIER_PROBE_SUFFIX = "__tier_probe__";

export interface TierPathInputs {
  /** The imported VERIFIER_CORE_PATHS. */
  verifierCorePaths: readonly string[];
  /** Raw text of src/tier-classifier.ts. */
  classifierSource: string;
  /** Raw text of src/untouchable.ts. */
  untouchableSource: string;
  /** The imported classifier (injectable so a fixture can prove a mismatch throws). */
  classify: (files: string[]) => { tier: number };
}

/** Quoted entries (with 1-based lines) of `const <name> … = Object.freeze([ … ])`. */
function scanFrozenList(src: string, name: string): Array<{ value: string; line: number }> {
  const code = stripComments(src);
  const m = new RegExp(`\\bconst\\s+${name}\\b[^=]*=\\s*Object\\.freeze\\(\\s*\\[([\\s\\S]*?)\\]\\s*\\)`).exec(code);
  if (!m) fail(`${CLASSIFIER_FILE}: no "const ${name} = Object.freeze([...])" literal found`);
  const bodyAt = (m.index ?? 0) + m[0].indexOf("[") + 1;
  const out: Array<{ value: string; line: number }> = [];
  for (const q of m[1].matchAll(/(["'])([^"'\n]+)\1/g)) {
    out.push({ value: q[2], line: lineOf(code, bodyAt + (q.index ?? 0)) });
  }
  if (out.length === 0) fail(`${CLASSIFIER_FILE}: ${name} scanned empty — the tier catalogue would silently miss a tier`);
  return out;
}

/** Pure row-builder: injected inputs in, rows sorted by tier then path out. */
export function buildTierPathRows(inputs: TierPathInputs): TierPathRow[] {
  const rows: TierPathRow[] = [];
  const kindOf = (p: string): "prefix" | "file" => (p.endsWith("/") ? "prefix" : "file");

  if (inputs.verifierCorePaths.length === 0) fail(`${UNTOUCHABLE_FILE}: VERIFIER_CORE_PATHS is empty`);
  for (const path of inputs.verifierCorePaths) {
    const at = inputs.untouchableSource.indexOf(`"${path}"`);
    if (at === -1) fail(`${UNTOUCHABLE_FILE}: Verifier Core entry "${path}" has no quoted source line`);
    rows.push({ tier: 4, kind: kindOf(path), path, source: { path: UNTOUCHABLE_FILE, line: lineOf(inputs.untouchableSource, at) } });
  }
  for (const [name, tier, kind] of [
    ["TIER_1_PREFIXES", 1, "prefix"],
    ["TIER_2_PREFIXES", 2, "prefix"],
    ["TIER_2_FILES", 2, "file"],
  ] as const) {
    for (const e of scanFrozenList(inputs.classifierSource, name)) {
      rows.push({ tier, kind, path: e.value, source: { path: CLASSIFIER_FILE, line: e.line } });
    }
  }

  // Behavioural verification: the classifier must agree with every row.
  for (const row of rows) {
    const probe = row.kind === "prefix" ? `${row.path}${TIER_PROBE_SUFFIX}` : row.path;
    const got = inputs.classify([probe]).tier;
    if (got !== row.tier) {
      fail(`tier-paths: ${row.source.path}:${row.source.line} "${row.path}" scanned as T${row.tier} but classifyChange(["${probe}"]) returned T${got}`);
    }
  }

  const defaultAt = inputs.classifierSource.search(/\bfunction\s+classifyOne\s*\(/);
  if (defaultAt === -1) fail(`${CLASSIFIER_FILE}: no classifyOne function — cannot anchor the T3 default row`);
  rows.push({ tier: 3, kind: "default", path: "*", source: { path: CLASSIFIER_FILE, line: lineOf(inputs.classifierSource, defaultAt) } });

  rows.sort((a, b) => (a.tier !== b.tier ? a.tier - b.tier : a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return rows;
}

/** The listing/sort label of a tier-paths row. */
export function tierPathRowLabel(row: TierPathRow): string {
  return `T${row.tier} ${row.kind} ${row.path}`;
}

export function extractTierPaths(repoRoot: string): TierPathsInventory {
  const rows = buildTierPathRows({
    verifierCorePaths: VERIFIER_CORE_PATHS,
    classifierSource: readFileSync(join(repoRoot, CLASSIFIER_FILE), "utf8"),
    untouchableSource: readFileSync(join(repoRoot, UNTOUCHABLE_FILE), "utf8"),
    classify: classifyChange,
  });
  return { family: "tier-paths", schemaVersion: 1, generatedFrom: GENERATED_FROM, rows };
}

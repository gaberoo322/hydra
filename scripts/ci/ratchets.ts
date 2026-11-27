/**
 * The Ratchet registry (issue #5656, parent epic #5649): every `*-baseline.json`
 * under `scripts/ci/` and `test/fixtures/` has exactly one row here, and the row
 * says what kind of file it is, which direction is bad for it and how hard CI
 * enforces it today. `baseline-raise-check` reads this instead of guessing.
 *
 * Row kinds
 *   ratchet   a check that runs on the Ratchet module (`defineRatchet`); the row
 *             holds the `Ratchet`, so baseline / polarity / enforcement are read
 *             from `ratchet.policy` and the live `verdict()` stays reachable.
 *   external  a check that owns a baseline but does not run on the module
 *             (suite-count floor, adr-area and coding-standards ceilings); the
 *             row declares the same facts by hand.
 *   fixture   a committed snapshot or cohort ledger, not a ratchet: no polarity.
 *
 * `enforcement` records today's level (epic #5649 Decision 12); this file never
 * changes one. Importing this module has no side effects: every ratchet module
 * gates its CLI behind `runIfCli`.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { anthropicSeamRatchet } from "./anthropic-seam-check.ts";
import { claudeCliSeamRatchet } from "./claude-cli-seam-check.ts";
import { failLoudRatchet } from "./fail-loud-ratchet.ts";
import { githubSeamRatchet } from "./github-seam-check.ts";
import { hostProbeSeamRatchet } from "./host-probe-seam-check.ts";
import { journalSeamRatchet } from "./journal-seam-check.ts";
import { lifecycleSeamRatchet } from "./lifecycle-seam-check.ts";
import { neverThrowRatchet } from "./never-throw-scan.ts";
import { duplicateRatchet } from "./playbook-duplicate-ratchet.ts";
import { referenceRatchet } from "./playbook-reference-check.ts";
import { adrVocabularyRatchet, vocabularyRatchet } from "./playbook-vocabulary-ratchet.ts";
import { querySeamRatchet } from "./query-seam-check.ts";
import type { Ratchet, RatchetEnforcement, RatchetPolarity } from "./ratchet.ts";
import { redisSeamRatchet } from "./redis-seam-check.ts";
import { schemaSeamRatchet } from "./schema-seam-check.ts";
import { skillSizeRatchet } from "./skill-size-ratchet.ts";
import { suiteTotalRatchet } from "./suite-total-ratchet.ts";
import { targetCouplingRatchet } from "./target-coupling-check.ts";
import { telegramSeamRatchet } from "./telegram-seam-check.ts";
import { testSourceReadRatchet } from "./test-source-read-scan.ts";
import { testSubjectRatchet } from "./test-subject-map.ts";
import { provenanceRatchet } from "./test-title-provenance-scan.ts";
import { typecheckRatchet } from "./test-typecheck-check.ts";
import { zizmorRatchet } from "./zizmor-ratchet.ts";
import { proseDriftRatchet } from "../docs/prose-drift.ts";

export type RatchetRow =
  | { kind: "ratchet"; ratchet: Ratchet }
  | {
      kind: "external";
      id: string;
      baseline: string;
      /** Absent when the baseline has no direction (the PR guard then skips it). */
      polarity?: RatchetPolarity;
      enforcement: RatchetEnforcement;
      /** The script or test that owns the file. */
      owner: string;
    }
  | { kind: "fixture"; id: string; baseline: string; owner: string };

export const RATCHETS: readonly RatchetRow[] = [
  { kind: "ratchet", ratchet: adrVocabularyRatchet },
  { kind: "ratchet", ratchet: anthropicSeamRatchet },
  { kind: "ratchet", ratchet: claudeCliSeamRatchet },
  { kind: "ratchet", ratchet: duplicateRatchet },
  { kind: "ratchet", ratchet: failLoudRatchet },
  { kind: "ratchet", ratchet: githubSeamRatchet },
  { kind: "ratchet", ratchet: hostProbeSeamRatchet },
  { kind: "ratchet", ratchet: journalSeamRatchet },
  { kind: "ratchet", ratchet: lifecycleSeamRatchet },
  { kind: "ratchet", ratchet: neverThrowRatchet },
  { kind: "ratchet", ratchet: proseDriftRatchet },
  { kind: "ratchet", ratchet: provenanceRatchet },
  { kind: "ratchet", ratchet: querySeamRatchet },
  { kind: "ratchet", ratchet: redisSeamRatchet },
  { kind: "ratchet", ratchet: referenceRatchet },
  { kind: "ratchet", ratchet: schemaSeamRatchet },
  { kind: "ratchet", ratchet: skillSizeRatchet },
  { kind: "ratchet", ratchet: suiteTotalRatchet },
  { kind: "ratchet", ratchet: targetCouplingRatchet },
  { kind: "ratchet", ratchet: telegramSeamRatchet },
  { kind: "ratchet", ratchet: testSourceReadRatchet },
  { kind: "ratchet", ratchet: testSubjectRatchet },
  { kind: "ratchet", ratchet: typecheckRatchet },
  { kind: "ratchet", ratchet: vocabularyRatchet },
  { kind: "ratchet", ratchet: zizmorRatchet },
  {
    kind: "external",
    id: "suite-count",
    baseline: "test/fixtures/suite-count-baseline.json",
    polarity: "floor",
    enforcement: "required",
    owner: "scripts/test/suite-count-check.mjs",
  },
  {
    kind: "external",
    id: "adr-area",
    baseline: "test/fixtures/adr-area-baseline.json",
    polarity: "ceiling",
    enforcement: "required",
    owner: "test/adr-roster.test.mts",
  },
  {
    kind: "external",
    id: "coding-standards",
    baseline: "test/fixtures/coding-standards-baseline.json",
    polarity: "ceiling",
    enforcement: "required",
    owner: "test/coding-standards-integrity.test.mts",
  },
  {
    kind: "fixture",
    id: "qa-cohort",
    baseline: "test/fixtures/qa-cohort-baseline.json",
    owner: "scripts/qa/cohort-baseline.ts",
  },
  {
    kind: "fixture",
    id: "turn-snapshot-pr-gate",
    baseline: "test/fixtures/turn-snapshot/pr-gate-baseline.json",
    owner: "test/turn-snapshot-pr-gate.test.mts",
  },
];

/** The row's repo-relative baseline path. */
export function rowBaseline(row: RatchetRow): string {
  return row.kind === "ratchet" ? row.ratchet.policy.baseline : row.baseline;
}

/** The row's id (a ratchet's policy id). */
export function rowId(row: RatchetRow): string {
  return row.kind === "ratchet" ? row.ratchet.policy.id : row.id;
}

/** Which direction is bad for the row's baseline; undefined for a fixture or an external without one. */
export function rowPolarity(row: RatchetRow): RatchetPolarity | undefined {
  if (row.kind === "ratchet") return row.ratchet.policy.polarity;
  return row.kind === "external" ? row.polarity : undefined;
}

/** The row's enforcement level; undefined for a fixture (nothing runs on it). */
export function rowEnforcement(row: RatchetRow): RatchetEnforcement | undefined {
  if (row.kind === "ratchet") return row.ratchet.policy.enforcement;
  return row.kind === "external" ? row.enforcement : undefined;
}

/** The only lookup: the row that owns `baselinePath`, or undefined for a path no row claims. */
export function registryRowFor(baselinePath: string): RatchetRow | undefined {
  return RATCHETS.find((row) => rowBaseline(row) === baselinePath);
}

/** Every `*-baseline.json` on disk (scripts/ci non-recursive, test/fixtures recursive), sorted: the registry owns the claim that each has exactly one row. */
export function listBaselineFixtures(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string, recurse: boolean): void => {
    const dir = join(root, rel);
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (recurse) walk(r, recurse);
      } else if (e.name.endsWith("-baseline.json")) out.push(r);
    }
  };
  walk("scripts/ci", false);
  walk("test/fixtures", true);
  return out.sort();
}

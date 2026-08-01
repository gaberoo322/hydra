/**
 * Regression test for issue #3819 — CONTEXT.md and CLAUDE.md described the
 * Verifier Core as "five files" while `VERIFIER_CORE_PATHS` in
 * `src/untouchable.ts` holds six (ADR-0020 added `deep-qa-gate.yml`). The
 * code was correct; the docs were stale, which matters because
 * `src/untouchable.ts` is itself Verifier Core (T4) — an agent reasoning
 * about whether a change is T4 reads the docs, not the array.
 *
 * This test is the drift guard the issue asked for: it re-derives the
 * documented Verifier Core membership from each doc site and asserts it
 * matches `VERIFIER_CORE_PATHS` exactly (as a set), and that any prose
 * digit/number-word count of "self-referential files" agrees with
 * `VERIFIER_CORE_PATHS.length`. A future edit to `VERIFIER_CORE_PATHS`
 * (add/remove a path) that isn't mirrored into these docs fails this test
 * instead of silently reintroducing the #3819 drift.
 *
 * Method: read each doc as plain text and extract backtick-quoted spans
 * that look like repo-relative paths (start with `.github/`, `scripts/`,
 * or `src/`) from the specific sentence/line describing Verifier Core
 * membership — not the whole file, so an unrelated code span elsewhere in
 * the doc can't accidentally satisfy (or break) the assertion.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { VERIFIER_CORE_PATHS } from "../src/untouchable.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");

const PATH_SPAN = /`((?:\.github\/|scripts\/|src\/)[\w./-]+)`/g;

function extractBacktickPaths(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PATH_SPAN)) {
    out.push(m[1]);
  }
  return out;
}

function sortedUnique(paths: string[]): string[] {
  return [...new Set(paths)].sort();
}

function readDoc(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, relPath), "utf-8");
}

/** Extract the substring between two markers (exclusive of the start marker). */
function sliceBetween(text: string, startMarker: string, endMarker: string): string {
  const start = text.indexOf(startMarker);
  assert.ok(start >= 0, `could not find marker ${JSON.stringify(startMarker)} in doc`);
  const from = start + startMarker.length;
  const end = text.indexOf(endMarker, from);
  assert.ok(end >= 0, `could not find end marker ${JSON.stringify(endMarker)} in doc`);
  return text.slice(from, end);
}

const EXPECTED = sortedUnique([...VERIFIER_CORE_PATHS]);

describe("Verifier Core doc drift guard (issue #3819)", () => {
  test("VERIFIER_CORE_PATHS is the array this suite pins against", () => {
    // Sanity pin so a future array edit is a visible diff to this test too,
    // not just a silent pass/fail flip.
    assert.equal(VERIFIER_CORE_PATHS.length, 6, "VERIFIER_CORE_PATHS length changed — update the doc sites below AND this pin");
  });

  test("CONTEXT.md 'Verifier Core' glossary entry matches VERIFIER_CORE_PATHS", () => {
    const doc = readDoc("CONTEXT.md");
    const section = sliceBetween(doc, "**Verifier Core**:", "_Avoid_:");
    const found = sortedUnique(extractBacktickPaths(section));
    assert.deepEqual(
      found,
      EXPECTED,
      `CONTEXT.md's Verifier Core glossary entry lists ${JSON.stringify(found)} but VERIFIER_CORE_PATHS is ${JSON.stringify(EXPECTED)}`,
    );
  });

  test("CLAUDE.md T4 tier-table row matches VERIFIER_CORE_PATHS", () => {
    const doc = readDoc("CLAUDE.md");
    const lines = doc.split("\n");
    const row = lines.find((l) => l.startsWith("| T4 — Verifier Core"));
    assert.ok(row, "CLAUDE.md is missing the '| T4 — Verifier Core' tier-table row");
    const found = sortedUnique(extractBacktickPaths(row as string));
    assert.deepEqual(
      found,
      EXPECTED,
      `CLAUDE.md's T4 tier-table row lists ${JSON.stringify(found)} but VERIFIER_CORE_PATHS is ${JSON.stringify(EXPECTED)}`,
    );
  });

  test("docs/reference.md 'Verifier Core list' sentence matches VERIFIER_CORE_PATHS", () => {
    const doc = readDoc("docs/reference.md");
    const section = sliceBetween(
      doc,
      "**Verifier Core list (`VERIFIER_CORE_PATHS` / `isVerifierCore` in `src/untouchable.ts`):**",
      "ADR-0015",
    );
    const found = sortedUnique(extractBacktickPaths(section));
    assert.deepEqual(
      found,
      EXPECTED,
      `docs/reference.md's Verifier Core list lists ${JSON.stringify(found)} but VERIFIER_CORE_PATHS is ${JSON.stringify(EXPECTED)}`,
    );
  });

  test("docs/reference.md T4 tier-table row cites the correct file count", () => {
    const doc = readDoc("docs/reference.md");
    const lines = doc.split("\n");
    const row = lines.find((l) => l.includes("**T4 — Verifier Core**"));
    assert.ok(row, "docs/reference.md is missing the '**T4 — Verifier Core**' tier-table row");
    const match = (row as string).match(/The (\d+) self-referential files/);
    assert.ok(match, `docs/reference.md's T4 row does not cite a digit file count: ${row}`);
    assert.equal(
      Number(match![1]),
      VERIFIER_CORE_PATHS.length,
      `docs/reference.md's T4 row says "${match![1]} self-referential files" but VERIFIER_CORE_PATHS.length is ${VERIFIER_CORE_PATHS.length}`,
    );
  });

  test("docs/operator-playbooks/hydra-qa.md T4 checklist intro cites the correct file count", () => {
    // NOTE: this file feeds ~/.claude/skills/hydra-qa/SKILL.md via
    // scripts/sync-skills.sh (regenerated on deploy) — the playbook is the
    // source of truth, not the generated skill artifact.
    const doc = readDoc("docs/operator-playbooks/hydra-qa.md");
    const match = doc.match(/the (\d+) self-referential paths/);
    assert.ok(match, `docs/operator-playbooks/hydra-qa.md does not cite a digit file count for the Verifier Core`);
    assert.equal(
      Number(match![1]),
      VERIFIER_CORE_PATHS.length,
      `docs/operator-playbooks/hydra-qa.md says "${match![1]} self-referential paths" but VERIFIER_CORE_PATHS.length is ${VERIFIER_CORE_PATHS.length}`,
    );
  });

  test("historical ADR-0015 count ('exactly 5') is intentionally NOT re-checked here", () => {
    // docs/reference.md narrates history: "ADR-0015 shrank the deepest tier
    // to exactly 5 self-referential files [then] ADR-0020 ... added a 6th".
    // The "5" there is a correct point-in-time fact about what ADR-0015 did,
    // not a claim about current membership — asserting it against the
    // live VERIFIER_CORE_PATHS.length would be a false positive the moment
    // ADR-0020's own history is preserved. This test exists purely to
    // document that omission so a future edit doesn't "fix" it into a
    // blanket regex that re-breaks on legitimate historical narration.
    assert.ok(true);
  });
});

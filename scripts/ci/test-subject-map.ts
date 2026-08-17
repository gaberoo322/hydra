/**
 * scripts/ci/test-subject-map.ts — resolve each test file's PRIMARY SUBJECT,
 * so test-file sprawl can be ratcheted (issue #4134).
 *
 * # The pathology
 *
 * The suite grew one test file per ISSUE rather than per module:
 *
 *   scripts/autopilot/decide.py   14 test files
 *   src/autopilot/anchor-type.ts  ~12 test files, 10 named after the issue
 *   now-pixel-*                   11 test files
 *
 * 14 files carry a bare issue number in their basename
 * (`anchor-type-branch-fallback-3579.test.mts`). This costs nothing at
 * runtime and a great deal in agent context: every dispatch touching one
 * module must discover and read a dozen files. Given that the audit's chosen
 * metric is operator Claude quota, it is the largest single drain identified
 * (epic #4131).
 *
 * # Why "primary subject" and not "every import"
 *
 * Counting every import would key on shared infrastructure — 23 test files
 * import `src/redis/connection.ts` and that is entirely legitimate, since it
 * is a utility rather than a subject. Ratcheting it would fire on unrelated
 * work and become ambient red, the failure class this repo routes around
 * elsewhere.
 *
 * So each file resolves to exactly ONE subject, by specificity:
 *
 *   1. A `scripts/**` target it executes, when it references exactly one.
 *      This is the load-bearing case: all 14 `decide-*.test.mts` files import
 *      NOTHING from `src/` — they spawn `scripts/autopilot/decide.py`. An
 *      import-only rule misses the largest cluster entirely, which is why the
 *      issue calls out both signals.
 *   2. Otherwise the imported `src/` module that the FEWEST other test files
 *      import — the most distinctive dependency, which is almost always the
 *      thing under test rather than the plumbing it needs.
 *   3. Otherwise null (a doc-lint or self-contained file), which is never
 *      ratcheted.
 *
 * # Ratchet, not sweep
 *
 * Baselines live in `test/fixtures/test-subject-baseline.json` and record
 * today's counts, so the existing clusters are grandfathered and only GROWTH
 * fails. Consolidating a cluster lowers its count, and the baseline is
 * regenerated in the same PR — the same convention as
 * `test/fixtures/suite-count-baseline.json` and
 * `test/fixtures/adr-area-baseline.json`.
 *
 * The escape hatch is deliberately that baseline regeneration, NOT a marker
 * in the PR body. A PR-body escape hatch would mean reading
 * `GITHUB_EVENT_PATH` from inside the test suite — exactly the coupling issue
 * #4132 removed, where a lint on the PR description caused 12 of 19 red
 * `test` jobs and could not self-clear on re-run. A baseline bump is visible
 * in the diff, reviewable, and needs no webhook payload.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/** A test file that legitimately owns more than one file per subject. */
export type SubjectCounts = Record<string, number>;

const SRC_IMPORT_RE = /from\s+["'](\.\.\/(?:src|dashboard)\/[^"']+)["']/g;
/**
 * A `scripts/**` path mentioned anywhere in the file — as an import, a
 * `spawnSync` argv entry, or a path built from a fixture root. Subprocess
 * targets are referenced as bare strings far more often than as imports, so
 * matching the path shape rather than an import statement is deliberate.
 */
const SCRIPT_TARGET_RE = /["'`]([^"'`\s]*scripts\/[A-Za-z0-9_./-]+\.(?:ts|mts|mjs|js|sh|py))["'`]/g;

function uniq(values: string[]): string[] {
  return [...new Set(values)];
}

/** Normalise a matched path to a repo-relative form. */
function normalise(p: string): string {
  const idx = p.indexOf("scripts/");
  if (idx >= 0) return p.slice(idx);
  return p.replace(/^\.\.\//, "");
}

export function srcImportsOf(source: string): string[] {
  return uniq([...source.matchAll(SRC_IMPORT_RE)].map((m) => normalise(m[1])));
}

export function scriptTargetsOf(source: string): string[] {
  return uniq([...source.matchAll(SCRIPT_TARGET_RE)].map((m) => normalise(m[1])));
}

export type FileFacts = { file: string; srcImports: string[]; scriptTargets: string[] };

export function readTestFacts(testDir: string): FileFacts[] {
  return readdirSync(testDir)
    .filter((f) => f.endsWith(".test.mts"))
    .sort()
    .map((f) => {
      const source = readFileSync(join(testDir, f), "utf8");
      return {
        file: `test/${f}`,
        srcImports: srcImportsOf(source),
        scriptTargets: scriptTargetsOf(source),
      };
    });
}

/**
 * Resolve one primary subject per file, by the specificity ladder in the
 * module header. `srcPopularity` maps a src module to how many test files
 * import it, so the rarest — most distinctive — import wins.
 */
export function resolvePrimarySubjects(facts: FileFacts[]): Map<string, string | null> {
  const srcPopularity = new Map<string, number>();
  for (const f of facts) {
    for (const imp of f.srcImports) {
      srcPopularity.set(imp, (srcPopularity.get(imp) ?? 0) + 1);
    }
  }

  const subjects = new Map<string, string | null>();
  for (const f of facts) {
    if (f.scriptTargets.length === 1) {
      subjects.set(f.file, f.scriptTargets[0]);
      continue;
    }
    if (f.srcImports.length > 0) {
      // Fewest importers wins; ties broken by path so the result is stable.
      const best = [...f.srcImports].sort((a, b) => {
        const d = (srcPopularity.get(a) ?? 0) - (srcPopularity.get(b) ?? 0);
        return d !== 0 ? d : a.localeCompare(b);
      })[0];
      subjects.set(f.file, best);
      continue;
    }
    if (f.scriptTargets.length > 1) {
      // No src import at all — a pure subprocess file. Pick the most-referenced
      // script deterministically rather than giving up.
      subjects.set(f.file, [...f.scriptTargets].sort()[0]);
      continue;
    }
    subjects.set(f.file, null);
  }
  return subjects;
}

/** Count how many test files each subject owns. Files with no subject are dropped. */
export function countBySubject(subjects: Map<string, string | null>): SubjectCounts {
  const counts: SubjectCounts = {};
  for (const subject of subjects.values()) {
    if (!subject) continue;
    counts[subject] = (counts[subject] ?? 0) + 1;
  }
  return counts;
}

export type Overgrowth = { subject: string; baseline: number; observed: number };

/**
 * Subjects that gained test files versus the baseline. A subject absent from
 * the baseline is allowed ONE file (a genuinely new module gets its first
 * test); a second file for an unbaselined subject is already sprawl.
 */
export function findOvergrowth(observed: SubjectCounts, baseline: SubjectCounts): Overgrowth[] {
  const out: Overgrowth[] = [];
  for (const [subject, count] of Object.entries(observed)) {
    const allowed = Object.prototype.hasOwnProperty.call(baseline, subject) ? baseline[subject] : 1;
    if (count > allowed) out.push({ subject, baseline: allowed, observed: count });
  }
  return out.sort((a, b) => b.observed - a.observed || a.subject.localeCompare(b.subject));
}

export function buildSubjectCounts(testDir: string): SubjectCounts {
  return countBySubject(resolvePrimarySubjects(readTestFacts(testDir)));
}

// --------------------------------------------------------------------------
// CLI — regenerate the baseline. Same convention as
// `node scripts/test/suite-count-check.mjs --update-baseline`.
// --------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
export const TEST_DIR = join(REPO_ROOT, "test");
export const BASELINE_PATH = join(REPO_ROOT, "test/fixtures/test-subject-baseline.json");

if (process.argv[2] === "--update-baseline") {
  const { writeFileSync } = await import("node:fs");
  const counts = buildSubjectCounts(TEST_DIR);
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(BASELINE_PATH, JSON.stringify(sorted, null, 2) + "\n");
  console.error(
    `[test-subject-map] wrote ${Object.keys(sorted).length} subject entries to test/fixtures/test-subject-baseline.json`,
  );
}

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
 *
 * Applied to COMMENT-STRIPPED source only — see {@link stripComments}.
 */
const SCRIPT_TARGET_RE = /["'`]([^"'`\s]*scripts\/[A-Za-z0-9_./-]+\.(?:ts|mts|mjs|js|sh|py))["'`]/g;

/**
 * Blank out `//` and block comments, preserving string and template-literal
 * CONTENTS (issue #4136 follow-up).
 *
 * # Why this is necessary rather than tidy
 *
 * Both patterns above are text regexes over raw source, and the script-target
 * one requires only that the path sit between quotes — which a Markdown-style
 * backtick inside a JSDoc block satisfies perfectly. Three files were
 * mis-attributed to `scripts/autopilot/decide.py` on the strength of a single
 * PROSE mention:
 *
 *   test/agent-stream-correlation.test.mts:7    * action emitted by `scripts/autopilot/decide.py`
 *   test/api-scheduler.test.mts:154             // brain (`scripts/autopilot/decide.py`)
 *   test/scheduler-status.test.mts:270          // (`scripts/autopilot/decide.py`)
 *
 * None of the three executes decide.py; all three are API tests. Because a
 * single `scripts/**` target wins the specificity ladder outright, one comment
 * outranked everything the file actually imports.
 *
 * The cost is not cosmetic. It inflated decide.py's baseline to 12 against a
 * true 9, which is three units of SLACK in a ratchet whose whole job is to
 * resist growth — three new decide.py test files could have landed without
 * tripping it — and it left three files' real subjects unrecorded.
 *
 * This is the exact failure mode CLAUDE.md's search guidance names when it
 * says to prefer ast-search over text grep because it "never false-matches a
 * comment or string literal". A full parse would be the principled fix; per
 * ADR-0014 simplicity this detector strips comments and keeps the regexes,
 * matching what `scripts/test/suite-count-check.mjs`'s scanner already does
 * for the same reason.
 *
 * Comments are replaced by spaces rather than removed so that offsets and
 * line structure survive, and a stripped comment can never glue two tokens
 * together.
 */
export function stripComments(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    // Line comment — consume to EOL, keeping the newline.
    if (c === "/" && next === "/") {
      while (i < n && source[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    // Block comment — consume to the terminator, keeping newlines so line
    // numbers do not shift.
    if (c === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        out += source[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += "  ";
      i += 2;
      continue;
    }
    // String or template literal — copy VERBATIM. Their contents are exactly
    // what the patterns above are looking for.
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        if (source[i] === "\\") {
          out += source[i] + (source[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += source[i];
        if (source[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

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
  const code = stripComments(source);
  return uniq([...code.matchAll(SRC_IMPORT_RE)].map((m) => normalise(m[1])));
}

/**
 * A `join(...)` / `resolve(...)` call with no nested call in its arguments.
 * That covers every path-building form in this suite; a nested call would be
 * skipped rather than mis-parsed.
 */
const PATH_CALL_RE = /\b(?:join|resolve)\s*\(([^()]*)\)/g;
/** `const NAME = join(...)` — the binding half of a two-step path build. */
const PATH_BINDING_RE = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:join|resolve)\s*\(([^()]*)\)/g;

/**
 * Evaluate one path call's argument list into a partial path.
 *
 * String literals contribute their text; a previously-bound identifier
 * contributes its resolved value; anything else (REPO_ROOT,
 * import.meta.dirname, "..") contributes nothing. We only care whether the
 * result contains a `scripts/**` target, so an unresolved absolute prefix is
 * irrelevant.
 */
function evalPathCall(argsSrc: string, bindings: Map<string, string>): string {
  const parts: string[] = [];
  for (const raw of argsSrc.split(",")) {
    const arg = raw.trim();
    if (!arg) continue;
    const lit = arg.match(/^["'`]([^"'`]*)["'`]$/);
    if (lit) {
      if (lit[1] && lit[1] !== "..") parts.push(lit[1]);
      continue;
    }
    const bound = bindings.get(arg);
    if (bound) parts.push(bound);
  }
  return parts.join("/");
}

const SCRIPT_PATH_SHAPE = /(?:^|\/)(scripts\/[A-Za-z0-9_./-]+\.(?:ts|mts|mjs|js|sh|py))$/;

/**
 * Every `scripts/**` file this test EXECUTES, read from code rather than prose.
 *
 * Two forms, both needed. A few files name the whole path in one string
 * literal. Far more build it a segment at a time —
 * `join(REPO_ROOT, "scripts", "autopilot", "decide.py")`, or in two steps via
 * `const SCRIPTS = join(REPO_ROOT, "scripts", "autopilot")` — and the
 * whole-path regex never saw those at all. Before {@link stripComments} that
 * went unnoticed because a backticked path in the file's header comment
 * matched instead, so the attribution came out right for the wrong reason;
 * once comments stopped counting, reading the actual construction became
 * mandatory. `scripts/autopilot/collect-state.sh` alone owns 9 files that
 * resolve this way.
 */
export function scriptTargetsOf(source: string): string[] {
  const code = stripComments(source);

  const bindings = new Map<string, string>();
  for (const m of code.matchAll(PATH_BINDING_RE)) {
    bindings.set(m[1], evalPathCall(m[2], bindings));
  }

  const found: string[] = [];
  for (const m of code.matchAll(SCRIPT_TARGET_RE)) found.push(normalise(m[1]));
  for (const m of code.matchAll(PATH_CALL_RE)) {
    const shape = evalPathCall(m[1], bindings).match(SCRIPT_PATH_SHAPE);
    if (shape) found.push(shape[1]);
  }
  return uniq(found);
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

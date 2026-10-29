/**
 * scripts/ci/test-source-read-scan.ts — detect test files that READ CODE PATHS,
 * and compare them against a kind-tagged fixture (issue #5262, ADR-0046).
 *
 * # Why
 *
 * CODING_STANDARDS.md § Tests `STD-TEST-RUN-THE-CODE`: a test asserts through
 * the module's interface; it may read repo text only as input to code it runs,
 * or as a sanctioned drift-guard / invariant-lint / dashboard-pin. A
 * substring/regex assertion over code that can run goes red on a
 * behaviour-preserving refactor. This module is the mechanical half of that
 * rule: it finds the files that read code, and the required test
 * (`test/test-source-read-ratchet.test.mts`) fails when a code-reading file is
 * not in `test/fixtures/test-source-read-baseline.json` under a sanctioned kind.
 *
 * # Detection is per FILE and gates only CODE paths
 *
 * A test file is a code reader iff (a) it calls a filesystem read
 * (`readFileSync` / `readFile` / `readdirSync` / `readdir`) AND (b) it contains
 * a string literal that resolves under `src/`, `scripts/`, `bin/` or
 * `dashboard/src/`, or ends in `.sh` / `.py` / `.mjs`. Reads of `docs/`,
 * `config/`, `.github/`, `CLAUDE.md`, `CONTEXT.md`, playbooks, `*.md` and
 * `test/fixtures` are never gated. `import` statements never count as reads,
 * and comments are stripped before scanning.
 *
 * # Grandfathered rows only shrink
 *
 * The test cannot see history (reading git state or GITHUB_EVENT_PATH from the
 * suite is the coupling #4132 removed), so "grandfathered rows only shrink" is
 * the reviewer's rule under STD-TEST-RUN-THE-CODE. What is enforced here: every
 * row names a known kind, an existing file, and a file that still reads code.
 *
 * Pure / result-object style: nothing here throws on malformed input.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./test-subject-map.ts";

/** The closed set of sanctioned kinds a fixture row may carry. */
export const READ_KINDS = ["drift-guard", "invariant-lint", "dashboard-pin", "behaviour", "grandfathered"] as const;
export type ReadKind = (typeof READ_KINDS)[number];

/** The rule id every failure message prints. */
export const RULE_ID = "STD-TEST-RUN-THE-CODE";

/** `fixture.files`: test file (repo-relative) -> kind. */
export interface ReadBaseline {
  note?: string;
  files: Record<string, string>;
}

export interface ReadViolation {
  file: string;
  code: "unlisted-reader" | "unknown-kind" | "stale-missing-file" | "stale-no-longer-reads";
  message: string;
}

const FS_READ_RE = /\b(?:readFileSync|readFile|readdirSync|readdir)\s*\(/;
/** Static and dynamic import specifiers are not reads. */
const IMPORT_FROM_RE = /(?:^|\n)\s*(?:import|export)\b[^;'"`]*?\bfrom\s*(["'])[^"'\n]*\1\s*;?/g;
const BARE_IMPORT_RE = /(?:^|\n)\s*import\s*(["'])[^"'\n]*\1\s*;?/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*(["'`])[^"'`\n]*\1\s*\)/g;
const LITERAL_RE = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
/** A literal that is, or sits under, a code root. */
const CODE_ROOT_RE = /(?:^|\/)(?:src|scripts|bin|dashboard\/src)(?:\/|$)/;
const CODE_EXT_RE = /\.(?:sh|py|mjs)$/;

/** Does this string-literal body resolve to a code path? */
export function isCodePathLiteral(body: string): boolean {
  if (/^(?:https?:)?\/\//.test(body)) return false;
  return CODE_ROOT_RE.test(body) || CODE_EXT_RE.test(body);
}

/** Source with comments and import specifiers blanked out. */
function scannable(source: string): string {
  return stripComments(source)
    .replace(IMPORT_FROM_RE, "\n")
    .replace(BARE_IMPORT_RE, "\n")
    .replace(DYNAMIC_IMPORT_RE, "import()");
}

/** Does the test file read a code path? Pure. */
export function readsCodePath(source: string): boolean {
  const code = scannable(source);
  if (!FS_READ_RE.test(code)) return false;
  for (const m of code.matchAll(LITERAL_RE)) {
    if (isCodePathLiteral(m[2])) return true;
  }
  return false;
}

/** The repo-relative `test/*.test.mts` files that read a code path, sorted. */
export function scanTestReaders(repoRoot: string): string[] {
  const dir = join(repoRoot, "test");
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".test.mts")) continue;
    let src: string;
    try {
      src = readFileSync(join(dir, name), "utf8");
    } catch (err) {
      console.error(`[test-source-read-scan] cannot read test/${name}:`, err);
      continue;
    }
    if (readsCodePath(src)) out.push(`test/${name}`);
  }
  return out;
}

/** The exact fixture line a reviewer adds to sanction a reader. */
export function fixtureLine(file: string, kind: ReadKind | string): string {
  return `    ${JSON.stringify(file)}: ${JSON.stringify(kind)}`;
}

/**
 * Compare the live readers against the fixture.
 *
 * @param readers files the scanner found reading a code path
 * @param baseline the parsed fixture
 * @param fileExists predicate over a repo-relative path
 */
export function checkReadRatchet(
  readers: readonly string[],
  baseline: ReadBaseline,
  fileExists: (path: string) => boolean,
): ReadViolation[] {
  const violations: ReadViolation[] = [];
  const rows = baseline && typeof baseline.files === "object" && baseline.files ? baseline.files : {};
  const readerSet = new Set(readers);
  const kinds = READ_KINDS as readonly string[];

  for (const file of readers) {
    if (!(file in rows)) {
      violations.push({
        file,
        code: "unlisted-reader",
        message:
          `${file} reads a code path but is not in test/fixtures/test-source-read-baseline.json (${RULE_ID}).\n` +
          `  Prefer running the code over reading it. If a read is truly the right test, add ONE line to "files" ` +
          `with a sanctioned kind (${READ_KINDS.join(" | ")}):\n${fixtureLine(file, "behaviour")},`,
      });
    }
  }
  for (const [file, kind] of Object.entries(rows)) {
    if (!kinds.includes(kind)) {
      violations.push({
        file,
        code: "unknown-kind",
        message: `${file}: kind ${JSON.stringify(kind)} is not one of ${READ_KINDS.join(" | ")} (${RULE_ID}).`,
      });
    }
    if (!fileExists(file)) {
      violations.push({
        file,
        code: "stale-missing-file",
        message: `${file} no longer exists - delete its row from the fixture (${RULE_ID}).`,
      });
    } else if (!readerSet.has(file)) {
      violations.push({
        file,
        code: "stale-no-longer-reads",
        message: `${file} no longer reads a code path - delete its row from the fixture (stale row; ${RULE_ID}).`,
      });
    }
  }
  return violations;
}

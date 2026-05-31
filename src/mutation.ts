/**
 * mutation.ts — Pure mutation-testing runner (CI-only after issue #476).
 *
 * Originally extracted from verification.ts (issue #161) when mutation testing
 * was step 6.7 of the in-process codex control loop.
 *
 * History (why this file is now a thin runner):
 *
 *   - Issue #382 / #383 (codex-removal): the in-process control loop and its
 *     gate orchestration were deleted. CI quality gates took over scope and
 *     mutation enforcement out-of-process (`scripts/ci/mutation-check.ts`,
 *     `scripts/ci/scope-check.ts`), invoked from `.github/workflows/ci.yml`.
 *   - Issue #476 (audit + cleanup): the orphaned in-cycle gate orchestration
 *     (`runMutationGate`, `summarizeMutationTests`, `classifyNoSignalDecision`,
 *     `MUTATION_DECISION`, `getQuickFixKillThreshold`, plus the quick-fix
 *     budget + cost-cap probe) had zero live callers under `src/` after PR-3.
 *     The CI gate (`scripts/ci/mutation-check.ts`) reimplements the same
 *     orchestration in a CI-context-appropriate way (no CycleContext, no OV
 *     session, no Redis), so the in-process versions were deleted.
 *
 * What remains here is the deterministic, dependency-free core that the CI
 * gate composes:
 *
 *   - runMutationTests()        — apply candidate mutations to changed files,
 *                                 run tests under each, report kill/survive.
 *   - shouldSkipMutation()      — pattern match for files we never mutate.
 *   - SKIP_PATTERNS             — the regex list backing shouldSkipMutation
 *                                 (exported so `test/mutation-skip-patterns.test.mts`
 *                                 can snapshot it; see issue #402).
 *
 * Everything else is module-private. If a future caller needs the gate
 * orchestration back, build it in CI-space (the way `scripts/ci/mutation-check.ts`
 * does) — do not resurrect the CycleContext-coupled gate that lived here.
 */

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIME_BUDGET_MS = 120_000;
const MT_TEST_TIMEOUT_MS = 45_000;

// Files we never mutate.
//
// Issue #402: Markdown / docs / operator-edited config paths are added so the
// gate doesn't generate `swap-comparison` mutants on `<` / `>` characters that
// appear in prose (e.g. `≥14 days`, code-block snippets in `.md`, hostnames
// in YAML). Those mutants always "survive" because no test reads documentation
// prose, which tanked kill rate on docs-only PRs (observed on PR #401: 11%).
export const SKIP_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /\.config\.[jt]s$/,
  /\.d\.ts$/,
  /drizzle\//,
  /migrations?\//,
  /__mocks__\//,
  /node_modules\//,
  // Issue #402: docs + config — see comment above.
  /\.mdx?$/,         // Markdown (.md) and defensive .mdx
  /(^|\/)docs\//,    // documentation tree, anywhere in the path
  /(^|\/)config\//,  // operator-edited config tree, anywhere in the path
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Mutation = {
  file: string;
  line: number;
  original: string;
  mutated: string;
  type: string;
};

type MutationResult = {
  mutation: Mutation;
  survived: boolean; // true = tests still passed = bad coverage
  skipped: boolean;
  error?: string;
};

export type MutationTestReport = {
  totalMutants: number;
  killed: number;
  survived: number;
  skipped: number;
  timedOut: boolean;
  durationMs: number;
  survivors: MutationResult[]; // only the surviving mutants (uncovered code)
  // Issue #300: number of mutation candidates the generator emitted BEFORE the
  // maxMutants cap was applied. Distinguishes "diff had nothing to mutate"
  // (candidatesGenerated === 0 → no-mutants) from "we capped a larger pool"
  // (candidatesGenerated > totalMutants → quick-fix sample).
  candidatesGenerated: number;
};

// ---------------------------------------------------------------------------
// Mutators (module-private)
// ---------------------------------------------------------------------------

/**
 * Mutators — each takes a line and returns a mutated version, or null if
 * the mutation doesn't apply.
 */
const MUTATORS: { type: string; apply: (line: string) => string | null }[] = [
  {
    type: "negate-boolean-return",
    apply: (line) => {
      if (/return\s+true\s*;/.test(line)) return line.replace(/return\s+true\s*;/, "return false;");
      if (/return\s+false\s*;/.test(line)) return line.replace(/return\s+false\s*;/, "return true;");
      return null;
    },
  },
  {
    type: "swap-comparison",
    apply: (line) => {
      // Only swap the first occurrence to keep mutations atomic
      if (line.includes("===")) return line.replace("===", "!==");
      if (line.includes("!==")) return line.replace("!==", "===");
      if (/[^=<>!]>[^=]/.test(line)) return line.replace(/([^=<>!])>([^=])/, "$1<$2");
      if (/[^=<>!]<[^=]/.test(line)) return line.replace(/([^=<>!])<([^=])/, "$1>$2");
      return null;
    },
  },
  {
    type: "negate-condition",
    apply: (line) => {
      // Match `if (...)` and negate the condition
      const match = line.match(/^(\s*if\s*\()(.+)(\)\s*\{?\s*)$/);
      if (match) return `${match[1]}!(${match[2]})${match[3]}`;
      return null;
    },
  },
  {
    type: "remove-early-return",
    apply: (line) => {
      // Only remove returns that have a value (not bare `return;`)
      const match = line.match(/^(\s*)return\s+.+;/);
      if (match && !line.includes("return;")) {
        return `${match[1]}/* MUTANT: removed return */`;
      }
      return null;
    },
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function shouldSkipMutation(filePath: string): boolean {
  return SKIP_PATTERNS.some((pat) => pat.test(filePath));
}

/**
 * Generate candidate mutations for a single file. Module-private — only
 * `runMutationTests` calls it, and exposing it never paid off.
 */
function generateMutations(filePath: string, content: string): Mutation[] {
  const mutations: Mutation[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip comment-only lines and imports
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*") || trimmed.startsWith("import ") || trimmed.startsWith("export type") || trimmed.startsWith("export interface")) {
      continue;
    }

    for (const mutator of MUTATORS) {
      const mutated = mutator.apply(line);
      if (mutated && mutated !== line) {
        mutations.push({
          file: filePath,
          line: i + 1,
          original: line,
          mutated,
          type: mutator.type,
        });
        break; // one mutation per line max
      }
    }
  }

  return mutations;
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

/**
 * Run mutation testing on the changed files.
 *
 * @param projectDir - Target project root (the configured target workspace)
 * @param changedFiles - List of changed file paths (from git diff)
 * @param opts.timeBudgetMs - Max time for all mutations (default 120s)
 * @param opts.testCommand - Command to run tests (default: npm test)
 * @param opts.maxMutants  - Optional cap on candidate mutants (quick-fix path)
 */
export async function runMutationTests(
  projectDir: string,
  changedFiles: string[],
  opts: { timeBudgetMs?: number; testCommand?: string; maxMutants?: number } = {},
): Promise<MutationTestReport> {
  const timeBudget = opts.timeBudgetMs || DEFAULT_TIME_BUDGET_MS;
  const testCommand = opts.testCommand || "npm test";
  // Issue #272: optional cap on candidate mutants — used by the quick-fix
  // path to keep the mutation run cheap (<60s) for thin diffs.
  const maxMutants = typeof opts.maxMutants === "number" && opts.maxMutants > 0
    ? opts.maxMutants
    : Infinity;
  const start = Date.now();

  const results: MutationResult[] = [];
  const allMutations: Mutation[] = [];

  // Resolve app directory (same logic as verifier)
  let appDir = projectDir;
  try {
    const { readFile: rf } = await import("node:fs/promises");
    await rf(`${projectDir}/package.json`);
  } catch { /* intentional: no package.json at root — probe subdirs */
    for (const sub of ["web", "app"]) {
      try {
        const { readFile: rf } = await import("node:fs/promises");
        await rf(`${projectDir}/${sub}/package.json`);
        appDir = `${projectDir}/${sub}`;
        break;
      } catch { /* intentional: sub-dir does not have package.json, try next */ }
    }
  }

  // Generate all candidate mutations
  for (const file of changedFiles) {
    if (shouldSkipMutation(file)) continue;

    const fullPath = file.startsWith("/") ? file : `${projectDir}/${file}`;
    try {
      const content = await readFile(fullPath, "utf-8");
      const mutations = generateMutations(fullPath, content);
      allMutations.push(...mutations);
    } catch { /* intentional: file may have been deleted in diff — skip mutation generation */ }
  }

  // Shuffle mutations to get a representative sample if we time out
  for (let i = allMutations.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allMutations[i], allMutations[j]] = [allMutations[j], allMutations[i]];
  }

  // Issue #272: cap candidate list so quick-fix runs stay cheap. Applied
  // AFTER the shuffle so the sample is representative, not biased toward
  // the first files in the diff.
  const candidates = Number.isFinite(maxMutants)
    ? allMutations.slice(0, maxMutants)
    : allMutations;
  // Issue #300: record the pre-cap candidate count so the gate can distinguish
  // "nothing to mutate" (legitimate no-mutants) from "we capped a larger pool"
  // (still useful signal, should classify as RAN).
  const candidatesGenerated = allMutations.length;

  let timedOut = false;

  for (const mutation of candidates) {
    if (Date.now() - start > timeBudget) {
      timedOut = true;
      break;
    }

    let originalContent: string;
    try {
      originalContent = await readFile(mutation.file, "utf-8");
    } catch (err: any) {
      // Intentionally non-fatal: record the read failure on the result so the
      // skip is surfaced in the mutation report rather than silently swallowed.
      results.push({ mutation, survived: false, skipped: true, error: `cannot read file: ${err?.message ?? err}` });
      continue;
    }

    // Apply the mutation
    const lines = originalContent.split("\n");
    lines[mutation.line - 1] = mutation.mutated;
    const mutatedContent = lines.join("\n");

    try {
      await writeFile(mutation.file, mutatedContent);

      // Run tests
      const [cmd, ...args] = testCommand.split(/\s+/);
      try {
        await execFileAsync(cmd, args, {
          cwd: appDir,
          timeout: MT_TEST_TIMEOUT_MS,
          env: process.env,
          shell: true,
          maxBuffer: 1024 * 1024 * 5,
        });
        // Tests passed with mutation = SURVIVED (bad)
        results.push({ mutation, survived: true, skipped: false });
      } catch { /* intentional: test failure under mutation = killed mutant (the desired signal) */
        results.push({ mutation, survived: false, skipped: false });
      }
    } finally {
      // Always restore the original file
      await writeFile(mutation.file, originalContent);
    }
  }

  const killed = results.filter((r) => !r.survived && !r.skipped).length;
  const survived = results.filter((r) => r.survived).length;
  const skipped = results.filter((r) => r.skipped).length;

  return {
    totalMutants: results.length,
    killed,
    survived,
    skipped,
    timedOut,
    durationMs: Date.now() - start,
    survivors: results.filter((r) => r.survived),
    candidatesGenerated,
  };
}

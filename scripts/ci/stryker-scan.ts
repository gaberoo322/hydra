#!/usr/bin/env -S npx tsx
/**
 * scripts/ci/stryker-scan.ts — Advisory Stryker mutation scan (tool-scout #3835).
 *
 * COMPARISON-ONLY sibling of the required homegrown mutation gate
 * (`scripts/ci/mutation-check.ts` + `src/mutation.ts`). It runs Stryker
 * (@stryker-mutator/core) on the PR's diff-changed `src/**\/*.ts` files and emits
 * the comparison the keep/replace/drop recommendation rests on: which surviving
 * mutants Stryker surfaces that the homegrown gate does not attempt AT ALL,
 * grouped by Stryker mutator category.
 *
 * # Why this exists (the operator decision)
 *
 * The homegrown gate mutates per-line by regex with an essentially four-entry
 * mutator list (`negate-boolean-return`, `swap-comparison`, `negate-condition`,
 * `remove-early-return` in `src/mutation.ts`). Stryker mutates at AST level
 * across a far broader catalog (ArithmeticOperator, StringLiteral,
 * LogicalOperator, UpdateOperator, …). The substantive question is whether that
 * broader catalog catches survivors the homegrown regex gate structurally
 * CANNOT. This scan answers it; an advisory check nobody acts on is
 * indistinguishable from no check, so the run MUST emit a concluded comparison
 * (the issue's acceptance criteria), not just a raw Stryker report.
 *
 * # Tool lane (ADR-0005) — pinned `npx`, NO package.json dependency
 *
 * Stryker is invoked through `npx --yes -p @stryker-mutator/core@9.6.1 stryker
 * run …` — exactly the ast-grep / comby / promptfoo / taze / osv-scanner
 * no-dependency lane. It is NOT a package.json dependency (runtime or dev), so
 * it never trips the @lavamoat/allow-scripts gate and never enters
 * package-lock.json. The pin below is the single source of truth — keep it in
 * lockstep with stryker.conf.json and .github/workflows/stryker-check.yml.
 *
 * # Diff scoping (issue #653 — a full-tree run is a regression)
 *
 * `filterMutationCandidates` is REUSED from `scripts/ci/mutation-check.ts`
 * (imported, not reimplemented) so the candidate set is computed the SAME way
 * the required gate computes it: only `src/**\/*.ts` files in the PR diff, minus
 * `shouldSkipMutation()` (co-located tests, .d.ts, docs/, config/, …). That
 * filtered list is passed to Stryker via `--mutate`, overriding the empty
 * `mutate: []` in stryker.conf.json. Stryker therefore never mutates the full
 * tree. An empty candidate set (asset/doc/test-only PR) skips cleanly.
 *
 * # Advisory, never blocking
 *
 * This script ALWAYS exits 0. A Stryker crash, a missing report, or a below-
 * threshold score is captured as a `status:"failed"`/`"skipped"` row in the
 * emitted JSON, never as a non-zero exit. The workflow additionally `|| true`s
 * and is not a required branch-protection context, so a red run can never wedge
 * the merge queue. Promotion to a required gate is a separate operator-gated
 * follow-up (issue out-of-scope list).
 *
 * # Budget (issue invariant — never run unbounded)
 *
 * A `commandRunner` run executes the full `npm test` suite once per mutant, so
 * the cost scales mutants × suite-time. Two bounds, mirroring the homegrown
 * gate's `MUTATION_TIME_BUDGET_MS` / `MUTATION_MAX_MUTANTS`: (1) the workflow's
 * hard `timeout-minutes` ceiling, and (2) `STRYKER_MAX_FILES` (default 3) caps
 * how many diff files are mutated in one run, sampling the first N changed
 * files when a large diff would otherwise overrun the budget. The cap is logged
 * when it bites.
 *
 * # Output
 *
 * The comparison JSON is written to stdout AND to `stryker-comparison.json`
 * (uploaded as the workflow artifact). The raw Stryker report stays at
 * `reports/stryker-scan/mutation.json`.
 *
 * Purity: `classifyStrykerStatus` / `buildComparison` are pure (no IO, no env,
 * no git) and unit-tested in `test/stryker-scan.test.mts`. `main()` owns all IO.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { filterMutationCandidates } from "./mutation-check.ts";

// ---------------------------------------------------------------------------
// Pin + constants
// ---------------------------------------------------------------------------

/**
 * Pinned Stryker version. MUST stay in lockstep with the advisory workflow and
 * stryker.conf.json. This is the ONLY place @stryker-mutator is named in the
 * repo's runtime — there is no package.json dependency entry (ADR-0005 lane).
 */
export const STRYKER_VERSION = "9.6.1";
const STRYKER_SPEC = `@stryker-mutator/core@${STRYKER_VERSION}`;

/**
 * The homegrown gate's mutator catalog (`MUTATORS` in `src/mutation.ts`). This
 * scan is comparison-only — `src/mutation.ts` is read (its `shouldSkipMutation`
 * is applied transitively via `filterMutationCandidates`) and NEVER modified.
 * The names are duplicated here because `MUTATORS` is module-private in
 * `src/mutation.ts`; keeping this list in sync is the price of that privacy.
 */
export const HOMEGROWN_MUTATOR_CATALOG = [
  "negate-boolean-return",
  "swap-comparison",
  "negate-condition",
  "remove-early-return",
] as const;

/**
 * Stryker mutator category -> whether the homegrown gate attempts that category
 * at all, with the homegrown equivalent when one exists.
 *
 * The homegrown gate covers only two Stryker categories, and only as a SUBSET:
 *   - `EqualityOperator` <-> `swap-comparison` (===, !==, <, >; Stryker also
 *     mutates <=, >=, ==, !=).
 *   - `BooleanLiteral`   <-> `negate-boolean-return` (`return true/false` only;
 *     Stryker also mutates inline boolean literals).
 *
 * Every OTHER Stryker category (ArithmeticOperator, StringLiteral,
 * LogicalOperator, UpdateOperator, BlockStatement, ConditionalExpression,
 * ObjectLiteral, ArrayDeclaration, ArrowFunction, MethodExpression, …) is a
 * category the homegrown gate does NOT attempt — survivors there are the
 * comparison signal. (`negate-condition` and `remove-early-return` are
 * homegrown-ONLY mutators with no Stryker category, so they never classify a
 * Stryker survivor.)
 */
export const STRYKER_CATEGORY_HOMEGROWN: Record<
  string,
  { attempted: true; homegrownEquivalent: string } | { attempted: false }
> = {
  EqualityOperator: {
    attempted: true,
    homegrownEquivalent: "swap-comparison (===, !==, <, >; Stryker also covers <=, >=, ==, !=)",
  },
  BooleanLiteral: {
    attempted: true,
    homegrownEquivalent: "negate-boolean-return (return true/false only; Stryker also mutates inline booleans)",
  },
};

/** Default cap on how many diff files one run mutates (budget guard). */
export const STRYKER_MAX_FILES_DEFAULT = 3;

// ---------------------------------------------------------------------------
// Types (the slice of Stryker's mutation.json this scanner reads)
// ---------------------------------------------------------------------------

export type StrykerMutantStatus =
  | "Killed"
  | "Survived"
  | "NoCoverage"
  | "Timeout"
  | "RuntimeError"
  | "Ignored";

export type StrykerMutant = {
  id?: string;
  mutatorName: string;
  status: string;
};

export type StrykerReport = {
  schemaVersion?: string;
  files?: Record<string, { mutants?: StrykerMutant[] }>;
};

/** High-level classification of a Stryker mutant status. */
export type MutantClass = "killed" | "survived" | "ignored" | "other";

export type CategoryBreakdown = {
  byCategory: Record<
    string,
    {
      count: number;
      attemptedByHomegrownGate: boolean;
      homegrownEquivalent?: string;
    }
  >;
  totalSurvivors: number;
  distinctCategories: number;
};

export type ComparisonResult = {
  status:
    | "survivors-in-unattempted-categories"
    | "no-unattempted-survivors"
    | "no-survivors"
    | "no-mutants";
  homegrownMutatorCatalog: readonly string[];
  stryker: {
    totalMutants: number;
    killed: number;
    survived: number;
    ignored: number;
    other: number;
    testable: number;
    mutationScore: number | null;
  };
  comparison: {
    survivorsNotAttemptedByHomegrown: CategoryBreakdown;
    survivorsInAttemptedCategories: CategoryBreakdown;
  };
  recommendationSignal: string;
};

// ---------------------------------------------------------------------------
// Pure decision core
// ---------------------------------------------------------------------------

/**
 * Map a Stryker mutant status to the high-level class.
 *
 * `Survived` and `NoCoverage` are both UNDETECTED by the test suite — a
 * `NoCoverage` mutant was never even reached, which the homegrown gate (running
 * the full suite per mutant with no per-test coverage) would also miss. Both
 * count as "survived" for an apples-to-apples comparison. `Timeout` and
 * `RuntimeError` are detection signals (the mutant broke something), so they
 * count as "killed" — parallel to the homegrown gate, where a non-zero test
 * exit kills the mutant.
 */
export function classifyStrykerStatus(status: string): MutantClass {
  switch (status) {
    case "Survived":
    case "NoCoverage":
      return "survived";
    case "Killed":
    case "Timeout":
    case "RuntimeError":
      return "killed";
    case "Ignored":
      return "ignored";
    default:
      return "other";
  }
}

/**
 * Collect every mutant across all files in a Stryker report. Pure.
 */
function collectMutants(report: StrykerReport): StrykerMutant[] {
  const out: StrykerMutant[] = [];
  for (const file of Object.values(report.files ?? {})) {
    for (const m of file.mutants ?? []) out.push(m);
  }
  return out;
}

/**
 * Build the keep/replace/drop comparison from a parsed Stryker report. Pure —
 * no IO, no env, no git. Unit-tested directly.
 *
 * The headline number is `comparison.survivorsNotAttemptedByHomegrown.totalSurvivors`
 * (and `distinctCategories`): surviving mutants in Stryker categories the
 * homegrown gate does not attempt at all. If that is 0 across enough PRs, the
 * correct recommendation is DROP — and that is a success outcome for this
 * experiment, not a failure.
 */
export function buildComparison(report: StrykerReport): ComparisonResult {
  const mutants = collectMutants(report);
  const totalMutants = mutants.length;

  let killed = 0;
  let survived = 0;
  let ignored = 0;
  let other = 0;

  // survivors grouped by Stryker mutator category
  const survivorByCategory = new Map<string, number>();
  for (const m of mutants) {
    const cls = classifyStrykerStatus(m.status);
    if (cls === "killed") killed++;
    else if (cls === "survived") {
      survived++;
      const cat = m.mutatorName || "(unknown)";
      survivorByCategory.set(cat, (survivorByCategory.get(cat) ?? 0) + 1);
    } else if (cls === "ignored") ignored++;
    else other++;
  }

  const testable = totalMutants - ignored;
  const mutationScore = testable > 0 ? Math.round((killed / testable) * 100) : null;

  const attempted: CategoryBreakdown = {
    byCategory: {},
    totalSurvivors: 0,
    distinctCategories: 0,
  };
  const unattempted: CategoryBreakdown = {
    byCategory: {},
    totalSurvivors: 0,
    distinctCategories: 0,
  };

  // Stable ordering: by descending survivor count, then category name.
  const sortedCategories = [...survivorByCategory.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });

  for (const [category, count] of sortedCategories) {
    const mapping = STRYKER_CATEGORY_HOMEGROWN[category] ?? { attempted: false };
    const target = mapping.attempted ? attempted : unattempted;
    target.byCategory[category] = mapping.attempted
      ? {
          count,
          attemptedByHomegrownGate: true,
          homegrownEquivalent: mapping.homegrownEquivalent,
        }
      : { count, attemptedByHomegrownGate: false };
    target.totalSurvivors += count;
    target.distinctCategories += 1;
  }

  let status: ComparisonResult["status"];
  if (totalMutants === 0) status = "no-mutants";
  else if (survived === 0) status = "no-survivors";
  else if (unattempted.totalSurvivors > 0) status = "survivors-in-unattempted-categories";
  else status = "no-unattempted-survivors";

  const recommendationSignal = formatRecommendationSignal(status, unattempted);

  return {
    status,
    homegrownMutatorCatalog: HOMEGROWN_MUTATOR_CATALOG,
    stryker: {
      totalMutants,
      killed,
      survived,
      ignored,
      other,
      testable,
      mutationScore,
    },
    comparison: {
      survivorsNotAttemptedByHomegrown: unattempted,
      survivorsInAttemptedCategories: attempted,
    },
    recommendationSignal,
  };
}

function formatRecommendationSignal(
  status: ComparisonResult["status"],
  unattempted: CategoryBreakdown,
): string {
  if (status === "no-mutants") {
    return "Stryker generated 0 mutants on this diff — no comparison signal this run.";
  }
  const n = unattempted.totalSurvivors;
  if (n === 0) {
    return "Stryker surfaced 0 surviving mutants in categories the homegrown gate does not attempt — supports a \"drop\" recommendation.";
  }
  const cats = Object.keys(unattempted.byCategory).join(", ");
  return (
    `Stryker surfaced ${n} surviving mutant(s) across ` +
    `${unattempted.distinctCategories} category/categories the homegrown gate does not attempt` +
    ` (${cats}) — the number the keep/replace/drop recommendation cites.`
  );
}

// ---------------------------------------------------------------------------
// IO orchestration (main)
// ---------------------------------------------------------------------------

function gitOutput(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/**
 * Resolve the diff-changed file set. Honors an explicit `CHANGED_FILES` env
 * (newline-separated, same contract as `scripts/ci/mutation-check.ts`) for
 * parity with the required gate; otherwise computes it from git against
 * origin/master using the same merge-base the mutation gate documents
 * (docs/quality-gates.md).
 */
function readChangedFiles(cwd: string): string[] {
  const env = process.env.CHANGED_FILES ?? "";
  if (env.trim().length > 0) {
    return env.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  }
  const base = gitOutput(["merge-base", "origin/master", "HEAD"], cwd);
  if (!base) return [];
  const diff = gitOutput(["diff", "--name-only", `${base}...HEAD`], cwd);
  return diff.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
}

/** Parse a positive int env with a fallback. */
function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function capFiles(files: string[], max: number): { kept: string[]; capped: boolean } {
  if (files.length <= max) return { kept: files, capped: false };
  return { kept: files.slice(0, max), capped: true };
}

/**
 * Locate Stryker's JSON report. With `reportsDirectory: "reports/stryker-scan"`
 * Stryker writes `reports/stryker-scan/mutation.json`; fall back to a search of
 * `reports/` for robustness across Stryker versions.
 */
function locateReport(cwd: string): string | null {
  // With `reportsDirectory: "reports/stryker-scan"` Stryker writes
  // reports/stryker-scan/mutation.json; fall back to the default reports root
  // for robustness across Stryker versions.
  const primary = join(cwd, "reports", "stryker-scan", "mutation.json");
  if (existsSync(primary)) return primary;
  const generic = join(cwd, "reports", "mutation.json");
  if (existsSync(generic)) return generic;
  return null;
}

function runStryker(mutateCsv: string, cwd: string): { ok: boolean; exitCode: number | null } {
  const result = spawnSync(
    "npx",
    [
      "--yes",
      "-p",
      STRYKER_SPEC,
      "stryker",
      "run",
      "--configFile",
      "stryker.conf.json",
      "--mutate",
      mutateCsv,
    ],
    {
      cwd,
      stdio: "inherit",
      env: process.env,
    },
  );
  // Advisory: never treat a Stryker non-zero exit as a script failure. The
  // workflow `|| true`s as well; a missing/bad report surfaces as status:"failed".
  return { ok: (result.status ?? 0) === 0 || existsSync(join(cwd, "reports", "stryker-scan", "mutation.json")), exitCode: result.status };
}

function emit(payload: unknown, cwd: string): void {
  const text = JSON.stringify(payload, null, 2) + "\n";
  process.stdout.write(text);
  try {
    writeFileSync(join(cwd, "stryker-comparison.json"), text);
  } catch (err: any) {
    process.stderr.write(`stryker-scan: could not write stryker-comparison.json (${err?.message ?? err})\n`);
  }
}

async function main(): Promise<number> {
  const cwd = process.cwd();
  const changed = readChangedFiles(cwd);

  if (changed.length === 0) {
    emit({ status: "skipped", reason: "no changed files in diff" }, cwd);
    process.stderr.write("stryker-scan: skipped — no changed files in diff\n");
    return 0;
  }

  // Diff scoping (issue #653): REUSE the required gate's filter so the
  // candidate set is computed identically. src/mutation.ts is read (via the
  // filter's shouldSkipMutation) and never modified.
  const candidates = filterMutationCandidates(changed);
  if (candidates.length === 0) {
    emit(
      {
        status: "skipped",
        reason: "no src/**/*.ts files changed",
        changed: changed.length,
        inspectable: 0,
      },
      cwd,
    );
    process.stderr.write(
      `stryker-scan: skipped — no src/**/*.ts files changed (${changed.length} non-src path(s) in diff)\n`,
    );
    return 0;
  }

  // Budget guard (issue invariant — never run unbounded). Cap the number of
  // diff files mutated in one run; mirrors the homegrown gate's MUTATION_MAX_MUTANTS.
  const maxFiles = parseIntEnv("STRYKER_MAX_FILES", STRYKER_MAX_FILES_DEFAULT);
  const { kept, capped } = capFiles(candidates, maxFiles);
  if (capped) {
    process.stderr.write(
      `stryker-scan: budget cap — mutating ${kept.length} of ${candidates.length} candidate file(s) ` +
        `(STRYKER_MAX_FILES=${maxFiles}); the rest are deferred to keep the run within budget.\n`,
    );
  }

  process.stderr.write(
    `stryker-scan: running Stryker ${STRYKER_VERSION} on ${kept.length} file(s): ${kept.join(", ")}\n`,
  );

  const run = runStryker(kept.join(","), cwd);

  const reportPath = locateReport(cwd);
  if (!reportPath) {
    emit(
      {
        status: "failed",
        reason: "Stryker did not produce a mutation.json report",
        strykerExitCode: run.exitCode,
        files: kept,
      },
      cwd,
    );
    process.stderr.write(
      `stryker-scan: no report found (stryker exit ${run.exitCode}) — emitting failed status (advisory, non-blocking)\n`,
    );
    return 0;
  }

  let report: StrykerReport;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf-8")) as StrykerReport;
  } catch (err: any) {
    emit(
      {
        status: "failed",
        reason: `could not parse Stryker report: ${err?.message ?? err}`,
        reportPath,
      },
      cwd,
    );
    return 0;
  }

  const comparison = buildComparison(report);
  emit(
    {
      status: comparison.status,
      diffFiles: kept,
      diffFilesCapped: capped,
      diffFilesTotal: candidates.length,
      stryker: comparison.stryker,
      comparison: comparison.comparison,
      recommendationSignal: comparison.recommendationSignal,
      homegrownMutatorCatalog: comparison.homegrownMutatorCatalog,
    },
    cwd,
  );

  process.stderr.write(`stryker-scan: ${comparison.recommendationSignal}\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code)).catch((err) => {
    // Even an unexpected error must not block: emit a failed row and exit 0.
    process.stderr.write(`stryker-scan: unexpected error (${err?.message ?? err})\n${err?.stack ?? ""}\n`);
    try {
      writeFileSync(join(process.cwd(), "stryker-comparison.json"), JSON.stringify({ status: "failed", reason: `unexpected error: ${err?.message ?? err}` }) + "\n");
    } catch { /* intentional: best-effort artifact write */ }
    process.exit(0);
  });
}

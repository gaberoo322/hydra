/**
 * mutation.ts — Mutation testing gate and runner
 *
 * Extracted from verification.ts (issue #161).
 *
 * Exports:
 *   - runMutationTests()        — run mutation testing on changed files
 *   - summarizeMutationTests()  — format report for logging
 *   - generateMutations()       — generate candidate mutations for a file
 *   - shouldSkipMutation()      — check if file should be skipped
 *   - MUTATORS                  — mutation operators
 *   - SKIP_PATTERNS             — file skip patterns
 *   - MutationTestReport type   — report shape
 */

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { getTracker } from "./task-tracker.ts";
import { recordOutcome } from "./learning.ts";
import { recordCycleMetrics } from "./metrics.ts";
import { reportOutcome } from "./anchor-selection.ts";
import { fail } from "./backlog.ts";
import { cleanupBrokenBranch, PROJECT_WORKSPACE } from "./cycle-helpers.ts";
import type { CycleContext } from "./cycle-helpers.ts";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIME_BUDGET_MS = 120_000;
const MT_TEST_TIMEOUT_MS = 45_000;

// Issue #272: quick-fix mutation budget — small diffs deserve a cheap gate
// instead of being skipped outright. Kept loose (capped mutants + lower
// kill-rate threshold) so trivial changes don't fail spuriously.
const QUICKFIX_MAX_MUTANTS = 10;
const QUICKFIX_TIME_BUDGET_MS = 60_000;
const DEFAULT_QUICKFIX_KILL_THRESHOLD = 50;
const DEFAULT_STANDARD_KILL_THRESHOLD = 30;

/**
 * Mutation decision strings (issue #272) — observable reason recorded in
 * cycle metrics so dashboards can answer "did the mutation gate run?".
 *
 * Values are stable strings, mirroring jit.ts decision conventions.
 *
 * Issue #300: NO_MUTANTS is now reserved for the case where the candidate
 * generator produced zero mutants for the diff (e.g. comment-only / formatting
 * diffs). A small-but-non-zero mutant count is reported as RAN — the gate did
 * useful work, even if the sample is thin. ALL_UNCOMPILABLE covers the
 * intermediate case where candidates were generated but every applied mutant
 * failed to compile or could not be read.
 */
export const MUTATION_DECISION = {
  RAN: "ran",
  NO_MUTANTS: "no-mutants",
  ALL_UNCOMPILABLE: "skipped: all-mutants-uncompilable",
  COST_CAP_SKIP: "cost-cap-skip",
  NO_FILES: "skipped: no files changed",
  ERROR: "error",
} as const;

export type MutationDecision = typeof MUTATION_DECISION[keyof typeof MUTATION_DECISION];

/**
 * Resolve the quick-fix kill-rate threshold from env (issue #272).
 * Looser than the standard gate (default 30) — small diffs typically
 * have fewer mutants so 50% is the right floor.
 *
 * Pure function — re-reads env each call so tests can mutate without
 * service restart.
 */
export function getQuickFixKillThreshold(): number {
  const raw = process.env.MUTATION_QUICKFIX_THRESHOLD;
  if (raw === undefined || raw === "") return DEFAULT_QUICKFIX_KILL_THRESHOLD;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    return DEFAULT_QUICKFIX_KILL_THRESHOLD;
  }
  return parsed;
}

// Files we never mutate
export const SKIP_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /\.config\.[jt]s$/,
  /\.d\.ts$/,
  /drizzle\//,
  /migrations?\//,
  /__mocks__\//,
  /node_modules\//,
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Mutation = {
  file: string;
  line: number;
  original: string;
  mutated: string;
  type: string;
};

export type MutationResult = {
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
// Mutators
// ---------------------------------------------------------------------------

/**
 * Mutators — each takes a line and returns a mutated version, or null if
 * the mutation doesn't apply.
 */
export const MUTATORS: { type: string; apply: (line: string) => string | null }[] = [
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
 * Generate candidate mutations for a single file.
 */
export function generateMutations(filePath: string, content: string): Mutation[] {
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
 * @param projectDir - Project root (~/hydra-betting)
 * @param changedFiles - List of changed file paths (from git diff)
 * @param opts.timeBudgetMs - Max time for all mutations (default 60s)
 * @param opts.testCommand - Command to run tests (default: npm test)
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

/**
 * Format mutation test results for logging / reality report.
 */
export function summarizeMutationTests(report: MutationTestReport): string {
  const parts: string[] = [];
  const score = report.totalMutants > 0
    ? Math.round((report.killed / (report.totalMutants - report.skipped)) * 100)
    : 100;

  parts.push(`## Mutation Testing: ${score}% kill rate (${report.killed}/${report.totalMutants - report.skipped} killed)`);
  if (report.timedOut) parts.push(`\u26A0 Time budget exceeded \u2014 ${report.totalMutants} of ${report.totalMutants} candidate mutants tested`);
  parts.push(`Duration: ${report.durationMs}ms`);

  if (report.survivors.length > 0) {
    parts.push(`\n### Surviving Mutants (uncovered code):`);
    for (const s of report.survivors.slice(0, 10)) {
      parts.push(`- ${s.mutation.file}:${s.mutation.line} [${s.mutation.type}]`);
      parts.push(`  Original: ${s.mutation.original.trim()}`);
      parts.push(`  Mutated:  ${s.mutation.mutated.trim()}`);
    }
    if (report.survivors.length > 10) {
      parts.push(`  ... and ${report.survivors.length - 10} more`);
    }
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Mutation gate — pipeline orchestration (step 6.7)
// ---------------------------------------------------------------------------

/**
 * Classify the gate decision when no mutants survived the testable filter.
 *
 * Issue #300: the gate previously short-circuited to NO_MUTANTS whenever
 * `testable < 3`, which silently downgraded small-but-valid samples (the
 * `mutationsTested: 2, mutationSurvived: 0` constant in the 20-cycle
 * telemetry) and pinned qualityGateCoverageRate at ~14%. Post-#300 the
 * decision is:
 *
 *   testable > 0                                    → null  (caller uses RAN)
 *   testable === 0 && candidatesGenerated === 0     → NO_MUTANTS
 *   testable === 0 && candidatesGenerated > 0       → ALL_UNCOMPILABLE
 *
 * Pure helper — exported for unit testing without a CycleContext mock.
 */
export function classifyNoSignalDecision(
  testable: number,
  candidatesGenerated: number,
): MutationDecision | null {
  if (testable > 0) return null;
  return candidatesGenerated === 0
    ? MUTATION_DECISION.NO_MUTANTS
    : MUTATION_DECISION.ALL_UNCOMPILABLE;
}

/**
 * Decide if the mutation pass should be skipped because the cycle has
 * already exceeded its per-cycle cost cap (issue #272 implementation note).
 *
 * Pure(-ish) helper — reads the cap via cost-cap.ts (which reads env). Kept
 * separate so tests can override via env without touching control-loop wiring.
 */
async function shouldSkipForCostCap(cycleId: string): Promise<boolean> {
  try {
    const { checkCostCap } = await import("./cost-cap.ts");
    const status = await checkCostCap(cycleId);
    return status.exceeded;
  } catch { /* intentional: cost cap is best-effort; never block mutation on a cap-check error */
    return false;
  }
}

/**
 * Run the mutation testing quality gate. Blocks merge when kill rate
 * is critically low.
 *
 * Issue #272: quick-fix cycles now run a reduced mutation budget instead of
 * skipping outright, with a looser (configurable) kill-rate threshold. The
 * gate result includes a `decision` string for observability and a
 * `filesInspected` list when no mutants were generated.
 *
 * Never throws — returns { report, decision, filesInspected, earlyReturn? }.
 */
export async function runMutationGate(
  ctx: CycleContext, task: any, verification: any, execResult: any,
  complexity: string, filesInScope: number, criteriaCount: number, taskId: string,
): Promise<{ report: any; decision: MutationDecision; filesInspected: string[]; earlyReturn?: any }> {
  const { cycleId, startTime, grounding, ovSession, eventBus, anchor } = ctx;
  const tracker = getTracker();

  const isQuickFix = complexity === "quick-fix";
  const inspectable = verification.filesChanged.filter((f: string) => !shouldSkipMutation(f));

  // Issue #272: short-circuit if the cycle is already at the cost cap.
  // Don't burn another mutation budget on something the operator has capped.
  if (await shouldSkipForCostCap(cycleId)) {
    console.log(`[ControlLoop] Step 6.7: Mutation gate skipped — cycle at cost cap`);
    return { report: null, decision: MUTATION_DECISION.COST_CAP_SKIP, filesInspected: inspectable };
  }

  const budgetMs = isQuickFix ? QUICKFIX_TIME_BUDGET_MS : 60_000;
  const maxMutants = isQuickFix ? QUICKFIX_MAX_MUTANTS : undefined;
  const killThreshold = isQuickFix ? getQuickFixKillThreshold() : DEFAULT_STANDARD_KILL_THRESHOLD;

  console.log(`[ControlLoop] Step 6.7: Running mutation tests on ${verification.filesChanged.length} changed files${isQuickFix ? ` (quick-fix budget: ${QUICKFIX_MAX_MUTANTS} mutants, ${QUICKFIX_TIME_BUDGET_MS}ms)` : ""}...`);
  try {
    const mutationReport = await runMutationTests(PROJECT_WORKSPACE, verification.filesChanged, {
      timeBudgetMs: budgetMs,
      testCommand: "npm test",
      maxMutants,
    });
    const testable = mutationReport.totalMutants - mutationReport.skipped;
    const killRate = testable > 0
      ? Math.round((mutationReport.killed / testable) * 100)
      : 100;
    console.log(`[ControlLoop] Mutation testing: ${killRate}% kill rate (${mutationReport.killed}/${testable} killed, ${mutationReport.survived} survived, ${mutationReport.candidatesGenerated} candidates generated)`);

    // Issue #300: classify "no signal" cases via the pure helper. testable > 0
    // returns null and falls through to the kill-rate gate below.
    const noSignal = classifyNoSignalDecision(testable, mutationReport.candidatesGenerated);
    if (noSignal !== null) {
      console.log(`[ControlLoop] Mutation testing: ${noSignal} (candidates=${mutationReport.candidatesGenerated}, skipped=${mutationReport.skipped}). Inspected files: ${inspectable.join(", ") || "(none)"}`);
      return { report: mutationReport, decision: noSignal, filesInspected: inspectable };
    }

    if (mutationReport.survived > 0) {
      console.log(`[ControlLoop] ${mutationReport.survived} surviving mutants — executor's tests may not cover changed behavior`);
      for (const s of mutationReport.survivors.slice(0, 3)) {
        console.log(`[ControlLoop]   ${s.mutation.file}:${s.mutation.line} [${s.mutation.type}]`);
      }
    }

    // Hard gate: block merge when kill rate is below threshold.
    // Quick-fix uses a looser configurable threshold (MUTATION_QUICKFIX_THRESHOLD,
    // default 50); standard/complex/high-risk use DEFAULT_STANDARD_KILL_THRESHOLD (30).
    if (killRate < killThreshold) {
      console.error(`[ControlLoop] MUTATION GATE: kill rate ${killRate}% < ${killThreshold}% threshold (${complexity}) — blocking merge`);
      await tracker.transitionTask(taskId, "failed", { reason: `Mutation gate: ${killRate}% kill rate (${mutationReport.survived} survivors)` });
      await recordOutcome({
        agents: ["planner"],
        cycleId, task, finalState: "failed",
        anchorRef: anchor.reference, anchorType: anchor.type,
        context: { failReason: `Mutation gate: ${killRate}% kill rate`, failedSteps: ["mutation-testing"] },
      });
      await fail(anchor.reference, "mutation gate blocked merge", { eventBus, cycleId });

      await cleanupBrokenBranch(PROJECT_WORKSPACE);
      await reportOutcome(anchor, { status: "failed", reason: `Mutation gate: tests don't cover changed behavior (${killRate}% kill rate)`, verification, taskId });
      await ovSession.logOutcome("failed", `Mutation gate: ${killRate}% kill rate`);
      await ovSession.commit();
      await recordCycleMetrics(cycleId, {
        tasksAttempted: 1, tasksFailed: 1, tasksMerged: 0, tasksVerified: 0, tasksAbandoned: 0,
        testsBefore: grounding.testReport.passed, testsAfter: grounding.testReport.passed,
        testsPassingBefore: grounding.testReport.passed, testsPassingAfter: grounding.testReport.passed,
        filesChanged: verification.filesChanged.length, totalDurationMs: Date.now() - startTime,
        groundingDurationMs: grounding.groundingDurationMs, verificationDurationMs: verification.totalDurationMs,
        regressionIntroduced: false, taskTitle: task.title,
        anchorType: task.anchorType, anchorReference: task.anchorReference,
        complexity, filesInScope, criteriaCount,
        plannerModel: task.__plannerModel || "unknown",
        executorModel: execResult?.__executorModel || "unknown",
        // Quality gate trend fields (issue #212)
        mutationKillRate: killRate,
        mutationsTested: testable,
        mutationKilled: mutationReport.killed,
        mutationSurvived: mutationReport.survived,
        gateBlocked: 1,
      });
      return {
        report: mutationReport,
        decision: MUTATION_DECISION.RAN,
        filesInspected: inspectable,
        earlyReturn: {
          cycleId,
          tasks: [{ taskId, finalState: "failed", reason: `Mutation gate: ${killRate}% kill rate` }],
          durationMs: Date.now() - startTime,
        },
      };
    }

    return { report: mutationReport, decision: MUTATION_DECISION.RAN, filesInspected: inspectable };
  } catch (err: any) {
    console.error(`[ControlLoop] Mutation testing failed (non-fatal): ${err.message}`);
    return { report: null, decision: MUTATION_DECISION.ERROR, filesInspected: inspectable };
  }
}

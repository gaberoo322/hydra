/**
 * incremental-verification.ts — Wire the test-impact-graph foundation
 * (issue #341, PR #360) into the verification path (issue #362).
 *
 * This is the runtime glue layer that:
 *   1. Reads env flags (HYDRA_INCREMENTAL_GROUNDING, HYDRA_FULL_SUITE_EVERY_N)
 *   2. Lists project test files + source files + computes changed files
 *   3. Delegates selection decisions to test-impact-graph.ts (pure module)
 *   4. Translates a selection into a concrete test-runner invocation
 *   5. Maintains a Redis cycle counter for the "full-suite every Nth" safety net
 *
 * Tier-2 sensitivity: changes here can mask Target Outcome regressions if the
 * incremental selector is wrong. Outcome Holdback (5-cycle watch + auto-revert)
 * applies. The default is OFF (HYDRA_INCREMENTAL_GROUNDING unset). When ON,
 * every decision path falls back to the FULL suite on any uncertainty:
 *
 *   - flag not set                  → full
 *   - cycle counter modulo N == 0   → full (every-Nth safety net)
 *   - changed files empty           → full (no-diff)
 *   - selection saturates >=90%     → full (saturation)
 *   - selection empty (zero tests)  → full (safety-net miss)
 *   - import-graph build fails      → full (degraded)
 *
 * The only path that produces an "incremental" decision is when all six
 * gates pass AND the selector returns a non-empty subset of the suite.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { incrKey, getString } from "./redis/kv.ts";
import {
  buildImportGraph,
  decideTestSelection,
  type ImportGraph,
  type SelectionDecision,
} from "./test-impact-graph.ts";

const execFileAsync = promisify(execFile);

// =========================================================================
// Env contract
// =========================================================================

/** Default cadence for the full-suite safety net. */
export const DEFAULT_FULL_SUITE_EVERY_N = 10;

/** Redis key tracking how many verification cycles have run since startup. */
export const CYCLE_COUNTER_KEY = "hydra:incremental:cycle-counter";

export interface IncrementalEnv {
  /** Master switch — false unless HYDRA_INCREMENTAL_GROUNDING=true. */
  enabled: boolean;
  /** Full-suite safety-net cadence (>= 1; coerced from HYDRA_FULL_SUITE_EVERY_N). */
  fullSuiteEveryN: number;
}

/**
 * Read incremental env flags. Pure function — call sites pass a
 * read-from-process-env'd object so unit tests can drive it without touching
 * the real process env.
 */
export function readIncrementalEnv(env: NodeJS.ProcessEnv = process.env): IncrementalEnv {
  const flag = (env.HYDRA_INCREMENTAL_GROUNDING || "").toLowerCase();
  const enabled = flag === "true" || flag === "1" || flag === "yes";

  const rawN = parseInt(env.HYDRA_FULL_SUITE_EVERY_N || "", 10);
  const fullSuiteEveryN = Number.isFinite(rawN) && rawN >= 1
    ? rawN
    : DEFAULT_FULL_SUITE_EVERY_N;

  return { enabled, fullSuiteEveryN };
}

// =========================================================================
// Decision types
// =========================================================================

export type IncrementalMode = "incremental" | "full" | "";

export interface IncrementalDecision {
  /**
   * "incremental" — only a subset of tests will run
   * "full"        — full suite (either flag off, safety-net, saturation, or zero-selection)
   * ""            — env flag was off; caller should not even attempt selection
   */
  mode: IncrementalMode;

  /** Number of tests the incremental selector picked. 0 for full-suite/disabled. */
  testsSelected: number;

  /** Total tests in the graph. 0 when disabled or graph build failed. */
  totalTests: number;

  /** Human-readable rationale (logs + dashboard). */
  reason: string;

  /**
   * Selected test files (relative to projectDir). Populated only when
   * mode === "incremental". Caller translates these into a runner CLI.
   */
  selectedTests: string[];

  /** Counter value AFTER this cycle's increment (for observability). */
  cycleCounter: number;
}

// =========================================================================
// Cycle counter — Redis-backed
// =========================================================================

/**
 * Increment the cycle counter and return its new value. Used by the
 * "full-suite every Nth" safety net.
 *
 * Falls back to a stable counter of 1 if Redis is unavailable — incremental
 * is a soft optimisation, not a correctness gate, so a Redis outage must NOT
 * block verification.
 */
export async function bumpCycleCounter(): Promise<number> {
  try {
    return await incrKey(CYCLE_COUNTER_KEY);
  } catch (err: any) {
    console.error(
      `[incremental-verification] incrKey failed (counter unavailable, treating as full): ${err.message}`,
    );
    return 1;
  }
}

/** Read the current counter without bumping it (mostly for tests + diagnostics). */
export async function readCycleCounter(): Promise<number> {
  try {
    const raw = await getString(CYCLE_COUNTER_KEY);
    if (raw === null) return 0;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

// =========================================================================
// Project file enumeration — git ls-files
// =========================================================================

export interface ProjectFiles {
  /** All TypeScript/JavaScript files tracked by git (relative paths). */
  allFiles: string[];
  /** Test files (filtered from allFiles by the standard suffixes). */
  testFiles: string[];
}

/**
 * Heuristic: a project's test file matches one of these globs.
 * - `*.test.ts` / `*.test.tsx` / `*.test.mts` / `*.test.js` / `*.test.mjs`
 * - `*.spec.ts` etc.
 * - lives under `test/`, `tests/`, or `__tests__/`
 *
 * Pure / sync — caller passes a list of relative paths.
 */
export function isTestFile(relPath: string): boolean {
  if (!relPath) return false;
  // Standard test/spec suffixes (TS + JS family).
  if (/\.(test|spec)\.(m?ts|m?js|tsx|jsx)$/.test(relPath)) return true;
  // Tests directory conventions.
  if (relPath.startsWith("test/") || relPath.startsWith("tests/")) {
    return /\.(m?ts|m?js|tsx|jsx)$/.test(relPath);
  }
  if (relPath.includes("__tests__/")) {
    return /\.(m?ts|m?js|tsx|jsx)$/.test(relPath);
  }
  return false;
}

/**
 * Filter out paths that aren't TS/JS source (configs, JSON, fixtures, …).
 * Keeping the graph small reduces import-resolution work and false positives.
 */
export function isSourceFile(relPath: string): boolean {
  return /\.(m?ts|m?js|tsx|jsx|cts|cjs)$/.test(relPath);
}

/**
 * List project files via `git ls-files`. Returns relative paths to projectDir,
 * partitioned into all source files vs test files.
 *
 * Never throws — returns empty arrays on git failure (caller falls back to
 * full suite, which is the safe default).
 */
export async function listProjectFiles(projectDir: string): Promise<ProjectFiles> {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files"], {
      cwd: projectDir,
      timeout: 15_000,
      maxBuffer: 1024 * 1024 * 5,
    });
    const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    const allFiles = lines.filter(isSourceFile);
    const testFiles = allFiles.filter(isTestFile);
    return { allFiles, testFiles };
  } catch (err: any) {
    console.error(
      `[incremental-verification] git ls-files failed (falling back to full): ${err.message}`,
    );
    return { allFiles: [], testFiles: [] };
  }
}

/**
 * Compute the set of files changed against a base ref.
 *
 * Strategy:
 *   - If featureBranch is provided: `git diff --name-only main...<branch>`
 *   - Else: `git diff --name-only HEAD` (unstaged + staged in workspace)
 *
 * Never throws — returns [] on failure (caller falls back to full suite).
 */
export async function listChangedFiles(
  projectDir: string,
  opts: { featureBranch?: string; baseRef?: string } = {},
): Promise<string[]> {
  const baseRef = opts.baseRef || "main";
  try {
    if (opts.featureBranch) {
      const { stdout } = await execFileAsync(
        "git",
        ["diff", "--name-only", `${baseRef}...${opts.featureBranch}`],
        { cwd: projectDir, timeout: 10_000 },
      );
      return stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    }
    // No branch — compare HEAD to base (covers in-progress workspace state).
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--name-only", baseRef],
      { cwd: projectDir, timeout: 10_000 },
    );
    return stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch (err: any) {
    console.error(
      `[incremental-verification] git diff --name-only failed: ${err.message}`,
    );
    return [];
  }
}

// =========================================================================
// Top-level orchestrator
// =========================================================================

export interface SelectionInputs {
  /** Project root (absolute path). */
  projectDir: string;
  /** Optional executor feature branch — improves diff accuracy when set. */
  featureBranch?: string;
  /** Env snapshot (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Pre-bumped counter (allows callers to bump once per verify-call). */
  cycleCounter?: number;
  /**
   * Injection hooks for tests — replace the I/O layer entirely.
   * If listProjectFilesImpl or listChangedFilesImpl is supplied, the
   * production helpers above are NOT called.
   */
  listProjectFilesImpl?: (dir: string) => Promise<ProjectFiles>;
  listChangedFilesImpl?: (
    dir: string,
    opts: { featureBranch?: string },
  ) => Promise<string[]>;
  /** Read-file impl forwarded into buildImportGraph (tests). */
  readFileImpl?: (absPath: string) => Promise<string>;
}

/**
 * Compute the full incremental-vs-full decision for one verification cycle.
 *
 * Order of gates (each one short-circuits to full):
 *   1. env.enabled === false       → mode "" (caller should use defaults)
 *   2. counter % N === 0           → mode "full" (every-Nth safety net)
 *   3. changedFiles empty          → mode "full" (no-diff)
 *   4. graph build fails           → mode "full" (degraded)
 *   5. decideTestSelection chooses → "full" (saturation/safety-net) OR
 *                                    "incremental" (subset)
 *
 * The counter increment is done inside this function so the decision and the
 * counter state are atomic from the caller's POV.
 */
export async function computeSelection(
  inputs: SelectionInputs,
): Promise<IncrementalDecision> {
  const env = readIncrementalEnv(inputs.env);

  // Gate 1: master env flag.
  if (!env.enabled) {
    return {
      mode: "",
      testsSelected: 0,
      totalTests: 0,
      reason: "HYDRA_INCREMENTAL_GROUNDING not set — using full suite (default)",
      selectedTests: [],
      cycleCounter: 0,
    };
  }

  // Counter: bump unless caller pre-supplied one. Always run a counter bump
  // so the every-Nth cadence is stable even when callers skip the env gate.
  const counter = typeof inputs.cycleCounter === "number"
    ? inputs.cycleCounter
    : await bumpCycleCounter();

  // Gate 2: full-suite every Nth cycle.
  if (counter > 0 && counter % env.fullSuiteEveryN === 0) {
    return {
      mode: "full",
      testsSelected: 0,
      totalTests: 0,
      reason: `safety-net: cycle ${counter} is multiple of ${env.fullSuiteEveryN} — running full suite`,
      selectedTests: [],
      cycleCounter: counter,
    };
  }

  // Gather project state.
  const lsImpl = inputs.listProjectFilesImpl || listProjectFiles;
  const diffImpl = inputs.listChangedFilesImpl || listChangedFiles;
  const project = await lsImpl(inputs.projectDir);
  if (project.testFiles.length === 0) {
    return {
      mode: "full",
      testsSelected: 0,
      totalTests: 0,
      reason: "no test files discovered — running full suite",
      selectedTests: [],
      cycleCounter: counter,
    };
  }

  const changedFiles = await diffImpl(inputs.projectDir, {
    featureBranch: inputs.featureBranch,
  });

  // Gate 3: no diff — covered inside decideTestSelection too, but we short-
  // circuit before building the graph to avoid the I/O cost.
  if (changedFiles.length === 0) {
    return {
      mode: "full",
      testsSelected: 0,
      totalTests: project.testFiles.length,
      reason: "no-diff: changed file list empty — running full suite",
      selectedTests: [],
      cycleCounter: counter,
    };
  }

  // Build the graph + decide.
  let graph: ImportGraph;
  try {
    graph = await buildImportGraph(
      {
        projectDir: inputs.projectDir,
        testFiles: project.testFiles,
        readFileImpl: inputs.readFileImpl,
      },
      {
        allFiles: new Set(project.allFiles),
      },
    );
  } catch (err: any) {
    console.error(
      `[incremental-verification] buildImportGraph failed: ${err.message} — falling back to full suite`,
    );
    return {
      mode: "full",
      testsSelected: 0,
      totalTests: project.testFiles.length,
      reason: `degraded: import-graph build failed (${err.message}) — running full suite`,
      selectedTests: [],
      cycleCounter: counter,
    };
  }

  const decision: SelectionDecision = decideTestSelection(changedFiles, graph);

  if (decision.mode === "full-suite") {
    return {
      mode: "full",
      testsSelected: 0,
      totalTests: graph.size,
      reason: decision.reason,
      selectedTests: [],
      cycleCounter: counter,
    };
  }

  return {
    mode: "incremental",
    testsSelected: decision.tests.length,
    totalTests: graph.size,
    reason: decision.reason,
    selectedTests: decision.tests,
    cycleCounter: counter,
  };
}

// =========================================================================
// Test-runner CLI translation
// =========================================================================

export interface VerificationStep {
  command: string;
  expected: string;
  label: string;
}

/**
 * Translate an incremental selection into a verification-plan test step.
 *
 * Strategy:
 *   - Target uses vitest (~/hydra-betting/web). We invoke vitest directly
 *     against the selected files via `npm --prefix web run test:raw -- <files...>`.
 *     vitest accepts positional file args and runs only those.
 *   - The min-passing-test-count gate (MIN_PASSING_TESTS=2301 in package.json)
 *     is skipped on incremental cycles — that gate validates *the whole suite*
 *     and is restored by the every-Nth full-suite safety net.
 *
 * Pure function — no I/O, deterministic.
 *
 * @param selectedTests  Test file paths (relative to projectDir).
 * @param appSubdir      Where vitest configs live (default "web").
 *                       Pass "" for projects with config at root.
 */
export function buildIncrementalTestStep(
  selectedTests: string[],
  appSubdir: string = "web",
): VerificationStep {
  if (selectedTests.length === 0) {
    // Should never be called with empty — but be defensive: the caller has
    // already chosen incremental, so empty here is a programming error.
    // Fall back to "npm test" so we never run zero tests.
    return { command: "npm test", expected: "exit code 0", label: "tests" };
  }

  // Quote each path to defend against spaces (unlikely in src/) and let the
  // shell pass them through to vitest as positional args. We deliberately do
  // NOT escape `--` runs of args; the test paths are git-tracked file paths
  // which have a tightly-constrained character set.
  const args = selectedTests.map((t) => `"${t}"`).join(" ");

  const prefix = appSubdir ? `npm --prefix ${appSubdir} run test:raw --` : "npx vitest run";
  return {
    command: `${prefix} ${args}`,
    expected: "exit code 0",
    label: "tests",
  };
}

/**
 * Replace the "tests" step in a verification plan with an incremental step.
 *
 * Pure function. Returns a NEW plan array — never mutates input.
 * If no step with label "tests" exists, returns the plan unchanged AND
 * logs (caller is responsible for noticing the warning via the returned bool).
 */
export function injectIncrementalTestStep(
  plan: VerificationStep[],
  step: VerificationStep,
): { plan: VerificationStep[]; replaced: boolean } {
  let replaced = false;
  const out = plan.map((s) => {
    if (s.label === "tests" && !replaced) {
      replaced = true;
      return step;
    }
    return s;
  });
  return { plan: out, replaced };
}

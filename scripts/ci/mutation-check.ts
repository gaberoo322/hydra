#!/usr/bin/env -S npx tsx
/**
 * scripts/ci/mutation-check.ts — Mutation testing CI gate (issues #382, #653).
 *
 * Re-homes the in-cycle mutation gate (was step 6.7 of the codex control
 * loop, runMutationGate() in src/mutation.ts) so PRs from any source get
 * the same kill-rate gate after the codex CLI is removed (PR-3).
 *
 * Issue #653: diff-scoped mutation. The gate ONLY mutates `src/**\/*.ts`
 * files that changed in the PR (computed by the workflow as
 * `git diff --name-only $(git merge-base origin/master HEAD)...HEAD`).
 * If the filtered list is empty (asset/doc-only PR) the gate emits a
 * `skipped` status with a clear reason and exits 0 — never a silent pass.
 *
 * Reuses the existing pure runner `runMutationTests()` from src/mutation.ts
 * — only the orchestration around it is rewritten here for a CI context
 * (no CycleContext, no OV session, no Redis).
 *
 * Inputs (env):
 *   CHANGED_FILES               — list of files in the diff. The CI path
 *                                 supplies newline-separated `git diff
 *                                 --name-only` output; since #4346 the gate
 *                                 shares the Target gate's #3803 whitespace-
 *                                 tokenizing parser, so a hand-built
 *                                 space-separated value also parses (one entry
 *                                 per path). Newline-only input parses
 *                                 byte-identically to the pre-#4346 split.
 *   MUTATION_KILL_RATE_FLOOR    — base kill-rate floor as integer percent for
 *                                 T1/T2 diffs (default 30)
 *   MUTATION_KILL_RATE_FLOOR_T3 — kill-rate floor for T3/T4 diffs (default 55;
 *                                 issue #778 — depth-gate protection for the
 *                                 load-bearing core paths #767 demoted to T3)
 *   PR_TIER                     — the Modification Tier (1|2|3|4) of this PR's
 *                                 diff, computed by the workflow via
 *                                 scripts/tier-classify.ts (the single tier
 *                                 authority). tier>=3 selects the T3 floor.
 *   MUTATION_TIME_BUDGET_MS     — overall time budget (default 540_000 = 9m,
 *                                 leaves 60s buffer under the 10m CI step timeout)
 *   MUTATION_MAX_MUTANTS        — optional cap on candidate mutants
 *
 * Quick-fix bypass: if the PR body contains "[quick-fix]" (via PR_BODY env)
 * the gate writes a "neutral" status and exits 0. Mirrors the in-cycle
 * quick-fix exemption.
 *
 * No-signal status (issue #1120): when the diff yields zero TESTABLE mutants
 * (all generated mutants skipped, or none generated) the gate no longer
 * fabricates `killRate=100`/`pass`. For tier>=3 it emits `status:"warn"` with a
 * null `killRate` and a reason distinguishing "no mutants generated" from "all
 * generated mutants skipped"; T1/T2 stays `neutral`. Both are non-blocking
 * (exit 0) — `warn` only surfaces the no-signal gap in the step-summary JSON.
 *
 * Timed-out status (issue #2393, porting the Target gate's #1821 precedent):
 * when the runner exhausts its time budget on a large file it can only
 * evaluate a partial mutant sample (e.g. 75 of 553). The pre-#2393 gate
 * captured `report.timedOut` into the summary JSON but NEVER branched on it —
 * it computed `killRate` over only the EVALUATED sample and emitted `pass` if
 * that partial rate cleared the floor, silently rubber-stamping a diff whose
 * surviving mutants land in the unevaluated tail. Now `classifyTimedOut` emits
 * a distinct `status:"warn"` carrying the partial kill rate for context
 * (informational only, NEVER compared against the floor); the warn is
 * non-blocking (exit 0) but never masquerades as a pass. This brings the
 * Orchestrator gate to parity with the Target gate (scripts/target/mutation-
 * check.ts). The timed-out check is tier-independent — a budget-exhausted run
 * has reached NO verdict regardless of tier, so it must not present as a pass
 * on any tier.
 *
 * Branch precedence in main(): classifyNoSignal -> classifyTimedOut ->
 * kill-rate, matching the Target sibling's ordering so the two gates stay
 * behaviorally aligned.
 *
 * Shared helpers (issue #4346): isQuickFix / parseIntEnv / readChangedFiles /
 * parseChangedFiles / classifyTimedOut now live in ONE shared leaf,
 * src/mutation-gate-inputs.ts, imported by both this gate and the Target gate
 * — the pre-#4346 hand-duplicated copies can never drift apart again.
 * classifyNoSignal deliberately stays gate-local (each gate's no-signal
 * POLICY differs: this gate's tier ladder vs. the Target's money-critical
 * boolean — divergence, not drift).
 *
 * Related-test scoping + honest verdicts (issue #4504): the pre-#4504 gate ran
 * the FULL `npm test` suite (~15 min) per mutant under the runner's 45s
 * per-mutant timeout, and the runner counted a timeout as KILLED — so every
 * mutant "died", the kill rate was always a fabricated 100%, and the job always
 * burned its whole 9-minute budget. Now:
 *   - each mutant runs ONLY the test files related to the mutated source file
 *     (`selectRelatedTests` over a static import graph of test/*.test.mts, plus
 *     a basename heuristic), via `npm run test:file` so the per-run Redis DB
 *     isolation is kept;
 *   - a mutated file with no related test yields `noCoverage` mutants (reported,
 *     never run, never killed);
 *   - a per-mutant timeout, or a related-test set that already fails on the
 *     UNMUTATED source, yields `inconclusive` mutants;
 *   - the kill rate is computed over CONCLUSIVE mutants only (killed+survived).
 *
 * Rollout switch (issue #4504): making the gate honest can surface real
 * sub-floor kill rates, so a below-floor verdict only blocks when
 * MUTATION_GATE_BLOCKING is truthy ("1"/"true"/"yes"). By default it is
 * reported as `status:"warn"` with `wouldFail:true` and exits 0.
 *
 * Extra inputs (env, issue #4504):
 *   MUTATION_GATE_BLOCKING      — "1"/"true"/"yes" makes a below-floor verdict
 *                                 exit 2 (default: non-blocking warn, exit 0)
 *   MUTATION_TEST_TIMEOUT_MS    — per-mutant test-run timeout (default 45_000)
 *   MUTATION_MAX_RELATED_TESTS  — cap on related test files per mutated file
 *                                 (default 8)
 *
 * Exit codes:
 *   0 — pass, neutral/warn skip, no-signal, timed-out warn, or a below-floor
 *       verdict while the gate is non-blocking (the default)
 *   2 — mutation gate failed: kill rate below floor AND MUTATION_GATE_BLOCKING
 *   1 — usage / unexpected error
 */

import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import {
  conclusiveMutants,
  runMutationTests,
  shouldSkipMutation,
  type MutationTestReport,
} from "../../src/mutation.ts";
import {
  classifyTimedOut,
  isQuickFix,
  parseIntEnv,
  readChangedFiles,
} from "../../src/mutation-gate-inputs.ts";

/**
 * Filter a list of changed paths down to the files the mutation gate
 * should actually mutate (issue #653).
 *
 * The contract is a positive allowlist: only `src/**\/*.ts` source files
 * survive. The legacy denylist (`shouldSkipMutation`) is applied as a
 * second pass so co-located `src/foo.test.ts` and `src/foo.d.ts` stay
 * excluded even though they pass the allowlist prefix.
 *
 * Pure — no filesystem, no git, no env. Test it by passing in arbitrary
 * string lists.
 */
export function filterMutationCandidates(changedFiles: string[]): string[] {
  return changedFiles
    .map((f) => f.trim())
    .filter((f) => f.length > 0)
    .filter((f) => f.startsWith("src/") && f.endsWith(".ts"))
    .filter((f) => !shouldSkipMutation(f));
}

// ---------------------------------------------------------------------------
// Related-test selection (issue #4504)
// ---------------------------------------------------------------------------

/**
 * Extract the RELATIVE module specifiers a source file imports: static
 * `import … from "x"` / `export … from "x"`, side-effect `import "x"`, and
 * dynamic `import("x")`. Bare package specifiers (no leading `.`) are dropped —
 * only in-repo edges matter for related-test selection.
 *
 * Deliberately a lexical scan, not a parser: a specifier inside a comment or
 * string can over-include an edge, which only ever ADDS a related test (safe);
 * it never drops a real import. Pure.
 */
export function extractRelativeImports(source: string): string[] {
  const out = new Set<string>();
  const patterns = [
    /\bfrom\s*["']([^"'\n]+)["']/g,
    /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
    /\bimport\s+["']([^"'\n]+)["']/g,
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) {
      if (m[1].startsWith(".")) out.add(m[1]);
    }
  }
  return [...out];
}

/**
 * Resolve a relative specifier imported by `fromFile` (repo-relative, posix)
 * to a repo-relative path, or null when it escapes the repo root. Pure.
 */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  const joined = join(dirname(fromFile), spec).split("\\").join("/");
  if (joined.startsWith("..") || joined.startsWith("/")) return null;
  return joined;
}

/**
 * Build the forward import graph reachable from `entryFiles` (repo-relative
 * paths). `readSource` returns a file's text, or null when it does not exist;
 * only existing files become graph nodes. Pure given `readSource`.
 */
export function buildImportGraph(
  entryFiles: string[],
  readSource: (repoRelPath: string) => string | null,
): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const stack = [...entryFiles];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (graph.has(file)) continue;
    const text = readSource(file);
    if (text === null) continue;
    const deps: string[] = [];
    for (const spec of extractRelativeImports(text)) {
      const dep = resolveSpecifier(file, spec);
      if (dep !== null) deps.push(dep);
    }
    graph.set(file, deps);
    for (const dep of deps) if (!graph.has(dep)) stack.push(dep);
  }
  return graph;
}

/**
 * Select the test files related to `mutatedFile` (issue #4504), most specific
 * first, capped at `maxTests`:
 *   1. tests that import it DIRECTLY (import-graph distance 1);
 *   2. tests whose basename starts with the mutated file's basename
 *      (`src/mutation.ts` → `test/mutation*.test.mts`) — catches tests that
 *      exercise a module through a subprocess rather than an import;
 *   3. tests that import it TRANSITIVELY, nearest first.
 * Ties break alphabetically so the selection is deterministic. An empty result
 * means the mutated file has no related test → its mutants are `noCoverage`.
 *
 * The cap keeps a widely-imported leaf (e.g. the logger) from turning every
 * mutant into a near-full-suite run; the nearest tests are the likeliest
 * killers. Pure.
 */
export function selectRelatedTests(
  mutatedFile: string,
  testFiles: string[],
  graph: Map<string, string[]>,
  maxTests: number,
): string[] {
  // Reverse BFS from the mutated file: import distance of every importer.
  const importers = new Map<string, string[]>();
  for (const [file, deps] of graph) {
    for (const dep of deps) {
      const list = importers.get(dep);
      if (list) list.push(file);
      else importers.set(dep, [file]);
    }
  }
  const distance = new Map<string, number>([[mutatedFile, 0]]);
  let frontier = [mutatedFile];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const f of frontier) {
      for (const imp of importers.get(f) ?? []) {
        if (distance.has(imp)) continue;
        distance.set(imp, (distance.get(f) as number) + 1);
        next.push(imp);
      }
    }
    frontier = next;
  }

  const stem = basename(mutatedFile).replace(/\.[^.]+$/, "");
  const rank = (t: string): number | null => {
    const d = distance.get(t);
    if (d === 1) return 1;
    if (basename(t).startsWith(stem)) return 1.5;
    return d === undefined ? null : d;
  };

  return testFiles
    .map((t) => ({ t, r: rank(t) }))
    .filter((x): x is { t: string; r: number } => x.r !== null)
    .sort((a, b) => a.r - b.r || a.t.localeCompare(b.t))
    .slice(0, Math.max(0, maxTests))
    .map((x) => x.t);
}

/**
 * The per-mutant test command for a related-test set (issue #4504):
 * `npm run test:file` (same strip-types runner + per-run Redis DB isolation as
 * `npm test`), serialised with `--test-concurrency=1` like the full suite so
 * Redis-sharing files never race each other. Null for an empty set — the
 * mutant is `noCoverage`, never a silent full-suite run. Pure.
 */
export function buildRelatedTestCommand(relatedTests: string[]): string | null {
  if (relatedTests.length === 0) return null;
  return `npm run test:file -- --test-concurrency=1 ${relatedTests.join(" ")}`;
}

/**
 * Whether a below-floor verdict blocks merge (issue #4504 rollout switch).
 * Only an explicit truthy MUTATION_GATE_BLOCKING value ("1", "true", "yes";
 * case-insensitive) blocks; unset / anything else is non-blocking. Pure.
 */
export function isGateBlocking(raw: string | undefined): boolean {
  return /^(1|true|yes)$/i.test((raw ?? "").trim());
}

/**
 * Resolve the gate's kill-rate verdict into the emitted status + exit code
 * (issue #4504). A clearing rate is `pass`/0. A below-floor rate is `fail`/2
 * ONLY when blocking; otherwise it is reported honestly as `warn` with
 * `wouldFail: true` and exits 0, so the rollout cannot redden the merge queue.
 * Pure.
 */
export function resolveKillRateVerdict(
  killRate: number,
  killFloor: number,
  blocking: boolean,
): { status: "pass" | "fail" | "warn"; wouldFail: boolean; exitCode: 0 | 2 } {
  if (killRate >= killFloor) return { status: "pass", wouldFail: false, exitCode: 0 };
  return blocking
    ? { status: "fail", wouldFail: true, exitCode: 2 }
    : { status: "warn", wouldFail: true, exitCode: 0 };
}

/**
 * List the suite's top-level test files exactly as `npm test`'s
 * `test/*.test.mts` glob does (repo-relative, sorted).
 */
function listTestFiles(projectDir: string): string[] {
  return readdirSync(join(projectDir, "test"))
    .filter((f) => f.endsWith(".test.mts"))
    .sort()
    .map((f) => `test/${f}`);
}

const DEFAULT_KILL_FLOOR = 30;
const DEFAULT_TEST_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_RELATED_TESTS = 8;
const DEFAULT_T3_KILL_FLOOR = 55;
const DEFAULT_TIME_BUDGET_MS = 540_000;

/**
 * Select the mutation kill-rate floor for a PR from its Modification Tier
 * (issue #778 — T3 depth-gate protection).
 *
 * Rule: tier>=3 (T3 core src/, and T4 which inherits T3's verification
 * depth) must clear the raised `t3Floor`; T1/T2 retain the existing
 * `baseFloor`. The predicate is `tier>=3`, not `tier===3`, precisely so a
 * T4 / Verifier-Core diff never drops below the T3 bar.
 *
 * Pure and deterministic from the tier integer — no per-path hardcoding
 * (AC#3). The tier is sourced upstream from classifyChange() (the single
 * tier authority); this helper only maps tier -> floor. A non-finite or
 * out-of-range tier (e.g. a missing/garbled PR_TIER env) is treated
 * conservatively as the T3 band so a classification failure never
 * silently relaxes the floor.
 */
export function selectKillFloor(
  tier: number,
  baseFloor: number,
  t3Floor: number,
): number {
  if (!Number.isFinite(tier)) return t3Floor;
  return tier >= 3 ? t3Floor : baseFloor;
}

/**
 * Result of the no-signal classification (issue #1120).
 *
 * `status` is the gate status to emit for the no-signal case:
 *   - `"warn"`    — tier>=3: the gate produced NO fault-detection signal on a
 *                   deep diff. Non-blocking (exit 0) but distinctly NOT a pass:
 *                   it never fabricates `killRate=100`, and `killRate` is null.
 *   - `"neutral"` — T1/T2: same no-signal case, preserved as the historical
 *                   non-blocking neutral skip.
 * `reason` distinguishes the two no-signal sub-cases.
 * `killRate` is always `null` here — the no-signal branch must NOT synthesise a
 * 100% kill rate (the root cause of the silent merge-gate bypass).
 */
export type NoSignalClassification = {
  status: "warn" | "neutral";
  reason: string;
  killRate: null;
};

/**
 * Classify a mutation report that produced no testable signal (issue #1120).
 *
 * "No testable signal" means `testable === totalMutants - skipped === 0`: every
 * generated mutant was skipped (uncompilable), or no mutants were generated at
 * all. The pre-#1120 gate collapsed this into a synthetic `killRate = 100` →
 * `status:pass`, silently rubber-stamping a T3/T4 diff with zero
 * fault-detection. This helper is the pure, unit-testable seam that derives the
 * correct no-signal status instead.
 *
 * Returns `null` when there IS testable signal (`testable > 0`) — the caller
 * then runs the normal kill-rate comparison. Only the `testable === 0` case
 * yields a classification.
 *
 * Tier policy:
 *   - tier>=3 → `status:"warn"` (deep diff, no signal is a real gap to surface).
 *   - T1/T2   → `status:"neutral"` (historical non-blocking behaviour preserved).
 * Both are non-blocking (the caller keeps exit 0); the distinction is purely
 * what surfaces in the CI step-summary JSON.
 *
 * DELIBERATELY gate-local (issue #4346): unlike the input-parse helpers and
 * classifyTimedOut (shared via src/mutation-gate-inputs.ts), classifyNoSignal
 * stays separate in each gate — this gate's tier ladder (T1/T2 neutral) is a
 * genuine policy divergence from the Target gate's tier-less money-critical
 * boolean (always warn), not drift to be deduplicated.
 *
 * Sub-case reasons:
 *   - `candidatesGenerated === 0` → "no mutants generated" (comment-only /
 *     trivial diff — the generator emitted nothing).
 *   - otherwise (`totalMutants > 0 && skipped === totalMutants`) → "all
 *     generated mutants were skipped" (every candidate was uncompilable).
 *
 * Pure — no env, no IO. Test it by passing in arbitrary reports + tiers.
 */
export function classifyNoSignal(
  report: MutationTestReport,
  tier: number,
): NoSignalClassification | null {
  // Issue #4504: "testable" means CONCLUSIVE (killed + survived) — a run whose
  // mutants were all no-coverage or inconclusive has no signal either.
  const testable = conclusiveMutants(report);
  if (testable > 0) return null;

  const status: "warn" | "neutral" =
    !Number.isFinite(tier) || tier >= 3 ? "warn" : "neutral";

  const reason =
    report.candidatesGenerated === 0
      ? "no mutants generated (diff is comment-only or trivial) — no fault-detection signal"
      : report.skipped === report.totalMutants
        ? "all generated mutants were skipped (uncompilable) — no fault-detection signal"
        : `no conclusive mutants (${report.noCoverage} no-coverage, ` +
          `${report.inconclusive} inconclusive, ${report.skipped} skipped) — no fault-detection signal`;

  return { status, reason, killRate: null };
}

async function main(): Promise<number> {
  const prBody = process.env.PR_BODY ?? "";
  const changed = readChangedFiles();

  if (changed.length === 0) {
    process.stdout.write(
      JSON.stringify({ status: "skipped", reason: "no changed files" }) + "\n",
    );
    process.stderr.write("mutation-gate: skipped — no changed files in diff\n");
    return 0;
  }

  if (isQuickFix(prBody)) {
    process.stdout.write(
      JSON.stringify({
        status: "neutral",
        reason: "[quick-fix] PR — mutation gate skipped",
        changed: changed.length,
      }) + "\n",
    );
    process.stderr.write("Mutation gate: [quick-fix] tag detected — gate skipped.\n");
    return 0;
  }

  // Issue #653: positive allowlist — only mutate src/**/*.ts files actually
  // changed in this diff. Asset-only PRs (PNGs, JSON fixtures), doc-only PRs
  // (.md / docs/**), and dashboard-only PRs (dashboard/**) collapse to an
  // empty list and skip cleanly with a clear log line.
  const inspectable = filterMutationCandidates(changed);
  if (inspectable.length === 0) {
    process.stdout.write(
      JSON.stringify({
        status: "skipped",
        reason: "no src/**/*.ts files changed",
        changed: changed.length,
        inspectable: 0,
      }) + "\n",
    );
    process.stderr.write(
      `mutation-gate: skipped — no src/**/*.ts files changed (${changed.length} non-src path(s) in diff)\n`,
    );
    return 0;
  }

  // Issue #778: the floor is tier-dependent. T1/T2 keep the base floor;
  // T3/T4 must clear the raised T3 floor. The tier is computed upstream by
  // the workflow (scripts/tier-classify.ts → classifyChange) and passed in
  // as PR_TIER — CI orchestration owns floor policy; the tier classifier
  // stays a pure path->tier mapper and src/mutation.ts stays
  // threshold-agnostic.
  const baseFloor = parseIntEnv("MUTATION_KILL_RATE_FLOOR", DEFAULT_KILL_FLOOR);
  const t3Floor = parseIntEnv("MUTATION_KILL_RATE_FLOOR_T3", DEFAULT_T3_KILL_FLOOR);
  const tier = parseIntEnv("PR_TIER", 3); // missing/garbled tier → conservative T3 band
  const killFloor = selectKillFloor(tier, baseFloor, t3Floor);
  const timeBudgetMs = parseIntEnv("MUTATION_TIME_BUDGET_MS", DEFAULT_TIME_BUDGET_MS);
  const maxMutantsRaw = process.env.MUTATION_MAX_MUTANTS;
  const maxMutants = maxMutantsRaw ? parseInt(maxMutantsRaw, 10) : undefined;
  const testTimeoutMs = parseIntEnv("MUTATION_TEST_TIMEOUT_MS", DEFAULT_TEST_TIMEOUT_MS);
  const maxRelatedTests = parseIntEnv("MUTATION_MAX_RELATED_TESTS", DEFAULT_MAX_RELATED_TESTS);
  const blocking = isGateBlocking(process.env.MUTATION_GATE_BLOCKING);

  process.stderr.write(
    `Mutation gate: ${inspectable.length} inspectable file(s), tier=${tier}, ` +
    `floor=${killFloor}% (base=${baseFloor}/T3=${t3Floor}), budget=${timeBudgetMs}ms, ` +
    `per-mutant timeout=${testTimeoutMs}ms, blocking=${blocking}\n`,
  );

  const projectDir = process.cwd();

  // Issue #4504: per mutated file, run only its related test files — never the
  // full suite under a per-mutant timeout it can never finish inside.
  const testFiles = listTestFiles(projectDir);
  const graph = buildImportGraph(testFiles, (p) => {
    try {
      return readFileSync(join(projectDir, p), "utf-8");
    } catch { /* intentional: unresolvable specifier (package subpath, deleted file) — not a graph node */
      return null;
    }
  });
  const relatedTests: Record<string, string[]> = {};
  for (const file of inspectable) {
    relatedTests[file] = selectRelatedTests(file, testFiles, graph, maxRelatedTests);
    process.stderr.write(
      `Mutation gate: ${file} → ${relatedTests[file].length} related test file(s)` +
      (relatedTests[file].length > 0 ? `: ${relatedTests[file].join(", ")}` : " (no-coverage)") +
      "\n",
    );
  }

  const report = await runMutationTests(projectDir, inspectable, {
    timeBudgetMs,
    maxMutants,
    testTimeoutMs,
    timeoutIsInconclusive: true,
    verifyBaseline: true,
    // The runner hands back the absolute mutated path; key by repo-relative.
    testCommandForFile: (abs) =>
      buildRelatedTestCommand(relatedTests[relative(projectDir, abs)] ?? []),
  });

  const testable = conclusiveMutants(report);

  // No-signal case (issue #1120): the diff produced ZERO testable mutants — the
  // gate cannot conclude. The pre-#1120 code fabricated `killRate = 100` here,
  // which let a T3/T4 diff clear the raised kill-floor with no fault-detection
  // signal at all (a silent merge-gate bypass). Instead, classify via the pure
  // `classifyNoSignal` seam: tier>=3 emits `warn` (distinctly NOT a pass, and
  // NO synthetic killRate), T1/T2 stays `neutral`. Both are non-blocking
  // (exit 0) — the `warn` surfaces the gap in the CI step-summary JSON without
  // hard-blocking. Only a below-floor kill rate (below) blocks merge.
  const noSignal = classifyNoSignal(report, tier);
  if (noSignal) {
    process.stdout.write(
      JSON.stringify({
        status: noSignal.status,
        reason: noSignal.reason,
        killRate: noSignal.killRate,
        tier,
        candidatesGenerated: report.candidatesGenerated,
        totalMutants: report.totalMutants,
        skipped: report.skipped,
        inconclusive: report.inconclusive,
        noCoverage: report.noCoverage,
        inspectable: inspectable.length,
        relatedTests,
      }) + "\n",
    );
    process.stderr.write(
      `Mutation gate: ${noSignal.reason} — status=${noSignal.status} (tier=${tier}, non-blocking).\n`,
    );
    return 0;
  }

  // Timed-out case (issue #2393, porting the Target gate's #1821 seam): the
  // runner exhausted its time budget before evaluating every mutant on a large
  // file. The pre-#2393 gate captured `report.timedOut` into the summary JSON
  // (below) but NEVER branched on it — it computed `killRate` over only the
  // EVALUATED sample and emitted `pass` if that partial rate cleared the floor,
  // silently rubber-stamping a diff whose surviving mutants land in the
  // unevaluated tail (the silent partial-coverage verdict this issue names).
  // Classify via the pure `classifyTimedOut` seam: it emits a DISTINCT `warn`
  // (NOT a pass, NOT compared against the floor) carrying the partial kill rate
  // for context only. Checked AFTER the no-signal branch and BEFORE the
  // kill-rate comparison, matching the Target sibling's
  // classifyNoSignal -> classifyTimedOut -> kill-rate precedence. The check is
  // tier-independent: a budget-exhausted run has reached no verdict regardless
  // of tier. The warn is non-blocking (exit 0) — a tooling wall-clock limit
  // must not hard-block an otherwise-good diff, but it must stop masquerading
  // as a pass.
  const timedOut = classifyTimedOut(report);
  if (timedOut) {
    process.stdout.write(
      JSON.stringify({
        status: timedOut.status,
        reason: timedOut.reason,
        timedOut: true,
        killRate: timedOut.killRate,
        killFloor,
        tier,
        killed: report.killed,
        survived: report.survived,
        testable,
        inconclusive: report.inconclusive,
        noCoverage: report.noCoverage,
        totalMutants: report.totalMutants,
        skipped: report.skipped,
        candidatesGenerated: report.candidatesGenerated,
        durationMs: report.durationMs,
        inspectable: inspectable.length,
        relatedTests,
      }) + "\n",
    );
    process.stderr.write(
      `Mutation gate: ${timedOut.reason} — status=${timedOut.status} (tier=${tier}, non-blocking).\n`,
    );
    return 0;
  }

  // Issue #4504: the rate is over CONCLUSIVE mutants only (testable above).
  const killRate = Math.round((report.killed / testable) * 100);
  const verdict = resolveKillRateVerdict(killRate, killFloor, blocking);

  const summary = {
    status: verdict.status,
    wouldFail: verdict.wouldFail,
    blocking,
    killRate,
    killFloor,
    tier,
    killed: report.killed,
    survived: report.survived,
    testable,
    inconclusive: report.inconclusive,
    noCoverage: report.noCoverage,
    totalMutants: report.totalMutants,
    skipped: report.skipped,
    candidatesGenerated: report.candidatesGenerated,
    timedOut: report.timedOut,
    durationMs: report.durationMs,
    relatedTests,
    survivors: report.survivors.slice(0, 10).map((s) => ({
      file: relative(projectDir, s.mutation.file),
      line: s.mutation.line,
      type: s.mutation.type,
    })),
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");

  if (verdict.wouldFail) {
    process.stderr.write(
      `MUTATION GATE ${blocking ? "FAILED" : "BELOW FLOOR (non-blocking warn)"}: ` +
      `kill rate ${killRate}% < ${killFloor}% floor ` +
      `(${report.killed} killed / ${report.survived} survived / ${testable} conclusive; ` +
      `${report.inconclusive} inconclusive, ${report.noCoverage} no-coverage).\n` +
      `Tests do not cover the changed behavior. Top survivors:\n`,
    );
    for (const s of report.survivors.slice(0, 5)) {
      process.stderr.write(
        `  - ${relative(projectDir, s.mutation.file)}:${s.mutation.line} [${s.mutation.type}]\n`,
      );
    }
    return verdict.exitCode;
  }

  process.stderr.write(
    `Mutation gate passed: ${killRate}% kill rate (${report.killed}/${testable} conclusive; ` +
    `${report.inconclusive} inconclusive, ${report.noCoverage} no-coverage).\n`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code)).catch((err) => {
    process.stderr.write(`Unexpected error: ${err?.message ?? err}\n${err?.stack ?? ""}\n`);
    process.exit(1);
  });
}

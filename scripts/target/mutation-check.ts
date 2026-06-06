#!/usr/bin/env -S npx tsx
/**
 * scripts/target/mutation-check.ts — Money-critical mutation gate for the
 * Target (hydra-betting) repo (issue #1057, parent epic #1052 — "Selectively
 * converge the Target SDLC with the Orchestrator's build-quality machinery").
 *
 * The Orchestrator already runs a diff-scoped mutation gate over its own
 * src tree (the sibling CI gate, NOT touched here). This is the Target
 * analogue, but with two deliberate differences that the epic calls out:
 *
 *   1. **Diff-scoped to money-critical paths only.** Instead of mutating the
 *      whole changed source set, this gate mutates ONLY the changed files that
 *      `classifyTargetRisk()` (src/target/money-critical.ts) flags as
 *      money-critical — provider integrations, execution, staking, bet-math.
 *      A green-but-empty test suite over those paths costs real money; a
 *      green-but-empty suite over UI/docs/config does not. Safe-path PRs skip
 *      mutation ENTIRELY so the single hydra-server-betting runner stays fast.
 *
 *   2. **A single kill-floor — explicitly NOT a tier ladder.** The Target risk
 *      model is a two-level boolean (money-critical vs. safe), mirroring
 *      money-critical.ts's "explicitly NOT a tier ladder" note. There is one
 *      floor; either the changed money-critical files clear it or the build
 *      fails. There is no T1/T2/T3 band selection here.
 *
 * Reuses the pure runner `runMutationTests()` from src/mutation.ts — only the
 * money-critical filtering and the single-floor orchestration are written here.
 * The runner itself stays threshold-agnostic and repo-agnostic.
 *
 * Inputs (env):
 *   CHANGED_FILES                 — newline-separated list of files in the PR
 *                                   diff, repo-relative to the Target repo
 *                                   (computed upstream by the workflow as
 *                                   `git diff --name-only $(git merge-base
 *                                   origin/main HEAD)...HEAD`).
 *   TARGET_MUTATION_KILL_FLOOR    — single kill-rate floor as integer percent
 *                                   for changed money-critical files
 *                                   (default 60 — money handling warrants a
 *                                   higher bar than the Orchestrator base 30).
 *   TARGET_PROJECT_DIR            — absolute path to the Target repo checkout
 *                                   to mutate (default: cwd). The runner reuses
 *                                   it to read source + run the test command.
 *   MUTATION_TIME_BUDGET_MS       — overall time budget (default 540_000 = 9m,
 *                                   leaving 60s buffer under a 10m CI timeout).
 *   MUTATION_MAX_MUTANTS          — optional cap on candidate mutants.
 *   PR_BODY                       — PR body; a "[quick-fix]" tag writes a
 *                                   neutral status and exits 0 (mirrors the
 *                                   Orchestrator gate's quick-fix exemption).
 *
 * Quick-fix bypass: if PR_BODY contains "[quick-fix]" the gate writes a
 * "neutral" status and exits 0.
 *
 * Exit codes:
 *   0 — pass (or skipped / neutral)
 *   2 — mutation gate failed (block merge)
 *   1 — usage / unexpected error
 */

import { runMutationTests, shouldSkipMutation } from "../../src/mutation.ts";
import { classifyTargetRisk } from "../../src/target/money-critical.ts";

const DEFAULT_TARGET_KILL_FLOOR = 60;
const DEFAULT_TIME_BUDGET_MS = 540_000;

/**
 * Filter a list of changed Target paths down to the files this gate should
 * actually mutate (issue #1057).
 *
 * The contract is: keep only files that `classifyTargetRisk()` flags as
 * money-critical, then drop anything `shouldSkipMutation()` excludes (co-located
 * tests, `.d.ts`, etc.) so a money-critical test file or declaration never
 * becomes a mutation target. Order and de-duplication follow `classifyTargetRisk`'s
 * matched-path contract (input order, de-duplicated).
 *
 * Pure — no filesystem, no git, no env. Test it by passing arbitrary string
 * lists. Mirrors `filterMutationCandidates` in the Orchestrator gate but routes
 * on the money-critical classifier instead of a `src/**\/*.ts` allowlist.
 */
export function filterMoneyCriticalCandidates(changedFiles: string[]): string[] {
  const trimmed = changedFiles
    .map((f) => (typeof f === "string" ? f.trim() : ""))
    .filter((f) => f.length > 0);
  const { matchedPaths } = classifyTargetRisk(trimmed);
  return matchedPaths.filter((f) => !shouldSkipMutation(f));
}

function readChangedFiles(): string[] {
  const env = process.env.CHANGED_FILES ?? "";
  return env
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function isQuickFix(body: string): boolean {
  return /\[quick-fix\]/i.test(body || "");
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

async function main(): Promise<number> {
  const prBody = process.env.PR_BODY ?? "";
  const changed = readChangedFiles();

  if (changed.length === 0) {
    process.stdout.write(
      JSON.stringify({ status: "skipped", reason: "no changed files" }) + "\n",
    );
    process.stderr.write("target-mutation-gate: skipped — no changed files in diff\n");
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
    process.stderr.write("target-mutation-gate: [quick-fix] tag detected — gate skipped.\n");
    return 0;
  }

  // Issue #1057: diff-scope to money-critical paths only. A PR that touches no
  // money-critical surface (UI / docs / config — the "safe" half of the Target
  // risk boolean) collapses to an empty list and SKIPS mutation entirely. This
  // keeps the single hydra-server-betting runner fast for the common safe-path
  // change instead of paying the ~9-minute mutation cost on every PR.
  const inspectable = filterMoneyCriticalCandidates(changed);
  if (inspectable.length === 0) {
    process.stdout.write(
      JSON.stringify({
        status: "skipped",
        reason: "no money-critical files changed",
        changed: changed.length,
        inspectable: 0,
      }) + "\n",
    );
    process.stderr.write(
      `target-mutation-gate: skipped — no money-critical files changed ` +
      `(${changed.length} safe-path file(s) in diff)\n`,
    );
    return 0;
  }

  // Issue #1057: a single floor — explicitly NOT a tier ladder. Either the
  // changed money-critical files clear this bar or the build fails. The default
  // is higher than the Orchestrator base floor because every file we reach here
  // handles real money.
  const killFloor = parseIntEnv("TARGET_MUTATION_KILL_FLOOR", DEFAULT_TARGET_KILL_FLOOR);
  const timeBudgetMs = parseIntEnv("MUTATION_TIME_BUDGET_MS", DEFAULT_TIME_BUDGET_MS);
  const maxMutantsRaw = process.env.MUTATION_MAX_MUTANTS;
  const maxMutants = maxMutantsRaw ? parseInt(maxMutantsRaw, 10) : undefined;
  const projectDir = process.env.TARGET_PROJECT_DIR || process.cwd();

  process.stderr.write(
    `target-mutation-gate: ${inspectable.length} money-critical file(s), ` +
    `floor=${killFloor}%, budget=${timeBudgetMs}ms, projectDir=${projectDir}\n`,
  );

  const report = await runMutationTests(projectDir, inspectable, {
    timeBudgetMs,
    testCommand: "npm test",
    maxMutants,
  });

  const testable = report.totalMutants - report.skipped;
  const killRate = testable > 0
    ? Math.round((report.killed / testable) * 100)
    : 100;

  // No-signal case: gate cannot conclude — treat as pass with note. Matches the
  // Orchestrator gate: only a kill-rate BELOW the floor blocks merge; an
  // inability to generate testable mutants does not.
  if (testable === 0) {
    const reason = report.candidatesGenerated === 0
      ? "no mutants generated (diff is comment-only or trivial)"
      : "all generated mutants were uncompilable";
    process.stdout.write(
      JSON.stringify({
        status: "neutral",
        reason,
        candidatesGenerated: report.candidatesGenerated,
        inspectable: inspectable.length,
      }) + "\n",
    );
    process.stderr.write(`target-mutation-gate: ${reason} — gate passes by default.\n`);
    return 0;
  }

  const summary = {
    status: killRate < killFloor ? "fail" : "pass",
    killRate,
    killFloor,
    killed: report.killed,
    survived: report.survived,
    testable,
    totalMutants: report.totalMutants,
    skipped: report.skipped,
    candidatesGenerated: report.candidatesGenerated,
    timedOut: report.timedOut,
    durationMs: report.durationMs,
    moneyCriticalFiles: inspectable,
    survivors: report.survivors.slice(0, 10).map((s) => ({
      file: s.mutation.file,
      line: s.mutation.line,
      type: s.mutation.type,
    })),
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");

  if (killRate < killFloor) {
    process.stderr.write(
      `TARGET MUTATION GATE FAILED: kill rate ${killRate}% < ${killFloor}% floor ` +
      `(${report.killed} killed / ${report.survived} survived / ${testable} testable) ` +
      `on money-critical paths.\n` +
      `Tests do not cover the changed money-handling behavior. Top survivors:\n`,
    );
    for (const s of report.survivors.slice(0, 5)) {
      process.stderr.write(`  - ${s.mutation.file}:${s.mutation.line} [${s.mutation.type}]\n`);
    }
    return 2;
  }

  process.stderr.write(
    `target-mutation-gate passed: ${killRate}% kill rate (${report.killed}/${testable}) ` +
    `on money-critical paths.\n`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code)).catch((err) => {
    process.stderr.write(`Unexpected error: ${err?.message ?? err}\n${err?.stack ?? ""}\n`);
    process.exit(1);
  });
}

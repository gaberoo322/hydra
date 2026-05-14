#!/usr/bin/env -S npx tsx
/**
 * scripts/ci/mutation-check.ts — Mutation testing CI gate (issue #382).
 *
 * Re-homes the in-cycle mutation gate (was step 6.7 of the codex control
 * loop, runMutationGate() in src/mutation.ts) so PRs from any source get
 * the same kill-rate gate after the codex CLI is removed (PR-3).
 *
 * Reuses the existing pure runner `runMutationTests()` from src/mutation.ts
 * — only the orchestration around it is rewritten here for a CI context
 * (no CycleContext, no OV session, no Redis).
 *
 * Inputs (env):
 *   CHANGED_FILES               — newline-separated list of files in the diff
 *   MUTATION_KILL_RATE_FLOOR    — kill-rate floor as integer percent (default 30)
 *   MUTATION_TIME_BUDGET_MS     — overall time budget (default 540_000 = 9m,
 *                                 leaves 60s buffer under the 10m CI step timeout)
 *   MUTATION_MAX_MUTANTS        — optional cap on candidate mutants
 *
 * Quick-fix bypass: if the PR body contains "[quick-fix]" (via PR_BODY env)
 * the gate writes a "neutral" status and exits 0. Mirrors the in-cycle
 * quick-fix exemption.
 *
 * Exit codes:
 *   0 — pass (or neutral skip)
 *   2 — mutation gate failed (block merge)
 *   1 — usage / unexpected error
 */

import { runMutationTests, shouldSkipMutation } from "../../src/mutation.ts";

const DEFAULT_KILL_FLOOR = 30;
const DEFAULT_TIME_BUDGET_MS = 540_000;

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
    process.stdout.write(JSON.stringify({ status: "pass", reason: "no changed files" }) + "\n");
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

  const inspectable = changed.filter((f) => !shouldSkipMutation(f));
  if (inspectable.length === 0) {
    // Issue #402: surface a clear "no inspectable source files" reason so the
    // CI status check explains why the gate passed (docs-only / config-only /
    // tests-only diff). All filtered paths come from SKIP_PATTERNS (tests,
    // configs, migrations, .md, docs/, config/).
    process.stdout.write(
      JSON.stringify({
        status: "pass",
        reason: "no inspectable source files",
        changed: changed.length,
        inspectable: 0,
      }) + "\n",
    );
    process.stderr.write(
      `Mutation gate: no inspectable source files in ${changed.length} changed path(s) — gate passes.\n`,
    );
    return 0;
  }

  const killFloor = parseIntEnv("MUTATION_KILL_RATE_FLOOR", DEFAULT_KILL_FLOOR);
  const timeBudgetMs = parseIntEnv("MUTATION_TIME_BUDGET_MS", DEFAULT_TIME_BUDGET_MS);
  const maxMutantsRaw = process.env.MUTATION_MAX_MUTANTS;
  const maxMutants = maxMutantsRaw ? parseInt(maxMutantsRaw, 10) : undefined;

  process.stderr.write(
    `Mutation gate: ${inspectable.length} inspectable file(s), floor=${killFloor}%, budget=${timeBudgetMs}ms\n`,
  );

  const projectDir = process.cwd();
  const report = await runMutationTests(projectDir, inspectable, {
    timeBudgetMs,
    testCommand: "npm test",
    maxMutants,
  });

  const testable = report.totalMutants - report.skipped;
  const killRate = testable > 0
    ? Math.round((report.killed / testable) * 100)
    : 100;

  // No-signal case: gate cannot conclude — treat as pass with note. Matches
  // the in-cycle gate's behaviour (classifyNoSignalDecision returns a decision
  // that does NOT block merge — only kill-rate below floor blocks).
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
    process.stderr.write(`Mutation gate: ${reason} — gate passes by default.\n`);
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
    survivors: report.survivors.slice(0, 10).map((s) => ({
      file: s.mutation.file,
      line: s.mutation.line,
      type: s.mutation.type,
    })),
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");

  if (killRate < killFloor) {
    process.stderr.write(
      `MUTATION GATE FAILED: kill rate ${killRate}% < ${killFloor}% floor ` +
      `(${report.killed} killed / ${report.survived} survived / ${testable} testable).\n` +
      `Tests do not cover the changed behavior. Top survivors:\n`,
    );
    for (const s of report.survivors.slice(0, 5)) {
      process.stderr.write(`  - ${s.mutation.file}:${s.mutation.line} [${s.mutation.type}]\n`);
    }
    return 2;
  }

  process.stderr.write(
    `Mutation gate passed: ${killRate}% kill rate (${report.killed}/${testable}).\n`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code)).catch((err) => {
    process.stderr.write(`Unexpected error: ${err?.message ?? err}\n${err?.stack ?? ""}\n`);
    process.exit(1);
  });
}

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
 *   CHANGED_FILES               — newline-separated list of files in the diff
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
 * Exit codes:
 *   0 — pass, neutral/warn skip, no-signal, or timed-out warn (non-blocking)
 *   2 — mutation gate failed: kill rate below floor (block merge)
 *   1 — usage / unexpected error
 */

import {
  runMutationTests,
  shouldSkipMutation,
  type MutationTestReport,
} from "../../src/mutation.ts";

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

const DEFAULT_KILL_FLOOR = 30;
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
  const testable = report.totalMutants - report.skipped;
  if (testable > 0) return null;

  const status: "warn" | "neutral" =
    !Number.isFinite(tier) || tier >= 3 ? "warn" : "neutral";

  const reason =
    report.candidatesGenerated === 0
      ? "no mutants generated (diff is comment-only or trivial) — no fault-detection signal"
      : "all generated mutants were skipped (uncompilable) — no fault-detection signal";

  return { status, reason, killRate: null };
}

/**
 * Result of the timed-out classification (issue #2393, porting the Target
 * gate's #1821 seam verbatim).
 *
 * `status` is always `"warn"` — a gate that exhausted its time budget reached
 * NO verdict, so it must not present as a clean `pass`. `killRate` carries the
 * partial kill rate computed from whatever mutants finished before the budget
 * ran out (informational only, NEVER compared against the floor) so the
 * step-summary still shows progress; it is explicitly NOT a pass/fail signal.
 * `warn` is non-blocking (the caller keeps exit 0) — a slow gate must not
 * hard-block an otherwise-good diff, but it must stop masquerading as a pass
 * (the silent partial-coverage verdict this issue names).
 *
 * Tier-independent: unlike `classifyNoSignal` (which emits `neutral` on T1/T2),
 * a budget-exhausted run has reached no verdict regardless of tier, so the
 * outcome is ALWAYS `warn`. There is no `neutral`/T1-T2 sub-case — a partial
 * sample is never a pass on any tier.
 */
export type TimedOutClassification = {
  status: "warn";
  reason: string;
  timedOut: true;
  killRate: number | null;
};

/**
 * Classify a mutation report whose runner exhausted its time budget (issue
 * #2393).
 *
 * The pre-#2393 gate computed `killRate` from whatever mutants finished before
 * the 540s budget and emitted `pass`/`fail` from that partial sample, so a
 * timed-out run looked identical to a complete one — a pure-enrichment diff to
 * a large (e.g. 553-mutant) file could survive because surviving mutants land
 * in the untouched (unevaluated) tail. This helper is the pure, unit-testable
 * seam that turns a timed-out report into a DISTINCT non-pass `warn` outcome
 * with an explicit reason, instead of a partial-sample verdict.
 *
 * Returns `null` when the runner did NOT time out (`report.timedOut === false`)
 * — the caller then runs the normal kill-rate comparison. Only `timedOut`
 * yields a classification.
 *
 * The partial kill rate is surfaced for context (how far the gate got before
 * the budget ran out) but is informational: a timed-out gate has, by
 * definition, not evaluated the full mutant set, so a partial rate above the
 * floor is not proof the diff clears it. `killRate` is `null` when no mutant
 * produced testable signal before the timeout.
 *
 * Pure — no env, no IO, no git. Test it by passing arbitrary reports.
 */
export function classifyTimedOut(
  report: MutationTestReport,
): TimedOutClassification | null {
  if (!report.timedOut) return null;

  const testable = report.totalMutants - report.skipped;
  const partialKillRate =
    testable > 0 ? Math.round((report.killed / testable) * 100) : null;

  const reason =
    `mutation gate timed out before evaluating all mutants ` +
    `(${report.totalMutants} of ${report.candidatesGenerated} candidate mutant(s) run; ` +
    `partial kill rate ` +
    (partialKillRate === null ? "n/a" : `${partialKillRate}%`) +
    `) — no complete verdict, treat as inconclusive (non-blocking)`;

  return { status: "warn", reason, timedOut: true, killRate: partialKillRate };
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

  process.stderr.write(
    `Mutation gate: ${inspectable.length} inspectable file(s), tier=${tier}, ` +
    `floor=${killFloor}% (base=${baseFloor}/T3=${t3Floor}), budget=${timeBudgetMs}ms\n`,
  );

  const projectDir = process.cwd();
  const report = await runMutationTests(projectDir, inspectable, {
    timeBudgetMs,
    testCommand: "npm test",
    maxMutants,
  });

  const testable = report.totalMutants - report.skipped;

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
        inspectable: inspectable.length,
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
        totalMutants: report.totalMutants,
        skipped: report.skipped,
        candidatesGenerated: report.candidatesGenerated,
        durationMs: report.durationMs,
        inspectable: inspectable.length,
      }) + "\n",
    );
    process.stderr.write(
      `Mutation gate: ${timedOut.reason} — status=${timedOut.status} (tier=${tier}, non-blocking).\n`,
    );
    return 0;
  }

  const killRate = Math.round((report.killed / testable) * 100);

  const summary = {
    status: killRate < killFloor ? "fail" : "pass",
    killRate,
    killFloor,
    tier,
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

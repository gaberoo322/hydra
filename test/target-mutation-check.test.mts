/**
 * Regression tests for the Target money-critical mutation-gate diff scoping
 * (issue #1057, parent epic #1052).
 *
 * The Target gate mutates ONLY the changed files that `classifyTargetRisk()`
 * flags as money-critical (provider integrations, execution, staking,
 * bet-math). Safe-path PRs — UI, docs, config — collapse to an empty
 * candidate list and skip the mutation runner entirely, keeping the single
 * hydra-server-betting runner fast.
 *
 * These tests exercise the pure `filterMoneyCriticalCandidates` helper in
 * `scripts/target/mutation-check.ts`. They do NOT touch git, the filesystem,
 * or the mutation runner — that contract is what makes the filter
 * unit-testable, mirroring the Orchestrator mutation-check tests.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  filterMoneyCriticalCandidates as filterRaw,
  classifyNoSignal,
  buildScopedTestCommand,
  classifyTimedOut,
} from "../scripts/target/mutation-check.ts";
import { runMutationTests, type MutationTestReport } from "../src/mutation.ts";
import {
  BETTING_RISK_SURFACE,
  BETTING_APP_SUBDIR,
} from "./_helpers/betting-risk-surface.mts";

// Issue #3018: filterMoneyCriticalCandidates now takes the manifest-sourced
// risk surface as arguments. The tests pass the betting fixture explicitly so
// they stay hermetic. This wrapper preserves the existing (changedFiles) call
// shape across all cases below.
const filterMoneyCriticalCandidates = (changedFiles: string[]) =>
  filterRaw(changedFiles, BETTING_RISK_SURFACE, BETTING_APP_SUBDIR);

/**
 * Build a MutationTestReport for the no-signal tests. Only the fields
 * `classifyNoSignal` reads (totalMutants / skipped / killed / candidatesGenerated)
 * are meaningful; the rest are inert defaults so the seam stays pure and the
 * test never touches the runner.
 */
function makeReport(overrides: Partial<MutationTestReport>): MutationTestReport {
  return {
    totalMutants: 0,
    killed: 0,
    survived: 0,
    skipped: 0,
    timedOut: false,
    durationMs: 0,
    survivors: [],
    candidatesGenerated: 0,
    ...overrides,
  };
}

describe("filterMoneyCriticalCandidates — money-critical diff scoping (issue #1057)", () => {
  test("keeps money-critical files (providers / execution / staking / bet-math)", () => {
    const result = filterMoneyCriticalCandidates([
      "src/lib/providers/draftkings.ts",
      "src/lib/execution/place-bet.ts",
      "src/lib/staking/kelly.ts",
      "src/lib/bet-math/edge.ts",
    ]);
    assert.deepEqual(result, [
      "src/lib/providers/draftkings.ts",
      "src/lib/execution/place-bet.ts",
      "src/lib/staking/kelly.ts",
      "src/lib/bet-math/edge.ts",
    ]);
  });

  test("drops safe-path files (UI components, pages)", () => {
    const result = filterMoneyCriticalCandidates([
      "src/components/Button.tsx",
      "src/app/dashboard/page.tsx",
      "src/lib/ui/theme.ts",
    ]);
    assert.deepEqual(
      result,
      [],
      "UI/safe paths must NOT be mutated — they don't handle money",
    );
  });

  test("drops markdown / docs / config (safe-path PR)", () => {
    const result = filterMoneyCriticalCandidates([
      "README.md",
      "docs/architecture.md",
      "web/AGENTS.md",
      "package.json",
      ".github/workflows/ci.yml",
    ]);
    assert.deepEqual(result, []);
  });

  test("drops co-located test files even under a money-critical dir", () => {
    // shouldSkipMutation excludes co-located tests; money-critical scoping
    // must not undo that — a green-but-empty *test* file isn't a mutation
    // target.
    const result = filterMoneyCriticalCandidates([
      "src/lib/execution/place-bet.test.ts",
      "src/lib/staking/kelly.spec.ts",
    ]);
    assert.deepEqual(result, []);
  });

  test("drops .d.ts declaration files even under a money-critical dir", () => {
    const result = filterMoneyCriticalCandidates([
      "src/lib/providers/types.d.ts",
      "src/lib/bet-math/odds.d.ts",
    ]);
    assert.deepEqual(result, []);
  });

  test("mixed diff returns ONLY the money-critical (non-test) subset", () => {
    const result = filterMoneyCriticalCandidates([
      "src/lib/execution/order-router.ts",
      "src/lib/execution/order-router.test.ts",
      "src/components/Header.tsx",
      "docs/guide.md",
      "src/lib/bet-math/settlement.ts",
      "package-lock.json",
    ]);
    assert.deepEqual(result, [
      "src/lib/execution/order-router.ts",
      "src/lib/bet-math/settlement.ts",
    ]);
  });

  test("safe-path-only PR collapses to empty — gate skips mutation entirely", () => {
    // The core fast-path: a UI/docs/config PR never spins up the mutation
    // runner on the single hydra-server-betting runner.
    const result = filterMoneyCriticalCandidates([
      "src/components/BetSlip.tsx",
      "src/app/(marketing)/page.tsx",
      "docs/changelog.md",
      "tailwind.config.ts",
    ]);
    assert.deepEqual(
      result,
      [],
      "safe-path PRs must skip the Target mutation gate (issue #1057)",
    );
  });

  test("empty input → empty output", () => {
    assert.deepEqual(filterMoneyCriticalCandidates([]), []);
  });

  test("de-duplicates repeated money-critical paths (classifier contract)", () => {
    const result = filterMoneyCriticalCandidates([
      "src/lib/staking/kelly.ts",
      "src/lib/staking/kelly.ts",
      "src/lib/providers/fanduel.ts",
    ]);
    assert.deepEqual(result, [
      "src/lib/staking/kelly.ts",
      "src/lib/providers/fanduel.ts",
    ]);
  });

  test("trims whitespace and drops empty lines (env-var split artefacts)", () => {
    const result = filterMoneyCriticalCandidates([
      "  src/lib/providers/pinnacle.ts  ",
      "",
      "\t",
      "src/lib/bet-math/probability.ts",
    ]);
    assert.deepEqual(result, [
      "src/lib/providers/pinnacle.ts",
      "src/lib/bet-math/probability.ts",
    ]);
  });

  test("normalizes a leading ./ before matching (classifier contract)", () => {
    const result = filterMoneyCriticalCandidates([
      "./src/lib/execution/place-bet.ts",
      "./src/components/Footer.tsx",
    ]);
    assert.deepEqual(result, ["./src/lib/execution/place-bet.ts"]);
  });

  // --- issue #1649: web/-prefix strip so runMutationTests gets projectDir- ---
  // --- relative paths (hydra-betting roots its tree at web/).             ---
  test("strips a single leading web/ from money-critical paths (issue #1649)", () => {
    // The hydra-betting layout: real diff paths are web/-rooted. The classifier
    // matches them (its normalize() strips web/ for matching) but returns them
    // verbatim; this filter must strip web/ so runMutationTests doesn't double
    // the prefix into web/web/... → ENOENT → silent zero-mutant warn.
    const result = filterMoneyCriticalCandidates([
      "web/src/lib/providers/draftkings.ts",
      "web/src/lib/execution/place-bet.ts",
      "web/src/lib/staking/kelly.ts",
      "web/src/lib/bet-math/edge.ts",
    ]);
    assert.deepEqual(
      result,
      [
        "src/lib/providers/draftkings.ts",
        "src/lib/execution/place-bet.ts",
        "src/lib/staking/kelly.ts",
        "src/lib/bet-math/edge.ts",
      ],
      "web/-prefixed inputs must come out projectDir-relative (no web/ prefix)",
    );
  });

  test("web/-strip is idempotent — bare src/... inputs are unaffected (issue #1649)", () => {
    // Idempotency guard: feeding the ALREADY-stripped output back in must be a
    // fixed point. A bare src/... path has no web/ prefix to strip, so the
    // output equals the input — the exact property that keeps CI (which strips
    // upstream) and the default synced invocation in agreement.
    const stripped = [
      "src/lib/providers/draftkings.ts",
      "src/lib/execution/place-bet.ts",
    ];
    assert.deepEqual(
      filterMoneyCriticalCandidates(stripped),
      stripped,
      "bare src/... paths must pass through unchanged (idempotent strip)",
    );
    // And applying the filter twice (strip-of-a-strip) is a fixed point.
    const once = filterMoneyCriticalCandidates(["web/src/lib/staking/kelly.ts"]);
    assert.deepEqual(filterMoneyCriticalCandidates(once), once);
  });

  test("strips exactly one web/ — never recursive (issue #1649)", () => {
    // Defensive: a pathological web/web/... must lose exactly ONE prefix, not
    // collapse recursively. (No such path exists in the real tree, but the
    // non-global ^web/ regex must be provably single-shot.) web/web/src/... is
    // NOT money-critical after one strip (web/src/... isn't a money path), so
    // it correctly drops — the point is the regex never double-strips.
    const result = filterMoneyCriticalCandidates([
      "web/web/src/lib/providers/x.ts",
    ]);
    // web/web/src/lib/providers/x.ts → classifier normalize strips one web/ →
    // web/src/lib/providers/x.ts, which is NOT a money path → not matched.
    assert.deepEqual(result, []);
  });

  test("strips web/ behind a leading ./ (./web/src/...) (issue #1649)", () => {
    const result = filterMoneyCriticalCandidates([
      "./web/src/lib/bet-math/probability.ts",
    ]);
    assert.deepEqual(result, ["src/lib/bet-math/probability.ts"]);
  });
});

describe("classifyNoSignal — tier-less no-signal gate (issue #1132)", () => {
  test("no mutants generated → warn, null killRate, generator-empty reason", () => {
    // candidatesGenerated === 0: the generator emitted nothing (comment-only /
    // trivial money-critical diff). Must NOT fabricate killRate=100.
    const result = classifyNoSignal(
      makeReport({ totalMutants: 0, skipped: 0, candidatesGenerated: 0 }),
    );
    assert.ok(result, "testable === 0 must yield a classification, not null");
    assert.equal(result!.status, "warn");
    assert.equal(result!.killRate, null);
    assert.match(result!.reason, /no mutants generated/);
    assert.match(result!.reason, /no fault-detection signal/);
  });

  test("all generated mutants skipped → warn, null killRate, all-skipped reason", () => {
    // totalMutants > 0 && skipped === totalMutants: every candidate was
    // uncompilable, so testable === 0 with a non-empty generator.
    const result = classifyNoSignal(
      makeReport({ totalMutants: 5, skipped: 5, candidatesGenerated: 5 }),
    );
    assert.ok(result);
    assert.equal(result!.status, "warn");
    assert.equal(result!.killRate, null);
    assert.match(result!.reason, /all generated mutants were skipped/);
    assert.match(result!.reason, /no fault-detection signal/);
  });

  test("the two no-signal sub-cases produce DISTINCT reasons", () => {
    const noneGenerated = classifyNoSignal(
      makeReport({ totalMutants: 0, skipped: 0, candidatesGenerated: 0 }),
    );
    const allSkipped = classifyNoSignal(
      makeReport({ totalMutants: 3, skipped: 3, candidatesGenerated: 3 }),
    );
    assert.ok(noneGenerated && allSkipped);
    assert.notEqual(
      noneGenerated!.reason,
      allSkipped!.reason,
      "no-mutants-generated and all-skipped must be distinguishable in the JSON",
    );
  });

  test("testable > 0 → returns null (caller runs the normal kill-rate path)", () => {
    // 4 testable mutants (10 total - 6 skipped). The seam must hand control back
    // to main()'s kill-rate comparison rather than short-circuiting.
    const result = classifyNoSignal(
      makeReport({
        totalMutants: 10,
        skipped: 6,
        killed: 4,
        candidatesGenerated: 10,
      }),
    );
    assert.equal(result, null);
  });

  test("a single testable mutant is enough to leave the no-signal branch", () => {
    // Boundary: testable === 1 is signal, so no classification.
    const result = classifyNoSignal(
      makeReport({
        totalMutants: 1,
        skipped: 0,
        killed: 1,
        candidatesGenerated: 1,
      }),
    );
    assert.equal(result, null);
  });

  test("ALWAYS warns on no-signal — never neutral (no Target tier analogue)", () => {
    // The deliberate divergence from the Orchestrator helper: every file
    // reaching this branch is money-critical, so there is no neutral/T1-T2
    // sub-case. Both no-signal shapes must be warn.
    for (const report of [
      makeReport({ totalMutants: 0, skipped: 0, candidatesGenerated: 0 }),
      makeReport({ totalMutants: 7, skipped: 7, candidatesGenerated: 7 }),
    ]) {
      const result = classifyNoSignal(report);
      assert.ok(result);
      assert.equal(
        result!.status,
        "warn",
        "Target no-signal is always money-critical → warn, never neutral",
      );
    }
  });

  test("no-signal classification never synthesises a killRate (null only)", () => {
    // The root-cause invariant of #1120/#1132: the no-signal branch must not
    // fabricate killRate=100. killRate is typed `null` and must stay null.
    const result = classifyNoSignal(
      makeReport({ totalMutants: 2, skipped: 2, candidatesGenerated: 2 }),
    );
    assert.ok(result);
    assert.strictEqual(result!.killRate, null);
  });
});

describe("buildScopedTestCommand — focused per-mutant test command (issue #1821)", () => {
  test("scopes to the money-critical files via `vitest related --run`", () => {
    const cmd = buildScopedTestCommand([
      "src/lib/execution/place-bet.ts",
      "src/lib/staking/kelly.ts",
    ]);
    assert.equal(
      cmd,
      "npx vitest related --run --passWithNoTests src/lib/execution/place-bet.ts src/lib/staking/kelly.ts",
    );
  });

  test("single money-critical file → single-path scoped command", () => {
    const cmd = buildScopedTestCommand(["src/lib/bet-math/edge.ts"]);
    assert.equal(
      cmd,
      "npx vitest related --run --passWithNoTests src/lib/bet-math/edge.ts",
    );
  });

  test("is NOT the full `npm test` suite for a non-empty file list (the #1821 fix)", () => {
    // The whole point of #1821: a money-critical diff must NOT run the full
    // vitest suite per mutant.
    const cmd = buildScopedTestCommand(["src/lib/providers/draftkings.ts"]);
    assert.notEqual(cmd, "npm test");
    assert.match(cmd, /vitest related/);
  });

  test("uses --run so each mutant runs a single non-watch pass", () => {
    // Mutation runs must terminate — a watch-mode invocation would hang the
    // per-mutant child process.
    const cmd = buildScopedTestCommand(["src/lib/execution/order-router.ts"]);
    assert.match(cmd, /--run\b/);
  });

  test("uses --passWithNoTests so an uncovered file does not error the runner", () => {
    // A mutated file with no importing test must SURVIVE (the desired coverage
    // signal), not crash the runner child with a non-zero 'no test files' exit.
    const cmd = buildScopedTestCommand(["src/lib/staking/parlay.ts"]);
    assert.match(cmd, /--passWithNoTests\b/);
  });

  test("empty input → falls back to the full `npm test` suite", () => {
    // Defensive: the caller guards inspectable.length === 0 before the runner,
    // but a scoped command with no file args would run the whole suite anyway,
    // so the explicit fallback is clearer and preserves prior behaviour.
    assert.equal(buildScopedTestCommand([]), "npm test");
  });

  test("trims whitespace and drops empty entries before composing the command", () => {
    const cmd = buildScopedTestCommand([
      "  src/lib/providers/pinnacle.ts  ",
      "",
      "\t",
      "src/lib/bet-math/probability.ts",
    ]);
    assert.equal(
      cmd,
      "npx vitest related --run --passWithNoTests src/lib/providers/pinnacle.ts src/lib/bet-math/probability.ts",
    );
  });

  test("a list that trims to empty → npm test fallback (no dangling args)", () => {
    // All-whitespace input must not emit `vitest related` with zero file args
    // (which would silently run the whole suite) — it falls back to npm test.
    assert.equal(buildScopedTestCommand(["", "  ", "\t"]), "npm test");
  });

  test("composes the runner-expected argv shape (whitespace-split tokens)", () => {
    // runMutationTests splits testCommand on /\s+/ and feeds tokens to /bin/sh.
    // Each file path must be its own token so vitest receives them as separate
    // positional args.
    const cmd = buildScopedTestCommand([
      "src/lib/execution/place-bet.ts",
      "src/lib/bet-math/settlement.ts",
    ]);
    const tokens = cmd.split(/\s+/);
    assert.deepEqual(tokens, [
      "npx",
      "vitest",
      "related",
      "--run",
      "--passWithNoTests",
      "src/lib/execution/place-bet.ts",
      "src/lib/bet-math/settlement.ts",
    ]);
  });
});

describe("classifyTimedOut — timed-out gate is a distinct non-pass (issue #1821)", () => {
  test("timedOut === true → warn (never pass), with a timed-out reason", () => {
    const result = classifyTimedOut(
      makeReport({
        timedOut: true,
        totalMutants: 4,
        killed: 3,
        survived: 1,
        skipped: 0,
        candidatesGenerated: 20,
      }),
    );
    assert.ok(result, "a timed-out report must yield a classification");
    assert.equal(result!.status, "warn");
    assert.equal(result!.timedOut, true);
    assert.match(result!.reason, /timed out/i);
  });

  test("surfaces the PARTIAL kill rate for context (informational, not a verdict)", () => {
    // 4 testable (4 total - 0 skipped), 3 killed → 75% partial rate.
    const result = classifyTimedOut(
      makeReport({
        timedOut: true,
        totalMutants: 4,
        killed: 3,
        skipped: 0,
        candidatesGenerated: 20,
      }),
    );
    assert.ok(result);
    assert.equal(result!.killRate, 75);
    assert.match(result!.reason, /partial kill rate 75%/);
  });

  test("partial killRate is null when no mutant produced testable signal yet", () => {
    // testable === 0 (all skipped, or none run) before the timeout → no rate.
    const result = classifyTimedOut(
      makeReport({
        timedOut: true,
        totalMutants: 2,
        killed: 0,
        skipped: 2,
        candidatesGenerated: 10,
      }),
    );
    assert.ok(result);
    assert.equal(result!.killRate, null);
    assert.match(result!.reason, /partial kill rate n\/a/);
  });

  test("timedOut === false → returns null (caller runs the normal kill-rate path)", () => {
    const result = classifyTimedOut(
      makeReport({
        timedOut: false,
        totalMutants: 10,
        killed: 9,
        skipped: 0,
        candidatesGenerated: 10,
      }),
    );
    assert.equal(result, null);
  });

  test("a timed-out run with a HIGH partial rate still warns — never a clean pass", () => {
    // The exact friction (`mutation-gate-times-out-but-passes`): even a partial
    // rate above any plausible floor must NOT present as pass, because the gate
    // never evaluated the full mutant set.
    const result = classifyTimedOut(
      makeReport({
        timedOut: true,
        totalMutants: 5,
        killed: 5,
        skipped: 0,
        candidatesGenerated: 50,
      }),
    );
    assert.ok(result);
    assert.equal(result!.status, "warn");
    assert.equal(result!.killRate, 100);
    assert.notEqual(result!.status as string, "pass");
  });

  test("reason names how many candidates were left unevaluated", () => {
    // 3 of 30 candidates run before the budget ran out — the reason must make
    // the incompleteness legible so an agent does not treat it as a verdict.
    const result = classifyTimedOut(
      makeReport({
        timedOut: true,
        totalMutants: 3,
        killed: 2,
        skipped: 0,
        candidatesGenerated: 30,
      }),
    );
    assert.ok(result);
    assert.match(result!.reason, /3 of 30 candidate/);
    assert.match(result!.reason, /non-blocking/);
  });
});

describe("web/-prefix integration — gate generates mutants, not a silent warn (issue #1649)", () => {
  // This is the end-to-end proof of #1649: a web/-prefixed money-critical
  // changed-file list must, after filterMoneyCriticalCandidates' strip, resolve
  // against a web/-rooted projectDir and yield candidatesGenerated > 0. The
  // pre-fix bug pushed the web/ prefix through verbatim, runMutationTests joined
  // projectDir (= .../web) → .../web/web/src/... → ENOENT (silently caught) →
  // candidatesGenerated === 0 → classifyNoSignal warn, bypassing the kill-floor.
  //
  // We assert ONLY mutant generation (candidatesGenerated > 0), not execution:
  // a 1ms time budget breaks the runner's execute loop after the candidate
  // count is recorded but before any mutant runs the test command, so the test
  // is fast and hermetic (no npm install / test run in the temp dir).

  // A money-critical source file with a mutable line (the `===` comparison and
  // the `return true;`/`return false;` are both mutator targets).
  const MONEY_SRC = [
    "export function isWinningBet(actual: string, predicted: string): boolean {",
    "  if (actual === predicted) {",
    "    return true;",
    "  }",
    "  return false;",
    "}",
    "",
  ].join("\n");

  test("web/-prefixed money-critical file → candidatesGenerated > 0", async () => {
    const root = await mkdtemp(join(tmpdir(), "mut-1649-"));
    try {
      // hydra-betting layout: source tree rooted at <project>/web/.
      const projectDir = join(root, "web");
      const relPath = "src/lib/providers/draftkings.ts";
      await mkdir(join(projectDir, "src/lib/providers"), { recursive: true });
      await writeFile(join(projectDir, relPath), MONEY_SRC, "utf-8");

      // The diff comes in web/-prefixed (the synced default invocation). Run it
      // through the SAME filter the gate uses, then hand the result to the runner
      // exactly as runMutationTests is called in mutation-check.ts.
      const changedFiles = filterMoneyCriticalCandidates([`web/${relPath}`]);
      assert.deepEqual(
        changedFiles,
        [relPath],
        "filter must strip web/ so the path is projectDir-relative",
      );

      const report: MutationTestReport = await runMutationTests(
        projectDir,
        changedFiles,
        // 1ms budget: the execute loop breaks before running any mutant, but
        // candidatesGenerated is recorded first — that's all we assert.
        { timeBudgetMs: 1, testCommand: "true" },
      );

      assert.ok(
        report.candidatesGenerated > 0,
        `the money-critical file must produce mutants (got ${report.candidatesGenerated}); ` +
          "candidatesGenerated === 0 here is the #1649 silent no-signal warn",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("pre-fix shape: a web/web-doubled path generates ZERO mutants (counter-proof)", async () => {
    // Pin WHY the strip matters: hand runMutationTests the path WITHOUT the
    // strip and the doubled web/web/... resolves to nothing → 0 candidates.
    const root = await mkdtemp(join(tmpdir(), "mut-1649-neg-"));
    try {
      const projectDir = join(root, "web");
      const relPath = "src/lib/providers/draftkings.ts";
      await mkdir(join(projectDir, "src/lib/providers"), { recursive: true });
      await writeFile(join(projectDir, relPath), MONEY_SRC, "utf-8");

      // The BUG: feed the web/-prefixed path straight to the runner (no strip).
      // projectDir is already .../web, so this joins to .../web/web/src/... →
      // ENOENT → silently skipped → zero mutants.
      const report = await runMutationTests(
        projectDir,
        [`web/${relPath}`],
        { timeBudgetMs: 1, testCommand: "true" },
      );
      assert.equal(
        report.candidatesGenerated,
        0,
        "doubled web/web/... must read nothing — this is the silent-warn bug #1649 fixes",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

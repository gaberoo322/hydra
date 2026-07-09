#!/usr/bin/env -S npx tsx
/**
 * scripts/ci/target-risk-core-check.ts — Target protected-paths guard
 * (issue #2702, epic #2700).
 *
 * The deterministic trigger that feeds hydra-target-qa's existing
 * money-critical adversarial fold. It replaces the prior comment-convention-
 * only enforcement of the "provider/execution/staking/bet-math is protected"
 * rule with a hard CI check:
 *
 *   - Compute the PR's changed-file list.
 *   - Classify it with `classifyTargetRisk` (the keystone slice #2701, in
 *     `src/target/money-critical.ts`) — a pure, data-driven money-critical
 *     path classifier.
 *   - If the diff is money-critical, require a `## Risk-core justification`
 *     markdown section in the PR body. Fail (exit 2) when it is absent;
 *     pass (exit 0) when present.
 *   - Standard (non-money-critical) PRs pass trivially (exit 0).
 *
 * Design notes:
 *   - This lives in its OWN workflow (.github/workflows/protected-paths.yml),
 *     deliberately NOT inside ci.yml or automerge.yml. ci.yml / deploy.yml are
 *     the exact-match Untouchable Core (ADR-0001); a new *verification* is a
 *     sibling workflow that lands as a normal (non-Tier-0) change.
 *   - The changed-file list can span both repos on a cross-repo seam issue.
 *     `classifyTargetRisk` already normalizes a leading `web/` (the Target's
 *     source root) so real hydra-betting diff paths like
 *     `web/src/lib/execution/x.ts` match the declared `src/lib/execution/`
 *     entries. Orchestrator-only paths never match, so an Orchestrator PR
 *     passes trivially.
 *   - Pure and total: never throws on bad input; the classifier itself is
 *     total. Any unexpected error surfaces as exit 1 (usage / infra), never a
 *     silent pass.
 *
 * Inputs (env, with CI-friendly defaults):
 *   PR_BODY        — text of the PR body (default: "")
 *   CHANGED_FILES  — newline-separated list of changed files (default: "")
 *
 * Output: JSON report on stdout; human-readable guidance on stderr.
 *
 * Exit codes:
 *   0 — pass (not money-critical, OR money-critical WITH justification)
 *   2 — money-critical diff missing the `## Risk-core justification` section
 *   1 — unexpected error
 *
 * CLI:
 *   --self-test  exercises the pure logic against synthetic fixtures and exits
 *                without reading the environment (proves the guard catches a
 *                planted money-critical-without-justification case).
 */

import { classifyRisk, type RiskSurface } from "../../src/target/risk-critical.ts";
import { loadRiskSurface } from "../target/target-risk-surface.ts";

/**
 * The PR-body section that a money-critical Target PR must contain. Matched
 * case-insensitively; both `## Risk-core justification` (markdown heading) and
 * a bold `**Risk-core justification**` form are accepted, mirroring the
 * permissive header matching the scope-check gate uses.
 *
 * A section "counts" only when it has non-whitespace content after the header —
 * an empty heading is not a justification.
 */
export function hasRiskCoreJustification(body: string): boolean {
  if (!body) return false;
  // Match the header line exactly (`[ \t]*`, not `\s*`, so it cannot eat a
  // trailing blank line into the next heading), then capture the section body
  // up to the next markdown heading / bold sub-header at line start, or EOF.
  const re =
    /(?:^|\n)[ \t]*(?:#{1,6}[ \t]*|\*\*)?Risk-core justification(?:\*\*)?[ \t]*\r?\n([\s\S]*?)(?=(?:^|\n)[ \t]*(?:#{1,6}[ \t]|\*\*[A-Za-z])|$)/i;
  const m = body.match(re);
  if (!m) return false;
  return m[1].replace(/[\s\r\n]/g, "").length > 0;
}

function readChangedFiles(): string[] {
  const env = process.env.CHANGED_FILES ?? "";
  return env
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

interface CheckResult {
  status: "pass" | "fail";
  reason: string;
  moneyCritical: boolean;
  matchedPaths: string[];
  hasJustification: boolean;
}

/**
 * Pure decision function — exported for tests / self-test. Given the changed
 * files, the PR body, and the manifest-sourced risk `surface`/`appSubdir`,
 * decide whether the guard passes. The surface is threaded in (issue #3018)
 * rather than imported as a const, so the classifier reads the target's
 * `.hydra/manifest.json` — `main()` resolves it via `loadRiskSurface`; tests
 * pass a fixture explicitly.
 */
export function evaluate(
  changed: readonly string[],
  prBody: string,
  surface: RiskSurface,
  appSubdir: string,
): CheckResult {
  // The public `CheckResult.moneyCritical` field here is consumed by
  // target-risk-core-check.test.mts. The underlying classifier sources its
  // surface from the manifest (#3018).
  const classification = classifyRisk(changed, surface, appSubdir);
  if (!classification.riskCritical) {
    return {
      status: "pass",
      reason: "not money-critical — guard passes trivially",
      moneyCritical: false,
      matchedPaths: [],
      hasJustification: false,
    };
  }
  const hasJustification = hasRiskCoreJustification(prBody);
  return {
    status: hasJustification ? "pass" : "fail",
    reason: hasJustification
      ? "money-critical diff with Risk-core justification"
      : "money-critical diff missing '## Risk-core justification' section",
    moneyCritical: true,
    matchedPaths: classification.matchedPaths,
    hasJustification,
  };
}

function main(): number {
  const prBody = process.env.PR_BODY ?? "";
  const changed = readChangedFiles();

  // Issue #3018: source the risk surface from the target's
  // `.hydra/manifest.json` (via loadRiskSurface) instead of a hardcoded const.
  // Fail LOUD, fail CLOSED (ADR-0026 decision 7): a missing/malformed manifest
  // aborts the guard with exit 1 rather than silently passing every diff as
  // "not money-critical" (which would disable the protected-paths gate). The
  // self-hosted runner resolves the Target workspace via getTargetWorkspace();
  // TARGET_MANIFEST_ROOT overrides it when set.
  const surfaceResult = loadRiskSurface();
  if (!surfaceResult.ok) {
    // `strict:false` in the base tsconfig disables the discriminated-union
    // narrowing that `!surfaceResult.ok` would give under strictNullChecks, so
    // read `errors` through the error-variant cast — same idiom loadRiskSurface
    // itself uses (target-risk-surface.ts).
    const errors = (surfaceResult as { ok: false; errors: string[] }).errors;
    process.stdout.write(
      JSON.stringify({
        status: "error",
        reason: "risk surface unavailable — manifest missing or invalid",
        errors,
      }) + "\n",
    );
    process.stderr.write(
      `PROTECTED-PATHS GUARD ERROR: cannot resolve the risk surface from ` +
        `.hydra/manifest.json (fail-closed):\n  ${errors.join("\n  ")}\n`,
    );
    return 1;
  }

  const result = evaluate(changed, prBody, surfaceResult.surface, surfaceResult.appSubdir);

  process.stdout.write(
    JSON.stringify(
      {
        status: result.status,
        reason: result.reason,
        changedFiles: changed.length,
        moneyCritical: result.moneyCritical,
        matchedPaths: result.matchedPaths.slice(0, 20),
        hasJustification: result.hasJustification,
      },
      null,
      2,
    ) + "\n",
  );

  if (result.status === "fail") {
    process.stderr.write(
      `PROTECTED-PATHS GUARD FAILED: this PR touches ${result.matchedPaths.length} ` +
        `money-critical Target path(s):\n` +
        `  ${result.matchedPaths.slice(0, 5).join(", ")}` +
        `${result.matchedPaths.length > 5 ? " ..." : ""}\n\n` +
        `Money-critical Target changes (providers / execution / staking / bet-math /\n` +
        `arbitrage / markets / bin runners) MUST document their reasoning so\n` +
        `hydra-target-qa's money-critical adversarial fold has something to review.\n\n` +
        `Fix: add a "## Risk-core justification" section to the PR body explaining\n` +
        `what changed on the money-critical surface and why it is safe, e.g.\n\n` +
        `    ## Risk-core justification\n` +
        `    Tightens the Kelly-fraction clamp in src/lib/staking/…; property tests\n` +
        `    cover the new bound; no change to bet placement.\n`,
    );
    return 2;
  }

  process.stderr.write(
    result.moneyCritical
      ? "Protected-paths guard: money-critical diff has a Risk-core justification — pass.\n"
      : "Protected-paths guard: no money-critical paths in diff — pass.\n",
  );
  return 0;
}

/**
 * A synthetic betting-shaped risk surface for the hermetic `--self-test` path
 * ONLY. The production `main()` sources the real surface from the target's
 * `.hydra/manifest.json` (issue #3018); the self-test must stay filesystem-free
 * (it runs as a standalone CI step with no manifest guaranteed), so it exercises
 * the pure `evaluate` logic against this inline fixture. This is a TEST fixture,
 * not the authoritative surface — betting globs here are fine (they are not in
 * `src/`, and never feed a production classification).
 */
const SELF_TEST_SURFACE: RiskSurface = [
  "src/lib/providers/",
  "src/lib/execution/",
  "src/lib/staking/",
  "src/lib/bet-math/",
  "src/lib/arbitrage/",
  "src/lib/markets/",
  "src/bin/",
];
const SELF_TEST_APP_SUBDIR = "web";

/**
 * Self-test: prove the guard (a) passes a standard PR, (b) fails a
 * money-critical PR with no justification, and (c) passes a money-critical PR
 * that supplies one. Runs against synthetic fixtures — no env, no filesystem,
 * no network (surface comes from the inline SELF_TEST_SURFACE fixture, not the
 * manifest). Mirrors the --self-test convention of target-coupling-check.ts.
 */
function selfTest(): number {
  const failures: string[] = [];

  const standard = evaluate(
    ["web/src/components/Foo.tsx", "docs/readme.md"],
    "no section here",
    SELF_TEST_SURFACE,
    SELF_TEST_APP_SUBDIR,
  );
  if (standard.status !== "pass" || standard.moneyCritical) {
    failures.push(`standard PR should pass trivially, got ${JSON.stringify(standard)}`);
  }

  const moneyNoJust = evaluate(
    ["web/src/lib/execution/place-bet.ts"],
    "## Summary\nRefactor.\n",
    SELF_TEST_SURFACE,
    SELF_TEST_APP_SUBDIR,
  );
  if (moneyNoJust.status !== "fail" || !moneyNoJust.moneyCritical) {
    failures.push(
      `money-critical PR without justification should FAIL, got ${JSON.stringify(moneyNoJust)}`,
    );
  }

  const moneyWithJust = evaluate(
    ["web/src/lib/staking/kelly.ts"],
    "## Risk-core justification\nTightens the Kelly clamp; property tests cover it.\n",
    SELF_TEST_SURFACE,
    SELF_TEST_APP_SUBDIR,
  );
  if (moneyWithJust.status !== "pass" || !moneyWithJust.moneyCritical) {
    failures.push(
      `money-critical PR WITH justification should PASS, got ${JSON.stringify(moneyWithJust)}`,
    );
  }

  const emptySection = evaluate(
    ["web/src/lib/bet-math/edge.ts"],
    "## Risk-core justification\n\n## Next\n",
    SELF_TEST_SURFACE,
    SELF_TEST_APP_SUBDIR,
  );
  if (emptySection.status !== "fail") {
    failures.push(
      `empty Risk-core justification section should FAIL, got ${JSON.stringify(emptySection)}`,
    );
  }

  if (failures.length > 0) {
    console.error("[target-risk-core-check --self-test] FAILED:");
    for (const f of failures) console.error(`  - ${f}`);
    return 1;
  }
  console.log(
    "[target-risk-core-check --self-test] OK — guard passes standard PRs, fails " +
      "money-critical PRs without a Risk-core justification, and accepts one that has it.",
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const code = process.argv.includes("--self-test") ? selfTest() : main();
  process.exit(code);
}

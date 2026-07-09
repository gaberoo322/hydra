/**
 * Import-chain smoke test for the `protected-paths` money-critical Target risk
 * guard (`scripts/ci/target-risk-core-check.ts`), issue #3035.
 *
 * # Why this test exists
 *
 * `protected-paths` is the deterministic guard that classifies money-critical /
 * risk-critical Target diffs and demands a `## Risk-core justification`. It runs
 * in its OWN advisory workflow (`.github/workflows/protected-paths.yml`), which
 * is deliberately NOT a required branch-protection check (that workflow file and
 * `ci.yml` are Verifier Core; a new required check there is a Tier-0 change).
 *
 * That advisory-only status bit us: PR #3033 auto-merged to master (commit
 * `b2a2cd8`) while `protected-paths` was RED — its import chain routed through
 * the zod-backed manifest schema, and the workflow runs `npx tsx` with no
 * `npm ci`, so it died with `ERR_MODULE_NOT_FOUND: Cannot find package 'zod'`.
 * The money-critical guard shipped DARK and nothing blocked it, because the
 * required checks (`test`, typecheck) had no knowledge of the guard.
 *
 * # What this test guarantees (fail-closed on guard breakage)
 *
 * This file rides the REQUIRED `test` job (`npm test`). It fail-CLOSES on any
 * breakage of the guard's import chain:
 *
 *   - Dynamically `import()`-ing the guard module resolves the ENTIRE chain
 *     — guard → `target-risk-surface.ts` → `src/target/manifest.ts` →
 *     `src/schemas/target-manifest.ts` (zod). A missing `zod`, a bad re-export,
 *     or a broken transitive import makes the `import()` throw, which fails
 *     `npm test`, which IS a required check. So a PR that breaks or disables the
 *     guard's import chain can no longer auto-merge.
 *   - The module's public API (`hasRiskCoreJustification`, `evaluate`) is
 *     asserted present — a deleted/renamed export the workflow depends on also
 *     turns this red.
 *   - The pure decision logic is exercised (mirroring the module's own
 *     `--self-test` fixture, which is not exported) to prove the classification
 *     path is LIVE, not merely importable: a standard PR passes, a
 *     money-critical PR without justification FAILS, and one with justification
 *     PASSES.
 *
 * This is intentionally distinct from `test/target-risk-core-check.test.mts`,
 * which unit-tests the pure logic in depth. THIS test's job is the import-chain
 * smoke gate: prove the guard is loadable and its logic path is alive, so a
 * regression that silently darkens the guard trips the required suite.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  BETTING_RISK_SURFACE,
  BETTING_APP_SUBDIR,
} from "./_helpers/betting-risk-surface.mts";

const GUARD_MODULE = "../scripts/ci/target-risk-core-check.ts";

test("protected-paths guard: import chain resolves without throwing (fail-closed on breakage)", async () => {
  // A dynamic import so the failure surfaces as a rejected assertion with the
  // underlying module-resolution error attached, rather than a whole-file load
  // failure. This exercises the SAME chain the advisory workflow runs — guard
  // -> target-risk-surface -> manifest -> zod schema — so a missing `zod` or a
  // broken transitive import (exactly the #3033 regression) fails `npm test`.
  await assert.doesNotReject(
    () => import(GUARD_MODULE),
    "the protected-paths guard import chain must resolve; a throw here means the money-critical guard is broken (e.g. missing zod / bad re-export) and would ship dark",
  );
});

test("protected-paths guard: exports the public API the workflow depends on", async () => {
  const mod = await import(GUARD_MODULE);
  assert.equal(
    typeof mod.hasRiskCoreJustification,
    "function",
    "hasRiskCoreJustification must be exported — the guard's PR-body matcher",
  );
  assert.equal(
    typeof mod.evaluate,
    "function",
    "evaluate must be exported — the guard's pure decision function",
  );
});

test("protected-paths guard: decision logic is LIVE (mirrors the module --self-test)", async () => {
  // Prove the classification path actually runs, not just that the module
  // imports. Mirrors the fixtures in the module's own `selfTest()` (which is not
  // exported) by driving the exported `evaluate` against the hermetic betting
  // risk surface. If the classifier ever stops matching the money-critical
  // surface, the guard silently passes every diff — this catches that.
  const mod = await import(GUARD_MODULE);

  const standard = mod.evaluate(
    ["web/src/components/Foo.tsx", "docs/readme.md"],
    "no section",
    BETTING_RISK_SURFACE,
    BETTING_APP_SUBDIR,
  );
  assert.equal(standard.status, "pass", "a standard PR must pass trivially");
  assert.equal(standard.moneyCritical, false);

  const moneyNoJustification = mod.evaluate(
    ["web/src/lib/execution/place-bet.ts"],
    "## Summary\nJust a refactor.\n",
    BETTING_RISK_SURFACE,
    BETTING_APP_SUBDIR,
  );
  assert.equal(
    moneyNoJustification.status,
    "fail",
    "a money-critical PR without a Risk-core justification MUST fail",
  );
  assert.equal(moneyNoJustification.moneyCritical, true);

  const moneyWithJustification = mod.evaluate(
    ["web/src/lib/staking/kelly.ts"],
    "## Risk-core justification\nTightens the Kelly clamp; property tests cover it.\n",
    BETTING_RISK_SURFACE,
    BETTING_APP_SUBDIR,
  );
  assert.equal(
    moneyWithJustification.status,
    "pass",
    "a money-critical PR WITH a Risk-core justification must pass",
  );
  assert.equal(moneyWithJustification.hasJustification, true);
});

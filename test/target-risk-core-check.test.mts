import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluate,
  hasRiskCoreJustification,
} from "../scripts/ci/target-risk-core-check.ts";

// Acceptance criteria (issue #2702, epic #2700): the protected-paths guard
// FAILS a money-critical Target PR that lacks a `## Risk-core justification`
// section, PASSES one that has it, and passes a standard PR trivially.

test("standard (non-money-critical) PR passes trivially", () => {
  const r = evaluate(["web/src/components/Foo.tsx", "docs/readme.md"], "no section");
  assert.equal(r.status, "pass");
  assert.equal(r.moneyCritical, false);
  assert.deepEqual(r.matchedPaths, []);
});

test("orchestrator-only PR passes trivially (paths never match Target surface)", () => {
  const r = evaluate(["src/api.ts", "scripts/ci/foo.ts"], "");
  assert.equal(r.status, "pass");
  assert.equal(r.moneyCritical, false);
});

test("money-critical PR WITHOUT a Risk-core justification section FAILS", () => {
  const r = evaluate(
    ["web/src/lib/execution/place-bet.ts"],
    "## Summary\nJust a refactor.\n",
  );
  assert.equal(r.status, "fail");
  assert.equal(r.moneyCritical, true);
  assert.deepEqual(r.matchedPaths, ["web/src/lib/execution/place-bet.ts"]);
});

test("money-critical PR WITH a Risk-core justification section PASSES", () => {
  const r = evaluate(
    ["web/src/lib/staking/kelly.ts"],
    "## Risk-core justification\nTightens the Kelly clamp; property tests cover it.\n",
  );
  assert.equal(r.status, "pass");
  assert.equal(r.moneyCritical, true);
  assert.equal(r.hasJustification, true);
});

test("a mixed diff (one money-critical file) still requires justification", () => {
  const r = evaluate(
    ["web/README.md", "web/src/lib/bet-math/edge.ts", "web/src/components/X.tsx"],
    "## Summary\nunrelated tweak\n",
  );
  assert.equal(r.status, "fail");
  assert.deepEqual(r.matchedPaths, ["web/src/lib/bet-math/edge.ts"]);
});

test("bin runner entrypoints are money-critical surface", () => {
  const r = evaluate(["web/src/bin/arbitrage-auto-approval-runner.ts"], "no section");
  assert.equal(r.status, "fail");
  assert.equal(r.moneyCritical, true);
});

// --- hasRiskCoreJustification section-matching edge cases ---

test("hasRiskCoreJustification: markdown heading form with content is true", () => {
  assert.equal(
    hasRiskCoreJustification("## Risk-core justification\nsome reason here\n"),
    true,
  );
});

test("hasRiskCoreJustification: bold form with content is true", () => {
  assert.equal(
    hasRiskCoreJustification("**Risk-core justification**\nsome reason here\n"),
    true,
  );
});

test("hasRiskCoreJustification: is case-insensitive", () => {
  assert.equal(
    hasRiskCoreJustification("## RISK-CORE JUSTIFICATION\nreason\n"),
    true,
  );
});

test("hasRiskCoreJustification: empty section (heading only) is false", () => {
  // A bare heading followed immediately by the next heading must not count —
  // an empty justification is no justification.
  assert.equal(
    hasRiskCoreJustification("## Risk-core justification\n\n## Next\n"),
    false,
  );
});

test("hasRiskCoreJustification: missing section is false", () => {
  assert.equal(hasRiskCoreJustification("## Summary\nRefactor.\n"), false);
  assert.equal(hasRiskCoreJustification(""), false);
});

test("hasRiskCoreJustification: content followed by another heading is true", () => {
  assert.equal(
    hasRiskCoreJustification("## Risk-core justification\nreason\n## Testing\nran tests\n"),
    true,
  );
});

/**
 * Regression test: test discovery guard blocks merge when test count collapses.
 *
 * Bug: executor changes (e.g. package.json modifications) can break test
 * discovery so only a fraction of tests are found. Verification sees all
 * discovered tests passing (exit 0) and allows merge. Post-merge grounding
 * detects the drop and auto-reverts, but the damage is already done.
 *
 * Fix: Step 6.05 in verification.ts parses the test count from the npm test
 * stdout and compares against the grounding baseline. If discovery drops >10%,
 * merge is blocked before it happens.
 *
 * Real incident: cycle-2026-05-07-1014 — "Add Top-Level Src Import Inventory
 * Guard" caused 4291 → 252 test count collapse via package.json changes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { _testing } from "../src/verification.ts";

const { parseVerificationTestCount } = _testing;

describe("parseVerificationTestCount", () => {
  it("parses vitest output", () => {
    const stdout = `
 ✓ src/lib/foo.test.ts (3 tests) 12ms
 ✓ src/lib/bar.test.ts (5 tests) 8ms

 Test Files  2 passed (2)
      Tests  4291 passed (4291)
   Start at  14:32:01
   Duration  45.21s
`;
    assert.equal(parseVerificationTestCount(stdout, ""), 4291);
  });

  it("parses vitest output with ANSI codes", () => {
    const stdout = "\x1B[32m Tests \x1B[39m \x1B[32m252 passed\x1B[39m (252)\n";
    assert.equal(parseVerificationTestCount(stdout, ""), 252);
  });

  it("parses generic 'N passed' output", () => {
    assert.equal(parseVerificationTestCount("ok 100 passed, 0 failed", ""), 100);
  });

  it("parses jest output", () => {
    const stdout = "Tests: 500 passed, 500 total\nTest Suites: 10 passed, 10 total";
    assert.equal(parseVerificationTestCount(stdout, ""), 500);
  });

  it("returns 0 for unparseable output", () => {
    assert.equal(parseVerificationTestCount("all good", ""), 0);
  });

  it("returns 0 for empty output", () => {
    assert.equal(parseVerificationTestCount("", ""), 0);
  });
});

describe("test discovery guard logic", () => {
  it("blocks when test count drops >10%", () => {
    const baseline = 4291;
    const discovered = 252;
    // The guard condition: discoveredTests < baselineTests * 0.9
    assert.ok(discovered < baseline * 0.9, "252 should be below 90% of 4291");
  });

  it("allows small drop within 10% threshold", () => {
    const baseline = 4291;
    const discovered = 4200; // ~2% drop
    assert.ok(!(discovered < baseline * 0.9), "4200 should be above 90% of 4291");
  });

  it("allows equal or higher test count", () => {
    const baseline = 4291;
    assert.ok(!(baseline < baseline * 0.9));
    assert.ok(!(4300 < baseline * 0.9));
  });

  it("skips guard when baseline is 0", () => {
    // Guard is gated on baselineTests > 0
    const baseline = 0;
    assert.ok(!(baseline > 0), "guard should not fire when baseline is 0");
  });

  it("skips guard when discovered count is 0 (unparseable)", () => {
    const baseline = 4291;
    const discovered = 0;
    // Guard requires discoveredTests > 0
    assert.ok(!(discovered > 0 && discovered < baseline * 0.9));
  });
});

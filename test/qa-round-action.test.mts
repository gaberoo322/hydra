/**
 * Moved verbatim from test/hydra-qa-prompt-verdict.test.mts (issue #5079,
 * ADR-0038 D2 — mechanical move): the round-action phase: T4 deep-QA loop and PASS marker cases.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as roundActionModule from "../src/qa/round-action.ts";
import {
  DEEP_QA_FAIL_MARKER,
  DEEP_QA_PASS_MARKER,
  decideRound,
  hasFreshDeepQaPass,
  renderDeepQaPassMarker,
} from "../src/qa/round-action.ts";

const SHA_C = "cccccccccccc3333333333333333333333333333";

describe("T4 deep-QA FAIL marker (issue #740, #5662)", () => {
  // The FAIL count and the 2nd-FAIL escalation live in the seam's `deep-qa-fails` Cap Arm
  // (test/lifecycle-caps.test.mts); this module only owns the marker literal and where it is emitted.
  test("DEEP_QA_FAIL_MARKER is the stable greppable literal the seam counts", () => {
    // If this literal drifts, the seam's per-PR count silently stops matching and a T4 PR bounces forever.
    assert.equal(DEEP_QA_FAIL_MARKER, "Verifier-Core deep-QA: FAIL");
  });

  test("round-action routes no T4 FAIL itself: the old decision function is gone", () => {
    assert.equal("decideDeepQaAction" in roundActionModule, false);
  });
});

describe("Deep-QA PASS marker — emission + freshness (issue #847, ADR-0020 Slice 1)", () => {
  const SHA = "abc1234deadbeef5678abc1234deadbeef5678ab";

  test("DEEP_QA_PASS_MARKER is the exact greppable base literal", () => {
    // Breaking-change guard: both the hydra-qa playbook and deep-qa-gate.yml
    // depend on this exact string.
    assert.equal(DEEP_QA_PASS_MARKER, "Verifier-Core deep-QA: PASS");
  });

  test("renderDeepQaPassMarker produces the exact `... PASS @ <sha>` line", () => {
    assert.equal(
      renderDeepQaPassMarker(SHA),
      `Verifier-Core deep-QA: PASS @ ${SHA}`,
    );
  });

  test("renderDeepQaPassMarker trims surrounding whitespace on the SHA", () => {
    assert.equal(
      renderDeepQaPassMarker(`  ${SHA}\n`),
      `Verifier-Core deep-QA: PASS @ ${SHA}`,
    );
  });

  test("hasFreshDeepQaPass is true when a comment carries the marker for THIS sha", () => {
    const comments = [
      "looks good to me",
      `> *T4 PASS proof*\n\n${renderDeepQaPassMarker(SHA)}\n\nmerging`,
    ];
    assert.equal(hasFreshDeepQaPass(comments, SHA), true);
  });

  test("hasFreshDeepQaPass is false for a STALE-sha marker (the SHA-bound guarantee)", () => {
    const oldSha = "0000000000000000000000000000000000000000";
    const comments = [renderDeepQaPassMarker(oldSha)];
    // The marker exists, but for a different head SHA — must NOT satisfy the gate.
    assert.equal(hasFreshDeepQaPass(comments, SHA), false);
  });

  test("hasFreshDeepQaPass is false when no comment carries the marker", () => {
    assert.equal(hasFreshDeepQaPass(["ship it", "lgtm"], SHA), false);
    assert.equal(hasFreshDeepQaPass([], SHA), false);
  });

  test("hasFreshDeepQaPass never matches on a blank/whitespace head SHA", () => {
    // Defensive: an unknown head SHA must never satisfy the gate, even if a
    // comment literally contains a trailing `PASS @ `.
    assert.equal(hasFreshDeepQaPass([`Verifier-Core deep-QA: PASS @ ${SHA}`], ""), false);
    assert.equal(hasFreshDeepQaPass([`Verifier-Core deep-QA: PASS @ ${SHA}`], "   "), false);
  });

  test("hasFreshDeepQaPass tolerates surrounding whitespace on the query SHA", () => {
    const comments = [renderDeepQaPassMarker(SHA)];
    assert.equal(hasFreshDeepQaPass(comments, `  ${SHA}  `), true);
  });

  test("PASS marker base is distinct from the FAIL marker", () => {
    assert.notEqual(DEEP_QA_PASS_MARKER, DEEP_QA_FAIL_MARKER);
    // A FAIL marker must never be mistaken for a fresh PASS.
    assert.equal(hasFreshDeepQaPass([`${DEEP_QA_FAIL_MARKER} (fail #1)`], SHA), false);
  });
});

describe("decideRound — the composed round-action head (issue #5079, INV-3)", () => {
  test("T1-T3 carry no deep-QA markers, whatever the verdict", () => {
    for (const tier of [1, 2, 3, null]) {
      for (const verdict of ["FAIL", "PASS", "FAIL-pending-CI"]) {
        const r = decideRound({ tier, verdict, reviewVerdict: "FAIL", headSha: SHA_C });
        assert.deepEqual(r, { passMarker: null, failMarker: null }, `${tier}/${verdict}`);
      }
    }
  });

  test("T4 FAIL carries the fail marker and NO PASS marker", () => {
    const r = decideRound({ tier: 4, verdict: "FAIL", reviewVerdict: "FAIL", headSha: SHA_C });
    assert.equal(r.passMarker, null);
    assert.equal(r.failMarker, DEEP_QA_FAIL_MARKER);
  });

  test("T4 FAIL driven by CI alone (review PASS) still carries the fail marker, never the PASS marker", () => {
    const r = decideRound({ tier: 4, verdict: "FAIL-pending-CI", reviewVerdict: "PASS", headSha: SHA_C });
    assert.equal(r.failMarker, DEEP_QA_FAIL_MARKER);
    assert.equal(r.passMarker, null);
  });

  test("T4 PASS carries the SHA-bound PASS marker", () => {
    const r = decideRound({ tier: 4, verdict: "PASS", reviewVerdict: "PASS", headSha: SHA_C });
    assert.equal(r.passMarker, renderDeepQaPassMarker(SHA_C));
    assert.equal(r.failMarker, null);
  });
});

/**
 * Moved verbatim from test/hydra-qa-prompt-verdict.test.mts (issue #5079,
 * ADR-0038 D2 — mechanical move): the round-action phase: T4 deep-QA loop and PASS marker cases.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  DEEP_QA_FAIL_MARKER,
  DEEP_QA_PASS_MARKER,
  decideDeepQaAction,
  decideRound,
  hasFreshDeepQaPass,
  renderDeepQaPassMarker,
} from "../src/qa/round-action.ts";

const SHA_C = "cccccccccccc3333333333333333333333333333";

describe("decideDeepQaAction — T4 deep-QA remediation loop (issue #740)", () => {
  // T4 inherits the T3 adversarial fold above, then adds block-and-escalate
  // teeth: 1st FAIL bounces (universal #739 loop), 2nd+ consecutive FAIL blocks
  // the PR and routes to the /hydra-review pickup set. The consecutive-fail
  // count is derived LIVE from machine-greppable FAIL markers already on the PR
  // (the PR is the durable per-attempt ledger) — NOT a Redis key, NOT an issue
  // label (labels reset on every bounce). These tests pin that contract.

  test("PASS verdict → proceed (no remediation, normal routing)", () => {
    const r = decideDeepQaAction("PASS", []);
    assert.equal(r.action, "proceed");
    assert.equal(r.failNumber, undefined);
  });

  test("PASS verdict ignores any prior FAIL markers (loop healed)", () => {
    // A PASS after a prior fail proceeds — and since a PASS merges the PR and
    // ends the loop, a PR never accumulates a FAIL after a PASS in practice.
    const r = decideDeepQaAction("PASS", [
      `something\n${DEEP_QA_FAIL_MARKER}\nmore`,
    ]);
    assert.equal(r.action, "proceed");
  });

  test("1st FAIL (no prior markers) → bounce, failNumber 1", () => {
    const r = decideDeepQaAction("FAIL", [
      "unrelated review comment",
      "another comment with no marker",
    ]);
    assert.equal(r.action, "bounce");
    assert.equal(r.failNumber, 1);
    assert.match(r.reason, /bounce|ready-for-agent/i);
  });

  test("2nd consecutive FAIL (one prior marker) → block-and-escalate, failNumber 2", () => {
    const r = decideDeepQaAction("FAIL", [
      `> *Automated QA failed*\n\n${DEEP_QA_FAIL_MARKER} — Live-Gate Invariant violated`,
    ]);
    assert.equal(r.action, "block-and-escalate");
    assert.equal(r.failNumber, 2);
    assert.match(r.reason, /hydra-review|ready-for-human|pickup set/i);
  });

  test("3rd FAIL (two prior markers) → still block-and-escalate, failNumber 3", () => {
    const r = decideDeepQaAction("FAIL", [
      `c1 ${DEEP_QA_FAIL_MARKER}`,
      `c2 ${DEEP_QA_FAIL_MARKER}`,
    ]);
    assert.equal(r.action, "block-and-escalate");
    assert.equal(r.failNumber, 3);
  });

  test("marker count is substring-based, robust to surrounding text", () => {
    // The playbook posts the marker on its own line inside a larger comment;
    // the count is a substring match so the surrounding report doesn't matter.
    const r = decideDeepQaAction("FAIL", [
      `# QA Report\n\nLots of findings...\n\n**Verdict:** \`FAIL\`\n\n${DEEP_QA_FAIL_MARKER}\n\n(checks table)`,
    ]);
    assert.equal(r.action, "block-and-escalate");
    assert.equal(r.failNumber, 2);
  });

  test("comments WITHOUT the exact marker do not count (no false escalation)", () => {
    // A generic FAIL comment from the T1/T2/T3 path (which does NOT post the
    // T4 marker) must not be miscounted as a deep-QA fail — otherwise a T4 PR
    // that previously failed a shallow check would escalate on its first deep
    // FAIL. Only the exact T4 marker counts.
    const r = decideDeepQaAction("FAIL", [
      "Verdict: `FAIL` — Code review FAIL",
      "Adversarial QA (T3): reviewer A surfaced a real blocker",
      "Verifier-Core deep-QA: PASS", // a PASS marker, not the FAIL marker
    ]);
    assert.equal(r.action, "bounce");
    assert.equal(r.failNumber, 1);
  });

  test("DEEP_QA_FAIL_MARKER is the stable greppable literal the playbook posts", () => {
    // If this literal ever drifts, the per-PR ledger count silently breaks
    // (prior markers stop matching) and every fail looks like a 1st fail —
    // the PR would bounce forever instead of escalating. Pin it.
    assert.equal(DEEP_QA_FAIL_MARKER, "Verifier-Core deep-QA: FAIL");
  });

  test("decision is a pure synchronous return — never blocks", () => {
    const r = decideDeepQaAction("FAIL", []);
    assert.equal(typeof r, "object");
    assert.equal((r as { then?: unknown }).then, undefined);
  });

  test("block-and-escalate does NOT introduce a new FinalVerdict literal", () => {
    // INV: T4 deep-QA is additive verification depth, NOT a policy change.
    // block-and-escalate is expressed via the ready-for-human pickup set, so
    // the four-verdict contract decide.py consumes stays intact. The decision
    // object carries an `action`, never a verdict literal.
    const r = decideDeepQaAction("FAIL", [`x ${DEEP_QA_FAIL_MARKER}`]);
    assert.ok(!("verdict" in r), "deep-QA decision must not carry a verdict literal");
    assert.equal(r.action, "block-and-escalate");
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
  test("T1-T3 carry no round decision: no deep-QA, no markers, whatever the verdict", () => {
    for (const tier of [1, 2, 3, null]) {
      for (const verdict of ["FAIL", "PASS", "FAIL-pending-CI"]) {
        const r = decideRound({ tier, verdict, reviewVerdict: "FAIL", headSha: SHA_C, priorBodies: [`c1 ${DEEP_QA_FAIL_MARKER}`] });
        assert.deepEqual(r, { deepQa: null, passMarker: null, failMarker: null }, `${tier}/${verdict}`);
      }
    }
  });

  test("T4 FAIL hands routing to the deep-QA loop and carries NO PASS marker", () => {
    const r = decideRound({ tier: 4, verdict: "FAIL", reviewVerdict: "FAIL", headSha: SHA_C, priorBodies: [] });
    assert.deepEqual(r.deepQa, decideDeepQaAction("FAIL", []));
    assert.equal(r.passMarker, null);
    assert.equal(r.failMarker, DEEP_QA_FAIL_MARKER);
  });

  test("T4 second FAIL (block-and-escalate) carries NO PASS marker", () => {
    const r = decideRound({ tier: 4, verdict: "FAIL", reviewVerdict: "FAIL", headSha: SHA_C, priorBodies: [`c1 ${DEEP_QA_FAIL_MARKER}`] });
    assert.equal(r.deepQa?.action, "block-and-escalate");
    assert.equal(r.passMarker, null);
  });

  test("T4 FAIL driven by CI alone (review PASS) still bounces", () => {
    const r = decideRound({ tier: 4, verdict: "FAIL", reviewVerdict: "PASS", headSha: SHA_C, priorBodies: [] });
    assert.equal(r.deepQa?.action, "bounce");
    assert.equal(r.passMarker, null);
  });

  test("T4 PASS carries the SHA-bound PASS marker", () => {
    const r = decideRound({ tier: 4, verdict: "PASS", reviewVerdict: "PASS", headSha: SHA_C, priorBodies: [] });
    assert.equal(r.deepQa?.action, "proceed");
    assert.equal(r.passMarker, renderDeepQaPassMarker(SHA_C));
    assert.equal(r.failMarker, null);
  });
});

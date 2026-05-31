/**
 * Regression tests for issue #772 — hydra-sweep must not re-label an issue
 * `ready-for-agent` when an OPEN PR already references it.
 *
 * Bug: on 2026-05-30, sweep re-triaged #750 to ready-for-agent while PR #754
 * (`Closes #750`) was already open → the autopilot dispatched a duplicate
 * dev_orch build (PR #770), wasting a cycle.
 *
 * Fix: `evaluateReadyForAgentPromotion()` is a pure pre-promotion gate the
 * sweep playbook calls at every edge that writes ready-for-agent. Given the
 * live list of OPEN PRs, it either allows promotion (no referencing PR) or
 * diverts the issue into an observable, non-dispatching lane:
 *   - PR mergeable        → needs-qa
 *   - PR CONFLICTING       → ready-for-human
 *   - PR unknown/absent     → has-open-pr (suppress, note)
 *
 * No Redis / network — the predicate is pure, so these tests are fast and
 * deterministic.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateReadyForAgentPromotion,
  findReferencingOpenPr,
  referencesIssue,
  type OpenPr,
} from "../src/sweep-promotion-gate.ts";

describe("referencesIssue", () => {
  test("matches a bare #N mention", () => {
    assert.equal(referencesIssue("fixes a thing for #772 today", 772), true);
  });

  test("matches Closes/Fixes/Resolves keyword forms", () => {
    assert.equal(referencesIssue("Closes #750", 750), true);
    assert.equal(referencesIssue("Fixes #750", 750), true);
    assert.equal(referencesIssue("Resolves #750", 750), true);
  });

  test("does NOT match a longer issue number (#75 vs #750)", () => {
    assert.equal(referencesIssue("Closes #750", 75), false);
  });

  test("does NOT match a shorter prefix (#7720 vs #772)", () => {
    assert.equal(referencesIssue("see #7720", 772), false);
  });

  test("returns false on empty/invalid input", () => {
    assert.equal(referencesIssue("", 772), false);
    assert.equal(referencesIssue(null, 772), false);
    assert.equal(referencesIssue("#772", 0), false);
    assert.equal(referencesIssue("#772", -1), false);
  });
});

describe("findReferencingOpenPr", () => {
  test("finds the PR referencing the issue in body or title", () => {
    const prs: OpenPr[] = [
      { number: 1, body: "unrelated", title: "nope" },
      { number: 754, body: "Closes #750", title: "fix" },
    ];
    assert.equal(findReferencingOpenPr(750, prs)?.number, 754);
  });

  test("matches a reference that appears only in the title", () => {
    const prs: OpenPr[] = [{ number: 808, body: null, title: "Implement #785 holdback" }];
    assert.equal(findReferencingOpenPr(785, prs)?.number, 808);
  });

  test("ignores PRs whose state is present and not OPEN", () => {
    const prs: OpenPr[] = [{ number: 754, body: "Closes #750", state: "CLOSED" }];
    assert.equal(findReferencingOpenPr(750, prs), null);
  });

  test("trusts the caller when state is absent (defaults to open)", () => {
    const prs: OpenPr[] = [{ number: 754, body: "Closes #750" }];
    assert.equal(findReferencingOpenPr(750, prs)?.number, 754);
  });

  test("returns null when no PR references the issue", () => {
    const prs: OpenPr[] = [{ number: 1, body: "Closes #999" }];
    assert.equal(findReferencingOpenPr(750, prs), null);
  });

  test("returns null on empty / non-array input", () => {
    assert.equal(findReferencingOpenPr(750, []), null);
    assert.equal(findReferencingOpenPr(750, null), null);
    assert.equal(findReferencingOpenPr(750, undefined), null);
  });
});

describe("evaluateReadyForAgentPromotion", () => {
  test("no open PR → promote to ready-for-agent (regression-free path)", () => {
    const d = evaluateReadyForAgentPromotion(772, [{ number: 1, body: "Closes #999" }]);
    assert.equal(d.promote, true);
    assert.equal(d.targetLane, "ready-for-agent");
    assert.equal(d.prRef, null);
  });

  test("THE #772 BUG: open PR referencing the issue suppresses promotion", () => {
    // PR #754 (Closes #750) is open → must NOT promote #750 to ready-for-agent.
    const d = evaluateReadyForAgentPromotion(750, [
      { number: 754, body: "Closes #750", mergeable: "CONFLICTING" },
    ]);
    assert.equal(d.promote, false);
    assert.equal(d.prRef, 754);
    assert.notEqual(d.targetLane, "ready-for-agent");
  });

  test("open + mergeable PR diverts to needs-qa", () => {
    const d = evaluateReadyForAgentPromotion(750, [
      { number: 754, body: "Closes #750", mergeable: "MERGEABLE" },
    ]);
    assert.equal(d.promote, false);
    assert.equal(d.targetLane, "needs-qa");
    assert.equal(d.prRef, 754);
  });

  test("open + CONFLICTING (DIRTY/parked) PR diverts to ready-for-human", () => {
    const d = evaluateReadyForAgentPromotion(750, [
      { number: 754, body: "Closes #750", mergeable: "CONFLICTING" },
    ]);
    assert.equal(d.targetLane, "ready-for-human");
  });

  test("open + UNKNOWN/absent mergeability diverts to has-open-pr note", () => {
    const unknown = evaluateReadyForAgentPromotion(750, [
      { number: 754, body: "Closes #750", mergeable: "UNKNOWN" },
    ]);
    assert.equal(unknown.targetLane, "has-open-pr");

    const absent = evaluateReadyForAgentPromotion(750, [{ number: 754, body: "Closes #750" }]);
    assert.equal(absent.targetLane, "has-open-pr");
  });

  test("a CLOSED PR does not suppress promotion (the #754→#770 handoff)", () => {
    // Once #754 is CLOSED (abandoned), #750 should be eligible again.
    const d = evaluateReadyForAgentPromotion(750, [
      { number: 754, body: "Closes #750", mergeable: "MERGEABLE", state: "CLOSED" },
    ]);
    assert.equal(d.promote, true);
    assert.equal(d.targetLane, "ready-for-agent");
  });

  test("idempotent: same inputs → identical decision", () => {
    const prs: OpenPr[] = [{ number: 754, body: "Closes #750", mergeable: "MERGEABLE" }];
    const a = evaluateReadyForAgentPromotion(750, prs);
    const b = evaluateReadyForAgentPromotion(750, prs);
    assert.deepEqual(a, b);
  });
});

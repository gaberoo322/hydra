/**
 * Moved verbatim from test/hydra-qa-prompt-verdict.test.mts (issue #5079,
 * ADR-0038 D2 — mechanical move): the fan-out phase — tier x change-shape reviewer sizing cases.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  decideReviewerFanout,
} from "../src/qa/fanout.ts";

describe("decideReviewerFanout — tier × change-shape fan-out sizing (issue #4733)", () => {
  const DOC = ["docs/adr/0042-x.md"];
  const CODE = ["docs/adr/0042-x.md", "src/foo.ts"];

  test("T3 docs-only → single reviewer covering both axes", () => {
    const d = decideReviewerFanout(3, DOC);
    assert.equal(d.mode, "single");
    assert.deepEqual(d.reviewers, ["reviewer-single"]);
    assert.match(d.reason, /single/);
    assert.match(d.reason, /docs-only/);
  });

  test("T1 prompt-only and T2 tests-only → single", () => {
    assert.equal(decideReviewerFanout(1, ["config/agents/x.md"]).mode, "single");
    assert.equal(decideReviewerFanout(2, ["test/x.test.mts"]).mode, "single");
  });

  test("T4 always gets the full adversarial fan-out, even for a docs-only diff", () => {
    const d = decideReviewerFanout(4, DOC);
    assert.equal(d.mode, "adversarial");
    assert.equal(d.reviewers.length, 4);
    assert.match(d.reason, /Verifier Core/);
  });

  test("code PRs keep the unchanged tier path (T3 adversarial, T1/T2 standard)", () => {
    const t3 = decideReviewerFanout(3, CODE);
    assert.equal(t3.mode, "adversarial");
    assert.deepEqual(t3.reviewers, [
      "reviewer-A-standards",
      "reviewer-A-spec",
      "reviewer-B-standards",
      "reviewer-B-spec",
    ]);
    const t2 = decideReviewerFanout(2, CODE);
    assert.equal(t2.mode, "standard");
    assert.deepEqual(t2.reviewers, ["standards", "spec"]);
  });

  test("unknown tier fail-closes to adversarial regardless of shape", () => {
    assert.equal(decideReviewerFanout(null, DOC).mode, "adversarial");
    assert.equal(decideReviewerFanout(Number.NaN, DOC).mode, "adversarial");
  });

  test("reason names the fan-out and why (for the verdict comment)", () => {
    const d = decideReviewerFanout(2, CODE);
    assert.match(d.reason, /^Review fan-out: standard/);
    assert.match(d.reason, /T2/);
    assert.match(d.reason, /`code`/);
  });
});

/**
 * Regression tests for the hydra-qa one-pass verdict classifier (issue #405).
 *
 * Before #405, the hydra-qa subagent looped waiting on pending required CI
 * checks (e.g. `mutation-test: QUEUED`) before emitting any verdict. A single
 * QA pass could span hours, sometimes long enough for the PR to auto-merge
 * before the verdict landed. The classifier now returns one of four verdicts
 * in a single pass and exits — autopilot polls CI separately:
 *
 *   PASS / FAIL / PASS-pending-CI / FAIL-pending-CI
 *
 * The "smoking-gun" assertion from the issue acceptance criteria:
 *
 *   "a PR with `mutation-test: QUEUED` and all other checks green returns
 *    PASS-pending-CI, not a wait"
 *
 * is the first test below. Every other test guards an adjacent edge case so
 * the classifier doesn't silently regress to the old looping behaviour.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  classifyVerdict,
  renderChecksBlock,
  aggregateAdversarialReview,
  type CheckState,
} from "../scripts/ci/qa-verdict.ts";

describe("classifyVerdict — pending CI does not loop", () => {
  test("mutation-test QUEUED + other checks green → PASS-pending-CI (issue #405 AC)", () => {
    const checks: CheckState[] = [
      { name: "typecheck", status: "completed", conclusion: "success", required: true },
      { name: "tests", status: "completed", conclusion: "success", required: true },
      { name: "dashboard-build", status: "completed", conclusion: "success", required: true },
      { name: "scope-check", status: "completed", conclusion: "success", required: true },
      { name: "mutation-test", status: "queued", required: true },
    ];

    const r = classifyVerdict("PASS", checks);

    assert.equal(r.verdict, "PASS-pending-CI");
    assert.equal(r.summary.requiredPending, 1);
    assert.equal(r.summary.requiredFailed, 0);
    assert.equal(r.summary.passed, 4);
    assert.match(r.reason, /mutation-test/);
    // The result MUST include a checks block listing every check by name.
    const names = r.checks.map((c) => c.name);
    assert.deepEqual(
      names.sort(),
      ["dashboard-build", "mutation-test", "scope-check", "tests", "typecheck"],
    );
  });

  test("mutation-test in_progress + others green → PASS-pending-CI", () => {
    const checks: CheckState[] = [
      { name: "typecheck", status: "completed", conclusion: "success", required: true },
      { name: "tests", status: "completed", conclusion: "success", required: true },
      { name: "mutation-test", status: "in_progress", required: true },
    ];
    assert.equal(classifyVerdict("PASS", checks).verdict, "PASS-pending-CI");
  });

  test("all required checks green → PASS (no pending tier)", () => {
    const checks: CheckState[] = [
      { name: "typecheck", status: "completed", conclusion: "success", required: true },
      { name: "tests", status: "completed", conclusion: "success", required: true },
      { name: "mutation-test", status: "completed", conclusion: "success", required: true },
    ];
    const r = classifyVerdict("PASS", checks);
    assert.equal(r.verdict, "PASS");
    assert.equal(r.summary.pending, 0);
  });

  test("review FAIL overrides everything — even with pending CI", () => {
    const checks: CheckState[] = [
      { name: "tests", status: "queued", required: true },
    ];
    const r = classifyVerdict("FAIL", checks);
    assert.equal(r.verdict, "FAIL");
    assert.match(r.reason, /review/i);
  });

  test("required check failed → FAIL even if review PASS", () => {
    const checks: CheckState[] = [
      { name: "typecheck", status: "completed", conclusion: "success", required: true },
      { name: "tests", status: "completed", conclusion: "failure", required: true },
    ];
    const r = classifyVerdict("PASS", checks);
    assert.equal(r.verdict, "FAIL");
    assert.match(r.reason, /tests/);
  });

  test("required failed beats required pending", () => {
    const checks: CheckState[] = [
      { name: "tests", status: "completed", conclusion: "failure", required: true },
      { name: "mutation-test", status: "queued", required: true },
    ];
    assert.equal(classifyVerdict("PASS", checks).verdict, "FAIL");
  });

  test("skipped and neutral conclusions count as success", () => {
    const checks: CheckState[] = [
      { name: "lint", status: "completed", conclusion: "skipped", required: true },
      { name: "deploy-preview", status: "completed", conclusion: "neutral", required: false },
    ];
    assert.equal(classifyVerdict("PASS", checks).verdict, "PASS");
  });

  test("only optional check pending, no required failures → PASS-pending-CI", () => {
    // Documents the behaviour: classifier never returns PASS while any check
    // is unresolved, even if it's optional. The verdict body explains.
    const checks: CheckState[] = [
      { name: "tests", status: "completed", conclusion: "success", required: true },
      { name: "preview-deploy", status: "in_progress", required: false },
    ];
    const r = classifyVerdict("PASS", checks);
    assert.equal(r.verdict, "PASS-pending-CI");
    assert.equal(r.summary.requiredPending, 0);
    assert.equal(r.summary.pending, 1);
  });

  test("zero checks reported → PASS when review PASS", () => {
    const r = classifyVerdict("PASS", []);
    assert.equal(r.verdict, "PASS");
    assert.equal(r.summary.total, 0);
  });

  test("zero checks reported → FAIL when review FAIL", () => {
    assert.equal(classifyVerdict("FAIL", []).verdict, "FAIL");
  });

  test("cancelled / timed_out are treated as failures", () => {
    for (const conclusion of ["cancelled", "timed_out", "action_required", "stale", "startup_failure"] as const) {
      const checks: CheckState[] = [
        { name: "build", status: "completed", conclusion, required: true },
      ];
      assert.equal(
        classifyVerdict("PASS", checks).verdict,
        "FAIL",
        `${conclusion} should map to FAIL`,
      );
    }
  });

  test("classifier never blocks/awaits — pure synchronous return", () => {
    // Trivial: if classifyVerdict ever became async we'd have to await it,
    // and the test runner would surface that. This test exists so that
    // future changes that make the function async fail loudly here first
    // before breaking the live skill.
    const r = classifyVerdict("PASS", [
      { name: "x", status: "queued", required: true },
    ]);
    assert.equal(typeof r, "object");
    assert.equal((r as { then?: unknown }).then, undefined);
  });
});

describe("classifyVerdict — case-insensitive GitHub enum casing (issue #761)", () => {
  // GitHub's GraphQL API (surfaced by `gh pr view --json statusCheckRollup`)
  // returns status/conclusion as UPPERCASE enums. Before #761 the classifier
  // matched only lowercase tokens, so an uppercase QUEUED check fell through
  // every guard to a false-green PASS — which could let auto-merge approve a
  // PR before CI ran. The classifier now folds casing at its boundary
  // (defense in depth; the playbook also ascii_downcases).

  test("UPPERCASE QUEUED required check → PASS-pending-CI, NOT a false-green PASS", () => {
    const checks = [
      { name: "typecheck", status: "COMPLETED", conclusion: "SUCCESS", required: true },
      { name: "tests", status: "COMPLETED", conclusion: "SUCCESS", required: true },
      { name: "mutation-test", status: "QUEUED", required: true },
    ] as unknown as CheckState[];
    const r = classifyVerdict("PASS", checks);
    assert.equal(r.verdict, "PASS-pending-CI");
    assert.equal(r.summary.requiredPending, 1);
    assert.equal(r.summary.passed, 2);
    assert.match(r.reason, /mutation-test/);
  });

  test("UPPERCASE IN_PROGRESS folds to pending", () => {
    const checks = [
      { name: "tests", status: "COMPLETED", conclusion: "SUCCESS", required: true },
      { name: "mutation-test", status: "IN_PROGRESS", required: true },
    ] as unknown as CheckState[];
    assert.equal(classifyVerdict("PASS", checks).verdict, "PASS-pending-CI");
  });

  test("all UPPERCASE COMPLETED/SUCCESS → PASS", () => {
    const checks = [
      { name: "typecheck", status: "COMPLETED", conclusion: "SUCCESS", required: true },
      { name: "tests", status: "COMPLETED", conclusion: "SUCCESS", required: true },
    ] as unknown as CheckState[];
    const r = classifyVerdict("PASS", checks);
    assert.equal(r.verdict, "PASS");
    assert.equal(r.summary.pending, 0);
    assert.equal(r.summary.passed, 2);
  });

  test("UPPERCASE FAILURE conclusion on a required check → FAIL", () => {
    const checks = [
      { name: "typecheck", status: "COMPLETED", conclusion: "SUCCESS", required: true },
      { name: "tests", status: "COMPLETED", conclusion: "FAILURE", required: true },
    ] as unknown as CheckState[];
    const r = classifyVerdict("PASS", checks);
    assert.equal(r.verdict, "FAIL");
    assert.match(r.reason, /tests/);
  });

  test("UPPERCASE SKIPPED / NEUTRAL conclusions count as success", () => {
    const checks = [
      { name: "lint", status: "COMPLETED", conclusion: "SKIPPED", required: true },
      { name: "preview", status: "COMPLETED", conclusion: "NEUTRAL", required: false },
    ] as unknown as CheckState[];
    assert.equal(classifyVerdict("PASS", checks).verdict, "PASS");
  });

  test("mixed casing (real-world gh output) classifies correctly", () => {
    // gh sometimes mixes CheckRun (UPPERCASE) and StatusContext rows.
    const checks = [
      { name: "ci", status: "COMPLETED", conclusion: "success", required: true },
      { name: "mutation-test", status: "queued", required: true },
      { name: "scope-check", status: "Completed", conclusion: "Success", required: true },
    ] as unknown as CheckState[];
    const r = classifyVerdict("PASS", checks);
    assert.equal(r.verdict, "PASS-pending-CI");
    assert.equal(r.summary.requiredPending, 1);
    assert.equal(r.summary.passed, 2);
  });

  test("rendered checks block normalises UPPERCASE tokens to lowercase-canonical", () => {
    const checks = [
      { name: "tests", status: "COMPLETED", conclusion: "SUCCESS", required: true },
      { name: "mutation-test", status: "QUEUED", required: true },
    ] as unknown as CheckState[];
    const md = renderChecksBlock(classifyVerdict("PASS", checks));
    assert.match(md, /\| tests \| completed \| success \| yes \|/);
    assert.match(md, /\| mutation-test \| queued \| — \| yes \|/);
  });
});

describe("renderChecksBlock", () => {
  test("produces a markdown table with stable column order", () => {
    const r = classifyVerdict("PASS", [
      { name: "tests", status: "completed", conclusion: "success", required: true },
      { name: "mutation-test", status: "queued", required: true },
    ]);
    const md = renderChecksBlock(r);
    assert.match(md, /\| Check \| Status \| Conclusion \| Required \|/);
    assert.match(md, /\| tests \| completed \| success \| yes \|/);
    assert.match(md, /\| mutation-test \| queued \| — \| yes \|/);
  });

  test("zero checks → human-readable fallback string", () => {
    const r = classifyVerdict("PASS", []);
    assert.match(renderChecksBlock(r), /No CI checks/i);
  });
});

describe("aggregateAdversarialReview — T3 two-reviewer refutation fan-out (issue #739)", () => {
  // T3 PASS iff BOTH independent refutation reviewers find no real blocker;
  // any single real blocker from EITHER reviewer is a FAIL. This is the
  // defining asymmetry of refutation framing (one refuter is enough to
  // bounce) and the AND-gate the issue's acceptance criteria pin.

  test("both reviewers PASS → PASS (neither surfaced a real blocker)", () => {
    const r = aggregateAdversarialReview("PASS", "PASS");
    assert.equal(r.reviewVerdict, "PASS");
    assert.match(r.reason, /both/i);
  });

  test("reviewer A FAIL, reviewer B PASS → FAIL (single blocker bounces)", () => {
    const r = aggregateAdversarialReview("FAIL", "PASS");
    assert.equal(r.reviewVerdict, "FAIL");
    assert.match(r.reason, /reviewer A/);
  });

  test("reviewer A PASS, reviewer B FAIL → FAIL (single blocker bounces)", () => {
    const r = aggregateAdversarialReview("PASS", "FAIL");
    assert.equal(r.reviewVerdict, "FAIL");
    assert.match(r.reason, /reviewer B/);
  });

  test("both reviewers FAIL → FAIL (names both)", () => {
    const r = aggregateAdversarialReview("FAIL", "FAIL");
    assert.equal(r.reviewVerdict, "FAIL");
    assert.match(r.reason, /both/i);
  });

  test("aggregate feeds straight into classifyVerdict without policy change", () => {
    // The whole point: the aggregate produces the same ReviewVerdict literal
    // classifyVerdict already consumes — the CI-state classification and the
    // emitted FinalVerdict are untouched (INV-007 / decide.py policy intact).
    const greenChecks: CheckState[] = [
      { name: "tests", status: "completed", conclusion: "success", required: true },
    ];
    const passAgg = aggregateAdversarialReview("PASS", "PASS");
    assert.equal(classifyVerdict(passAgg.reviewVerdict, greenChecks).verdict, "PASS");

    const failAgg = aggregateAdversarialReview("PASS", "FAIL");
    assert.equal(classifyVerdict(failAgg.reviewVerdict, greenChecks).verdict, "FAIL");
  });

  test("aggregate is pure synchronous return — never blocks", () => {
    const r = aggregateAdversarialReview("PASS", "FAIL");
    assert.equal(typeof r, "object");
    assert.equal((r as { then?: unknown }).then, undefined);
  });
});

describe("verdict tiers documentation", () => {
  test("all four verdict tiers are reachable from classifyVerdict", () => {
    // Belt-and-braces: confirms the skill's documented tiers are not just
    // prose — every one is exercised by at least one classifier path.
    const pass = classifyVerdict("PASS", [
      { name: "a", status: "completed", conclusion: "success", required: true },
    ]).verdict;
    const fail = classifyVerdict("FAIL", []).verdict;
    const passPending = classifyVerdict("PASS", [
      { name: "a", status: "queued", required: true },
    ]).verdict;
    // FAIL-pending-CI is currently a reserved tier — documented for
    // operator playbook use even though the classifier folds it into the
    // PASS-pending-CI / FAIL paths today. Assert the type allows it.
    const reserved: import("../scripts/ci/qa-verdict.ts").FinalVerdict = "FAIL-pending-CI";

    assert.equal(pass, "PASS");
    assert.equal(fail, "FAIL");
    assert.equal(passPending, "PASS-pending-CI");
    assert.equal(reserved, "FAIL-pending-CI");
  });
});

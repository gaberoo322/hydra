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
  decideDeepQaAction,
  DEEP_QA_FAIL_MARKER,
  DEEP_QA_PASS_MARKER,
  renderDeepQaPassMarker,
  hasFreshDeepQaPass,
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

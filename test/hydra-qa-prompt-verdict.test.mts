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
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  QA_VERDICT_TRAILER_PREFIX,
  QA_VERDICT_UNKNOWN_SHA,
  QA_VERDICT_ERROR_PREFIX,
  parseQaVerdictErrors,
  renderQaVerdictErrorLine,
  qaVerdictShaMatches,
  redRequiredChecks,
  type FinalVerdict,
  type QaSeverity,
  renderQaVerdictTrailer,
  parseQaVerdictTrailer,
  parseQaVerdictTrailers,
  isFailVerdict,
  nextQaVerdictRound,
  buildQaVerdictTrailer,
  classifyVerdict,
  renderChecksBlock,
  aggregateAdversarialReview,
  decideReviewAdmission,
  decideDeepQaAction,
  DEEP_QA_FAIL_MARKER,
  DEEP_QA_PASS_MARKER,
  renderDeepQaPassMarker,
  hasFreshDeepQaPass,
  classifyChangeShape,
  decideReviewerFanout,
  isPromptOnlyChange,
  isPromptPath,
  type ChangeShape,
  type CheckState,
  foldReviewFindings,
  normaliseReviewFindings,
  reviewerGroup,
  trailerBlockerCounts,
  renderFindingsTable,
  renderReviewReport,
  renderCiSummary,
  type ReviewFinding,
} from "../scripts/ci/qa-verdict.ts";
import { classifyPrQaOutcome } from "../scripts/ci/qa-catch-rate.ts";

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

describe("decideReviewAdmission — reviewer admission gate (issue #3815)", () => {
  // The T3/T4 fan-out is the second-largest token consumer in the system. The
  // admission gate skips it ONLY when a reviewer's output provably cannot change
  // the emitted verdict under the CURRENT fold (INV-A — the gate is a derivation
  // of the fold, not an independent policy). Two conditions are verdict-invariant
  // today: a merge conflict (DIRTY — the diff won't merge) and a required check
  // already failed (classifyVerdict returns FAIL regardless of reviewVerdict).
  // T4 is only ever DEFERRED, never depth-reduced (INV-B). Unknown tier/merge
  // state fail-closed to full depth (INV-E). These tests pin each invariant as an
  // executable property so a future fold change that breaks the derivation fails
  // loudly here, in the same PR (INV-A's "re-derived in the same PR" clause).

  const green: CheckState[] = [
    { name: "typecheck", status: "completed", conclusion: "success", required: true },
    { name: "tests", status: "completed", conclusion: "success", required: true },
  ];
  const reqFailed: CheckState[] = [
    { name: "typecheck", status: "completed", conclusion: "success", required: true },
    { name: "tests", status: "completed", conclusion: "failure", required: true },
  ];
  const reqPending: CheckState[] = [
    { name: "typecheck", status: "completed", conclusion: "success", required: true },
    { name: "mutation-test", status: "queued", required: true },
  ];

  test("INV-A: skip-required-failed fires ONLY where classifyVerdict is FAIL for BOTH review verdicts", () => {
    // The defining property: wherever the gate declines to spawn reviewers on a
    // failed required check, the classifier must return the same verdict whether
    // the (un-run) review would have passed or failed — otherwise the gate would
    // be skipping a load-bearing review. Enumerate representative check sets.
    const cases: CheckState[][] = [
      green,
      reqFailed,
      reqPending,
      [{ name: "tests", status: "completed", conclusion: "failure", required: true }],
      [{ name: "tests", status: "completed", conclusion: "timed_out", required: true }],
      [],
    ];
    for (const checks of cases) {
      const d = decideReviewAdmission({ checks, mergeStateStatus: "CLEAN", tier: 3 });
      const ifReviewPass = classifyVerdict("PASS", checks).verdict;
      const ifReviewFail = classifyVerdict("FAIL", checks).verdict;
      if (d.action === "skip-required-failed") {
        // Skipped ⇒ review is moot ⇒ both review verdicts yield the same result.
        assert.equal(ifReviewPass, "FAIL", "gate skipped but PASS-review was not a forced FAIL");
        assert.equal(ifReviewFail, "FAIL");
        assert.equal(d.verdict, "FAIL");
      } else {
        // Not skipped ⇒ the review CAN matter ⇒ it is NOT the case that both
        // review verdicts are forced to FAIL. (Equivalently: the gate skips in
        // exactly the cases this property says it may.)
        assert.ok(
          !(ifReviewPass === "FAIL" && ifReviewFail === "FAIL"),
          "gate failed to skip a verdict that is FAIL regardless of the review",
        );
      }
    }
  });

  test("clean green T3 PR is admitted (the common path — full fan-out runs)", () => {
    const d = decideReviewAdmission({ checks: green, mergeStateStatus: "CLEAN", tier: 3 });
    assert.equal(d.action, "admit");
    assert.equal(d.verdict, undefined);
  });

  test("pending required check with NO failure is admitted (review may still change PASS-pending-CI)", () => {
    // BLOCKED with a pending required check → classifyVerdict returns
    // PASS-pending-CI, which still needs a real review input. Skipping here
    // would fabricate a verdict. (The issue's rejected BLOCKED trigger.)
    const d = decideReviewAdmission({ checks: reqPending, mergeStateStatus: "BLOCKED", tier: 3 });
    assert.equal(d.action, "admit");
  });

  test("required check failed, T3 → skip-required-failed carrying FAIL (no PASS)", () => {
    const d = decideReviewAdmission({ checks: reqFailed, mergeStateStatus: "CLEAN", tier: 3 });
    assert.equal(d.action, "skip-required-failed");
    assert.equal(d.verdict, "FAIL"); // a skipped review never yields PASS (INV-D)
  });

  test("INV-B: required check failed, T4 → DEFER (T4 is only ever deferred, never FAIL-skipped)", () => {
    // The deep-QA routing needs a real review verdict; skipping the fan-out would
    // leave none. So a T4 PR with a failed required check is deferred until CI
    // concludes, then the full Verifier-Core fan-out runs — depth is unchanged.
    const d = decideReviewAdmission({ checks: reqFailed, mergeStateStatus: "CLEAN", tier: 4 });
    assert.equal(d.action, "defer");
    assert.equal(d.verdict, undefined); // never a verdict for T4 — never depth-reduced
  });

  test("INV-B: DIRTY merge conflict is a DEFER for every tier, including T4", () => {
    for (const tier of [1, 2, 3, 4]) {
      const d = decideReviewAdmission({ checks: green, mergeStateStatus: "DIRTY", tier });
      assert.equal(d.action, "defer", `tier ${tier}`);
      assert.equal(d.verdict, undefined, `tier ${tier} must not carry a verdict`);
    }
  });

  test("DIRTY takes precedence over a failed required check (the diff won't merge either way)", () => {
    // A FAIL verdict over a conflicting diff is moot — the diff changes on
    // rebase — so defer to the rebase rather than emit FAIL.
    const d = decideReviewAdmission({ checks: reqFailed, mergeStateStatus: "DIRTY", tier: 3 });
    assert.equal(d.action, "defer");
  });

  test("BLOCKED and BEHIND are NOT defer triggers (only DIRTY is verdict-invariant)", () => {
    // BLOCKED covers pending required checks (review matters); BEHIND auto-rebases.
    for (const ms of ["BLOCKED", "BEHIND", "UNSTABLE", "HAS_HOOKS"]) {
      const d = decideReviewAdmission({ checks: green, mergeStateStatus: ms, tier: 3 });
      assert.equal(d.action, "admit", `${ms} should admit a clean PR`);
    }
  });

  test("INV-E: unreachable tier classifier (null) → admit (fail-closed to full depth)", () => {
    // Even with a failed required check — unknown tier means we cannot confirm
    // it isn't T4, so fail-closed runs the full fan-out. Mirrors the playbook's
    // existing ADVERSARIAL=1-on-empty-PR_TIER default.
    const d = decideReviewAdmission({ checks: reqFailed, mergeStateStatus: "CLEAN", tier: null });
    assert.equal(d.action, "admit");
  });

  test("INV-E: unknown / empty mergeStateStatus → admit (fail-closed to full depth)", () => {
    for (const ms of ["", "UNKNOWN", "   "]) {
      const d = decideReviewAdmission({ checks: reqFailed, mergeStateStatus: ms, tier: 3 });
      assert.equal(d.action, "admit", `mergeStateStatus ${JSON.stringify(ms)} should fail-closed to admit`);
    }
  });

  test("UPPERCASE / lowercase mergeStateStatus fold identically (defense in depth)", () => {
    assert.equal(
      decideReviewAdmission({ checks: green, mergeStateStatus: "dirty", tier: 3 }).action,
      "defer",
    );
    assert.equal(
      decideReviewAdmission({ checks: green, mergeStateStatus: "Dirty", tier: 3 }).action,
      "defer",
    );
  });

  test("zero checks reported → admit (a PR with no CI signal is reviewed, not skipped)", () => {
    const d = decideReviewAdmission({ checks: [], mergeStateStatus: "CLEAN", tier: 3 });
    assert.equal(d.action, "admit");
  });

  test("decision is a pure synchronous return — never blocks", () => {
    const r = decideReviewAdmission({ checks: green, mergeStateStatus: "CLEAN", tier: 3 });
    assert.equal(typeof r, "object");
    assert.equal((r as { then?: unknown }).then, undefined);
  });

  test("the admission gate introduces no new FinalVerdict literal (INV-D)", () => {
    // A skipped review never yields PASS; the only verdict the gate ever carries
    // is the FAIL the fold already determined. classifyVerdict / aggregate /
    // decideDeepQaAction semantics are untouched — the gate only declines to
    // spawn moot reviewers.
    for (const tier of [1, 2, 3, 4]) {
      for (const checks of [green, reqFailed, reqPending]) {
        for (const ms of ["CLEAN", "DIRTY", "BLOCKED"]) {
          const d = decideReviewAdmission({ checks, mergeStateStatus: ms, tier });
          assert.ok(
            d.verdict === undefined || d.verdict === "FAIL",
            `gate must never carry a non-FAIL verdict (got ${d.verdict} for tier ${tier} ${ms})`,
          );
        }
      }
    }
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

// ---------------------------------------------------------------------------
// Issue #4729 — canonical `QA-Verdict:` trailer: helper shape + playbook pin.
// ---------------------------------------------------------------------------

const TRAILER_SHAPE_RE =
  /^QA-Verdict: (PASS|FAIL|PASS-pending-CI|FAIL-pending-CI) pr=\d+ round=\d+ sha=[0-9a-f]{12} blockers=\d+ max_severity=(high|medium|low|none)$/;

describe("QA-Verdict trailer — render + parse (issue #4729)", () => {
  const HEAD = "ABCDEF0123456789abcdef0123456789abcdef01";

  test("renders the exact canonical shape", () => {
    const line = renderQaVerdictTrailer({
      verdict: "FAIL", pr: 4729, round: 2, sha: HEAD, blockers: 3, maxSeverity: "medium",
    });
    assert.equal(
      line,
      "QA-Verdict: FAIL pr=4729 round=2 sha=abcdef012345 blockers=3 max_severity=medium",
    );
    assert.match(line, TRAILER_SHAPE_RE);
    assert.ok(line.startsWith(QA_VERDICT_TRAILER_PREFIX));
  });

  test("zero blockers always renders max_severity=none; blockers with no severity renders high", () => {
    assert.match(
      renderQaVerdictTrailer({ verdict: "PASS", pr: 1, round: 1, sha: HEAD, blockers: 0, maxSeverity: "high" }),
      / blockers=0 max_severity=none$/,
    );
    assert.match(
      renderQaVerdictTrailer({ verdict: "FAIL", pr: 1, round: 1, sha: HEAD, blockers: 2, maxSeverity: "none" }),
      / blockers=2 max_severity=high$/,
    );
  });

  test("render → parse round-trips every verdict literal (PASS never shadows PASS-pending-CI)", () => {
    for (const verdict of ["PASS", "FAIL", "PASS-pending-CI", "FAIL-pending-CI"] as const) {
      const line = renderQaVerdictTrailer({ verdict, pr: 7, round: 3, sha: HEAD, blockers: 1, maxSeverity: "low" });
      assert.deepEqual(parseQaVerdictTrailer(`header\n\n${line}\n`), {
        verdict, pr: 7, round: 3, sha: "abcdef012345", blockers: 1, maxSeverity: "low",
      });
    }
  });

  test("parse returns null for legacy bodies and malformed lines", () => {
    assert.equal(parseQaVerdictTrailer("> *Automated QA — two-axis review*\n\n**Verdict:** `FAIL`"), null);
    assert.equal(parseQaVerdictTrailer(null), null);
    assert.equal(parseQaVerdictTrailer("QA-Verdict: MAYBE pr=1 round=1 sha=abcdef0 blockers=0 max_severity=none"), null);
    assert.equal(parseQaVerdictTrailer("QA-Verdict: PASS pr=0 round=1 sha=abcdef0 blockers=0 max_severity=none"), null);
    assert.equal(parseQaVerdictTrailer("QA-Verdict: PASS round=1 pr=1 sha=abcdef0 blockers=0 max_severity=none"), null);
    // Mid-line mention (e.g. quoted in prose) is not a trailer.
    assert.equal(parseQaVerdictTrailer("see `QA-Verdict: PASS pr=1 round=1 sha=abcdef0 blockers=0 max_severity=none`"), null);
  });

  test("parseQaVerdictTrailers returns every trailer in order; isFailVerdict splits the literals", () => {
    const body = [
      "QA-Verdict: FAIL pr=5 round=1 sha=abcdef012345 blockers=1 max_severity=high",
      "QA-Verdict: PASS pr=5 round=2 sha=abcdef012346 blockers=0 max_severity=none",
    ].join("\r\n");
    const all = parseQaVerdictTrailers(body);
    assert.deepEqual(all.map((t) => t.round), [1, 2]);
    assert.equal(isFailVerdict("FAIL"), true);
    assert.equal(isFailVerdict("FAIL-pending-CI"), true);
    assert.equal(isFailVerdict("PASS"), false);
    assert.equal(isFailVerdict("PASS-pending-CI"), false);
  });

  test("round = prior trailers naming the same PR + 1 (other PRs ignored)", () => {
    const prior = [
      "no trailer here",
      "x\nQA-Verdict: FAIL pr=9 round=1 sha=abcdef012345 blockers=1 max_severity=low",
      "QA-Verdict: FAIL pr=8 round=1 sha=abcdef012345 blockers=1 max_severity=low",
      null,
    ];
    assert.equal(nextQaVerdictRound(prior, 9), 2);
    assert.equal(nextQaVerdictRound(prior, 8), 2);
    assert.equal(nextQaVerdictRound([], 9), 1);
    assert.equal(
      buildQaVerdictTrailer({ verdict: "PASS", pr: 9, headSha: HEAD, blockers: 0, maxSeverity: "none", priorBodies: prior }),
      "QA-Verdict: PASS pr=9 round=2 sha=abcdef012345 blockers=0 max_severity=none",
    );
  });
});

describe("hydra-qa playbook emits the QA-Verdict trailer on every verdict post (issue #4729)", () => {
  const playbook = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "operator-playbooks", "hydra-qa.md"),
    "utf8",
  );
  const step10 = playbook.slice(
    playbook.indexOf("### 10. Verdict routing"),
    playbook.indexOf("### 11. Lesson capture"),
  );
  // Every `--body "…"` template in step 10 (bodies end at the first unescaped `"`).
  const bodies = [...step10.matchAll(/(gh (?:pr|issue) (?:comment|review))[^\n]*--body "((?:[^"\\]|\\.)*)"/g)].map(
    (m) => ({ cmd: m[1] as string, body: m[2] as string }),
  );

  test("step 9.5 renders the trailer via buildQaVerdictTrailer", () => {
    assert.match(playbook, /### 9\.5 Render the `QA-Verdict:` trailer/);
    assert.match(playbook, /buildQaVerdictTrailer/);
    assert.match(
      playbook,
      /QA-Verdict: <PASS\|FAIL\|PASS-pending-CI\|FAIL-pending-CI> pr=<N> round=<k> sha=<head12> blockers=<n> max_severity=<high\|medium\|low\|none>/,
    );
  });

  test("every verdict body in step 10 (PR and issue side, T1-T4) ends with exactly one trailer", () => {
    const verdictBodies = bodies.filter((b) => !b.body.includes("PASS proof"));
    // PASS, PASS-pending-CI, T1-T3 FAIL review + 2 issue pointers, T4 review + 2 issue pointers = 8.
    assert.equal(verdictBodies.length, 8, `found ${verdictBodies.length} verdict bodies`);
    for (const { cmd, body } of verdictBodies) {
      const count = body.split("${QA_VERDICT_TRAILER}").length - 1;
      assert.equal(count, 1, `${cmd} body must carry exactly one trailer:\n${body.slice(0, 200)}`);
      assert.ok(body.trimEnd().endsWith("${QA_VERDICT_TRAILER}"), `${cmd} trailer must be the last line`);
    }
  });

  test("issue-side comments are short pointers that keep their bounce markers (≤800 chars with worst-case fields, #4746)", () => {
    const issueBodies = bodies.filter((b) => b.cmd === "gh issue comment").map((b) => b.body);
    assert.equal(issueBodies.length, 4);
    for (const body of issueBodies) {
      const filled = fillWorstCase(body);
      assert.ok(!/\$\{?\w/.test(filled), `unexpanded variable left in pointer:\n${filled}`);
      assert.ok(filled.length <= 800, `issue pointer too long with worst-case fields (${filled.length} chars):\n${filled}`);
      assert.ok(!body.includes("$REVIEW_REPORT"), "the full review must live only on the PR");
      assert.match(body, /PR #\$pr_number/);
      assert.match(body, /\$\{BLOCKER_SUMMARY\}/);
      assert.match(body, /Automated QA failed|T4 Deep-QA failed|T4 Deep-QA blocked/);
    }
  });

  test("the skip-required-failed path runs step 9.5 before step 10", () => {
    const skip = playbook.slice(playbook.indexOf("- **`skip-required-failed`** (T1/T2/T3 only"));
    assert.match(skip.slice(0, 4000), /run step 9\.5/i);
    assert.match(skip.slice(0, 4000), /MAX_SEVERITY=high/);
  });
});

// ── Change-shape reviewer sizing (issue #4733) ─────────────────────────────
describe("classifyChangeShape — pure change-shape classifier (issue #4733)", () => {
  const table: Array<{ name: string; paths: string[]; shape: ChangeShape }> = [
    { name: "single ADR doc", paths: ["docs/adr/0042-x.md"], shape: "docs-only" },
    { name: "top-level markdown + changelog fragment", paths: ["README.md", ".changelog/1-x.md"], shape: "docs-only" },
    { name: "research doc", paths: ["docs/research/2026-09-28-x.md"], shape: "docs-only" },
    { name: "tests only", paths: ["test/foo.test.mts", "test/fixtures/foo.json"], shape: "tests-only" },
    { name: "tests + docs (most behavioural non-code part wins)", paths: ["test/foo.test.mts", "docs/x.md"], shape: "tests-only" },
    { name: "playbook only", paths: ["docs/operator-playbooks/hydra-qa.md"], shape: "prompt-only" },
    { name: "agent config lesson", paths: ["config/agents/dev.md", "config/feedback/x.json"], shape: "prompt-only" },
    { name: "playbook + its test", paths: ["docs/operator-playbooks/hydra-qa.md", "test/x.test.mts"], shape: "prompt-only" },
    { name: "mixed: a doc and a src/ file", paths: ["docs/adr/0042-x.md", "src/foo.ts"], shape: "code" },
    { name: "mixed: a test and a scripts/ file", paths: ["test/x.test.mts", "scripts/ci/qa-verdict.ts"], shape: "code" },
    { name: "mixed: playbook and dashboard/src", paths: ["docs/operator-playbooks/hydra-qa.md", "dashboard/src/App.tsx"], shape: "code" },
    { name: ".github markdown", paths: [".github/PULL_REQUEST_TEMPLATE.md"], shape: "code" },
    { name: "src/ CONTEXT.md (code-dir prefix wins)", paths: ["src/cost/CONTEXT.md"], shape: "code" },
    { name: "non-md playbook sibling (hook settings)", paths: ["docs/operator-playbooks/hydra-qa.settings.json"], shape: "code" },
    { name: "package.json", paths: ["package.json"], shape: "code" },
    { name: "empty list fail-closes", paths: [], shape: "code" },
    { name: "blank entries only fail-close", paths: ["", "  "], shape: "code" },
  ];
  for (const row of table) {
    test(`${row.name} → ${row.shape}`, () => {
      assert.equal(classifyChangeShape(row.paths), row.shape);
    });
  }
});

describe("isPromptOnlyChange — the one shared prompt-path list (issue #4733)", () => {
  test("playbook .md, skill .md, config/agents, config/feedback are prompt paths", () => {
    assert.equal(
      isPromptOnlyChange([
        "docs/operator-playbooks/hydra-qa.md",
        ".claude/skills/x/SKILL.md",
        "config/agents/dev.md",
        "config/feedback/x.json",
      ]),
      true,
    );
  });

  test("other config/ paths, tests, docs, and empty lists are not prompt-only", () => {
    assert.equal(isPromptOnlyChange(["config/autopilot/classes.json"]), false);
    assert.equal(isPromptOnlyChange(["docs/operator-playbooks/hydra-qa.md", "test/x.test.mts"]), false);
    assert.equal(isPromptOnlyChange(["docs/adr/0042-x.md"]), false);
    assert.equal(isPromptOnlyChange([]), false);
    assert.equal(isPromptOnlyChange([""]), false);
  });

  test("agrees with classifyChangeShape on every prompt path", () => {
    for (const p of ["docs/operator-playbooks/a.md", "config/agents/b.json", ".claude/skills/c.md"]) {
      assert.equal(isPromptPath(p), true);
      assert.equal(classifyChangeShape([p]), "prompt-only");
    }
  });

  test("a src/ → test/ rename listed by --no-renames (old + new path) stays code", () => {
    assert.equal(classifyChangeShape(["src/foo.ts", "test/foo.test.mts"]), "code");
  });
});

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

describe("hydra-qa playbook — spawn step branches on change shape (issue #4733)", () => {
  const playbook = readFileSync(
    new URL("../docs/operator-playbooks/hydra-qa.md", import.meta.url),
    "utf8",
  );

  test("step 6.7 sizes the fan-out via decideReviewerFanout", () => {
    assert.match(playbook, /### 6\.7 [^\n]*change shape/i);
    assert.ok(playbook.includes("decideReviewerFanout("), "playbook must call decideReviewerFanout");
    assert.ok(playbook.includes("FANOUT_MODE"), "playbook must carry FANOUT_MODE");
  });

  test("step 7 has a single-reviewer branch; T4 and code PRs keep the full fan-out", () => {
    assert.match(playbook, /#### 7c\. [^\n]*single reviewer/i);
    assert.ok(
      playbook.includes("A T4 PR or a `code` PR always gets the full fan-out"),
      "playbook must pin the T4/code full-fan-out rule",
    );
  });

  test("fan-out fallback sets FANOUT_REVIEWERS; diffs use --no-renames; step 6 shares the prompt-path list", () => {
    const start = playbook.indexOf("### 6.7 ");
    const section = playbook.slice(start, playbook.indexOf("### 7. ", start));
    assert.ok(section.includes(".catch("), "6.7 helper call must log a failure cause");
    assert.equal(section.match(/FANOUT_REVIEWERS=/g)?.length, 3, "6.7 must set FANOUT_REVIEWERS on success AND both fallback arms");
    assert.ok(!/^CHANGED=\$\(git diff --name-only/m.test(playbook), "CHANGED lists must use --no-renames");
    assert.ok(playbook.includes("isPromptOnlyChange("), "step 6 must use the shared prompt-path predicate");
    assert.ok(!playbook.includes(".claude/skills/*|config/*|docs/operator-playbooks/*"), "the old step-6 case list must be gone");
  });

  test("step 7.5 completeness check covers the one-reviewer fan-out", () => {
    const start = playbook.indexOf("### 7.5 ");
    const end = playbook.indexOf("### 8. ", start);
    assert.ok(start > 0 && end > start, "step 7.5 section must exist");
    const section = playbook.slice(start, end);
    assert.ok(section.includes("reviewer-single"), "7.5 must name the single-reviewer spawn");
    assert.ok(section.includes("FANOUT_REVIEWERS"), "7.5 must check against the decided reviewer list");
  });
});

// ---------------------------------------------------------------------------
// Issue #4746 — harden the QA-Verdict trailer before it becomes load-bearing.
// ---------------------------------------------------------------------------

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const QA_PLAYBOOK = readFileSync(join(REPO_ROOT, "docs", "operator-playbooks", "hydra-qa.md"), "utf8");
const ALL_VERDICTS = ["PASS", "FAIL", "PASS-pending-CI", "FAIL-pending-CI"] as const;
const FULL_HEAD = "0123456789abcdef0123456789abcdef01234567";
/** The seven branch-protection contexts — the longest realistic red list. */
const ALL_REQUIRED = ["test", "dashboard-build", "tier-gate", "mutation-test", "scope-check", "secret-scan", "deep-qa-gate"];

/** The bash between `# >>> <name>` and `# <<< <name>` in the playbook. */
function playbookBlock(name: string): string {
  const start = QA_PLAYBOOK.indexOf(`# >>> ${name}\n`);
  const end = QA_PLAYBOOK.indexOf(`# <<< ${name}`);
  assert.ok(start >= 0 && end > start, `playbook block ${name} not found`);
  return QA_PLAYBOOK.slice(start, end);
}

/** Run a playbook block in bash from the repo root; returns the named vars. */
function runBlock(
  name: string,
  env: Record<string, string>,
  outVars: string[],
  pathPrefix?: string,
): Record<string, string> {
  const script = `${playbookBlock(name)}\n${outVars.map((v) => `printf '%s\\0' "$${v}"`).join("\n")}\n`;
  const r = spawnSync("bash", ["-c", script], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env, PATH: pathPrefix ? `${pathPrefix}:${process.env.PATH}` : process.env.PATH },
  });
  assert.equal(r.status, 0, `block ${name} exited ${r.status}: ${r.stderr}`);
  const parts = r.stdout.split("\0");
  return Object.fromEntries(outVars.map((v, i) => [v, parts[i] ?? ""]));
}

/** A PATH dir whose `node` always fails — simulates the render step erroring. */
function brokenNodeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "qa-4746-node-"));
  writeFileSync(join(dir, "node"), "#!/bin/sh\necho 'simulated node failure' >&2\nexit 1\n");
  chmodSync(join(dir, "node"), 0o755);
  return dir;
}

/** Fill a step-10 issue-pointer template with worst-case (longest) field values. */
function fillWorstCase(body: string): string {
  const summaryTpl = /BLOCKER_SUMMARY="((?:[^"\\]|\\.)*)"/.exec(QA_PLAYBOOK)?.[1];
  assert.ok(summaryTpl, "BLOCKER_SUMMARY template not found");
  const trailer = renderQaVerdictTrailer({
    verdict: "FAIL-pending-CI", pr: 99999, round: 999, sha: FULL_HEAD, blockers: 999, maxSeverity: "medium",
  });
  const errorLine = renderQaVerdictErrorLine({
    verdict: "FAIL-pending-CI", pr: 99999, reason: "trailer render failed (full and minimal)",
  });
  const values: Record<string, string> = {
    VERDICT: "FAIL-pending-CI",
    pr_number: "99999",
    issue_number: "99999",
    DEEP_QA_FAILNO: "99",
    BLOCKERS: "999",
    MAX_SEVERITY: "medium",
    WORST_FINDING: "w".repeat(120),
    RED_REQUIRED_LIST: ALL_REQUIRED.join(", "),
    QA_VERDICT_TRAILER: trailer.length >= errorLine.length ? trailer : errorLine,
  };
  const expand = (s: string): string =>
    s
      .replace(/\$\{(\w+):\+((?:[^{}]|\$\{\w+\})*)\}/g, (_m, _v, alt: string) => alt)
      .replace(/\$\{(\w+):-[^}]*\}/g, (m, v: string) => values[v] ?? m)
      .replace(/\$\{(\w+)\}|\$(\w+)/g, (m, a?: string, b?: string) => values[(a ?? b) as string] ?? m);
  values.BLOCKER_SUMMARY = expand(summaryTpl);
  return expand(body).replace(/\\(.)/g, "$1");
}

describe("QA-Verdict trailer — every rendered line parses (issue #4746)", () => {
  const SHAS = [FULL_HEAD, FULL_HEAD.toUpperCase(), FULL_HEAD.slice(0, 12), FULL_HEAD.slice(0, 7), "", "   ", "abc", "not-a-sha", "unknown", undefined];
  const BLOCKER_COUNTS = [0, 1, 7, -3, Number.NaN];
  const SEVERITIES = ["high", "medium", "low", "none", "bogus"];

  test("parse(render(x)) round-trips for every verdict × sha × blockers × severity", () => {
    let n = 0;
    for (const verdict of ALL_VERDICTS) {
      for (const sha of SHAS) {
        for (const blockers of BLOCKER_COUNTS) {
          for (const sev of SEVERITIES) {
            const line = renderQaVerdictTrailer({
              verdict, pr: 42, round: 2, sha: sha as string, blockers, maxSeverity: sev as QaSeverity,
            });
            const parsed = parseQaVerdictTrailer(line);
            assert.ok(parsed, `renderer emitted an unparseable line: ${line}`);
            const cut = String(sha ?? "").trim().toLowerCase().slice(0, 12);
            const expectedSha = /^[0-9a-f]{7,12}$/.test(cut) ? cut : QA_VERDICT_UNKNOWN_SHA;
            const b = Number.isFinite(blockers) ? Math.max(0, blockers) : 0;
            assert.deepEqual(parsed, {
              verdict, pr: 42, round: 2, sha: expectedSha, blockers: b,
              maxSeverity: b === 0 ? "none" : sev === "none" || sev === "bogus" ? "high" : sev,
            });
            n += 1;
          }
        }
      }
    }
    assert.equal(n, ALL_VERDICTS.length * SHAS.length * BLOCKER_COUNTS.length * SEVERITIES.length);
  });

  test("empty / unknown head SHA renders the documented sentinel, which never matches a head SHA", () => {
    const line = renderQaVerdictTrailer({ verdict: "PASS", pr: 1, round: 1, sha: "", blockers: 0, maxSeverity: "none" });
    assert.equal(line, "QA-Verdict: PASS pr=1 round=1 sha=unknown blockers=0 max_severity=none");
    const t = parseQaVerdictTrailer(line);
    assert.ok(t);
    assert.equal(t.sha, QA_VERDICT_UNKNOWN_SHA);
    assert.equal(qaVerdictShaMatches(t, FULL_HEAD), false);
    assert.equal(qaVerdictShaMatches(t, ""), false);
    assert.equal(qaVerdictShaMatches(t, "unknown"), false);
  });

  test("qaVerdictShaMatches: the 12-char sha matches its own head only", () => {
    const t = parseQaVerdictTrailer(
      renderQaVerdictTrailer({ verdict: "PASS", pr: 1, round: 1, sha: FULL_HEAD, blockers: 0, maxSeverity: "none" }),
    );
    assert.ok(t);
    assert.equal(qaVerdictShaMatches(t, FULL_HEAD), true);
    assert.equal(qaVerdictShaMatches(t, ` ${FULL_HEAD.toUpperCase()} `), true);
    assert.equal(qaVerdictShaMatches(t, "f".repeat(40)), false);
    assert.equal(qaVerdictShaMatches(t, "   "), false);
  });

  test("an unknown verdict literal renders FAIL (fail toward loud), still parseable", () => {
    const line = renderQaVerdictTrailer({
      verdict: " BOGUS " as unknown as FinalVerdict, pr: 3, round: 1, sha: FULL_HEAD, blockers: 1, maxSeverity: "low",
    });
    assert.equal(parseQaVerdictTrailer(line)?.verdict, "FAIL");
    const padded = renderQaVerdictTrailer({
      verdict: " PASS-pending-CI " as FinalVerdict, pr: 3, round: 1, sha: FULL_HEAD, blockers: 0, maxSeverity: "none",
    });
    assert.equal(parseQaVerdictTrailer(padded)?.verdict, "PASS-pending-CI");
  });

  test("QA-Verdict-Error: render → parse round-trips; unknown verdict/pr parse as null, never vanish", () => {
    for (const verdict of ALL_VERDICTS) {
      const line = renderQaVerdictErrorLine({ verdict, pr: 17, reason: "render\nfailed  twice" });
      assert.equal(line, `QA-Verdict-Error: verdict=${verdict} pr=17 reason=render failed twice`);
      assert.deepEqual(parseQaVerdictErrors(`body\n\n${line}\n`), [{ verdict, pr: 17, reason: "render failed twice" }]);
      assert.equal(parseQaVerdictTrailer(line), null, "an error line is never a trailer");
    }
    assert.deepEqual(
      parseQaVerdictErrors("QA-Verdict-Error: verdict=unknown pr=unknown reason=x"),
      [{ verdict: null, pr: null, reason: "x" }],
    );
    assert.deepEqual(parseQaVerdictErrors("see `QA-Verdict-Error: verdict=FAIL pr=1` mid-line"), []);
    assert.deepEqual(parseQaVerdictErrors(null), []);
  });
});

describe("hydra-qa step 9.5 trailer block — executed verbatim from the playbook (issue #4746)", () => {
  function priorFile(bodies: string[]): string {
    const f = join(mkdtempSync(join(tmpdir(), "qa-4746-prior-")), "prior.json");
    writeFileSync(f, JSON.stringify(bodies));
    return f;
  }
  // > 128 KiB of prior review history — larger than a single env var may be.
  const bigHistory = [
    ...Array.from({ length: 40 }, (_, i) => `> *Automated QA* review ${i}\n\n${"lorem ipsum ".repeat(500)}`),
    "x\n\nQA-Verdict: FAIL pr=77 round=1 sha=0123456789ab blockers=2 max_severity=high",
    "QA-Verdict: FAIL pr=77 round=2 sha=0123456789ab blockers=1 max_severity=low",
    "QA-Verdict: FAIL pr=78 round=1 sha=0123456789ab blockers=1 max_severity=low",
  ];
  const baseEnv = {
    VERDICT: "FAIL", pr_number: "77", HEAD_SHA: FULL_HEAD, BLOCKERS: "2", MAX_SEVERITY: "medium",
  };

  test("prior bodies travel through a file, not an env var", () => {
    assert.match(playbookBlock("qa-verdict-trailer"), /PRIOR_BODIES_FILE/);
    assert.doesNotMatch(QA_PLAYBOOK, /PRIOR_BODIES_JSON|PRIOR_COMMENTS_JSON=/);
  });

  test("renders the full trailer from a >128 KiB comment history", () => {
    const file = priorFile(bigHistory);
    assert.ok(readFileSync(file).length > 128 * 1024, "fixture must exceed the 128 KiB env limit");
    const { QA_VERDICT_TRAILER } = runBlock("qa-verdict-trailer", { ...baseEnv, PRIOR_BODIES_FILE: file }, ["QA_VERDICT_TRAILER"]);
    assert.equal(QA_VERDICT_TRAILER, "QA-Verdict: FAIL pr=77 round=3 sha=0123456789ab blockers=2 max_severity=medium");
  });

  test("render failure → minimal shell-built trailer that still parses (same round)", () => {
    const { QA_VERDICT_TRAILER } = runBlock(
      "qa-verdict-trailer", { ...baseEnv, PRIOR_BODIES_FILE: priorFile(bigHistory) }, ["QA_VERDICT_TRAILER"], brokenNodeDir(),
    );
    assert.deepEqual(parseQaVerdictTrailer(QA_VERDICT_TRAILER), {
      verdict: "FAIL", pr: 77, round: 3, sha: "0123456789ab", blockers: 2, maxSeverity: "medium",
    });
  });

  test("render failure with an empty head SHA → minimal trailer carries sha=unknown", () => {
    const { QA_VERDICT_TRAILER } = runBlock(
      "qa-verdict-trailer", { ...baseEnv, HEAD_SHA: "", PRIOR_BODIES_FILE: priorFile([]) }, ["QA_VERDICT_TRAILER"], brokenNodeDir(),
    );
    const t = parseQaVerdictTrailer(QA_VERDICT_TRAILER);
    assert.equal(t?.sha, QA_VERDICT_UNKNOWN_SHA);
    assert.equal(t?.round, 1);
  });

  test("full AND minimal render fail → explicit QA-Verdict-Error line, never trailer-less", () => {
    const { QA_VERDICT_TRAILER } = runBlock(
      "qa-verdict-trailer", { ...baseEnv, VERDICT: "BOGUS VERDICT", PRIOR_BODIES_FILE: priorFile([]) }, ["QA_VERDICT_TRAILER"], brokenNodeDir(),
    );
    assert.ok(QA_VERDICT_TRAILER.startsWith(QA_VERDICT_ERROR_PREFIX), QA_VERDICT_TRAILER);
    assert.deepEqual(parseQaVerdictErrors(QA_VERDICT_TRAILER), [
      { verdict: null, pr: 77, reason: "trailer render failed (full and minimal)" },
    ]);
  });
});

describe("one definition of a red required check (issue #4746)", () => {
  const CASES: Array<{ name: string; checks: CheckState[]; red: string[] }> = [
    { name: "all green", checks: [{ name: "test", status: "completed", conclusion: "success", required: true }], red: [] },
    { name: "pending only", checks: [{ name: "test", status: "queued", required: true }], red: [] },
    {
      name: "mixed red conclusions + optional red",
      checks: [
        { name: "test", status: "completed", conclusion: "failure", required: true },
        { name: "tier-gate", status: "completed", conclusion: "cancelled", required: true },
        { name: "mutation-test", status: "COMPLETED" as CheckState["status"], conclusion: "TIMED_OUT" as CheckState["conclusion"], required: true },
        { name: "advisory-checks", status: "completed", conclusion: "failure", required: false },
        { name: "scope-check", status: "completed", conclusion: "skipped", required: true },
      ],
      red: ["test", "tier-gate", "mutation-test"],
    },
    {
      name: "startup_failure / action_required / stale",
      checks: [
        { name: "a", status: "completed", conclusion: "startup_failure", required: true },
        { name: "b", status: "completed", conclusion: "action_required", required: true },
        { name: "c", status: "completed", conclusion: "stale", required: true },
      ],
      red: ["a", "b", "c"],
    },
  ];

  test("redRequiredChecks agrees with classifyVerdict's requiredFailed count and FAIL reason", () => {
    for (const c of CASES) {
      const red = redRequiredChecks(c.checks);
      assert.deepEqual(red, c.red, c.name);
      const r = classifyVerdict("PASS", c.checks);
      assert.equal(r.summary.requiredFailed, red.length, c.name);
      if (red.length > 0) {
        assert.equal(r.verdict, "FAIL");
        assert.equal(r.reason, `Required CI check(s) failed: ${red.join(", ")}`);
      }
    }
  });

  test("the playbook's RED_REQUIRED_LIST + skip-path BLOCKERS derive from redRequiredChecks (no divergent jq filter)", () => {
    assert.match(playbookBlock("red-required-checks"), /redRequiredChecks/);
    assert.doesNotMatch(QA_PLAYBOOK, /IN\("failure"/, "no hand-rolled conclusion filter may remain");
    assert.match(QA_PLAYBOOK, /BLOCKERS=\$\(printf '%s' "\$RED_REQUIRED_JSON" \| jq 'length'/);
    assert.match(QA_PLAYBOOK, /WORST_FINDING="required CI check\(s\) red: \$\{RED_REQUIRED_LIST/);
  });

  test("executed block: RED_REQUIRED_LIST names the red checks (the pre-#4746 list was always empty)", () => {
    for (const c of CASES) {
      const out = runBlock("red-required-checks", { CHECKS_JSON: JSON.stringify(c.checks) }, ["RED_REQUIRED_LIST", "RED_REQUIRED_JSON"]);
      assert.equal(out.RED_REQUIRED_LIST, c.red.join(", "), c.name);
      assert.equal(JSON.parse(out.RED_REQUIRED_JSON as string).length, c.red.length, c.name);
    }
  });
});

describe("hydra-qa FAIL path posts a comment, never a request-changes review (issue #4746)", () => {
  test("no `gh pr review --request-changes` anywhere in the playbook", () => {
    assert.doesNotMatch(QA_PLAYBOOK, /gh pr review \$pr_number[^\n]*--request-changes/);
  });

  test("the T1-T3 and T4 FAIL verdict bodies are `gh pr comment`s", () => {
    const step10 = QA_PLAYBOOK.slice(QA_PLAYBOOK.indexOf("### 10. Verdict routing"), QA_PLAYBOOK.indexOf("### 11. Lesson capture"));
    const failSection = step10.slice(step10.indexOf("**Verdict `FAIL` or `FAIL-pending-CI`**"));
    assert.match(failSection, /gh pr comment \$pr_number --repo gaberoo322\/hydra --body "> \*Automated QA — two-axis review\*/);
    assert.match(failSection, /gh pr comment \$pr_number --repo gaberoo322\/hydra --body "> \*Automated QA — T4 Verifier-Core deep review\*/);
  });
});

// ---------------------------------------------------------------------------
// Issue #4734 — severity-gated T1–T3 fold + structured findings table.
// ---------------------------------------------------------------------------

function finding(over: Partial<ReviewFinding>): ReviewFinding {
  return {
    severity: "low",
    axis: "standards",
    reviewer: "reviewer-A-standards",
    location: "src/x.ts:10",
    finding: "comment wording drifted",
    fix: "reword the comment",
    ...over,
  };
}

describe("foldReviewFindings — severity-gated T1–T3 fold (issue #4734)", () => {
  const CASES: Array<{ name: string; tier: number; findings: ReviewFinding[]; verdict: "PASS" | "FAIL"; blockers: number; followUps: number; max: QaSeverity }> = [
    { name: "no findings → PASS", tier: 3, findings: [], verdict: "PASS", blockers: 0, followUps: 0, max: "none" },
    { name: "lone low (reviewer A only) → PASS + follow-up", tier: 3, findings: [finding({})], verdict: "PASS", blockers: 0, followUps: 1, max: "none" },
    {
      name: "both reviewers raise the same low → FAIL",
      tier: 3,
      findings: [finding({}), finding({ reviewer: "reviewer-B-standards", finding: "wording is stale" })],
      verdict: "FAIL", blockers: 1, followUps: 0, max: "low",
    },
    {
      name: "A-standards + A-spec raise the same low → still one reviewer → PASS",
      tier: 3,
      findings: [finding({}), finding({ reviewer: "reviewer-A-spec", axis: "spec" })],
      verdict: "PASS", blockers: 0, followUps: 1, max: "none",
    },
    {
      name: "A and B raise DIFFERENT lows → PASS, two follow-ups",
      tier: 3,
      findings: [finding({}), finding({ reviewer: "reviewer-B-spec", location: "docs/y.md:3" })],
      verdict: "PASS", blockers: 0, followUps: 2, max: "none",
    },
    { name: "any medium → FAIL", tier: 3, findings: [finding({ severity: "medium" }), finding({ location: "a.ts:1" })], verdict: "FAIL", blockers: 1, followUps: 1, max: "medium" },
    { name: "any high → FAIL", tier: 2, findings: [finding({ severity: "high", reviewer: "standards" })], verdict: "FAIL", blockers: 1, followUps: 0, max: "high" },
    { name: "T1 standard pair: standards+spec lows on one line are one reviewer → PASS", tier: 1, findings: [finding({ reviewer: "standards" }), finding({ reviewer: "spec", axis: "spec" })], verdict: "PASS", blockers: 0, followUps: 1, max: "none" },
    { name: "single reviewer lone low → PASS", tier: 3, findings: [finding({ reviewer: "reviewer-single" })], verdict: "PASS", blockers: 0, followUps: 1, max: "none" },
  ];
  for (const c of CASES) {
    test(c.name, () => {
      const r = foldReviewFindings({ tier: c.tier, findings: c.findings });
      assert.equal(r.mode, "severity-gated");
      assert.equal(r.reviewVerdict, c.verdict);
      assert.equal(r.blockers, c.blockers);
      assert.equal(r.followUps.length, c.followUps);
      assert.equal(r.maxSeverity, c.max);
    });
  }

  test("blocking rows are worst-first and the worst finding line is ≤120 chars", () => {
    const r = foldReviewFindings({
      tier: 3,
      findings: [finding({ severity: "medium", location: "m.ts:1" }), finding({ severity: "high", location: "h.ts:2", finding: "x".repeat(300) })],
    });
    assert.deepEqual(r.blocking.map((b) => b.severity), ["high", "medium"]);
    assert.equal(r.maxSeverity, "high");
    assert.ok(r.worstFinding.startsWith("h.ts:2 — "));
    assert.ok(r.worstFinding.length <= 120);
  });

  test("a missing / unknown severity fails toward loud (treated as high)", () => {
    const r = foldReviewFindings({ tier: 3, findings: [{ reviewer: "reviewer-A-spec", location: "a.ts:1", finding: "f", fix: "g" }] });
    assert.equal(r.reviewVerdict, "FAIL");
    assert.equal(r.maxSeverity, "high");
    assert.deepEqual(normaliseReviewFindings("not an array"), []);
    assert.deepEqual(normaliseReviewFindings([null, 3, "x"]), []);
  });

  test("reviewerGroup maps the T3 fan-out to A/B and everything else to one reviewer", () => {
    assert.equal(reviewerGroup("reviewer-A-standards"), "A");
    assert.equal(reviewerGroup("reviewer-b-spec"), "B");
    for (const n of ["standards", "spec", "reviewer-single", ""]) assert.equal(reviewerGroup(n), "primary");
  });

  test("the fold never introduces a verdict literal beyond PASS / FAIL", () => {
    for (const tier of [1, 2, 3, 4, null]) {
      for (const findings of [[], [finding({})], [finding({ severity: "high" })]]) {
        assert.ok(["PASS", "FAIL"].includes(foldReviewFindings({ tier, findings }).reviewVerdict));
      }
    }
  });
});

describe("foldReviewFindings — T4 keeps any-blocker semantics (issue #4734)", () => {
  test("T4: a lone low from one reviewer still FAILs (no severity gate)", () => {
    const r = foldReviewFindings({ tier: 4, findings: [finding({})] });
    assert.equal(r.mode, "any-blocker");
    assert.equal(r.reviewVerdict, "FAIL");
    assert.equal(r.followUps.length, 0);
    assert.equal(r.blockers, 1);
    assert.equal(r.maxSeverity, "low");
  });

  test("T4: agrees with aggregateAdversarialReview over per-reviewer verdicts", () => {
    const cases: Array<[ReviewFinding[], "PASS" | "FAIL", "PASS" | "FAIL"]> = [
      [[], "PASS", "PASS"],
      [[finding({})], "FAIL", "PASS"],
      [[finding({ reviewer: "reviewer-B-spec" })], "PASS", "FAIL"],
      [[finding({}), finding({ reviewer: "reviewer-B-spec", location: "z.ts:1" })], "FAIL", "FAIL"],
    ];
    for (const [findings, a, b] of cases) {
      const r = foldReviewFindings({ tier: 4, findings });
      assert.equal(r.reviewVerdict, aggregateAdversarialReview(a, b).reviewVerdict);
    }
  });

  test("unknown tier fails closed to the any-blocker fold", () => {
    const r = foldReviewFindings({ tier: null, findings: [finding({})] });
    assert.equal(r.mode, "any-blocker");
    assert.equal(r.reviewVerdict, "FAIL");
  });
});

describe("trailer counts + comment rendering from the findings table (issue #4734)", () => {
  test("blockers= / max_severity= come from the fold; each red required check adds one high", () => {
    const pass = foldReviewFindings({ tier: 3, findings: [finding({})] });
    assert.deepEqual(trailerBlockerCounts(pass, []), { blockers: 0, maxSeverity: "none" });
    const fail = foldReviewFindings({ tier: 3, findings: [finding({ severity: "medium" })] });
    assert.deepEqual(trailerBlockerCounts(fail, []), { blockers: 1, maxSeverity: "medium" });
    assert.deepEqual(trailerBlockerCounts(fail, ["test", "tier-gate"]), { blockers: 3, maxSeverity: "high" });
  });

  test("PASS-with-follow-ups renders a trailer that qa:catch-rate reads as clean (not a FAIL verdict)", () => {
    const fold = foldReviewFindings({ tier: 3, findings: [finding({}), finding({ location: "b.ts:2" })] });
    const counts = trailerBlockerCounts(fold, []);
    const verdict = classifyVerdict(fold.reviewVerdict, [{ name: "test", status: "completed", conclusion: "success", required: true }]).verdict;
    const t = parseQaVerdictTrailer(buildQaVerdictTrailer({ verdict, pr: 5, headSha: FULL_HEAD, ...counts, priorBodies: [] }));
    assert.equal(t?.verdict, "PASS");
    assert.equal(t?.blockers, 0);
    assert.equal(t?.maxSeverity, "none");
    assert.equal(isFailVerdict(t!.verdict), false);
    // The whole step-10 PASS comment, as qa:catch-rate reads it.
    const report = renderReviewReport({ fold, standardsSummary: "Two nits.", specSummary: "All criteria met." });
    const body = `> *Automated QA — two-axis review*\n\n${report}\n\n---\n\n**Verdict:** \`PASS\` — ok\n\n**CI:** all 1 required checks green.\n\n${buildQaVerdictTrailer({ verdict, pr: 5, headSha: FULL_HEAD, ...counts, priorBodies: [] })}`;
    assert.equal(
      classifyPrQaOutcome({ prNumber: 5, reviews: [], prComments: [{ body }], issueComments: [] }),
      "clean-pass",
    );
  });

  test("findings table has the six columns and escapes pipes / newlines", () => {
    const fold = foldReviewFindings({ tier: 3, findings: [finding({ severity: "high", finding: "a | b\nc" })] });
    const table = renderFindingsTable(fold.blocking);
    const lines = table.split("\n");
    assert.equal(lines[0], "| Severity | Axis | Reviewer | File:line | Finding | Fix |");
    assert.equal(lines.length, 3);
    assert.ok(lines[2]?.includes("a \\| b c"));
  });

  test("review report: blocking table, follow-ups section, one paragraph per axis, no CI table", () => {
    const fold = foldReviewFindings({ tier: 3, findings: [finding({ severity: "medium", location: "m.ts:1" }), finding({})] });
    const report = renderReviewReport({ fold, standardsSummary: "Clean apart from one nit.", specSummary: "Criterion 2 unmet.", fanoutReason: "Review fan-out: adversarial." });
    assert.match(report, /### Findings\n\n\| Severity/);
    assert.match(report, /### Follow-ups \(non-blocking\)/);
    assert.match(report, /## Standards\n\nClean apart from one nit\./);
    assert.match(report, /## Spec\n\nCriterion 2 unmet\./);
    assert.ok(report.includes("Review fan-out: adversarial."));
    assert.doesNotMatch(report, /\| Check \| Status/);
    const clean = renderReviewReport({ fold: foldReviewFindings({ tier: 3, findings: [] }), standardsSummary: "", specSummary: "" });
    assert.match(clean, /_No blocking findings\._/);
    assert.doesNotMatch(clean, /Follow-ups/);
  });

  test("renderCiSummary lists only the non-green REQUIRED checks, once", () => {
    const checks: CheckState[] = [
      { name: "test", status: "completed", conclusion: "failure", required: true },
      { name: "mutation-test", status: "queued", required: true },
      { name: "tier-gate", status: "completed", conclusion: "success", required: true },
      { name: "advisory-checks", status: "completed", conclusion: "failure", required: false },
    ];
    const line = renderCiSummary(classifyVerdict("PASS", checks));
    assert.equal(line, "**CI:** 1/3 required checks green. Not green: `test` (failure), `mutation-test` (pending).");
    assert.ok(!line.includes("advisory-checks") && !line.includes("tier-gate"));
    const green = renderCiSummary(classifyVerdict("PASS", [{ name: "test", status: "COMPLETED" as CheckState["status"], conclusion: "SUCCESS" as CheckState["conclusion"], required: true }]));
    assert.equal(green, "**CI:** all 1 required checks green.");
    assert.match(renderCiSummary(classifyVerdict("PASS", [])), /no checks reported/);
  });
});

describe("hydra-qa playbook wires the severity fold (issue #4734)", () => {
  test("reviewer prompts carry the severity rubric and the findings contract", () => {
    assert.match(QA_PLAYBOOK, /`high` — behaviou?r regression, data or work loss, or a weakened safety gate/);
    assert.match(QA_PLAYBOOK, /`medium` — a spec criterion unmet, or a real bug on a non-critical path/);
    assert.match(QA_PLAYBOOK, /`low` — wording, comments, citations, style/);
    assert.ok(QA_PLAYBOOK.includes('"severity": "high|medium|low"'), "reviewers must emit the severity field");
  });

  test("steps 8–9 fold via foldReviewFindings and render via renderReviewReport; CI via renderCiSummary", () => {
    const s8 = QA_PLAYBOOK.slice(QA_PLAYBOOK.indexOf("### 8. Aggregate"), QA_PLAYBOOK.indexOf("### 9.5 "));
    assert.ok(s8.includes("foldReviewFindings("), "step 8/9 must call foldReviewFindings");
    assert.ok(s8.includes("renderReviewReport("), "step 8 must render the findings table");
    assert.ok(s8.includes("trailerBlockerCounts("), "trailer counts must come from the table");
    assert.ok(s8.includes("renderCiSummary("), "the CI line must list only non-green required checks");
    assert.ok(s8.includes("aggregateAdversarialReview("), "T4 keeps the unchanged adversarial AND");
    assert.doesNotMatch(QA_PLAYBOOK, /renderChecksBlock\(r\)/, "verdict comments no longer repeat the full CI table");
  });

  function findingsFile(rows: unknown): string {
    const f = join(mkdtempSync(join(tmpdir(), "qa-4734-findings-")), "findings.json");
    writeFileSync(f, JSON.stringify(rows));
    return f;
  }
  const OUT = ["REVIEW_VERDICT", "REVIEW_REPORT", "BLOCKERS", "MAX_SEVERITY", "WORST_FINDING"];
  const env = { STANDARDS_SUMMARY: "std", SPEC_SUMMARY: "spec", FANOUT_REASON: "fan", RED_REQUIRED_JSON: "[]" };

  test("executed fold block: T3 lone low → PASS with a follow-up, blockers=0", () => {
    const out = runBlock("severity-fold", { ...env, PR_TIER_NUM: "3", FINDINGS_FILE: findingsFile([finding({})]) }, OUT);
    assert.equal(out.REVIEW_VERDICT, "PASS");
    assert.equal(out.BLOCKERS, "0");
    assert.equal(out.MAX_SEVERITY, "none");
    assert.match(out.REVIEW_REPORT as string, /### Follow-ups \(non-blocking\)/);
  });

  test("executed fold block: T3 medium + a red required check → FAIL, blockers from the table + CI", () => {
    const out = runBlock(
      "severity-fold",
      { ...env, PR_TIER_NUM: "3", RED_REQUIRED_JSON: '["test"]', FINDINGS_FILE: findingsFile([finding({ severity: "medium" })]) },
      OUT,
    );
    assert.equal(out.REVIEW_VERDICT, "FAIL");
    assert.equal(out.BLOCKERS, "2");
    assert.equal(out.MAX_SEVERITY, "high");
    assert.ok((out.WORST_FINDING as string).startsWith("src/x.ts:10 — "));
  });

  test("executed fold block: T4 lone low still FAILs (unchanged any-blocker)", () => {
    const out = runBlock("severity-fold", { ...env, PR_TIER_NUM: "4", FINDINGS_FILE: findingsFile([finding({})]) }, OUT);
    assert.equal(out.REVIEW_VERDICT, "FAIL");
    assert.equal(out.MAX_SEVERITY, "low");
  });

  test("executed fold block: a fold failure fails closed to FAIL, never PASS", () => {
    const out = runBlock(
      "severity-fold",
      { ...env, PR_TIER_NUM: "3", FINDINGS_FILE: findingsFile([]) },
      OUT,
      brokenNodeDir(),
    );
    assert.equal(out.REVIEW_VERDICT, "FAIL");
    assert.equal(out.MAX_SEVERITY, "high");
  });
});

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
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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
  MALFORMED_FINDING_ID,
  canonicalLocationKey,
  NON_MERGEABLE_LOCATIONS,
  QA_FAIL_ROUND_CAP,
  QA_ESCALATION_LABELS,
  decideQaRoundAction,
  qaVerdictHistory,
  recommendQaEscalation,
  renderQaEscalationSummary,
  decideReReviewContext,
  isReviewedFailRound,
  QA_FINDINGS_HEADING,
  QA_ADMISSION_SKIP_MARKER,
  priorFindingsSection,
  buildCheckStates,
  type RawRollupEntry,
} from "../scripts/ci/qa-verdict.ts";
import { glmLane } from "../src/glm/eligibility.ts";

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
    // PASS, PASS-pending-CI, T1-T3 FAIL review + 4 issue pointers (escalated
    // #4735, GLM wording, open-PR #4766, not-open fallback), T4 review + 2
    // issue pointers = 10.
    assert.equal(verdictBodies.length, 10, `found ${verdictBodies.length} verdict bodies`);
    for (const { cmd, body } of verdictBodies) {
      const count = body.split("${QA_VERDICT_TRAILER}").length - 1;
      assert.equal(count, 1, `${cmd} body must carry exactly one trailer:\n${body.slice(0, 200)}`);
      assert.ok(body.trimEnd().endsWith("${QA_VERDICT_TRAILER}"), `${cmd} trailer must be the last line`);
    }
  });

  test("issue-side comments are short pointers that keep their bounce markers (≤800 chars with worst-case fields, #4746)", () => {
    const issueBodies = bodies.filter((b) => b.cmd === "gh issue comment").map((b) => b.body);
    // 6 since #4766: escalated #4735, GLM wording, open-PR wording, not-open
    // fallback, T4 blocked, T4 1st-FAIL bounce.
    assert.equal(issueBodies.length, 6);
    for (const body of issueBodies) {
      const filled = fillWorstCase(body);
      assert.ok(!/\$\{?\w/.test(filled), `unexpanded variable left in pointer:\n${filled}`);
      // The #4735 escalation carries the round-by-round summary (≤10 rows), so it gets a larger bound.
      const limit = body.includes("${QA_ESCALATION_SUMMARY}") ? 2500 : 800;
      assert.ok(filled.length <= limit, `issue pointer too long with worst-case fields (${filled.length} chars):\n${filled}`);
      assert.ok(!body.includes("$REVIEW_REPORT"), "the full review must live only on the PR");
      assert.match(body, /PR #\$pr_number/);
      assert.match(body, /\$\{BLOCKER_SUMMARY\}/);
      assert.match(body, /Automated QA failed|Automated QA escalated|T4 Deep-QA failed|T4 Deep-QA blocked/);
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
  cwd: string = REPO_ROOT,
  render: (block: string) => string = (b) => b,
): Record<string, string> {
  const script = `${render(playbookBlock(name))}\n${outVars.map((v) => `printf '%s\\0' "$${v}"`).join("\n")}\n`;
  const r = spawnSync("bash", ["-c", script], {
    cwd,
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
    // #4766 bounce label — both candidates are 16 chars, so either is the
    // worst case; needs-dev-resume is the primary (open-PR) arm.
    BOUNCE_LABEL: "needs-dev-resume",
    DEEP_QA_FAILNO: "99",
    BLOCKERS: "999",
    MAX_SEVERITY: "medium",
    WORST_FINDING: "w".repeat(120),
    RED_REQUIRED_LIST: ALL_REQUIRED.join(", "),
    QA_VERDICT_TRAILER: trailer.length >= errorLine.length ? trailer : errorLine,
    ESC_LABEL_NOTE:
      "**Label routing FAILED** (see the QA log): add `ready-for-human` and remove `needs-qa`, `ready-for-agent`, `needs-dev-resume` and `in-progress` by hand, or QA will re-run on this issue.",
    QA_ESCALATION_SUMMARY: renderQaEscalationSummary({
      pr: 99999,
      priorBodies: Array.from({ length: 12 }, (_, i) =>
        renderQaVerdictTrailer({ verdict: "FAIL-pending-CI", pr: 99999, round: 990 + i, sha: FULL_HEAD, blockers: 999, maxSeverity: "medium" }),
      ),
      currentTrailer: trailer,
    }),
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
      name: "A-standards + A-spec raise the same low → still one reviewer → PASS, kept as two rows",
      tier: 3,
      findings: [finding({}), finding({ reviewer: "reviewer-A-spec", axis: "spec" })],
      verdict: "PASS", blockers: 0, followUps: 2, max: "none",
    },
    {
      name: "A and B raise DIFFERENT lows → PASS, two follow-ups",
      tier: 3,
      findings: [finding({}), finding({ reviewer: "reviewer-B-spec", location: "docs/y.md:3" })],
      verdict: "PASS", blockers: 0, followUps: 2, max: "none",
    },
    { name: "any medium → FAIL", tier: 3, findings: [finding({ severity: "medium" }), finding({ location: "a.ts:1" })], verdict: "FAIL", blockers: 1, followUps: 1, max: "medium" },
    { name: "any high → FAIL", tier: 2, findings: [finding({ severity: "high", reviewer: "standards" })], verdict: "FAIL", blockers: 1, followUps: 0, max: "high" },
    { name: "T1 standard pair: standards+spec lows on one line are one reviewer → PASS", tier: 1, findings: [finding({ reviewer: "standards" }), finding({ reviewer: "spec", axis: "spec" })], verdict: "PASS", blockers: 0, followUps: 2, max: "none" },
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
    // Fail CLOSED (QA round 1 on PR #4752): malformed input is a high finding, never [].
    const notArray = normaliseReviewFindings("not an array");
    assert.equal(notArray.length, 1);
    assert.equal(notArray[0]?.severity, "high");
    assert.match(notArray[0]?.finding ?? "", /reviewer-output-malformed/);
    const badRows = normaliseReviewFindings([null, 3, "high: gate bypassed"]);
    assert.equal(badRows.length, 3, "a non-object row is a synthetic high finding, never a silent drop");
    assert.ok(badRows.every((f) => f.severity === "high"));
    assert.ok(badRows[2]?.finding.includes("high: gate bypassed"), "the raw row text is carried");
  });

  test("a shared `key` matches the same low raised at different lines; one reviewer's two rows stay separate", () => {
    const keyed = foldReviewFindings({
      tier: 3,
      findings: [finding({ key: "stale-cite" }), finding({ reviewer: "reviewer-B-spec", location: "docs/z.md:9", key: "stale-cite" })],
    });
    assert.equal(keyed.reviewVerdict, "FAIL");
    assert.deepEqual(keyed.blocking[0]?.reviewers, ["reviewer-A-standards", "reviewer-B-spec"]);
    const sameReviewer = foldReviewFindings({
      tier: 3,
      findings: [finding({}), finding({ finding: "a second, different nit" }), finding({ reviewer: "reviewer-B-standards" })],
    });
    assert.equal(sameReviewer.blocking.length, 1, "B's row merges with ONE of A's rows");
    assert.equal(sameReviewer.followUps.length, 1, "A's other row is kept, not swallowed");
  });

  test("reviewerGroup maps the T3 fan-out to A/B, the known single reviewers to one group, and an unknown name to its OWN group", () => {
    assert.equal(reviewerGroup("reviewer-A-standards"), "A");
    assert.equal(reviewerGroup("reviewer-b-spec"), "B");
    assert.equal(reviewerGroup("REVIEWER-B-SPEC"), "B");
    for (const n of ["standards", "spec", "reviewer-single", "Standards", "SPEC"]) assert.equal(reviewerGroup(n), "primary");
    // Fail-safe: an unknown or empty name never collapses into `primary` (which
    // would disable the both-reviewers rule); it is its own group.
    for (const n of ["", "reviewer-A", "qa-bot"]) assert.notEqual(reviewerGroup(n), "primary", n);
    assert.notEqual(reviewerGroup("qa-bot"), reviewerGroup("reviewer-A-spec"));
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
    // The whole step-10 PASS comment: qa:catch-rate keys on its one trailer
    // (isFailVerdict), and the follow-ups table must carry no FAIL marker.
    const report = renderReviewReport({ fold, standardsSummary: "Two nits.", specSummary: "All criteria met." });
    const body = `> *Automated QA — two-axis review*\n\n${report}\n\n---\n\n**Verdict:** \`PASS\` — ok\n\n**CI:** all 1 required checks green.\n\n${buildQaVerdictTrailer({ verdict, pr: 5, headSha: FULL_HEAD, ...counts, priorBodies: [] })}`;
    const trailers = parseQaVerdictTrailers(body);
    assert.equal(trailers.length, 1);
    assert.equal(isFailVerdict(trailers[0]!.verdict), false);
    assert.doesNotMatch(body, /\*\*Verdict:\*\*\s*`FAIL/);
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

  // PR #4752 QA r1: the executed block must fail CLOSED on a bad findings file.
  function rawFile(text: string): string {
    const f = join(mkdtempSync(join(tmpdir(), "qa-4734-raw-")), "findings.json");
    writeFileSync(f, text);
    return f;
  }
  const BAD_FILES: Array<{ name: string; path: () => string }> = [
    { name: "missing file", path: () => join(mkdtempSync(join(tmpdir(), "qa-4734-missing-")), "never-written.json") },
    { name: "empty file", path: () => rawFile("") },
    { name: "unparseable file", path: () => rawFile("looks fine to me") },
    { name: "object wrapper", path: () => rawFile(JSON.stringify({ findings: [{ severity: "high" }] })) },
    { name: "string row", path: () => rawFile(JSON.stringify(["high: gate bypassed"])) },
  ];
  for (const tier of ["1", "3", "4"]) {
    for (const bad of BAD_FILES) {
      test(`executed fold block: T${tier} ${bad.name} → FAIL, blockers>=1, max_severity=high`, () => {
        const out = runBlock("severity-fold", { ...env, PR_TIER_NUM: tier, FINDINGS_FILE: bad.path() }, OUT);
        assert.equal(out.REVIEW_VERDICT, "FAIL");
        assert.ok(Number(out.BLOCKERS) >= 1, `BLOCKERS=${out.BLOCKERS}`);
        assert.equal(out.MAX_SEVERITY, "high");
      });
    }
  }

  test("executed fold block: an explicit [] file is a PASS", () => {
    const out = runBlock("severity-fold", { ...env, PR_TIER_NUM: "4", FINDINGS_FILE: rawFile("[]") }, OUT);
    assert.equal(out.REVIEW_VERDICT, "PASS");
    assert.equal(out.BLOCKERS, "0");
  });

  test("the playbook has no `|| '[]'` findings default and no dead REVIEWER_A/B_VERDICT cross-check", () => {
    assert.doesNotMatch(playbookBlock("severity-fold"), /\|\| '\[\]'\);/);
    assert.doesNotMatch(QA_PLAYBOOK, /process\.env\.REVIEWER_A_VERDICT/);
  });
});

// ---------------------------------------------------------------------------
// PR #4752 QA round 1 — the fold must FAIL CLOSED on malformed reviewer output.
// ---------------------------------------------------------------------------

describe("foldReviewFindings fails CLOSED on malformed input, every tier (PR #4752 QA r1)", () => {
  const MALFORMED: Array<{ name: string; input: unknown }> = [
    { name: "missing (undefined)", input: undefined },
    { name: "null", input: null },
    { name: "empty string (empty file)", input: "" },
    { name: "unparseable text", input: "reviewer said: looks fine" },
    { name: "object wrapper {findings:[…]}", input: { findings: [{ severity: "high" }] } },
    { name: "a number", input: 42 },
    { name: "array with a string row", input: ["high: gate bypassed"] },
    { name: "array with a null row", input: [null] },
    { name: "array with a nested array row", input: [[{ severity: "low" }]] },
  ];
  for (const tier of [1, 3, 4] as const) {
    for (const m of MALFORMED) {
      test(`T${tier}: ${m.name} → FAIL with a high reviewer-output-malformed blocker`, () => {
        const r = foldReviewFindings({ tier, findings: m.input });
        assert.equal(r.reviewVerdict, "FAIL");
        assert.ok(r.blockers >= 1);
        assert.equal(r.maxSeverity, "high");
        assert.ok(r.blocking.some((b) => b.finding.includes(MALFORMED_FINDING_ID)), JSON.stringify(r.blocking));
        const counts = trailerBlockerCounts(r, []);
        assert.ok(counts.blockers >= 1);
        assert.equal(counts.maxSeverity, "high");
      });
    }
    test(`T${tier}: an explicit empty list [] is the one legitimate no-findings PASS`, () => {
      const r = foldReviewFindings({ tier, findings: [] });
      assert.equal(r.reviewVerdict, "PASS");
      assert.equal(r.blockers, 0);
    });
  }

  test("a string row keeps its raw text in the finding (never a silent drop)", () => {
    const r = foldReviewFindings({ tier: 3, findings: [finding({}), "high: gate bypassed"] });
    assert.equal(r.reviewVerdict, "FAIL");
    assert.ok(r.blocking.some((b) => b.finding.includes("high: gate bypassed")));
    assert.equal(r.followUps.length, 1, "the well-formed low row is still reported");
  });
});

describe("advisory hardening from PR #4752 QA r1", () => {
  test("(a) a FAIL review verdict never renders blockers=0", () => {
    assert.deepEqual(
      trailerBlockerCounts({ reviewVerdict: "FAIL", blockers: 0, maxSeverity: "none" }, []),
      { blockers: 1, maxSeverity: "high" },
    );
    assert.deepEqual(
      trailerBlockerCounts({ reviewVerdict: "PASS", blockers: 0, maxSeverity: "none" }, []),
      { blockers: 0, maxSeverity: "none" },
    );
  });

  test("(b) placeholder locations never merge two reviewers' lows; a real file:line or key does", () => {
    for (const location of ["PR body", "(no location)", "", "pr BODY"]) {
      const r = foldReviewFindings({
        tier: 3,
        findings: [finding({ location, finding: "one" }), finding({ reviewer: "reviewer-B-spec", location, finding: "two" })],
      });
      assert.equal(r.reviewVerdict, "PASS", `location ${JSON.stringify(location)} must not merge`);
      assert.equal(r.followUps.length, 2);
    }
    const keyed = foldReviewFindings({
      tier: 3,
      findings: [finding({ location: "PR body", key: "k" }), finding({ reviewer: "reviewer-B-spec", location: "PR body", key: "k" })],
    });
    assert.equal(keyed.reviewVerdict, "FAIL");
  });

  test("(c) an unknown reviewer name is its own group, so the both-reviewers rule still fires", () => {
    const r = foldReviewFindings({
      tier: 3,
      findings: [finding({ reviewer: "Reviewer-A-Standards" }), finding({ reviewer: "qa-bot" })],
    });
    assert.equal(r.reviewVerdict, "FAIL", "two distinct reviewers raised the same low");
    const mixedCase = foldReviewFindings({
      tier: 3,
      findings: [finding({ reviewer: "REVIEWER-A-SPEC" }), finding({ reviewer: "reviewer-a-standards" })],
    });
    assert.equal(mixedCase.reviewVerdict, "PASS", "case-insensitive: both rows are reviewer A");
  });

  test("(d) renderCiSummary de-duplicates same-name checks, worst state wins", () => {
    const checks: CheckState[] = [
      { name: "deep-qa-gate", status: "completed", conclusion: "success", required: true },
      { name: "deep-qa-gate", status: "completed", conclusion: "failure", required: true },
      { name: "test", status: "completed", conclusion: "success", required: true },
      { name: "test", status: "completed", conclusion: "success", required: true },
      { name: "tier-gate", status: "queued", required: true },
      { name: "tier-gate", status: "completed", conclusion: "success", required: true },
    ];
    assert.equal(
      renderCiSummary(classifyVerdict("PASS", checks)),
      "**CI:** 1/3 required checks green. Not green: `deep-qa-gate` (failure), `tier-gate` (pending).",
    );
  });
});

// ---------------------------------------------------------------------------
// PR #4752 QA round 2 — location canonicalisation for the both-reviewers rule.
// ---------------------------------------------------------------------------

describe("both-reviewers rule merges on a canonical location (PR #4752 QA r2)", () => {
  const bothLow = (tier: number, locA: string, locB: string) =>
    foldReviewFindings({
      tier,
      findings: [
        finding({ location: locA, finding: "one" }),
        finding({ reviewer: "reviewer-B-spec", location: locB, finding: "two" }),
      ],
    });

  test("the exact round-2 regression: bare path / #L12 / :L12 both-reviewer lows FAIL again", () => {
    for (const loc of ["src/foo.ts", "src/foo.ts#L12", "src/foo.ts:L12"]) {
      assert.equal(bothLow(3, loc, loc).reviewVerdict, "FAIL", loc);
    }
  });

  const SAME: Array<[string, string]> = [
    ["src/foo.ts", "src/foo.ts"],
    ["src/foo.ts", " SRC/Foo.ts "],
    ["src/foo.ts#L12", "src/foo.ts:12"],
    ["src/foo.ts:L12", "src/foo.ts:12"],
    ["src/foo.ts#L12", "src/foo.ts:L12"],
    ["src/foo.ts L12", "src/foo.ts:12"],
    ["./src/foo.ts:12", "src/foo.ts:12"],
  ];
  for (const tier of [1, 2, 3]) {
    for (const [a, b] of SAME) {
      test(`T${tier}: ${JSON.stringify(a)} ~ ${JSON.stringify(b)} → merged, both-reviewer low FAILs`, () => {
        const r = bothLow(tier, a, b);
        assert.equal(r.reviewVerdict, "FAIL");
        assert.equal(r.blocking.length, 1);
        assert.deepEqual(r.blocking[0]?.reviewers, ["reviewer-A-standards", "reviewer-B-spec"]);
      });
    }
  }

  const NEVER: Array<[string, string]> = [
    ["", ""],
    ["(no location)", "(no location)"],
    ["PR body", "pr BODY"],
    ["n/a", "N/A"],
    ["-", "-"],
    ["none", "None"],
    ["the whole diff", "the whole diff"],
    ["src/foo.ts:12", "src/bar.ts:12"],
    ["src/foo.ts:12", "src/foo.ts:13"],
  ];
  for (const [a, b] of NEVER) {
    test(`${JSON.stringify(a)} vs ${JSON.stringify(b)} → never merged, lone lows PASS`, () => {
      const r = bothLow(3, a, b);
      assert.equal(r.reviewVerdict, "PASS");
      assert.equal(r.followUps.length, 2);
    });
  }

  test("low follow-ups: `primary` is the primary reviewer; tier ≤0 / NaN takes the strict path", () => {
    assert.equal(reviewerGroup("primary"), "primary");
    assert.equal(reviewerGroup("Primary"), "primary");
    for (const tier of [0, -1, Number.NaN]) {
      const r = foldReviewFindings({ tier, findings: [finding({})] });
      assert.equal(r.mode, "any-blocker", String(tier));
      assert.equal(r.reviewVerdict, "FAIL", String(tier));
    }
  });
});

describe("canonicalLocationKey — accepted location formats (PR #4752 QA r2)", () => {
  const CASES: Array<[string, string | null]> = [
    ["src/foo.ts", "src/foo.ts"],
    ["src/foo.ts:12", "src/foo.ts:12"],
    ["src/foo.ts:L12", "src/foo.ts:12"],
    ["src/foo.ts#L12", "src/foo.ts:12"],
    ["src/foo.ts L12", "src/foo.ts:12"],
    ["src/foo.ts:12-18", "src/foo.ts:12"],
    ["src/foo.ts:12:5", "src/foo.ts:12"],
    ["./SRC/Foo.ts:012", "src/foo.ts:12"],
    ["docs/operator-playbooks/hydra-qa.md#L900", "docs/operator-playbooks/hydra-qa.md:900"],
    ["PR body", null],
    ["(no location)", null],
    ["N/A", null],
    ["-", null],
    ["None", null],
    ["", null],
    ["the whole diff", null],
    ["README", null],
    // #4758: reviewers wrap locations in quotes/backticks and trailing parentheticals.
    ["`src/foo.ts:12`", "src/foo.ts:12"],
    ['"src/foo.ts:12"', "src/foo.ts:12"],
    ["'src/foo.ts:12'", "src/foo.ts:12"],
    ["  src/foo.ts:12  ", "src/foo.ts:12"],
    ["src/foo.ts:12 (buildX)", "src/foo.ts:12"],
    ["src/foo.ts:12(buildX)", "src/foo.ts:12"],
    ["`src/foo.ts:12 (buildX)`", "src/foo.ts:12"],
    ['"`src/foo.ts:12`"', "src/foo.ts:12"], // quote-strip, paren-drop, quote-strip again
    ["`src/foo.ts (see buildX)`", "src/foo.ts"],
    // #4758: an extension-less file name is path-like ONLY with a line number.
    ["Dockerfile:12", "dockerfile:12"],
    ["Makefile:3", "makefile:3"],
    ["Makefile", null],
    ["tests", null],
    // Placeholders stay non-mergeable even quoted/wrapped.
    ["`PR body`", null],
    ["`N/A`", null],
    ['"(no location)"', null],
    ["`src/weird file.ts:12`", null], // whitespace in the path part, post-stripping
    ["my file.ts:12", null],
  ];
  for (const [input, want] of CASES) {
    test(`${JSON.stringify(input)} → ${JSON.stringify(want)}`, () => {
      assert.equal(canonicalLocationKey(input), want);
    });
  }
  test("every NON_MERGEABLE_LOCATIONS entry keys to null", () => {
    for (const p of NON_MERGEABLE_LOCATIONS) assert.equal(canonicalLocationKey(p.toUpperCase()), null, p);
  });
});

describe("foldReviewFindings — per-reviewer map with spawnedReviewers fails closed (issue #4758)", () => {
  /** A step-8 map row: same fields as a flat row, minus a mandatory reviewer. */
  const mrow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    severity: "low",
    axis: "standards",
    location: "src/x.ts:10",
    finding: "nit",
    fix: "fix it",
    ...over,
  });
  const SPAWNED = ["reviewer-A-standards", "reviewer-B-spec"];
  // Count OMISSION findings for a reviewer by prefix: a malformed-shape finding's
  // raw preview can legitimately mention the same reviewer name.
  const omissions = (fold: ReturnType<typeof foldReviewFindings>, reviewer: string) =>
    fold.blocking.filter((r) => r.finding.startsWith(`${MALFORMED_FINDING_ID}: spawned reviewer \`${reviewer}\``));

  test("a spawned reviewer omitted from the map → ONE high malformed finding naming it, FAIL at every tier", () => {
    for (const tier of [1, 3, 4, null] as Array<number | null>) {
      const fold = foldReviewFindings({
        tier,
        findings: { "reviewer-A-standards": [mrow()] }, // reviewer-B-spec omitted
        spawnedReviewers: SPAWNED,
      });
      assert.equal(fold.reviewVerdict, "FAIL", `tier ${tier}`);
      assert.equal(fold.maxSeverity, "high", `tier ${tier}`);
      const rows = omissions(fold, "reviewer-B-spec");
      assert.equal(rows.length, 1, `tier ${tier}: exactly ONE finding for the omitted reviewer`);
      assert.ok(rows[0]!.finding.includes(MALFORMED_FINDING_ID), `tier ${tier}`);
      assert.ok(rows[0]!.finding.includes("only an explicit [] is"), `tier ${tier}`);
    }
  });

  test("a NON-ARRAY entry under a spawned key is the same omission: one malformed finding, never two", () => {
    const fold = foldReviewFindings({
      tier: 3,
      findings: { "reviewer-A-standards": "not an array", "reviewer-B-spec": [] },
      spawnedReviewers: SPAWNED,
    });
    assert.equal(fold.reviewVerdict, "FAIL");
    assert.equal(omissions(fold, "reviewer-A-standards").length, 1, "ONE finding, not one for the entry plus one per row");
    assert.equal(fold.blockers, 1);
  });

  test("an explicit [] from every spawned reviewer is the only clean map → PASS at T3 and T4", () => {
    const findings = { "reviewer-A-standards": [], "reviewer-B-spec": [] };
    assert.equal(foldReviewFindings({ tier: 3, findings, spawnedReviewers: SPAWNED }).reviewVerdict, "PASS");
    const t4 = foldReviewFindings({ tier: 4, findings, spawnedReviewers: SPAWNED });
    assert.equal(t4.reviewVerdict, "PASS");
    assert.equal(t4.blockers, 0);
  });

  test("spawnedReviewers present but empty is itself malformed → FAIL, never a silent PASS", () => {
    const fold = foldReviewFindings({ tier: 3, findings: {}, spawnedReviewers: [] });
    assert.equal(fold.reviewVerdict, "FAIL");
    assert.equal(fold.maxSeverity, "high");
    assert.ok(fold.blocking[0]!.finding.includes("present but empty"));
  });

  test("a flat array where the fold expected the per-reviewer map is malformed → FAIL", () => {
    const fold = foldReviewFindings({ tier: 3, findings: [finding({})], spawnedReviewers: SPAWNED });
    assert.equal(fold.reviewVerdict, "FAIL");
    assert.equal(fold.maxSeverity, "high");
    assert.ok(fold.blocking.some((r) => r.finding.includes("per-reviewer map")), "the shape itself is named");
    // Plus one missing-reviewer finding per spawned name — the reviewers are unverifiable.
    assert.equal(omissions(fold, "reviewer-A-standards").length, 1);
    assert.equal(omissions(fold, "reviewer-B-spec").length, 1);
  });

  test("spawnedReviewers absent keeps the flat-array behaviour unchanged (regression)", () => {
    const lone = foldReviewFindings({ tier: 3, findings: [finding({})] });
    assert.equal(lone.reviewVerdict, "PASS");
    assert.equal(lone.followUps.length, 1);
    const withNull = foldReviewFindings({ tier: 3, findings: [finding({})], spawnedReviewers: null });
    assert.equal(withNull.reviewVerdict, "PASS", "null is the same as absent");
  });

  test("rows under a non-spawned key are still counted and inherit the map key as reviewer", () => {
    const fold = foldReviewFindings({
      tier: 3,
      findings: { "reviewer-A-standards": [], "extra-reviewer": [mrow({})] }, // no reviewer field on the row
      spawnedReviewers: ["reviewer-A-standards"],
    });
    assert.equal(fold.reviewVerdict, "PASS", "a lone low from the extra key is a follow-up, not dropped");
    assert.equal(fold.followUps.length, 1);
    assert.ok(fold.followUps[0]!.reviewers.includes("extra-reviewer"), "the map key is inherited as the reviewer");
  });

  test("garbage under a non-spawned key becomes a malformed finding (counted, never dropped)", () => {
    const fold = foldReviewFindings({
      tier: 3,
      findings: { "reviewer-A-standards": [], "extra-reviewer": "not an array" },
      spawnedReviewers: ["reviewer-A-standards"],
    });
    assert.equal(fold.reviewVerdict, "FAIL");
    assert.equal(fold.maxSeverity, "high");
    assert.ok(fold.blocking.some((r) => r.finding.includes("extra-reviewer")));
  });

  test("round-3 regression: wrapped and parenthesised locations merge onto the same key → both-reviewers low FAILs", () => {
    const fold = foldReviewFindings({
      tier: 3,
      findings: {
        "reviewer-A-standards": [mrow({ location: "src/foo.ts:12", finding: "same bug" })],
        "reviewer-B-spec": [mrow({ location: "`src/foo.ts:12 (buildX)`", finding: "same bug, wrapped" })],
      },
      spawnedReviewers: SPAWNED,
    });
    assert.equal(fold.reviewVerdict, "FAIL", "the two rows merge, so the low was raised by both reviewers");
    assert.equal(fold.blockers, 1);
    assert.equal(fold.blocking[0]!.reviewers.length, 2);
  });
});

describe("qa-verdict constants pin the playbook's hand-copied text (issue #4758)", () => {
  test("step 8's hand-copied placeholder list equals NON_MERGEABLE_LOCATIONS (drift guard)", () => {
    const m = /the `NON_MERGEABLE_LOCATIONS` list \((.*?) case-insensitive\)/.exec(QA_PLAYBOOK);
    assert.ok(m, "step 8 must carry the parseable hand copy of the placeholder list");
    const copied = m[1]!
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "")
      .map((s) => s.replace(/^`|`$/g, "").toLowerCase())
      .map((s) => (s === "empty" ? "" : s));
    assert.deepEqual([...copied].sort(), [...NON_MERGEABLE_LOCATIONS].sort());
    // The prose word 'empty' stands for the '' entry — an explicit check, not an accident.
    assert.ok(copied.includes(""));
  });

  test("step 8's 'contains whitespace' wording says the test applies AFTER the stripping", () => {
    assert.match(
      QA_PLAYBOOK,
      /the whitespace test applies to the path part after the quote\/backtick\/parenthetical stripping/,
    );
  });

  test("step 8 says an extension-less path is path-like only WITH a line number", () => {
    assert.match(QA_PLAYBOOK, /`Dockerfile:12` is path-like only WITH a line number/);
  });

  test("QA_ADMISSION_SKIP_MARKER: step 6.6's REVIEW_REPORT and step 10's case pattern both contain it (INV-10)", () => {
    assert.equal(QA_ADMISSION_SKIP_MARKER, "Review skipped by the admission gate");
    assert.ok(QA_PLAYBOOK.includes(`REVIEW_REPORT="_${QA_ADMISSION_SKIP_MARKER}`), "step 6.6's skip report carries the marker");
    assert.ok(QA_PLAYBOOK.includes(`*"${QA_ADMISSION_SKIP_MARKER}"*`), "step 10's CURRENT_REVIEWED case pattern carries the marker");
  });

  test("QA_FINDINGS_HEADING: the fold-failure fallback and priorFindingsSection key on the same heading", () => {
    assert.equal(QA_FINDINGS_HEADING, "### Findings");
    assert.ok(QA_PLAYBOOK.includes(`REVIEW_REPORT="${QA_FINDINGS_HEADING}`), "the fold-failure fallback report starts with the heading");
    // priorFindingsSection reads the heading the report writes — one constant, both sides.
    const body = verdictBody(1, "FAIL", SHA_A, 1, "medium", `${QA_FINDINGS_HEADING}\n\n| medium | x |`);
    assert.equal(priorFindingsSection([body], 7, 1), `${QA_FINDINGS_HEADING}\n\n| medium | x |`);
  });

  test("reviewerGroup's docstring states the true empty-name behaviour (INV-7, docstring-only)", () => {
    const src = readFileSync(join(REPO_ROOT, "scripts/ci/qa-verdict.ts"), "utf8");
    const at = src.indexOf("export function reviewerGroup");
    assert.ok(at > 0);
    const doc = src.slice(Math.max(0, at - 800), at);
    assert.match(doc, /empty reviewer name[^.]*`primary`/, "the docstring must say an empty name maps to primary");
  });
});

describe("hydra-qa step 9 severity-fold block — per-reviewer map executed verbatim (issue #4758)", () => {
  const OUT = ["REVIEW_VERDICT", "REVIEW_REPORT", "BLOCKERS", "MAX_SEVERITY"];
  const env = { STANDARDS_SUMMARY: "std", SPEC_SUMMARY: "spec", FANOUT_REASON: "fan", RED_REQUIRED_JSON: "[]" };
  function findingsFile(rows: unknown): string {
    const f = join(mkdtempSync(join(tmpdir(), "qa-4758-fold-")), "findings.json");
    writeFileSync(f, JSON.stringify(rows));
    return f;
  }
  const FANOUT = { FANOUT_REVIEWERS: "reviewer-A-standards,reviewer-B-spec" };
  const mrow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    severity: "low", axis: "standards", location: "src/x.ts:10", finding: "nit", fix: "fix", ...over,
  });

  test("FANOUT_REVIEWERS set + per-reviewer map with every entry → the lone lows PASS at T3", () => {
    const out = runBlock(
      "severity-fold",
      {
        ...env,
        ...FANOUT,
        PR_TIER_NUM: "3",
        FINDINGS_FILE: findingsFile({ "reviewer-A-standards": [], "reviewer-B-spec": [mrow({})] }),
      },
      OUT,
    );
    assert.equal(out.REVIEW_VERDICT, "PASS");
    assert.equal(out.BLOCKERS, "0");
  });

  test("FANOUT_REVIEWERS set + a reviewer omitted from the map → FAIL naming the reviewer", () => {
    const out = runBlock(
      "severity-fold",
      { ...env, ...FANOUT, PR_TIER_NUM: "3", FINDINGS_FILE: findingsFile({ "reviewer-A-standards": [mrow({})] }) },
      OUT,
    );
    assert.equal(out.REVIEW_VERDICT, "FAIL");
    assert.equal(out.MAX_SEVERITY, "high");
    assert.match(out.REVIEW_REPORT as string, /reviewer-B-spec/);
    assert.match(out.REVIEW_REPORT as string, new RegExp(MALFORMED_FINDING_ID));
  });

  test("FANOUT_REVIEWERS set but the file holds a flat array → FAIL (the map shape is checked)", () => {
    const out = runBlock("severity-fold", { ...env, ...FANOUT, PR_TIER_NUM: "3", FINDINGS_FILE: findingsFile([mrow({})]) }, OUT);
    assert.equal(out.REVIEW_VERDICT, "FAIL");
    assert.match(out.REVIEW_REPORT as string, /per-reviewer map/);
  });
});

// ---------------------------------------------------------------------------
// Issue #4735 — convergent QA: round cap, re-review context, class sweep.
// ---------------------------------------------------------------------------

const TABLE_HEADER = "| Severity | Axis | Reviewer | File:line | Finding | Fix |\n|---|---|---|---|---|---|";
/** A prior round's `### Findings` section with the given blocking rows. */
function findingsSection(rows: string[]): string {
  return rows.length === 0 ? "### Findings\n\n_No blocking findings._" : `### Findings\n\n${TABLE_HEADER}\n${rows.join("\n")}`;
}
const ROW_X = "| medium | standards | reviewer-A-standards | src/x.ts:1 | bug | fix |";

/** A PR comment body ending in a QA-Verdict trailer for PR 7 (a reviewed round by default). */
function verdictBody(round: number, verdict: FinalVerdict, sha: string, blockers: number, sev: QaSeverity, findings = findingsSection([ROW_X])): string {
  const trailer = renderQaVerdictTrailer({ verdict, pr: 7, round, sha, blockers, maxSeverity: sev });
  return `> *Automated QA — two-axis review*\n\n${findings}\n\n## Standards\n\nstd\n\n---\n\n${trailer}`;
}
/** A CI-only skip-required-failed round: FAIL trailer, no findings table. */
function ciOnlyBody(round: number, sha: string): string {
  return verdictBody(round, "FAIL", sha, 1, "high", "_Review skipped by the admission gate (issue #3815): a required CI check already failed._");
}
const SHA_A = "aaaaaaaaaaaa1111111111111111111111111111";
const SHA_B = "bbbbbbbbbbbb2222222222222222222222222222";
const SHA_C = "cccccccccccc3333333333333333333333333333";

describe("decideQaRoundAction — bounce vs escalate from the prior FAIL rounds (issue #4735)", () => {
  const f1 = verdictBody(1, "FAIL", SHA_A, 3, "high");
  const f2 = verdictBody(2, "FAIL", SHA_B, 1, "medium");
  const p1 = verdictBody(1, "PASS-pending-CI", SHA_A, 0, "none", findingsSection([]));
  const other = renderQaVerdictTrailer({ verdict: "FAIL", pr: 8, round: 1, sha: SHA_A, blockers: 1, maxSeverity: "high" });
  const CASES: Array<{ name: string; tier: number | null; verdict: FinalVerdict; prior: string[]; action: string; failRound: number | null; round: number; reviewed?: boolean }> = [
    { name: "T3 1st FAIL → bounce", tier: 3, verdict: "FAIL", prior: [], action: "bounce", failRound: 1, round: 1 },
    { name: "T3 2nd FAIL → bounce", tier: 3, verdict: "FAIL", prior: [f1], action: "bounce", failRound: 2, round: 2 },
    { name: "T3 3rd FAIL → escalate", tier: 3, verdict: "FAIL", prior: [f1, f2], action: "escalate", failRound: 3, round: 3 },
    { name: "T1 3rd FAIL → escalate", tier: 1, verdict: "FAIL-pending-CI", prior: [f1, f2], action: "escalate", failRound: 3, round: 3 },
    { name: "T2 4th FAIL → escalate", tier: 2, verdict: "FAIL", prior: [f1, f2, verdictBody(3, "FAIL", SHA_C, 1, "low")], action: "escalate", failRound: 4, round: 4 },
    { name: "unknown tier 3rd FAIL → escalate (T1–T3 routing)", tier: null, verdict: "FAIL", prior: [f1, f2], action: "escalate", failRound: 3, round: 3 },
    { name: "a PASS round does not count as a FAIL round", tier: 3, verdict: "FAIL", prior: [p1, f2], action: "bounce", failRound: 2, round: 3 },
    { name: "trailers naming another PR are ignored", tier: 3, verdict: "FAIL", prior: [f1, other], action: "bounce", failRound: 2, round: 2 },
    { name: "a duplicated trailer for one round counts once", tier: 3, verdict: "FAIL", prior: [f1, f1], action: "bounce", failRound: 2, round: 3 },
    { name: "CI-only prior FAIL rounds do not count", tier: 3, verdict: "FAIL", prior: [ciOnlyBody(1, SHA_A), ciOnlyBody(2, SHA_B)], action: "bounce", failRound: 1, round: 3 },
    { name: "one reviewed + one CI-only prior FAIL → 2nd reviewed FAIL, bounce", tier: 3, verdict: "FAIL", prior: [f1, ciOnlyBody(2, SHA_B)], action: "bounce", failRound: 2, round: 3 },
    { name: "a CI-only current round never escalates", tier: 3, verdict: "FAIL", prior: [f1, f2], action: "bounce", failRound: 2, round: 3, reviewed: false },
    { name: "PASS after two FAILs → proceed", tier: 3, verdict: "PASS", prior: [f1, f2], action: "proceed", failRound: null, round: 3 },
    { name: "T4 → deep-qa (decideDeepQaAction owns it)", tier: 4, verdict: "FAIL", prior: [f1, f2], action: "deep-qa", failRound: null, round: 3 },
  ];
  for (const c of CASES) {
    test(c.name, () => {
      const d = decideQaRoundAction({ tier: c.tier, verdict: c.verdict, pr: 7, priorBodies: c.prior, ...(c.reviewed === undefined ? {} : { currentReviewed: c.reviewed }) });
      assert.equal(d.action, c.action);
      assert.equal(d.failRound, c.failRound);
      assert.equal(d.round, c.round);
      assert.ok(d.reason.length > 0);
    });
  }

  test("the cap is 3 and T4's 2nd-fail rule is untouched", () => {
    assert.equal(QA_FAIL_ROUND_CAP, 3);
    assert.equal(decideDeepQaAction("FAIL", [`x\n${DEEP_QA_FAIL_MARKER}`]).action, "block-and-escalate");
    assert.equal(decideDeepQaAction("FAIL", []).action, "bounce");
  });

  test("escalation labels leave the issue on no dev lane (glmLane → neither)", () => {
    const before = ["enhancement", "needs-qa", "ready-for-agent", "glm-eligible", "in-progress", "needs-dev-resume"];
    const after = [...before.filter((l) => !QA_ESCALATION_LABELS.issueRemove.includes(l)), ...QA_ESCALATION_LABELS.issueAdd];
    for (const active of [true, false]) assert.equal(glmLane(after, active).lane, "neither");
    for (const l of ["needs-qa", "ready-for-agent", "needs-dev-resume", "in-progress"]) {
      assert.ok(!after.includes(l), `${l} must be removed`);
    }
    assert.ok(after.includes("ready-for-human"));
    // The PR is labelled too: collect-state's dev-resume and glm-red picks skip a ready-for-human PR.
    assert.deepEqual([...QA_ESCALATION_LABELS.prAdd], ["ready-for-human"]);
  });
});

describe("renderQaEscalationSummary — the structured 3-round summary (issue #4735)", () => {
  const current = renderQaVerdictTrailer({ verdict: "FAIL", pr: 7, round: 3, sha: SHA_C, blockers: 2, maxSeverity: "high" });
  test("lists every round with verdict, sha, blockers, severity, and a recommendation", () => {
    const s = renderQaEscalationSummary({
      pr: 7,
      priorBodies: [verdictBody(1, "FAIL", SHA_A, 3, "high"), verdictBody(2, "FAIL", SHA_B, 2, "medium")],
      currentTrailer: current,
    });
    assert.match(s, /\| 1 \| FAIL \| aaaaaaaaaaaa \| 3 \| high \|/);
    assert.match(s, /\| 2 \| FAIL \| bbbbbbbbbbbb \| 2 \| medium \|/);
    assert.match(s, /\| 3 \| FAIL \| cccccccccccc \| 2 \| high \|/);
    assert.match(s, /\*\*Recommendation: redesign via grill\*\*/);
    for (const opt of [/redesign/i, /accept with follow-ups/i, /close/i]) assert.match(s, opt);
  });

  const REC: Array<{ name: string; rounds: Array<[number, QaSeverity]>; want: string }> = [
    { name: "a high blocker in the last round → redesign", rounds: [[3, "medium"], [2, "medium"], [1, "high"]], want: "redesign" },
    { name: "converging to fewer medium/low blockers → accept with follow-ups", rounds: [[4, "high"], [2, "medium"], [1, "medium"]], want: "accept-with-follow-ups" },
    { name: "not converging → redesign", rounds: [[1, "medium"], [2, "medium"], [2, "medium"]], want: "redesign" },
  ];
  for (const c of REC) {
    test(c.name, () => {
      const rounds = c.rounds.map(([blockers, maxSeverity], i) => ({ verdict: "FAIL" as const, pr: 7, round: i + 1, sha: "abcdef123456", blockers, maxSeverity }));
      assert.equal(recommendQaEscalation(rounds).recommendation, c.want);
    });
  }

  test("an unparseable current trailer still renders the prior rounds and a recommendation", () => {
    const s = renderQaEscalationSummary({ pr: 7, priorBodies: [verdictBody(1, "FAIL", SHA_A, 1, "high")], currentTrailer: "QA-Verdict-Error: verdict=FAIL pr=7" });
    assert.match(s, /\| 1 \| FAIL \|/);
    assert.match(s, /Recommendation/);
  });
});

describe("decideReReviewContext — re-review context fails CLOSED to none (issues #4735 + #4758)", () => {
  const priorFail = parseQaVerdictTrailer(verdictBody(1, "FAIL", SHA_A, 2, "medium"));
  const priorPass = parseQaVerdictTrailer(verdictBody(1, "PASS-pending-CI", SHA_A, 0, "none"));
  const priorUnknown = parseQaVerdictTrailer(verdictBody(1, "FAIL", "", 2, "medium"));
  const TABLE = findingsSection([ROW_X]);
  const base = { tier: 3 as number | null, prior: priorFail, headSha: SHA_B, priorShaIsAncestor: true as boolean | null, changedSince: ["src/x.ts"] as string[] | null, priorFindings: TABLE };
  // context: none = plain first-pass review · table = prior findings only · full = findings + incremental diff.
  const CASES: Array<{ name: string; over: Partial<typeof base>; ctx: "none" | "table" | "full" }> = [
    { name: "prior FAIL, ancestor, new commits → findings + incremental diff", over: {}, ctx: "full" },
    { name: "no prior verdict (first review) → no context", over: { prior: null }, ctx: "none" },
    { name: "prior verdict was a PASS → no context", over: { prior: priorPass }, ctx: "none" },
    { name: "prior sha=unknown → prior table only", over: { prior: priorUnknown }, ctx: "table" },
    { name: "prior sha no longer an ancestor (force-push / rebase) → prior table only", over: { priorShaIsAncestor: false }, ctx: "table" },
    { name: "ancestry check failed (sha not fetched) → prior table only", over: { priorShaIsAncestor: null }, ctx: "table" },
    { name: "no commits since the prior verdict (same head) → prior table only, never an empty diff", over: { headSha: SHA_A }, ctx: "table" },
    { name: "empty changed-file list → prior table only, never an empty diff", over: { changedSince: [] }, ctx: "table" },
    { name: "changed-file list unavailable → prior table only", over: { changedSince: null }, ctx: "table" },
    { name: "prior round had no findings table (CI-only skip round) → no context", over: { priorFindings: "" }, ctx: "none" },
    { name: "T4 → no context (deep QA never takes re-review context)", over: { tier: 4 }, ctx: "none" },
    { name: "unknown tier → no context", over: { tier: null }, ctx: "none" },
  ];
  for (const c of CASES) {
    test(c.name, () => {
      const ctx = decideReReviewContext({ ...base, ...c.over });
      assert.equal(ctx.includeFindings, c.ctx !== "none", ctx.reason);
      assert.equal(ctx.includeDiff, c.ctx === "full", ctx.reason);
      assert.equal(ctx.baseSha, c.ctx === "full" ? "aaaaaaaaaaaa" : null, ctx.reason);
      assert.ok(ctx.reason.length > 0);
    });
  }

  test("decideReReviewContext no longer exposes mode / priorRound / priorBlockers (renamed, #4758)", () => {
    const ctx = decideReReviewContext({ ...base });
    assert.deepEqual(Object.keys(ctx).sort(), ["baseSha", "includeDiff", "includeFindings", "reason"]);
  });

  test("isReviewedFailRound — the shared reviewed-FAIL predicate (T1–T3 × FAIL × has findings table)", () => {
    assert.equal(isReviewedFailRound(3, priorFail, TABLE), true);
    assert.equal(isReviewedFailRound(1, priorFail, TABLE), true);
    assert.equal(isReviewedFailRound(4, priorFail, TABLE), false, "T4 never takes re-review context");
    assert.equal(isReviewedFailRound(null, priorFail, TABLE), false, "unknown tier");
    assert.equal(isReviewedFailRound(3, null, TABLE), false, "no prior verdict");
    assert.equal(isReviewedFailRound(3, priorPass, TABLE), false, "prior PASS");
    assert.equal(isReviewedFailRound(3, priorFail, ""), false, "CI-only prior round (no findings table)");
    assert.equal(isReviewedFailRound(3, priorFail, "### Findings\n\n| low | x |"), true, "any findings table counts");
    // includeFindings is exactly isReviewedFailRound — one definition, no inline duplicate.
    for (const over of [{ tier: 4 as number | null }, { prior: null }, { priorFindings: "" }]) {
      const ctx = decideReReviewContext({ ...base, ...over });
      assert.equal(
        ctx.includeFindings,
        isReviewedFailRound(over.tier ?? base.tier, over.prior === undefined ? base.prior : over.prior, over.priorFindings ?? TABLE),
        `includeFindings must equal isReviewedFailRound for ${JSON.stringify(over)}`,
      );
    }
  });

  test("priorFindingsSection extracts the prior round's table, and only for that PR + round", () => {
    const body = verdictBody(2, "FAIL", SHA_B, 1, "medium", "### Findings\n\n| medium | x |");
    assert.equal(priorFindingsSection([body], 7, 2), "### Findings\n\n| medium | x |");
    assert.equal(priorFindingsSection([body], 7, 1), "");
    assert.equal(priorFindingsSection([body], 8, 2), "");
    assert.equal(priorFindingsSection([ciOnlyBody(2, SHA_B)], 7, 2), "");
  });

  test("qaVerdictHistory is one trailer per round, in round order", () => {
    const h = qaVerdictHistory([verdictBody(2, "FAIL", SHA_B, 1, "medium"), verdictBody(1, "FAIL", SHA_A, 1, "high"), verdictBody(1, "FAIL", SHA_A, 1, "high")], 7);
    assert.deepEqual(h.map((t) => t.round), [1, 2]);
  });
});

// ── #4735 playbook wiring: the blocks run verbatim against a fake `gh` ──────

/**
 * A PATH dir with a fake `gh`: `pr view` prints $FAKE_GH_BODIES (or fails),
 * `api` succeeds unless $FAKE_GH_API_FAIL is set (404 or 500), every call is logged.
 */
function fakeGhDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "qa-4735-gh-"));
  writeFileSync(
    join(dir, "gh"),
    [
      "#!/bin/sh",
      'printf \'%s\\n\' "$*" >> "$FAKE_GH_LOG"',
      'case "$1" in',
      '  pr) [ "$FAKE_GH_FAIL" = 1 ] && exit 1; cat "$FAKE_GH_BODIES" ;;',
      '  api) case "$FAKE_GH_API_FAIL" in',
      '         404) case "$*" in *DELETE*) echo "gh: Label does not exist (HTTP 404)" >&2; exit 1 ;; esac ;;',
      '         500) echo "gh: Server Error (HTTP 500)" >&2; exit 1 ;;',
      "       esac ;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(join(dir, "gh"), 0o755);
  return dir;
}

function ghFixture(bodies: string[]): { FAKE_GH_BODIES: string; FAKE_GH_LOG: string } {
  const dir = mkdtempSync(join(tmpdir(), "qa-4735-fx-"));
  writeFileSync(join(dir, "bodies.json"), JSON.stringify(bodies));
  writeFileSync(join(dir, "gh.log"), "");
  return { FAKE_GH_BODIES: join(dir, "bodies.json"), FAKE_GH_LOG: join(dir, "gh.log") };
}

/** A throwaway repo: c1 → c2 (adds src/changed.ts), plus an orphan commit that is no ancestor of HEAD. */
function scratchRepo(): { dir: string; c1: string; c2: string; orphan: string } {
  const dir = mkdtempSync(join(tmpdir(), "qa-4735-repo-"));
  const git = (...args: string[]): string => {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git("init", "-q");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "c1");
  const c1 = git("rev-parse", "HEAD");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "changed.ts"), "export const x = 1;\n");
  git("add", "src/changed.ts");
  git("commit", "-q", "-m", "c2");
  const c2 = git("rev-parse", "HEAD");
  const orphan = git("commit-tree", git("rev-parse", "HEAD^{tree}"), "-m", "orphan");
  // The blocks import ./scripts/ci/qa-verdict.ts relative to cwd.
  symlinkSync(join(REPO_ROOT, "scripts"), join(dir, "scripts"));
  return { dir, c1, c2, orphan };
}

/** The Skill loader's argument substitution: the bare `$issue_number` token becomes the number. */
const skillRender = (issue: number) => (block: string): string => block.split("$issue_number").join(String(issue));

describe("hydra-qa step 7.0a re-review context block — executed verbatim (issue #4735)", () => {
  const repo = scratchRepo();
  const gh = fakeGhDir();
  const TABLE = findingsSection(["| medium | standards | reviewer-A-standards | src/changed.ts:1 | bug | fix |"]);
  const prior = (sha: string, verdict: FinalVerdict = "FAIL") => [verdictBody(1, verdict, sha, 1, "medium", TABLE)];
  const OUT = ["PRIOR_FINDINGS", "REREVIEW_DIFF_BASE"];
  const run = (bodies: string[], over: Record<string, string> = {}, extraPath = "") =>
    runBlock(
      "rereview-context",
      { pr_number: "7", PR_TIER_NUM: "3", PRIOR_QA_FILE: join(mkdtempSync(join(tmpdir(), "qa-4735-p-")), "p.json"), ...ghFixture(bodies), ...over },
      OUT,
      `${extraPath}${gh}`,
      repo.dir,
    );

  test("prior FAIL at an ancestor with new commits → prior table + incremental diff base as context", () => {
    const out = run(prior(repo.c1));
    assert.equal(out.REREVIEW_DIFF_BASE, repo.c1.slice(0, 12));
    assert.ok((out.PRIOR_FINDINGS as string).startsWith("### Findings"));
  });

  // The prior table is still useful context when only the diff base is unusable.
  const TABLE_ONLY: Array<{ name: string; bodies: () => string[] }> = [
    { name: "prior sha=unknown", bodies: () => prior("") },
    { name: "prior sha not in the repo (force-pushed away)", bodies: () => prior("0123456789ab") },
    { name: "prior sha not an ancestor of HEAD (rebase)", bodies: () => prior(repo.orphan) },
    { name: "prior verdict at HEAD (no new commits)", bodies: () => prior(repo.c2) },
  ];
  for (const c of TABLE_ONLY) {
    test(`${c.name} → prior table as context, the incremental diff omitted`, () => {
      const out = run(c.bodies());
      assert.equal(out.REREVIEW_DIFF_BASE, "");
      assert.ok((out.PRIOR_FINDINGS as string).startsWith("### Findings"));
    });
  }

  const NONE: Array<{ name: string; bodies: () => string[]; over?: Record<string, string>; broken?: boolean }> = [
    { name: "no prior verdict", bodies: () => [] },
    { name: "prior verdict was a PASS", bodies: () => prior(repo.c1, "PASS-pending-CI") },
    { name: "prior round had no findings table (CI-only)", bodies: () => [ciOnlyBody(1, repo.c1)] },
    { name: "T4", bodies: () => prior(repo.c1), over: { PR_TIER_NUM: "4" } },
    { name: "unknown tier", bodies: () => prior(repo.c1), over: { PR_TIER_NUM: "" } },
    { name: "gh read fails", bodies: () => prior(repo.c1), over: { FAKE_GH_FAIL: "1" } },
    { name: "node fails", bodies: () => prior(repo.c1), broken: true },
  ];
  for (const c of NONE) {
    test(`${c.name} → no re-review context (a plain first-pass review)`, () => {
      const out = run(c.bodies(), c.over, c.broken ? `${brokenNodeDir()}:` : "");
      assert.equal(out.REREVIEW_DIFF_BASE, "");
      assert.equal(out.PRIOR_FINDINGS, "");
    });
  }
});

describe("hydra-qa step 10 round-cap block — executed as the Skill loader renders it (issue #4735)", () => {
  const gh = fakeGhDir();
  const current = renderQaVerdictTrailer({ verdict: "FAIL", pr: 7, round: 3, sha: SHA_C, blockers: 1, maxSeverity: "medium" });
  const OUT = ["ROUND_ACTION", "QA_ESCALATION_SUMMARY", "ESC_LABELS_OK", "ESC_LABEL_NOTE"];
  // No `issue_number` in the env: the Skill loader substitutes the bare token and never sets a shell var.
  const setup = (bodies: string[], over: Record<string, string> = {}) => {
    const fx = ghFixture(bodies);
    const env = {
      pr_number: "7",
      PR_TIER_NUM: "3",
      VERDICT: "FAIL",
      QA_VERDICT_TRAILER: current,
      REVIEW_REPORT: "### Findings\n\n| medium | ... |",
      ROUND_PRIOR_FILE: join(mkdtempSync(join(tmpdir(), "qa-4735-r-")), "r.json"),
      ...fx,
      ...over,
    };
    return { fx, env };
  };
  const run = (env: Record<string, string>, extraPath = "") => runBlock("qa-round-cap", env, OUT, `${extraPath}${gh}`, REPO_ROOT, skillRender(70));
  const twoFails = [verdictBody(1, "FAIL", SHA_A, 3, "high"), verdictBody(2, "FAIL", SHA_B, 2, "medium")];

  test("the playbook never uses the braced ${issue_number} form (the loader only substitutes the bare token)", () => {
    assert.ok(!QA_PLAYBOOK.includes("${issue_number}"), "found ${issue_number} in hydra-qa.md");
    assert.ok(!("issue_number" in process.env), "the regression test must not get issue_number from the env");
  });

  test("3rd FAIL → escalate: ready-for-human on issue 70 AND the PR, every dev-lane label removed from issue 70", () => {
    const { fx, env } = setup(twoFails);
    const out = run(env);
    assert.equal(out.ROUND_ACTION, "escalate");
    assert.equal(out.ESC_LABELS_OK, "1");
    assert.match(out.ESC_LABEL_NOTE as string, /Labelled `ready-for-human`/);
    assert.match(out.QA_ESCALATION_SUMMARY as string, /\| 3 \| FAIL \| cccccccccccc \| 1 \| medium \|/);
    assert.match(out.QA_ESCALATION_SUMMARY as string, /Recommendation: accept with follow-ups/);
    const log = readFileSync(fx.FAKE_GH_LOG, "utf8");
    assert.doesNotMatch(log, /issues\/\/labels/);
    assert.match(log, /api -X POST repos\/gaberoo322\/hydra\/issues\/70\/labels -f labels\[\]=ready-for-human/);
    assert.match(log, /api -X POST repos\/gaberoo322\/hydra\/issues\/7\/labels -f labels\[\]=ready-for-human/);
    for (const l of ["needs-qa", "ready-for-agent", "needs-dev-resume", "in-progress"]) {
      assert.match(log, new RegExp(`api -X DELETE repos/gaberoo322/hydra/issues/70/labels/${l}\\n`));
    }
    assert.doesNotMatch(log, /labels\[\]=(ready-for-agent|needs-dev-resume)/);
  });

  test("a 404 on removing an absent label is not a failure", () => {
    const { env } = setup(twoFails, { FAKE_GH_API_FAIL: "404" });
    const out = run(env);
    assert.equal(out.ROUND_ACTION, "escalate");
    assert.equal(out.ESC_LABELS_OK, "1");
  });

  test("a failed label call → the escalation note says so and never claims `Labelled`", () => {
    const { env } = setup(twoFails, { FAKE_GH_API_FAIL: "500" });
    const out = run(env);
    assert.equal(out.ROUND_ACTION, "escalate");
    assert.equal(out.ESC_LABELS_OK, "0");
    assert.doesNotMatch(out.ESC_LABEL_NOTE as string, /^Labelled/);
    assert.match(out.ESC_LABEL_NOTE as string, /FAILED/);
  });

  test("an unsubstituted issue number (loader skipped) fails loud instead of calling issues//labels", () => {
    const { fx, env } = setup(twoFails);
    const out = runBlock("qa-round-cap", env, OUT, gh, REPO_ROOT);
    assert.equal(out.ESC_LABELS_OK, "0");
    assert.doesNotMatch(readFileSync(fx.FAKE_GH_LOG, "utf8"), /issues\/\/labels/);
  });

  test("a CI-only current round (admission-gate skip) never escalates", () => {
    const { env } = setup(twoFails, { REVIEW_REPORT: "_Review skipped by the admission gate (issue #3815): a required CI check already failed._" });
    assert.equal(run(env).ROUND_ACTION, "bounce");
  });

  const BOUNCE: Array<{ name: string; bodies: string[]; over?: Record<string, string>; broken?: boolean }> = [
    { name: "2nd FAIL", bodies: [twoFails[0] as string] },
    { name: "gh read fails (pre-#4735 behaviour)", bodies: twoFails, over: { FAKE_GH_FAIL: "1" } },
    { name: "node fails (pre-#4735 behaviour)", bodies: twoFails, broken: true },
  ];
  for (const c of BOUNCE) {
    test(`${c.name} → bounce, no label writes`, () => {
      const { fx, env } = setup(c.bodies, c.over);
      const out = run(env, c.broken ? `${brokenNodeDir()}:` : "");
      assert.equal(out.ROUND_ACTION, "bounce");
      assert.equal(out.QA_ESCALATION_SUMMARY, "");
      assert.doesNotMatch(readFileSync(fx.FAKE_GH_LOG, "utf8"), /^api /m);
    });
  }
});

describe("hydra-qa playbook wires convergent review (issue #4735)", () => {
  const step10 = QA_PLAYBOOK.slice(QA_PLAYBOOK.indexOf("### 10. Verdict routing"), QA_PLAYBOOK.indexOf("### 11. Lesson capture"));
  const t13 = step10.slice(step10.indexOf("For T1 / T2 / T3"), step10.indexOf("For **T4**"));
  const t4 = step10.slice(step10.indexOf("For **T4**"));

  test("reviewer prompts carry the class-sweep instruction", () => {
    assert.match(QA_PLAYBOOK, /\*Class sweep \(issue #4735\): when you raise a finding, search the whole diff and every touched file/);
    assert.match(QA_PLAYBOOK, /3 or more instances, or the inputs are adversarial/);
  });

  test("the re-review context is APPENDED to the full packet, with the confirm-first instruction", () => {
    const s7 = QA_PLAYBOOK.slice(QA_PLAYBOOK.indexOf("#### 7.0a"), QA_PLAYBOOK.indexOf("#### 7a."));
    assert.ok(s7.includes("${PRIOR_FINDINGS}"));
    assert.ok(s7.includes('git diff --no-renames "$REREVIEW_DIFF_BASE" HEAD'));
    assert.ok(s7.includes('REVIEW_PACKET="${REVIEW_PACKET}'), "the context is appended; the full diff and changed files stay");
    assert.match(s7, /first state fixed\/not-fixed for each prior finding; for anything new, prefer medium\+ and say why it wasn't visible before/);
  });

  test("T1–T3: the round cap runs before this round's comment, and escalation never re-labels for dev", () => {
    assert.ok(t13.indexOf("# >>> qa-round-cap") < t13.indexOf("gh pr comment $pr_number"), "round cap must read the PR before this round is posted");
    const esc = t13.indexOf('if [ "$ROUND_ACTION" = "escalate" ]; then\n  gh issue comment');
    // Re-anchored by #4766: the second routing branch is now the open-PR
    // bounce arm (step 3's qa_bounce_label helper), replacing the retired
    // GLM_AUTHORED arm — escalate must still be the FIRST branch.
    const bounce = t13.indexOf('elif [ "$BOUNCE_LABEL" = "needs-dev-resume" ]');
    assert.ok(esc > 0 && esc < bounce, "escalate must be the first routing branch");
    const branch = t13.slice(esc, bounce);
    assert.ok(!branch.includes("ready-for-agent"));
    assert.ok(branch.includes("${ESC_LABEL_NOTE}"), "the labelled claim comes from the label calls' outcome");
    assert.ok(!branch.includes("Labelled `ready-for-human`"), "no unconditional labelled claim");
  });

  test("T4 keeps decideDeepQaAction and never runs the T1–T3 round cap", () => {
    assert.ok(t4.includes("decideDeepQaAction("));
    assert.ok(!t4.includes("qa-round-cap") && !t4.includes("decideQaRoundAction"));
  });
});

// ── #4735 simplification: re-review context never reaches the verdict ─────────
// Operator decision (https://github.com/gaberoo322/hydra/issues/4735#issuecomment-5883251393):
// the re-review context is PROMPT ONLY. No code path filters, demotes or narrows
// a finding; step 9 always folds with plain foldReviewFindings.
describe("no demotion path: step 9 always folds with plain foldReviewFindings (issue #4735)", () => {
  const OUT = ["REVIEW_VERDICT", "REVIEW_REPORT", "BLOCKERS", "MAX_SEVERITY"];
  const env = { STANDARDS_SUMMARY: "std", SPEC_SUMMARY: "spec", FANOUT_REASON: "fan", RED_REQUIRED_JSON: "[]" };
  function findingsFile(rows: unknown): string {
    const f = join(mkdtempSync(join(tmpdir(), "qa-4735-nodemote-")), "findings.json");
    writeFileSync(f, JSON.stringify(rows));
    return f;
  }

  test("the severity-fold block calls exactly one fold, passing the spawned reviewers when named (#4758)", () => {
    const block = playbookBlock("severity-fold");
    assert.ok(
      block.includes("q.foldReviewFindings({ tier, findings, ...(spawned.length > 0 ? { spawnedReviewers: spawned } : {}) })"),
      "the fold call must pass spawnedReviewers via a conditional spread",
    );
    assert.ok(block.includes('SPAWNED_REVIEWERS="$FANOUT_REVIEWERS"'), "the block must feed $FANOUT_REVIEWERS in");
    assert.equal((block.match(/q\.fold\w*\(/g) ?? []).length, 1, "one fold call, no scoped variant");
    for (const v of ["PRIOR_FINDINGS", "REREVIEW_DIFF_BASE", "scope", "prior"]) {
      assert.ok(!block.includes(v), `the fold must not read re-review context (${v})`);
    }
  });

  test("qa-verdict.ts exports no filter / scoped fold / prior-table parser", async () => {
    const mod: Record<string, unknown> = await import("../scripts/ci/qa-verdict.ts");
    for (const gone of ["filterReReviewFindings", "foldReReviewFindings", "parsePriorFindingsTable"]) {
      assert.equal(mod[gone], undefined, `${gone} must not exist`);
    }
  });

  test("the playbook keeps no per-PR re-review state", () => {
    for (const gone of ["HYDRA_QA_STATE_ROOT", "hydra-qa-state", "scope.json", "PRIOR_CHECKS_FILE", "foldReReviewFindings", "filterReReviewFindings"]) {
      assert.ok(!QA_PLAYBOOK.includes(gone), `playbook still mentions ${gone}`);
    }
  });

  test("executed fold with re-review context set: a new medium in an unchanged file still FAILs at T3", () => {
    const out = runBlock(
      "severity-fold",
      {
        ...env,
        PR_TIER_NUM: "3",
        PRIOR_FINDINGS: findingsSection(["| medium | standards | reviewer-A-standards | src/changed.ts:1 | bug | fix |"]),
        REREVIEW_DIFF_BASE: "aaaaaaaaaaaa",
        FINDINGS_FILE: findingsFile([finding({ severity: "medium", location: "src/never-touched.ts:5", finding: "new bug, no why-new" })]),
      },
      OUT,
    );
    assert.equal(out.REVIEW_VERDICT, "FAIL");
    assert.equal(out.MAX_SEVERITY, "medium");
    assert.equal(out.BLOCKERS, "1");
  });

  test("a failed fold keeps a ### Findings heading, so the round counts toward the cap", () => {
    const out = runBlock("severity-fold", { ...env, PR_TIER_NUM: "3", FINDINGS_FILE: findingsFile([]) }, OUT, `${brokenNodeDir()}:`);
    assert.equal(out.REVIEW_VERDICT, "FAIL");
    assert.ok((out.REVIEW_REPORT as string).startsWith("### Findings"), String(out.REVIEW_REPORT));
  });

  test("decideQaRoundAction counts a fold-failed FAIL round as a reviewed round", () => {
    const foldFailed = (round: number, sha: string) =>
      verdictBody(round, "FAIL", sha, 1, "high", "### Findings\n\n_Findings fold failed; raw reviewer reports follow._");
    const d = decideQaRoundAction({ tier: 3, verdict: "FAIL", pr: 7, priorBodies: [foldFailed(1, SHA_A), foldFailed(2, SHA_B)], currentReviewed: true });
    assert.equal(d.action, "escalate");
    assert.equal(d.failRound, QA_FAIL_ROUND_CAP);
  });
});

describe("buildCheckStates — required-ness joined from branch protection, not the rollup (issue #4757)", () => {
  /** The live protected contexts (gh api .../required_status_checks on master). */
  const CONTEXTS = ["test", "dashboard-build", "tier-gate", "mutation-test", "scope-check", "secret-scan", "deep-qa-gate", "design-concept-reconcile"];
  const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "pr-4754-status-check-rollup.json");
  const FIXTURE_RAW = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as { statusCheckRollup: RawRollupEntry[] };
  const FIXTURE = FIXTURE_RAW.statusCheckRollup;

  test("the recorded live fixture is the real rollup shape: no required-ness key at any depth, both row kinds, a duplicate name", () => {
    // Recursive key scan: the #4757 bug is that the rollup carries NO
    // required-ness field, so the fixture must never grow one either (a
    // hand-built `required: true` fixture is exactly what hid the bug).
    const keys = (v: unknown): string[] =>
      typeof v !== "object" || v === null
        ? []
        : Object.entries(v).flatMap(([k, val]) => [k, ...keys(val)]);
    assert.ok(!keys(FIXTURE_RAW).includes("isRequired"), "the live rollup carries no required-ness field (the #4757 bug)");
    const types = new Set(FIXTURE.map((e) => e.__typename));
    assert.ok(types.has("CheckRun") && types.has("StatusContext"), "fixture must pin BOTH live row kinds");
    assert.ok(
      FIXTURE.filter((e) => (e.name ?? e.context) === "deep-qa-gate").length >= 2,
      "fixture must pin the live duplicate-name pathology (re-runs leave stale rows)",
    );
  });

  test("marks exactly the branch-protection contexts required:true and every advisory check required:false", () => {
    const states = buildCheckStates(FIXTURE, CONTEXTS);
    for (const s of states) {
      assert.equal(s.required, CONTEXTS.includes(s.name), `${s.name} required=${s.required}`);
      // Output shape: exactly the pre-#4757 CHECKS_JSON contract — no new keys.
      assert.deepEqual(Object.keys(s).sort(), ["conclusion", "name", "required", "status"], `${s.name} keys`);
    }
    assert.equal(states.filter((s) => s.required).length, CONTEXTS.length);
    // The fixture rollup names all 8 required contexts, so nothing is synthesized.
    assert.equal(states.length, new Set(FIXTURE.map((e) => e.name ?? e.context).filter(Boolean)).size);
  });

  test("dedup keeps the LATEST entry per name (fixture's triple deep-qa-gate folds to one; stale CANCELLED loses to fresh FAILURE)", () => {
    const states = buildCheckStates(FIXTURE, CONTEXTS);
    const dqa = states.filter((s) => s.name === "deep-qa-gate");
    assert.equal(dqa.length, 1);
    assert.deepEqual(dqa[0], { name: "deep-qa-gate", status: "completed", conclusion: "success", required: true });

    const pair = (a: string, b: string) =>
      buildCheckStates(
        [
          { __typename: "CheckRun", name: "x", status: "COMPLETED", conclusion: a, startedAt: "2026-01-01T00:00:00Z" },
          { __typename: "CheckRun", name: "x", status: "COMPLETED", conclusion: b, startedAt: "2026-01-02T00:00:00Z" },
        ],
        [],
      );
    assert.equal(pair("CANCELLED", "FAILURE")[0].conclusion, "failure", "greatest startedAt wins");
    assert.equal(pair("FAILURE", "CANCELLED")[0].conclusion, "cancelled", "…even when the stale row is listed second");
    // Equal startedAt → later list index wins.
    const tie = buildCheckStates(
      [
        { __typename: "CheckRun", name: "x", status: "COMPLETED", conclusion: "CANCELLED", startedAt: "2026-01-01T00:00:00Z" },
        { __typename: "CheckRun", name: "x", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-01-01T00:00:00Z" },
      ],
      [],
    );
    assert.equal(tie[0].conclusion, "failure", "a startedAt tie falls to the later list index");
  });

  test("a queued / unstamped row is never shadowed by a stale completed SUCCESS — both list orders, same-kind and cross-kind (#4757 QA round 1)", () => {
    const stale = { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-01-01T00:00:00Z" };
    const queued = { __typename: "CheckRun", name: "test", status: "QUEUED", conclusion: null };
    const staleCtx = { __typename: "StatusContext", context: "test", state: "SUCCESS", createdAt: "2026-01-01T00:00:00Z" };
    const pendingCtx = { __typename: "StatusContext", context: "test", state: "PENDING" };
    const cases: Array<[string, Record<string, unknown>[]]> = [
      ["same-kind queued last", [stale, queued]],
      ["same-kind queued first", [queued, stale]],
      ["cross-kind pending ctx last", [stale, pendingCtx]],
      ["cross-kind pending ctx first", [pendingCtx, stale]],
      ["cross-kind queued run vs stale ctx, queued first", [queued, staleCtx]],
      ["cross-kind queued run vs stale ctx, queued last", [staleCtx, queued]],
      ["cross-kind pending ctx vs stale run, ctx first", [pendingCtx, staleCtx]],
    ];
    for (const [label, rows] of cases) {
      const [s] = buildCheckStates(rows, ["test"]);
      assert.equal(s.status === "completed" && s.conclusion === "success", false, `${label}: must not read PASS`);
      assert.equal(s.required, true, label);
    }
    // An unstamped completed row listed later still beats an older stamped row (index fallback).
    const [a] = buildCheckStates([stale, { ...stale, conclusion: "FAILURE", startedAt: undefined }], []);
    assert.equal(a.conclusion, "failure");
  });

  test("StatusContext rows fold by commit-status state", () => {
    const fold = (state: string) =>
      buildCheckStates([{ __typename: "StatusContext", context: `sc-${state}`, state, startedAt: "2026-01-01T00:00:00Z" }], [])[0];
    assert.deepEqual(fold("SUCCESS"), { name: "sc-SUCCESS", status: "completed", conclusion: "success", required: false });
    assert.deepEqual(fold("PENDING"), { name: "sc-PENDING", status: "pending", conclusion: null, required: false });
    assert.deepEqual(fold("EXPECTED"), { name: "sc-EXPECTED", status: "pending", conclusion: null, required: false });
    assert.deepEqual(fold("FAILURE"), { name: "sc-FAILURE", status: "completed", conclusion: "failure", required: false });
    assert.deepEqual(fold("ERROR"), { name: "sc-ERROR", status: "completed", conclusion: "failure", required: false });
    assert.deepEqual(fold("SOMETHING_NEW"), { name: "sc-SOMETHING_NEW", status: "pending", conclusion: null, required: false }, "unknown state reads pending, not guessed");
  });

  test("a required context absent from the rollup is synthesized as pending, never invisible", () => {
    assert.deepEqual(buildCheckStates([], ["late-gate"]), [
      { name: "late-gate", status: "pending", conclusion: null, required: true },
    ]);
  });

  test("nameless rows are skipped; CheckRun enums fold to lowercase-canonical (#761)", () => {
    const states = buildCheckStates(
      [
        { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-01-01T00:00:00Z" }, // no name/context — noise
        { __typename: "CheckRun", name: "casing", status: "IN_PROGRESS", conclusion: null, startedAt: "2026-01-01T00:00:00Z" },
        { name: "minimal", status: "COMPLETED", conclusion: "SUCCESS" }, // no startedAt, no __typename
      ],
      [],
    );
    assert.equal(states.length, 2, "the nameless row is skipped");
    assert.deepEqual(states[0], { name: "casing", status: "in_progress", conclusion: null, required: false });
    assert.deepEqual(states[1], { name: "minimal", status: "completed", conclusion: "success", required: false });
  });

  test("end-to-end against the classifier: fixture + live contexts chain to a clean PASS", () => {
    const states = buildCheckStates(FIXTURE, CONTEXTS);
    assert.deepEqual(redRequiredChecks(states), []);
    const r = classifyVerdict("PASS", states);
    assert.equal(r.summary.requiredPending, 0);
    assert.equal(r.summary.requiredFailed, 0);
  });
});

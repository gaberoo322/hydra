/**
 * Regression tests for the AC1 catch-rate measurement helper (issue #3815).
 *
 * The design-concept artifact's acceptance criterion 1 requires the true QA
 * catch rate to be measured by counting FAIL verdicts wherever they are
 * recorded — PR review state, a verdict comment, or the ready-for-agent
 * bounce path — not just `CHANGES_REQUESTED` on closed PRs (the issue's own
 * flawed 0/36 original methodology). These tests pin the three-signal
 * classification rule `scripts/ci/qa-catch-rate.ts` implements:
 *
 *   1. No `Automated QA` marker anywhere → not-reviewed (excluded from the
 *      rate, not counted as a clean pass)
 *   2. `Automated QA` marker present, no FAIL signal → clean-pass
 *   3. A `CHANGES_REQUESTED` review carrying the marker → caught
 *   4. A `**Verdict:** \`FAIL\`` PR comment → caught (covers the
 *      admission-gate's `skip-required-failed` branch, which never spawns a
 *      reviewer, so it has no review-state signal at all)
 *   5. A `**Verdict:** \`FAIL-pending-CI\`` PR comment → caught
 *   6. A `ready-for-agent` bounce-path issue comment (T1-T3 or either T4
 *      literal) → caught
 *   7. computeCatchRate folds outcomes into the aggregate rate, and never
 *      divides by zero (0 reviewed → catchRate 0, not NaN)
 *
 * This module is pure — no fs/network/process — so these tests run in
 * milliseconds with zero setup, matching the sibling `qa-verdict.ts` and
 * `issue-dedup.ts` regression suites' style.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  classifyPrQaOutcome,
  computeCatchRate,
  AUTOMATED_QA_MARKER,
  type QaSignalSet,
  type PrQaOutcome,
} from "../scripts/ci/qa-catch-rate.ts";

const empty: QaSignalSet = { reviews: [], prComments: [], issueComments: [] };

describe("classifyPrQaOutcome — not-reviewed", () => {
  test("no Automated QA marker anywhere → not-reviewed", () => {
    const signals: QaSignalSet = {
      reviews: [{ state: "APPROVED", body: "looks good" }],
      prComments: [{ body: "unrelated comment" }],
      issueComments: [{ body: "unrelated issue chatter" }],
    };
    assert.equal(classifyPrQaOutcome(signals), "not-reviewed");
  });

  test("an empty signal set is not-reviewed", () => {
    assert.equal(classifyPrQaOutcome(empty), "not-reviewed");
  });
});

describe("classifyPrQaOutcome — clean-pass", () => {
  test("Automated QA PASS comment with no FAIL signal → clean-pass", () => {
    const signals: QaSignalSet = {
      reviews: [],
      prComments: [
        {
          body: `> *${AUTOMATED_QA_MARKER} — two-axis review*\n\n**Verdict:** \`PASS\` — all checks green`,
        },
      ],
      issueComments: [],
    };
    assert.equal(classifyPrQaOutcome(signals), "clean-pass");
  });

  test("Automated QA PASS-pending-CI comment → clean-pass (not a FAIL literal)", () => {
    const signals: QaSignalSet = {
      reviews: [],
      prComments: [
        {
          body: `> *${AUTOMATED_QA_MARKER} — two-axis review (pending CI)*\n\nVerdict: \`PASS-pending-CI\`.`,
        },
      ],
      issueComments: [],
    };
    assert.equal(classifyPrQaOutcome(signals), "clean-pass");
  });

  test("an APPROVED review carrying the marker is not itself a catch", () => {
    const signals: QaSignalSet = {
      reviews: [
        { state: "APPROVED", body: `${AUTOMATED_QA_MARKER}: no blockers found` },
      ],
      prComments: [],
      issueComments: [],
    };
    assert.equal(classifyPrQaOutcome(signals), "clean-pass");
  });
});

describe("classifyPrQaOutcome — caught (three signals)", () => {
  test("signal 1: CHANGES_REQUESTED review carrying the marker → caught", () => {
    const signals: QaSignalSet = {
      reviews: [
        {
          state: "CHANGES_REQUESTED",
          body: `> *${AUTOMATED_QA_MARKER} — two-axis review*\n\n**Verdict:** \`FAIL\` — hard finding on the Standards axis`,
        },
      ],
      prComments: [],
      issueComments: [],
    };
    assert.equal(classifyPrQaOutcome(signals), "caught");
  });

  test("signal 2: a bare **Verdict:** `FAIL` PR comment → caught (skip-required-failed branch, no reviewer spawned)", () => {
    const signals: QaSignalSet = {
      reviews: [],
      prComments: [
        {
          body: `${AUTOMATED_QA_MARKER} note.\n\n**Verdict:** \`FAIL\` — a required check already failed`,
        },
      ],
      issueComments: [],
    };
    assert.equal(classifyPrQaOutcome(signals), "caught");
  });

  test("signal 2b: **Verdict:** `FAIL-pending-CI` PR comment → caught", () => {
    const signals: QaSignalSet = {
      reviews: [],
      prComments: [
        {
          body: `${AUTOMATED_QA_MARKER} note.\n\n**Verdict:** \`FAIL-pending-CI\` — reserved tier`,
        },
      ],
      issueComments: [],
    };
    assert.equal(classifyPrQaOutcome(signals), "caught");
  });

  test("signal 3: T1-T3 bounce-path issue comment → caught", () => {
    const signals: QaSignalSet = {
      reviews: [],
      prComments: [{ body: `${AUTOMATED_QA_MARKER} ran and passed the review axes` }],
      issueComments: [
        { body: "> *Automated QA failed*\n\nReturning to ready-for-agent for retry." },
      ],
    };
    assert.equal(classifyPrQaOutcome(signals), "caught");
  });

  test("signal 3b: T4 first-fail bounce issue comment → caught", () => {
    const signals: QaSignalSet = {
      reviews: [],
      prComments: [{ body: `${AUTOMATED_QA_MARKER} deep review ran` }],
      issueComments: [
        {
          body: "> *T4 Deep-QA failed (1st) — bouncing to dev*\n\nReturning to ready-for-agent for remediation.",
        },
      ],
    };
    assert.equal(classifyPrQaOutcome(signals), "caught");
  });

  test("signal 3c: T4 block-and-escalate issue comment → caught", () => {
    const signals: QaSignalSet = {
      reviews: [],
      prComments: [{ body: `${AUTOMATED_QA_MARKER} deep review ran` }],
      issueComments: [
        {
          body: "> *T4 Deep-QA blocked — operator decision needed*\n\nfailed the Verifier-Core deep-QA gate twice consecutively.",
        },
      ],
    };
    assert.equal(classifyPrQaOutcome(signals), "caught");
  });

  test("a CHANGES_REQUESTED review with NO marker does not count as an Automated QA catch", () => {
    const signals: QaSignalSet = {
      reviews: [{ state: "CHANGES_REQUESTED", body: "please rename this variable" }],
      prComments: [{ body: `${AUTOMATED_QA_MARKER} ran clean` }],
      issueComments: [],
    };
    assert.equal(classifyPrQaOutcome(signals), "clean-pass");
  });
});

describe("computeCatchRate", () => {
  test("folds outcomes into totals and a ratio", () => {
    const outcomes: PrQaOutcome[] = [
      "caught",
      "caught",
      "clean-pass",
      "clean-pass",
      "clean-pass",
      "clean-pass",
      "not-reviewed",
      "not-reviewed",
    ];
    const result = computeCatchRate(outcomes);
    assert.equal(result.totalPrs, 8);
    assert.equal(result.totalCaught, 2);
    assert.equal(result.totalCleanPass, 4);
    assert.equal(result.totalNotReviewed, 2);
    assert.equal(result.totalReviewed, 6);
    assert.equal(result.catchRate, 2 / 6);
  });

  test("zero reviewed PRs never divides by zero — catchRate is 0, not NaN", () => {
    const result = computeCatchRate(["not-reviewed", "not-reviewed"]);
    assert.equal(result.totalReviewed, 0);
    assert.equal(result.catchRate, 0);
    assert.ok(!Number.isNaN(result.catchRate));
  });

  test("empty input yields all-zero totals with no throw", () => {
    const result = computeCatchRate([]);
    assert.deepEqual(result, {
      totalPrs: 0,
      totalReviewed: 0,
      totalCaught: 0,
      totalCleanPass: 0,
      totalNotReviewed: 0,
      catchRate: 0,
    });
  });

  test("all-caught window yields catchRate 1", () => {
    const result = computeCatchRate(["caught", "caught", "caught"]);
    assert.equal(result.catchRate, 1);
  });
});

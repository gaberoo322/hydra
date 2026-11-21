/**
 * Moved verbatim from test/hydra-qa-prompt-verdict.test.mts (issue #5079,
 * ADR-0038 D2 — mechanical move): the round-action phase — bounce / escalate round cap, T4 deep-QA loop and PASS marker cases.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { CAP_DEFAULTS } from "../src/lifecycle/caps.ts";
import { glmLane } from "../src/glm/eligibility.ts";
import * as roundActionModule from "../src/qa/round-action.ts";
import {
  DEEP_QA_FAIL_MARKER,
  DEEP_QA_PASS_MARKER,
  QA_ESCALATION_LABELS,
  QA_FAIL_ROUND_CAP,
  decideQaRoundAction,
  hasFreshDeepQaPass,
  recommendQaEscalation,
  renderDeepQaPassMarker,
  renderQaEscalationSummary,
} from "../src/qa/round-action.ts";
import {
  type FinalVerdict,
  type QaSeverity,
  renderQaVerdictTrailer,
} from "../src/qa/verdict-trailer.ts";
import { decideRound } from "../src/qa/round-action.ts";

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

describe("T4 deep-QA FAIL marker (issue #740, #5662)", () => {
  // The FAIL count and the 2nd-FAIL escalation live in the seam's `deep-qa-fails` Cap Arm
  // (test/lifecycle-caps.test.mts); this module only owns the marker literal and where it is emitted.
  test("DEEP_QA_FAIL_MARKER is the stable greppable literal the seam counts", () => {
    // If this literal drifts, the seam's per-PR count silently stops matching and a T4 PR bounces forever.
    assert.equal(DEEP_QA_FAIL_MARKER, "Verifier-Core deep-QA: FAIL");
  });

  test("decideDeepQaAction no longer exists: round-action routes no T4 FAIL itself", () => {
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
    { name: "T4 → deep-qa (the seam owns FAIL routing)", tier: 4, verdict: "FAIL", prior: [f1, f2], action: "deep-qa", failRound: null, round: 3 },
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

  test("FAIL rounds before the latest Hydra-Cap-Reset marker do not count (ADR-0047 D6)", () => {
    const reset = "Hydra-Cap-Reset: by=operator ts=2026-11-04T10:00:00Z";
    const before = decideQaRoundAction({ tier: 3, verdict: "FAIL", pr: 7, priorBodies: [f1, f2] });
    assert.equal(before.action, "escalate");
    const after = decideQaRoundAction({ tier: 3, verdict: "FAIL", pr: 7, priorBodies: [f1, f2, reset] });
    assert.equal(after.action, "bounce");
    assert.equal(after.failRound, 1);
    // round numbering is unchanged: it still counts every trailer on the PR
    assert.equal(after.round, 3);
    const oneAfter = decideQaRoundAction({ tier: 3, verdict: "FAIL", pr: 7, priorBodies: [f1, f2, reset, verdictBody(3, "FAIL", SHA_C, 1, "high")] });
    assert.equal(oneAfter.failRound, 2);
  });

  test("QA_FAIL_ROUND_CAP is sourced from the caps.ts default, not env-overridable", () => {
    assert.equal(QA_FAIL_ROUND_CAP, CAP_DEFAULTS["qa-fail-rounds"]);
  });

  test("the T1-T3 cap is 3", () => {
    assert.equal(QA_FAIL_ROUND_CAP, 3);
  });

  test("escalation labels leave the issue on no dev lane (glmLane → neither)", () => {
    const before = ["enhancement", "needs-qa", "ready-for-agent", "glm-eligible", "in-progress", "needs-dev-resume"];
    const after = [...before.filter((l) => !QA_ESCALATION_LABELS.issueRemove.includes(l)), ...QA_ESCALATION_LABELS.issueAdd];
    for (const active of [true, false]) assert.equal(glmLane(after, active).lane, "neither");
    for (const l of ["needs-qa", "ready-for-agent", "needs-dev-resume", "in-progress"]) {
      assert.ok(!after.includes(l), `${l} must be removed`);
    }
    assert.ok(after.includes("ready-for-human"));
    // The PR is labelled too: the Turn Snapshot's dev-resume pick skips a ready-for-human PR.
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

describe("decideRound — the composed round-action head (issue #5079, INV-3)", () => {
  const prior1 = verdictBody(1, "FAIL", SHA_A, 1, "medium");
  const prior2 = verdictBody(2, "FAIL", SHA_B, 1, "medium");

  test("T1-T3 FAIL round 1 bounces, equal to decideQaRoundAction, with no fail marker or summary", () => {
    const input = { tier: 3, verdict: "FAIL", reviewVerdict: "FAIL" as const, pr: 7, headSha: SHA_C, priorBodies: [] as string[] };
    const r = decideRound(input);
    assert.deepEqual(r.round, decideQaRoundAction(input));
    assert.equal(r.round.action, "bounce");
    assert.equal(r.failMarker, null);
    assert.equal(r.passMarker, null);
    assert.equal(r.escalationSummary, null);
  });

  test("the 3rd reviewed FAIL escalates and renders the structured summary", () => {
    const current = renderQaVerdictTrailer({ verdict: "FAIL", pr: 7, round: 3, sha: SHA_C, blockers: 1, maxSeverity: "medium" });
    const r = decideRound({
      tier: 2, verdict: "FAIL", reviewVerdict: "FAIL", pr: 7, headSha: SHA_C,
      priorBodies: [prior1, prior2], currentTrailer: current,
    });
    assert.equal(r.round.action, "escalate");
    assert.equal(
      r.escalationSummary,
      renderQaEscalationSummary({ pr: 7, priorBodies: [prior1, prior2], currentTrailer: current }),
    );
  });

  test("T4 FAIL carries the fail marker and NO PASS marker, whatever the prior bodies", () => {
    const r = decideRound({ tier: 4, verdict: "FAIL", reviewVerdict: "FAIL", pr: 7, headSha: SHA_C, priorBodies: [] });
    assert.equal(r.round.action, "deep-qa");
    assert.equal(r.failMarker, DEEP_QA_FAIL_MARKER);
    assert.equal(r.passMarker, null);
    assert.equal(r.escalationSummary, null);
  });

  test("T4 FAIL driven by CI alone (review PASS) still carries the fail marker, never the PASS marker", () => {
    const r = decideRound({ tier: 4, verdict: "FAIL-pending-CI", reviewVerdict: "PASS", pr: 7, headSha: SHA_C, priorBodies: [`c1 ${DEEP_QA_FAIL_MARKER}`] });
    assert.equal(r.failMarker, DEEP_QA_FAIL_MARKER);
    assert.equal(r.passMarker, null);
  });

  test("T4 PASS carries the SHA-bound PASS marker", () => {
    const r = decideRound({ tier: 4, verdict: "PASS", reviewVerdict: "PASS", pr: 7, headSha: SHA_C, priorBodies: [] });
    assert.equal(r.round.action, "deep-qa");
    assert.equal(r.failMarker, null);
    assert.equal(r.passMarker, renderDeepQaPassMarker(SHA_C));
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  shadowFold,
  renderQaShadowLine,
  parseQaShadowLines,
  type ShadowFoldInput,
} from "../src/qa/shadow-fold.ts";
import type { ReversibilityRecord } from "../src/qa/fanout.ts";
import { parseQaVerdictTrailers } from "../src/qa/verdict-trailer.ts";

const QUARTET = ["reviewer-A-standards", "reviewer-A-spec", "reviewer-B-standards", "reviewer-B-spec"];
const PAIR = ["standards", "spec"];

function row(reviewer: string, severity: string, location: string, finding = "bug") {
  return { reviewer, severity, axis: "standards", location, finding, fix: "fix it" };
}

function emptyMap(names: readonly string[]): Record<string, unknown[]> {
  return Object.fromEntries(names.map((n) => [n, []]));
}

function record(over: Partial<ReversibilityRecord> = {}): ReversibilityRecord {
  return {
    door: "two-way",
    twoWayPair: "shadow",
    legacyMode: "adversarial",
    selectedMode: "standard",
    pairEligible: true,
    reductionApplied: false,
    escalated: false,
    ...over,
  };
}

function shadowInput(findings: unknown, over: Partial<ShadowFoldInput> = {}): ShadowFoldInput {
  return {
    tier: 3,
    findings,
    spawnedReviewers: QUARTET,
    fanoutMode: "adversarial",
    reversibility: record(),
    ...over,
  };
}

describe("shadowFold counterfactual", () => {
  it("miss round: B-only medium is a pair-miss, A-only counterfactual PASSes, live FAILs", () => {
    const map = { ...emptyMap(QUARTET), "reviewer-B-spec": [row("reviewer-B-spec", "medium", "src/a.ts:1")] };
    const r = shadowFold(shadowInput(map));
    assert.equal(r.live.reviewVerdict, "FAIL");
    const cf = r.counterfactual;
    assert.ok(cf.applicable && cf.measured);
    assert.equal(cf.pairMissCount, 1);
    assert.equal(cf.reviewVerdict, "PASS");
    assert.equal(cf.verdictFlipped, true);
    assert.equal(cf.pairMissRows[0]?.location, "src/a.ts:1");
  });

  it("no-miss round: a row A and B both raised is not a miss", () => {
    const map = {
      ...emptyMap(QUARTET),
      "reviewer-A-spec": [row("reviewer-A-spec", "high", "src/a.ts:1")],
      "reviewer-B-spec": [row("reviewer-B-spec", "high", "src/a.ts:1")],
    };
    const cf = shadowFold(shadowInput(map)).counterfactual;
    assert.ok(cf.applicable && cf.measured);
    assert.equal(cf.pairMissCount, 0);
    assert.equal(cf.reviewVerdict, "FAIL");
    assert.equal(cf.verdictFlipped, false);
  });

  it("no-miss round: A-only finding is not a miss", () => {
    const map = { ...emptyMap(QUARTET), "reviewer-A-spec": [row("reviewer-A-spec", "medium", "src/a.ts:1")] };
    const cf = shadowFold(shadowInput(map)).counterfactual;
    assert.ok(cf.applicable && cf.measured);
    assert.equal(cf.pairMissCount, 0);
  });

  it("no-miss round: B-only LOW is a follow-up, never a miss", () => {
    const map = { ...emptyMap(QUARTET), "reviewer-B-spec": [row("reviewer-B-spec", "low", "src/a.ts:1")] };
    const r = shadowFold(shadowInput(map));
    const cf = r.counterfactual;
    assert.ok(cf.applicable && cf.measured);
    assert.equal(cf.pairMissCount, 0);
    assert.equal(r.live.reviewVerdict, "PASS");
  });

  const clean = emptyMap(QUARTET);
  const notApplicable: Array<[string, ShadowFoldInput, string]> = [
    ["record absent", shadowInput(clean, { reversibility: null }), "reversibility-record-absent"],
    ["off", shadowInput(clean, { reversibility: record({ twoWayPair: "off" }) }), "two-way-pair-off"],
    ["on", shadowInput(clean, { reversibility: record({ twoWayPair: "on" }) }), "two-way-pair-on"],
    ["pairEligible false", shadowInput(clean, { reversibility: record({ pairEligible: false }) }), "pair-not-eligible"],
    [
      "reductionApplied",
      shadowInput(clean, { reversibility: record({ reductionApplied: true }) }),
      "pair-reduction-applied",
    ],
    [
      "non-adversarial live mode",
      shadowInput(emptyMap(PAIR), { fanoutMode: "standard", spawnedReviewers: PAIR }),
      "live-mode-not-adversarial",
    ],
    ["T4 any-blocker", shadowInput(clean, { tier: 4 }), "tier-not-severity-gated"],
  ];
  for (const [name, input, reason] of notApplicable) {
    it(`not applicable: ${name}`, () => {
      const cf = shadowFold(input).counterfactual;
      assert.equal(cf.applicable, false);
      assert.equal((cf as { reason: string }).reason, reason);
      assert.equal("pairMissCount" in cf, false);
    });
  }

  it("not applicable: no A reviewer spawned", () => {
    const names = ["reviewer-B-standards", "reviewer-B-spec"];
    const cf = shadowFold(shadowInput(emptyMap(names), { spawnedReviewers: names })).counterfactual;
    assert.equal(cf.applicable, false);
    assert.equal((cf as { reason: string }).reason, "no-a-reviewer");
  });

  it("malformed B output is unmeasured, not a clean round", () => {
    const map: Record<string, unknown> = emptyMap(QUARTET);
    delete map["reviewer-B-spec"];
    const r = shadowFold(shadowInput(map));
    const cf = r.counterfactual;
    assert.ok(cf.applicable && !cf.measured);
    assert.equal(cf.pairMissCount, null);
    assert.equal((cf as { reason: string }).reason, "reviewer-output-malformed");
    assert.match(renderQaShadowLine({ pr: 9, sha: "abcdef1234567", result: r }), /pair_miss=unmeasured/);
  });
});

describe("shadowFold top-up and detector gaps", () => {
  const pairRec = record({ reductionApplied: true, selectedMode: "standard", legacyMode: "adversarial" });
  const pairInput = (doors: ShadowFoldInput["reviewerDoors"], rec = pairRec) =>
    shadowInput(emptyMap(PAIR), {
      fanoutMode: "standard",
      spawnedReviewers: PAIR,
      reversibility: rec,
      reviewerDoors: doors,
    });

  it("pair live + reviewer one-way: tops up with reviewer B and logs a gap", () => {
    const r = shadowFold(pairInput({ spec: "one-way" }));
    assert.equal(r.topUp.required, true);
    assert.deepEqual(r.topUp.addReviewers, ["reviewer-B-standards", "reviewer-B-spec"]);
    assert.equal(r.topUp.mode, "adversarial");
    assert.deepEqual(r.detectorGaps, [{ reviewer: "spec", reviewerDoor: "one-way", detectorDoor: "two-way" }]);
  });

  it("pair live + reviewer unknown: same as one-way (fail closed)", () => {
    const r = shadowFold(pairInput({ standards: "unknown" }));
    assert.equal(r.topUp.required, true);
    assert.equal(r.detectorGaps.length, 1);
  });

  it("adversarial live + one-way: gap only, no top-up", () => {
    const r = shadowFold(shadowInput(emptyMap(QUARTET), { reviewerDoors: { "reviewer-B-spec": "one-way" } }));
    assert.equal(r.topUp.required, false);
    assert.equal(r.topUp.reason, "already-adversarial");
    assert.equal(r.detectorGaps.length, 1);
  });

  it("detector already one-way: no gap", () => {
    const r = shadowFold(pairInput({ spec: "one-way" }, record({ door: "one-way", reductionApplied: true })));
    assert.equal(r.detectorGaps.length, 0);
  });

  it("detector not run (null door) still logs a gap", () => {
    const r = shadowFold(pairInput({ spec: "one-way" }, record({ door: null, reductionApplied: true })));
    assert.deepEqual(r.detectorGaps[0]?.detectorDoor, null);
  });

  it("no reviewer call / absent doors / two-way call: no top-up", () => {
    assert.equal(shadowFold(pairInput(undefined)).topUp.reason, "reviewerDoors-absent");
    assert.equal(shadowFold(pairInput({ spec: "two-way" })).topUp.reason, "no-reviewer-call");
    assert.equal(shadowFold(pairInput({ spec: "two-way" })).detectorGaps.length, 0);
  });

  it("single mode never tops up", () => {
    const r = shadowFold(
      shadowInput(emptyMap(["reviewer-single"]), {
        fanoutMode: "single",
        spawnedReviewers: ["reviewer-single"],
        reviewerDoors: { "reviewer-single": "one-way" },
      }),
    );
    assert.equal(r.topUp.required, false);
    assert.equal(r.topUp.reason, "single-mode");
  });

  it("a detector gap is never a finding: pair-miss count and verdict unchanged", () => {
    const withGap = shadowFold(shadowInput(emptyMap(QUARTET), { reviewerDoors: { "reviewer-A-spec": "one-way" } }));
    const without = shadowFold(shadowInput(emptyMap(QUARTET)));
    assert.deepEqual(withGap.counterfactual, without.counterfactual);
    assert.equal(withGap.live.reviewVerdict, without.live.reviewVerdict);
  });
});

describe("QA-Shadow line", () => {
  const miss = shadowFold(
    shadowInput({ ...emptyMap(QUARTET), "reviewer-B-spec": [row("reviewer-B-spec", "medium", "src/a.ts:1")] }),
  );

  it("renders one line and round-trips through the parser", () => {
    const line = renderQaShadowLine({ pr: 42, sha: "ABCDEF1234567890", result: miss });
    assert.equal(
      line,
      "QA-Shadow: pr=42 sha=abcdef123456 pair_miss=1 counterfactual=PASS live=FAIL top_up=0 detector_gaps=0",
    );
    assert.deepEqual(parseQaShadowLines(`text\n${line}\nmore`), [
      { pr: 42, sha: "abcdef123456", pairMiss: 1, counterfactual: "PASS", live: "FAIL", topUp: 0, detectorGaps: 0 },
    ]);
  });

  it("not applicable renders n/a; bad sha renders unknown; malformed pr parses null", () => {
    const na = shadowFold(shadowInput(emptyMap(QUARTET), { reversibility: null }));
    const line = renderQaShadowLine({ pr: null, sha: "zzz", result: na });
    assert.match(line, /pr=unknown sha=unknown pair_miss=n\/a counterfactual=n\/a live=PASS/);
    const parsed = parseQaShadowLines(line)[0];
    assert.equal(parsed?.pr, null);
    assert.equal(parsed?.pairMiss, "n/a");
  });

  it("never collides with the QA-Verdict trailer grammar", () => {
    const line = renderQaShadowLine({ pr: 42, sha: "abcdef1234567", result: miss });
    assert.deepEqual(parseQaVerdictTrailers(line), []);
    assert.deepEqual(parseQaShadowLines("QA-Verdict: PASS pr=1"), []);
  });
});

describe("shadowFold purity", () => {
  it("does not mutate inputs and repeated calls are deep-equal", () => {
    const map = { ...emptyMap(QUARTET), "reviewer-B-spec": [row("reviewer-B-spec", "high", "src/a.ts:1")] };
    const input = shadowInput(map, { reviewerDoors: { "reviewer-B-spec": "one-way" } });
    const snapshot = structuredClone(input);
    const first = shadowFold(input);
    const second = shadowFold(input);
    assert.deepEqual(input, snapshot);
    assert.deepEqual(first, second);
  });

  it("leaves the live fold untouched: no shadow code in fold.ts", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/qa/fold.ts", import.meta.url), "utf8");
    assert.equal(src.includes("shadow"), false);
  });
});

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  GRADUATION_MIN_SHADOW_PRS,
  TRIP_MIN_PAIR_PRS,
  FLIP_ITEM_TITLE,
  FLIP_ITEM_MARKER,
  assessPairGraduation,
  planFlipItem,
  findOnWindow,
  pairCohortOf,
  type GraduationInputs,
} from "../scripts/qa/pair-graduation.ts";
import { MIN_MATURED_PAIR } from "../scripts/qa/cohort-baseline.ts";
import type { ParsedQaShadowLine } from "../src/qa/shadow-fold.ts";
import type { QaVerdictTrailer } from "../src/qa/verdict-trailer.ts";

const line = (pr: number, pairMiss: ParsedQaShadowLine["pairMiss"]): ParsedQaShadowLine => ({
  pr,
  sha: "abcdef1",
  pairMiss,
  counterfactual: "PASS",
  live: "PASS",
  topUp: 0,
  detectorGaps: 0,
});
const trailer = (pr: number): QaVerdictTrailer => ({
  verdict: "PASS",
  pr,
  round: 1,
  sha: "aaaaaaaaaaaa",
  blockers: 0,
  maxSeverity: "none",
});
const shadowPrs = (n: number, miss: ParsedQaShadowLine["pairMiss"] = 0, start = 1) =>
  Array.from({ length: n }, (_, i) => ({ number: start + i, shadowLines: [line(start + i, miss)] }));
const inputs = (over: Partial<GraduationInputs> = {}): GraduationInputs => ({
  prs: shadowPrs(20),
  switches: { configured: "shadow", trip: "not-tripped" },
  cohortTrip: { pairMatured: 0, tripped: false, criteriaMet: false },
  ...over,
});

describe("assessPairGraduation readiness", () => {
  test("ready at 20 clean measured shadow PRs in shadow", () => {
    const { report } = assessPairGraduation(inputs());
    assert.equal(report.ready, true);
    assert.equal(report.state, "ready");
    assert.equal(report.shadow.measuredPrs, 20);
    assert.equal(report.shadow.needed, GRADUATION_MIN_SHADOW_PRS);
  });

  test("not ready at 19 and still reports the numeric evidence", () => {
    const { report } = assessPairGraduation(inputs({ prs: shadowPrs(19) }));
    assert.equal(report.ready, false);
    assert.equal(report.state, "collecting");
    assert.equal(report.shadow.measuredPrs, 19);
    assert.equal(report.shadow.pairMissPrs, 0);
  });

  test("one pair-miss PR blocks readiness", () => {
    const prs = [...shadowPrs(20), { number: 99, shadowLines: [line(99, 2)] }];
    const { report } = assessPairGraduation(inputs({ prs }));
    assert.equal(report.ready, false);
    assert.equal(report.shadow.pairMissPrs, 1);
    assert.equal(report.shadow.measuredPrs, 21);
  });

  test("unmeasured and n/a rounds neither count nor block", () => {
    const prs = [
      ...shadowPrs(20),
      { number: 90, shadowLines: [line(90, "unmeasured")] },
      { number: 91, shadowLines: [line(91, "n/a")] },
    ];
    const { report } = assessPairGraduation(inputs({ prs }));
    assert.equal(report.ready, true);
    assert.equal(report.shadow.unmeasured, 1);
    assert.equal(report.shadow.measuredPrs, 20);
  });

  test("a pr= mismatch line is not that PR's evidence", () => {
    const prs = [{ number: 1, shadowLines: [line(2, 0)] }];
    const { report } = assessPairGraduation(inputs({ prs }));
    assert.equal(report.shadow.measuredPrs, 0);
  });

  test("not-in-shadow, already-on and tripped never plan a flip item", () => {
    for (const [sw, state] of [
      [{ configured: "off", trip: "not-tripped" }, "not-in-shadow"],
      [{ configured: "on", trip: "not-tripped" }, "already-on"],
      [{ configured: "shadow", trip: "tripped" }, "tripped"],
    ] as const) {
      const { report } = assessPairGraduation(inputs({ switches: sw as any }));
      assert.equal(report.state, state);
      assert.equal(report.ready, false);
      assert.equal(planFlipItem(report, []).file, false);
    }
  });

  test("the fold never throws on {}", () => {
    const r = assessPairGraduation({} as any);
    assert.equal(r.report.ready, false);
    assert.equal(r.report.shadow.measuredPrs, 0);
  });

  test("malformed and duplicate rows warn", () => {
    const { warnings } = assessPairGraduation(
      inputs({ prs: [{ number: 0, shadowLines: [] }, ...shadowPrs(1), ...shadowPrs(1)] }),
    );
    assert.equal(warnings.some((w) => w.includes("missing number")), true);
    assert.equal(warnings.some((w) => w.includes("duplicate")), true);
  });
});

describe("planFlipItem", () => {
  const ready = () => assessPairGraduation(inputs()).report;

  test("files one ready-for-human item when ready and none open", () => {
    const plan = planFlipItem(ready(), []);
    assert.equal(plan.file, true);
    if (plan.file === true) {
      assert.equal(plan.title, FLIP_ITEM_TITLE);
      assert.deepEqual(plan.labels, ["ready-for-human"]);
      assert.equal(plan.body.includes(FLIP_ITEM_MARKER), true);
      assert.equal(plan.body.includes('"two-way-pair": "on"'), true);
    }
  });

  test("skips when an open issue has the title", () => {
    const plan = planFlipItem(ready(), [{ number: 7, title: FLIP_ITEM_TITLE }]);
    assert.deepEqual(plan, { file: false, reason: "flip-item-already-open", existing: 7 });
  });

  test("skips when an open issue carries the marker", () => {
    const plan = planFlipItem(ready(), [{ number: 8, title: "renamed", body: `x\n${FLIP_ITEM_MARKER}` }]);
    assert.equal(plan.file, false);
  });

  test("never files when not ready", () => {
    const plan = planFlipItem(assessPairGraduation(inputs({ prs: [] })).report, []);
    assert.equal(plan.file, false);
  });
});

describe("findOnWindow", () => {
  test("null when never on", () => {
    assert.equal(findOnWindow([]), null);
    assert.equal(findOnWindow([{ at: "2026-10-01T00:00:00Z", twoWayPair: "off" }, { at: "2026-10-02T00:00:00Z", twoWayPair: "shadow" }]), null);
  });
  test("open window while still on", () => {
    const w = findOnWindow([
      { at: "2026-10-01T00:00:00Z", twoWayPair: "shadow" },
      { at: "2026-10-02T00:00:00Z", twoWayPair: "on" },
    ]);
    assert.deepEqual(w, { onFlipAt: "2026-10-02T00:00:00Z", offFlipAt: null });
  });
  test("closed window at the first later non-on commit", () => {
    const w = findOnWindow([
      { at: "2026-10-02T00:00:00Z", twoWayPair: "on" },
      { at: "2026-10-03T00:00:00Z", twoWayPair: "on" },
      { at: "2026-10-04T00:00:00Z", twoWayPair: "off" },
      { at: "2026-10-05T00:00:00Z", twoWayPair: "on" },
    ]);
    assert.deepEqual(w, { onFlipAt: "2026-10-02T00:00:00Z", offFlipAt: "2026-10-04T00:00:00Z" });
  });
});

describe("pairCohortOf", () => {
  const window = { onFlipAt: "2026-10-10T00:00:00Z", offFlipAt: "2026-10-20T00:00:00Z" };
  const row = (over: Record<string, unknown> = {}) => ({
    number: 5,
    mergedAt: "2026-10-15T00:00:00Z",
    trailers: [trailer(5)],
    shadowLines: [] as ParsedQaShadowLine[],
    ...over,
  });

  test("pair inside the window when trailer-reviewed and not shadow", () => {
    assert.equal(pairCohortOf(row(), window), "pair");
  });
  test("baseline with a null window, before the flip, or at/after the off flip", () => {
    assert.equal(pairCohortOf(row(), null), "baseline");
    assert.equal(pairCohortOf(row({ mergedAt: "2026-10-09T00:00:00Z" }), window), "baseline");
    assert.equal(pairCohortOf(row({ mergedAt: "2026-10-20T00:00:00Z" }), window), "baseline");
  });
  test("the on flip instant is inclusive", () => {
    assert.equal(pairCohortOf(row({ mergedAt: window.onFlipAt }), window), "pair");
  });
  test("baseline without an own trailer", () => {
    assert.equal(pairCohortOf(row({ trailers: [trailer(6)] }), window), "baseline");
    assert.equal(pairCohortOf(row({ trailers: [] }), window), "baseline");
  });
  test("shadow PRs never join the pair cohort", () => {
    assert.equal(pairCohortOf(row({ shadowLines: [line(5, 0)] }), window), "baseline");
  });
  test("a pr= mismatched shadow line does not exclude the PR; n/a is not shadow evidence", () => {
    assert.equal(pairCohortOf(row({ shadowLines: [line(6, 0)] }), window), "pair");
    assert.equal(pairCohortOf(row({ shadowLines: [line(5, "n/a")] }), window), "pair");
  });
});

describe("trip constant", () => {
  test("TRIP_MIN_PAIR_PRS equals cohort-baseline MIN_MATURED_PAIR", () => {
    assert.equal(TRIP_MIN_PAIR_PRS, MIN_MATURED_PAIR);
    assert.equal(TRIP_MIN_PAIR_PRS, 30);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideReviewerFanout, maxDoor, selectReviewDepth } from "../src/qa/fanout.ts";
import type { OneWayDoorResult } from "../src/qa/one-way-door.ts";

type Door = OneWayDoorResult["door"];
const CODE = ["src/foo.ts"];
const DOCS = ["docs/x.md"];
const TIERS = [1, 2, 3, 4, null] as const;
const DOORS: (Door | null)[] = ["two-way", "one-way", "unknown", null];

describe("selectReviewDepth matrix", () => {
  for (const tier of TIERS) {
    for (const door of DOORS) {
      it(`code T${tier} door ${door}`, () => {
        const { mode } = selectReviewDepth({ tier, shape: "code", door });
        assert.notEqual(mode, "single");
        if (tier === null || tier >= 4) assert.equal(mode, "adversarial");
        else if (door === "one-way" || door === "unknown") assert.equal(mode, "adversarial");
        else if (door === "two-way") assert.equal(mode, "standard");
        else assert.equal(mode, tier >= 3 ? "adversarial" : "standard");
      });
      it(`non-code T${tier} door ${door}`, () => {
        const { mode } = selectReviewDepth({ tier, shape: "docs-only", door });
        if (tier === null || tier >= 4 || door === "one-way" || door === "unknown") {
          assert.equal(mode, "adversarial");
        } else {
          assert.equal(mode, "single");
        }
      });
    }
  }
});

describe("decideReviewerFanout reversibility", () => {
  it("legacy 2-arg call has no reversibility key and unchanged mode", () => {
    const d = decideReviewerFanout(3, CODE);
    assert.equal(d.mode, "adversarial");
    assert.equal("reversibility" in d, false);
    assert.match(d.reason, /\(issue #4733\)\.$/);
  });
  it("off and shadow keep T3 two-way code adversarial", () => {
    for (const twoWayPair of ["off", "shadow"] as const) {
      const d = decideReviewerFanout(3, CODE, { door: "two-way", twoWayPair });
      assert.equal(d.mode, "adversarial");
      assert.equal(d.reversibility?.pairEligible, true);
      assert.equal(d.reversibility?.reductionApplied, false);
      assert.equal(d.reversibility?.selectedMode, "standard");
    }
  });
  it("omitted twoWayPair defaults to off", () => {
    assert.equal(decideReviewerFanout(3, CODE, { door: "two-way" }).mode, "adversarial");
  });
  it("on lowers T3 two-way code to the pair", () => {
    const d = decideReviewerFanout(3, CODE, { door: "two-way", twoWayPair: "on" });
    assert.equal(d.mode, "standard");
    assert.equal(d.reviewers.length, 2);
    assert.equal(d.reversibility?.reductionApplied, true);
  });
  it("escalation is ungated, even under off", () => {
    const d = decideReviewerFanout(2, CODE, { door: "one-way", twoWayPair: "off" });
    assert.equal(d.mode, "adversarial");
    assert.equal(d.reversibility?.escalated, true);
    assert.equal(decideReviewerFanout(1, DOCS, { door: "unknown" }).mode, "adversarial");
  });
  it("T4 and unknown tier never lowered", () => {
    assert.equal(decideReviewerFanout(4, CODE, { door: "two-way", twoWayPair: "on" }).mode, "adversarial");
    assert.equal(decideReviewerFanout(null, CODE, { door: "two-way", twoWayPair: "on" }).mode, "adversarial");
  });
  it("door null matches legacy even under on", () => {
    for (const t of [1, 2, 3]) {
      assert.equal(
        decideReviewerFanout(t, CODE, { door: null, twoWayPair: "on" }).mode,
        decideReviewerFanout(t, CODE).mode,
      );
    }
  });
  it("shadow reason names door and switch", () => {
    const d = decideReviewerFanout(3, CODE, { door: "two-way", twoWayPair: "shadow" });
    assert.match(d.reason, /door `two-way`, two-way-pair `shadow`: pair would run/);
    assert.match(d.reason, /#5263/);
  });
});

describe("maxDoor", () => {
  it("ranks one-way > unknown > two-way > null", () => {
    assert.equal(maxDoor("two-way", "one-way", null), "one-way");
    assert.equal(maxDoor("two-way", "unknown"), "unknown");
    assert.equal(maxDoor(null, "two-way", undefined), "two-way");
    assert.equal(maxDoor(null, undefined), null);
    assert.equal(maxDoor(), null);
  });
});

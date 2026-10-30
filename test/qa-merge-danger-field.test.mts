import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { compareMergeDanger, parseMergeDangerField } from "../src/qa/change-shape.ts";
import type { MergeDangerDetector } from "../src/qa/change-shape.ts";
import { foldReviewFindings } from "../src/qa/fold.ts";

const ONE_WAY: MergeDangerDetector = {
  door: "one-way",
  classes: ["persistent-state"],
  signals: [{ ruleId: "OWD-X", class: "persistent-state", path: "src/a.ts", line: 3 }],
};
const TWO_WAY: MergeDangerDetector = { door: "two-way", classes: [], signals: [] };
const UNKNOWN: MergeDangerDetector = { door: "unknown", classes: [], signals: [] };

describe("parseMergeDangerField", () => {
  test("present with reason", () => {
    const f = parseMergeDangerField("Tier: 3\nMerge danger: one-way — persistent-state\nCloses #1");
    assert.equal(f.status, "ok");
    assert.equal(f.declared, "one-way");
    assert.equal(f.reason, "persistent-state");
  });
  test("case-insensitive value, no reason", () => {
    const f = parseMergeDangerField("Merge danger: Two-Way");
    assert.equal(f.declared, "two-way");
    assert.equal(f.reason, null);
  });
  test("missing and non-string input", () => {
    assert.equal(parseMergeDangerField("nothing here").status, "missing");
    assert.equal(parseMergeDangerField(null).status, "missing");
    assert.equal(parseMergeDangerField(undefined).status, "missing");
    assert.equal(parseMergeDangerField(42 as unknown as string).status, "missing");
  });
  test("malformed values are never coerced", () => {
    for (const v of ["none", "low", ""]) {
      const f = parseMergeDangerField(`Merge danger: ${v}`);
      assert.equal(f.status, "malformed", v);
      assert.equal(f.declared, null);
    }
  });
  test("first well-formed line wins", () => {
    const f = parseMergeDangerField("Merge danger: none\nMerge danger: two-way - a\nMerge danger: one-way");
    assert.equal(f.status, "ok");
    assert.equal(f.declared, "two-way");
    assert.equal(f.reason, "a");
  });
  test("reason capped at 200 chars", () => {
    const f = parseMergeDangerField(`Merge danger: one-way — ${"x".repeat(500)}`);
    assert.equal(f.reason?.length, 200);
  });
});

describe("compareMergeDanger matrix", () => {
  const ok = (d: string) => parseMergeDangerField(`Merge danger: ${d} — why`);
  test("match", () => {
    for (const [d, det] of [["one-way", ONE_WAY], ["two-way", TWO_WAY], ["one-way", UNKNOWN]] as const) {
      const r = compareMergeDanger(ok(d), det);
      assert.equal(r.outcome, "match");
      assert.equal(r.finding, null);
      assert.equal(r.gapLine, null);
    }
  });
  test("under-declared yields one medium row quoting the signal", () => {
    const r = compareMergeDanger(ok("two-way"), ONE_WAY);
    assert.equal(r.outcome, "under-declared");
    assert.equal(r.effectiveDoor, "one-way");
    assert.equal(r.finding?.severity, "medium");
    assert.equal(r.finding?.reviewer, "merge-danger-check");
    assert.match(r.finding?.finding ?? "", /OWD-X\/persistent-state src\/a\.ts:3/);
  });
  test("over-declared logs gap line, no finding", () => {
    const r = compareMergeDanger(ok("one-way"), TWO_WAY, { pr: 7, sha: "abcdef0123456789" });
    assert.equal(r.outcome, "over-declared");
    assert.equal(r.finding, null);
    assert.equal(r.gapLine, "Merge-danger-gap: pr=7 sha=abcdef012345 declared=one-way detector=two-way reason=why");
  });
  test("missing and malformed are low rows with fail-closed depth", () => {
    for (const body of ["", "Merge danger: none"]) {
      const r = compareMergeDanger(parseMergeDangerField(body), TWO_WAY);
      assert.equal(r.finding?.severity, "low");
      assert.equal(r.effectiveDoor, "one-way");
    }
    assert.equal(compareMergeDanger(parseMergeDangerField(""), TWO_WAY).outcome, "missing");
    assert.equal(compareMergeDanger(parseMergeDangerField("Merge danger: none"), TWO_WAY).outcome, "malformed");
  });
  test("detector-unknown fails closed with no finding", () => {
    const r = compareMergeDanger(ok("two-way"), UNKNOWN);
    assert.equal(r.outcome, "detector-unknown");
    assert.equal(r.effectiveDoor, "one-way");
    assert.equal(r.finding, null);
  });
});

describe("fold pass-through", () => {
  const spawned = ["reviewer-A-standards", "reviewer-A-spec"];
  test("medium row folds to FAIL severity-gated", () => {
    const row = compareMergeDanger(parseMergeDangerField("Merge danger: two-way"), ONE_WAY).finding;
    const r = foldReviewFindings({
      tier: 3,
      findings: { "reviewer-A-standards": [], "reviewer-A-spec": [], "merge-danger-check": [row] },
      spawnedReviewers: spawned,
    });
    assert.equal(r.reviewVerdict, "FAIL");
    assert.equal(r.mode, "severity-gated");
  });
  test("low row folds to PASS with one follow-up", () => {
    const row = compareMergeDanger(parseMergeDangerField(""), TWO_WAY).finding;
    const r = foldReviewFindings({
      tier: 3,
      findings: { "reviewer-A-standards": [], "reviewer-A-spec": [], "merge-danger-check": [row] },
      spawnedReviewers: spawned,
    });
    assert.equal(r.reviewVerdict, "PASS");
    assert.equal(r.followUps.length, 1);
  });
});

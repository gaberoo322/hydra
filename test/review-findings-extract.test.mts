/**
 * test/review-findings-extract.test.mts — review-findings seam, comment
 * parser, reconcile merge and arm extractor (issue #5270, R1; ADR-0046 D8).
 * Importing every seam accessor statically keeps knip from re-flagging them
 * while their only live callers are a playbook script (the #1041 lesson).
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import {
  extractReviewFindingArms,
  makeFindingRow,
  parseReviewFindingsComment,
  reconcileReviewFindings,
  reviewFindingRowId,
  rowsFromFold,
} from "../src/qa/review-findings-extract.ts";
import {
  appendReviewFindingRows,
  deleteReviewFindingRows,
  readReviewFindingRows,
  type ReviewFindingRow,
  type StoredReviewFindingRow,
} from "../src/redis/review-findings.ts";
import { closeRedisConnections } from "../src/redis/connection.ts";
import { renderReviewReport, foldReviewFindings } from "../src/qa/fold.ts";
import { renderQaVerdictTrailer } from "../src/qa/verdict-trailer.ts";

const NOW = Date.parse("2026-10-30T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const iso = (daysAgo: number): string => new Date(NOW - daysAgo * DAY).toISOString();

function finding(over: Partial<Parameters<typeof makeFindingRow>[0]> = {}): ReviewFindingRow {
  return makeFindingRow({
    pr: 100,
    round: 1,
    sha: "abcdef123456",
    at: iso(1),
    source: "route",
    severity: "medium",
    axis: "standards",
    location: "src/a.ts:10",
    finding: "STD-DESIGN-NO-REIMPLEMENT: duplicated helper",
    reviewers: ["reviewer-A-standards"],
    ...over,
  });
}

function armNames(rows: unknown[]): string[] {
  return extractReviewFindingArms(rows, { now: NOW }).arms.map((a) => `${a.arm}`);
}

describe("review-findings extractor — distinct-PR counting", () => {
  test("a rule on 3 distinct PRs fires rule-cross-pr with the distinct PRs", () => {
    const rows = [100, 101, 102].map((pr) => finding({ pr }));
    const { arms } = extractReviewFindingArms(rows, { now: NOW });
    const arm = arms.find((a) => a.arm === "rule-cross-pr");
    assert.deepEqual(arm, { arm: "rule-cross-pr", key: "STD-DESIGN-NO-REIMPLEMENT", prs: [100, 101, 102] });
  });

  test("one rule five times on a SINGLE PR does not fire the cross-PR arm", () => {
    const rows = [1, 1, 1, 1, 1].map((round, i) =>
      finding({ pr: 100, round, finding: `STD-DESIGN-NO-REIMPLEMENT: variant ${i}` }),
    );
    assert.ok(!armNames(rows).includes("rule-cross-pr"));
    assert.ok(!armNames(rows).includes("file-cross-pr"));
  });

  test("the same rule in 3 distinct rounds of one PR fires the same-PR arm", () => {
    const rows = [1, 2, 3].map((round) => finding({ pr: 100, round }));
    const { arms } = extractReviewFindingArms(rows, { now: NOW });
    assert.deepEqual(
      arms.find((a) => a.arm === "rule-same-pr-rounds"),
      { arm: "rule-same-pr-rounds", key: "STD-DESIGN-NO-REIMPLEMENT", pr: 100, rounds: [1, 2, 3] },
    );
  });

  test("two rounds do not fire the same-PR arm", () => {
    const rows = [1, 2].map((round) => finding({ pr: 100, round }));
    assert.ok(!armNames(rows).includes("rule-same-pr-rounds"));
  });

  test("30-day window boundary: 29 days old counts, 31 days old does not", () => {
    const inside = [100, 101, 102].map((pr) => finding({ pr, at: iso(29) }));
    const outside = [100, 101, 102].map((pr) => finding({ pr, at: iso(31) }));
    assert.ok(armNames(inside).includes("file-cross-pr"));
    assert.deepEqual(armNames(outside), []);
  });

  test("a file on 3 distinct PRs fires file-cross-pr even without a rule", () => {
    const rows = [100, 101, 102].map((pr) => finding({ pr, finding: "no rule cited here" }));
    assert.deepEqual(armNames(rows), ["file-cross-pr"]);
  });

  test("any medium or high pair-miss fires; a low pair-miss does not", () => {
    const base = { kind: "pair-miss" as const, pr: 5, round: 1, sha: "abc1234", at: iso(2), source: "route" as const };
    assert.deepEqual(armNames([{ ...base, severity: "medium" }]), ["pair-miss"]);
    assert.deepEqual(armNames([{ ...base, severity: "low" }]), []);
  });

  test("detector-gap needs 2+ same-class gaps on distinct PRs", () => {
    const gap = (pr: number, gapClass: string): ReviewFindingRow => ({
      kind: "detector-gap", pr, round: 1, sha: "abc1234", at: iso(2), source: "route", gapClass,
    });
    assert.deepEqual(armNames([gap(1, "schema"), gap(1, "schema")]), []);
    assert.deepEqual(armNames([gap(1, "schema"), gap(2, "schema")]), ["detector-gap"]);
    assert.deepEqual(armNames([gap(1, "schema"), gap(2, "migration")]), []);
  });

  test("hotSpots: a file with 3+ low STD-DESIGN rows", () => {
    const rows = [100, 101, 102].map((pr) =>
      finding({ pr, severity: "low", finding: "STD-DESIGN-DEEP-MODULE: shallow wrapper" }),
    );
    const { hotSpots } = extractReviewFindingArms(rows, { now: NOW });
    assert.deepEqual(hotSpots, [{ file: "src/a.ts", count: 3, rules: ["STD-DESIGN-DEEP-MODULE"] }]);
  });

  test("malformed rows are skipped and reported, never thrown", () => {
    const res = extractReviewFindingArms([null, { kind: "finding" }, "x", finding()], { now: NOW });
    assert.equal(res.warnings.length, 3);
    assert.deepEqual(res.arms, []);
  });
});

describe("review-findings parser and id", () => {
  const folded = foldReviewFindings({
    tier: 3,
    findings: [
      { severity: "medium", axis: "standards", reviewer: "reviewer-A-standards", location: "src/a.ts:10", finding: "STD-DESIGN-NO-REIMPLEMENT: a | b pipe", fix: "x" },
      { severity: "low", axis: "spec", reviewer: "reviewer-B-spec", location: "PR body", finding: "wording", fix: "y" },
    ],
  });
  const trailer = renderQaVerdictTrailer({ verdict: "FAIL", pr: 321, round: 2, sha: "abcdef1234567890", blockers: 1, maxSeverity: "medium" });
  const comment = `${renderReviewReport({ fold: folded, standardsSummary: "s", specSummary: "p" })}\n\n${trailer}`;

  test("parse of a rendered report yields the same ids as the route feeder", () => {
    const parsed = parseReviewFindingsComment(comment, { at: iso(1) });
    const routed = rowsFromFold(folded, { pr: 321, round: 2, sha: "abcdef123456" }, { at: iso(1) });
    assert.equal(parsed.length, 2);
    assert.deepEqual(parsed.map((p) => p.id).sort(), routed.map((r) => r.id).sort());
    const pipe = parsed.find((p) => p.row.kind === "finding" && p.row.rule === "STD-DESIGN-NO-REIMPLEMENT");
    assert.ok(pipe && pipe.row.kind === "finding" && pipe.row.finding.includes("a | b"));
    assert.equal(pipe.row.kind === "finding" ? pipe.row.file : "x", "src/a.ts");
    const body = parsed.find((p) => p.row.kind === "finding" && p.row.severity === "low");
    assert.ok(body && body.row.kind === "finding" && body.row.file === null);
  });

  test("a comment with no findings yields zero rows; one with no trailer yields none", () => {
    const clean = foldReviewFindings({ tier: 3, findings: [] });
    const body = `${renderReviewReport({ fold: clean, standardsSummary: "s", specSummary: "p" })}\n\n${trailer}`;
    assert.deepEqual(parseReviewFindingsComment(body, { at: iso(1) }), []);
    assert.deepEqual(parseReviewFindingsComment("### Findings\n\n| high | spec | a | b.ts:1 | f | g |", { at: iso(1) }), []);
    assert.deepEqual(parseReviewFindingsComment(null, { at: iso(1) }), []);
  });

  test("rows are attributed to the trailer's PR", () => {
    const parsed = parseReviewFindingsComment(comment, { at: iso(1) });
    assert.ok(parsed.every((p) => p.row.pr === 321 && p.row.round === 2));
  });

  test("id is stable across source and ignores case/whitespace in finding text", () => {
    const a = finding({ source: "route", finding: "STD-X-Y:  Some   Text" });
    const b = finding({ source: "reconcile", finding: "STD-X-Y: some text" });
    assert.equal(reviewFindingRowId(a), reviewFindingRowId(b));
  });
});

describe("review-findings row id discriminators (QA round 1)", () => {
  test("same text at different severity or axis keeps separate ids", () => {
    const hi = finding({ severity: "high", finding: "same text" });
    const lo = finding({ severity: "low", finding: "same text" });
    const sp = finding({ severity: "high", axis: "spec", finding: "same text" });
    assert.notEqual(reviewFindingRowId(hi), reviewFindingRowId(lo));
    assert.notEqual(reviewFindingRowId(hi), reviewFindingRowId(sp));
    // sibling: identical severity+axis+text still collapses
    assert.equal(reviewFindingRowId(hi), reviewFindingRowId(finding({ severity: "high", finding: "same text" })));
  });

  test("pair-miss and detector-gap rows with distinct keys keep separate ids", () => {
    const pm = { kind: "pair-miss" as const, pr: 5, round: 1, sha: "abc1234", at: iso(1), source: "route" as const, severity: "medium" as const };
    assert.notEqual(reviewFindingRowId({ ...pm, key: "a.ts:1" }), reviewFindingRowId({ ...pm, key: "b.ts:2" }));
    assert.equal(reviewFindingRowId({ ...pm, key: "a.ts:1" }), reviewFindingRowId({ ...pm, key: "a.ts:1" }));
    const dg = { kind: "detector-gap" as const, pr: 5, round: 1, sha: "abc1234", at: iso(1), source: "route" as const, gapClass: "schema" };
    assert.notEqual(reviewFindingRowId({ ...dg, key: "x" }), reviewFindingRowId({ ...dg, key: "y" }));
    assert.equal(reviewFindingRowId(dg), reviewFindingRowId({ ...dg }));
  });
});

describe("review-findings reconcile merge", () => {
  const stored = (row: ReviewFindingRow): StoredReviewFindingRow => ({ id: reviewFindingRowId(row), row });

  test("running reconcile twice is a no-op the second time", () => {
    const harvested = [stored(finding({ source: "reconcile" })), stored(finding({ source: "reconcile", location: "src/b.ts:3" }))];
    const first = reconcileReviewFindings([], harvested, { now: NOW });
    assert.equal(first.upserts.length, 2);
    const second = reconcileReviewFindings(first.upserts, harvested, { now: NOW });
    assert.equal(second.upserts.length, 0);
    assert.equal(second.unchanged, 2);
  });

  test("an existing route row is never replaced by a reconcile row", () => {
    const route = stored(finding({ source: "route" }));
    const rec = stored(finding({ source: "reconcile" }));
    assert.equal(route.id, rec.id);
    const res = reconcileReviewFindings([route], [rec], { now: NOW });
    assert.deepEqual(res.upserts, []);
  });

  test("rows older than 90 days are pruned", () => {
    const old = stored(finding({ at: iso(91) }));
    const fresh = stored(finding({ at: iso(89), location: "src/z.ts:1" }));
    const res = reconcileReviewFindings([old, fresh], [], { now: NOW });
    assert.deepEqual(res.pruned, [old.id]);
  });
});

describe("review-findings Redis seam (live round trip)", () => {
  const mk = (loc: string, source: "route" | "reconcile", finding_: string): StoredReviewFindingRow => {
    const row = finding({ location: loc, source, finding: finding_ });
    return { id: reviewFindingRowId(row), row };
  };

  beforeEach(async () => {
    const all = await readReviewFindingRows();
    await deleteReviewFindingRows(all.map((e) => e.id));
  });

  after(() => {
    closeRedisConnections();
  });

  test("append then read round-trips; re-append is idempotent", async () => {
    const e = mk("src/rt.ts:1", "route", "STD-A-B: round trip");
    assert.deepEqual(await appendReviewFindingRows([e]), { written: 1 });
    await appendReviewFindingRows([e]);
    const read = await readReviewFindingRows();
    assert.equal(read.length, 1);
    assert.deepEqual(read[0], e);
  });

  test("a reconcile row never overwrites a route row", async () => {
    const route = mk("src/nd.ts:1", "route", "STD-A-B: same");
    const rec = { id: route.id, row: { ...route.row, source: "reconcile" as const, at: iso(3) } };
    await appendReviewFindingRows([route]);
    assert.deepEqual(await appendReviewFindingRows([rec]), { written: 0 });
    const read = await readReviewFindingRows();
    assert.equal(read[0]?.row.source, "route");
  });

  test("deleteReviewFindingRows removes by id", async () => {
    const e = mk("src/del.ts:1", "route", "STD-A-B: delete me");
    await appendReviewFindingRows([e]);
    assert.equal(await deleteReviewFindingRows([e.id]), 1);
    assert.deepEqual(await readReviewFindingRows(), []);
  });
});

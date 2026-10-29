/**
 * Tests for the S0 cohort-baseline measurement fold (issue #5256, ADR-0046
 * Decisions 6 and 8). The fold is pure; the committed fixture doubles as the
 * re-measurable baseline (INV-8).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  measureCohort,
  extractMentions,
  roundsOf,
  stableStringify,
  cohortOf,
  withRetry,
  countReviewedWithoutClosingRef,
  MIN_MATURED_PAIR,
  type CohortInputs,
  type ItemRow,
  type PrRow,
} from "../scripts/qa/cohort-baseline.ts";
import type { QaVerdictTrailer } from "../src/qa/verdict-trailer.ts";

const MERGED = "2026-10-10T00:00:00Z";
const UNTIL = "2026-11-30T00:00:00Z";

const trailer = (
  pr: number,
  round: number,
  verdict: QaVerdictTrailer["verdict"],
  sha = "aaaaaaaaaaaa",
): QaVerdictTrailer => ({ verdict, pr, round, sha, blockers: 0, maxSeverity: "none" });

const pr = (
  number: number,
  trailers: QaVerdictTrailer[],
  over: Partial<PrRow> = {},
): PrRow => ({ number, mergedAt: MERGED, title: `feat: ${number}`, cohort: "baseline", trailers, ...over });

const item = (number: number, over: Partial<ItemRow>): ItemRow => ({
  number,
  kind: "pr",
  createdAt: "2026-10-11T00:00:00Z",
  mergedAt: "2026-10-11T01:00:00Z",
  title: "x",
  isRevert: false,
  isFix: false,
  isPostMortem: false,
  mentions: [],
  ...over,
});

const inputs = (prs: PrRow[], items: ItemRow[] = [], until = UNTIL): CohortInputs => ({
  prs,
  items,
  until,
  tokens: { qaOrchTokens: null, attributedPercent: null },
});

describe("qa-cohort-baseline rounds and first-FAIL", () => {
  test("one trailer is one round; a same-sha PASS collapses into PASS-pending-CI", () => {
    const r = roundsOf([
      trailer(1, 1, "FAIL", "bbbbbbbbbbbb"),
      trailer(1, 2, "PASS-pending-CI", "cccccccccccc"),
      trailer(1, 3, "PASS", "cccccccccccc"),
    ]);
    assert.deepEqual(r, { rounds: 2, firstFail: true });
  });

  test("a PASS on a different sha than the pending one is its own round", () => {
    const r = roundsOf([
      trailer(1, 1, "PASS-pending-CI", "cccccccccccc"),
      trailer(1, 2, "PASS", "dddddddddddd"),
    ]);
    assert.deepEqual(r, { rounds: 2, firstFail: false });
  });

  test("duplicate trailers from comment + review bodies count once", () => {
    const t = trailer(1, 1, "PASS");
    assert.equal(roundsOf([t, { ...t }]).rounds, 1);
  });

  test("rounds/PR and first-FAIL rate fold over reviewed PRs only; pr= mismatch ignored", () => {
    const { metrics } = measureCohort(
      inputs([
        pr(1, [trailer(1, 1, "FAIL"), trailer(1, 2, "PASS", "eeeeeeeeeeee")]),
        pr(2, [trailer(2, 1, "PASS")]),
        pr(3, []), // unreviewed: excluded
        pr(4, [trailer(99, 1, "FAIL")]), // names another PR: not reviewed
      ]),
    );
    assert.equal(metrics.reviewed, 2);
    assert.equal(metrics.roundsPerPr, 1.5);
    assert.equal(metrics.firstFailRate, 0.5);
  });

  test("zero reviewed PRs yields null rates, never NaN or Infinity", () => {
    const { metrics } = measureCohort(inputs([pr(3, [])]));
    assert.equal(metrics.roundsPerPr, null);
    assert.equal(metrics.firstFailRate, null);
    assert.equal(metrics.cohorts.baseline.rate, null);
    assert.equal(metrics.cohorts.pair.rate, null);
  });
});

describe("qa-cohort-baseline escaped-defect rules", () => {
  const reviewed = [pr(10, [trailer(10, 1, "PASS")])];

  test("revert, fix-pr and post-mortem each count, with evidence and severity", () => {
    const { metrics } = measureCohort(
      inputs(
        [pr(10, [trailer(10, 1, "PASS")]), pr(11, [trailer(11, 1, "PASS")]), pr(12, [trailer(12, 1, "PASS")])],
        [
          item(20, { isRevert: true, mentions: [10] }),
          item(21, { isFix: true, mentions: [11] }),
          item(22, { kind: "issue", mergedAt: null, isPostMortem: true, mentions: [12] }),
        ],
      ),
    );
    assert.deepEqual(metrics.escapes, [
      { pr: 10, kind: "revert", by: 20, high: true },
      { pr: 11, kind: "fix-pr", by: 21, high: false },
      { pr: 12, kind: "post-mortem", by: 22, high: true },
    ]);
    assert.equal(metrics.cohorts.baseline.matured, 3);
    assert.equal(metrics.cohorts.baseline.escaped, 3);
    assert.equal(metrics.cohorts.baseline.highEscapes, 2);
    assert.equal(metrics.cohorts.baseline.rate, 1);
  });

  test("an item before mergedAt, after 14 days, unmerged, or not naming the PR does not count", () => {
    const { metrics } = measureCohort(
      inputs(reviewed, [
        item(30, { isRevert: true, mentions: [10], createdAt: "2026-10-09T00:00:00Z" }),
        item(31, { isRevert: true, mentions: [10], createdAt: "2026-10-25T00:00:00Z" }),
        item(32, { isRevert: true, mentions: [10], mergedAt: null }),
        item(33, { isRevert: true, mentions: [999] }),
        item(34, { isFix: true, mentions: [10], kind: "issue" }),
      ]),
    );
    assert.equal(metrics.escapes.length, 0);
    assert.equal(metrics.cohorts.baseline.escaped, 0);
    assert.equal(metrics.cohorts.baseline.rate, 0);
  });

  test("a PR merged less than 14 days before until is pending and excluded from denominators", () => {
    const { metrics } = measureCohort(inputs(reviewed, [], "2026-10-20T00:00:00Z"));
    assert.deepEqual(metrics.pending, [10]);
    assert.equal(metrics.cohorts.baseline.matured, 0);
    assert.equal(metrics.cohorts.baseline.rate, null);
    assert.equal(metrics.reviewed, 1);
  });

  test("extractMentions is word-bounded", () => {
    assert.deepEqual(extractMentions("fixes #12, see #7 and PR#9 and abc#4 and ##5 #123456"), [7, 12, 123456]);
    assert.deepEqual(extractMentions(null), []);
  });
});

describe("qa-cohort-baseline trip and criteria", () => {
  const pairPrs = (n: number): PrRow[] =>
    Array.from({ length: n }, (_, i) =>
      pr(1000 + i, [trailer(1000 + i, 1, "PASS")], { cohort: "pair" }),
    );
  const basePrs: PrRow[] = [
    pr(1, [trailer(1, 1, "PASS")]),
    pr(2, [trailer(2, 1, "PASS")]),
  ];

  test("below the maturity floor neither tripped nor criteriaMet, even with a high escape", () => {
    const { metrics } = measureCohort(
      inputs(pairPrs(MIN_MATURED_PAIR - 1), [item(5000, { isRevert: true, mentions: [1000] })]),
    );
    assert.equal(metrics.tripped, false);
    assert.equal(metrics.criteriaMet, false);
  });

  test("at the floor with a clean pair cohort the criteria are met and nothing trips", () => {
    const { metrics } = measureCohort(inputs([...basePrs, ...pairPrs(MIN_MATURED_PAIR)]));
    assert.equal(metrics.cohorts.pair.matured, MIN_MATURED_PAIR);
    assert.equal(metrics.tripped, false);
    assert.equal(metrics.criteriaMet, true);
  });

  test("a high-severity pair escape trips", () => {
    const { metrics } = measureCohort(
      inputs(
        [...basePrs, ...pairPrs(MIN_MATURED_PAIR)],
        [item(5000, { isRevert: true, mentions: [1000] })],
      ),
    );
    assert.equal(metrics.tripped, true);
    assert.equal(metrics.criteriaMet, false);
  });

  test("a pair escape rate above baseline trips even without a high escape", () => {
    const { metrics } = measureCohort(
      inputs(
        [...basePrs, ...pairPrs(MIN_MATURED_PAIR)],
        [item(5000, { isFix: true, mentions: [1000] })],
      ),
    );
    assert.equal(metrics.cohorts.pair.highEscapes, 0);
    assert.equal(metrics.tripped, true);
  });
});

describe("qa-cohort-baseline tokens per review", () => {
  const p = [pr(1, [trailer(1, 1, "PASS")]), pr(2, [trailer(2, 1, "PASS")])];

  test("value is null with a warning when nothing is attributed", () => {
    const r = measureCohort({ ...inputs(p), tokens: { qaOrchTokens: 500, attributedPercent: 0 } });
    assert.equal(r.metrics.tokensPerReview.value, null);
    assert.equal(r.metrics.tokensPerReview.source, "api/usage/by-issue");
    assert.ok(r.warnings.some((w) => w.includes("tokensPerReview")));
  });

  test("value is tokens divided by reviewed PRs when attributed", () => {
    const r = measureCohort({ ...inputs(p), tokens: { qaOrchTokens: 500, attributedPercent: 40 } });
    assert.equal(r.metrics.tokensPerReview.value, 250);
    assert.equal(r.metrics.tokensPerReview.attributedPercent, 40);
  });
});

describe("qa-cohort-baseline never throws", () => {
  test("malformed rows are skipped with warnings naming the row", () => {
    const bad: any = {
      prs: [
        { mergedAt: MERGED, trailers: [], cohort: "baseline" },
        { number: 7, mergedAt: "not a date", trailers: [], cohort: "baseline" },
        { number: 8, mergedAt: MERGED, trailers: [], cohort: "mystery" },
        null,
      ],
      items: [{ number: 9, createdAt: "garbage" }, { createdAt: MERGED }],
      until: UNTIL,
    };
    const r = measureCohort(bad);
    assert.equal(r.metrics.reviewed, 0);
    assert.equal(r.warnings.filter((w) => w.includes("skipped")).length, 6);
    assert.ok(r.warnings.some((w) => w.includes("#7")));
    assert.ok(r.warnings.some((w) => w.includes("mystery")));
  });

  test("a totally empty input returns a result object", () => {
    const r = measureCohort({} as any);
    assert.equal(r.metrics.reviewed, 0);
    assert.equal(r.metrics.tripped, false);
  });

  test("cohortOf tags every PR baseline today (the single seam)", () => {
    assert.equal(cohortOf({ number: 1 }), "baseline");
  });
});

describe("qa-cohort-baseline committed fixture", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/qa-cohort-baseline.json", import.meta.url), "utf8"),
  );

  test("measureCohort(fixture.inputs) reproduces the committed metrics exactly", () => {
    const { metrics } = measureCohort(fixture.inputs);
    assert.deepEqual(JSON.parse(stableStringify(metrics)), fixture.metrics);
  });

  test("the fixture is serialised with sorted keys", () => {
    const text = readFileSync(new URL("./fixtures/qa-cohort-baseline.json", import.meta.url), "utf8");
    assert.equal(stableStringify(fixture), text);
  });

  test("the only timestamp outside metrics is measuredAt at the top level", () => {
    assert.equal(typeof fixture.measuredAt, "string");
    assert.equal(JSON.stringify(fixture.metrics).includes("measuredAt"), false);
  });
});

describe("qa-cohort-baseline QA round-1 fixes (#5278)", () => {
  test("trailer-less merged PRs are excluded from cohort denominators and pending (documented ruling)", () => {
    const r = measureCohort({
      prs: [pr(1, [trailer(1, 1, "PASS")]), pr(2, []), pr(3, [], { mergedAt: "2026-11-29T00:00:00Z" })],
      items: [],
      until: UNTIL,
      tokens: { qaOrchTokens: null, attributedPercent: null },
    });
    assert.equal(r.metrics.cohorts.baseline.matured, 1);
    assert.deepEqual(r.metrics.pending, []);
  });

  test("withRetry retries a rate-limited call with backoff, then succeeds", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const res = await withRetry(
      async () => (++n < 3 ? { ok: false as const, code: "gh-rate-limited" } : { ok: true as const }),
      { baseMs: 10, sleep: async (ms) => void sleeps.push(ms) },
    );
    assert.equal(res.ok, true);
    assert.equal(n, 3);
    assert.deepEqual(sleeps, [10, 20]);
  });

  test("withRetry does not retry a non-transient failure", async () => {
    let n = 0;
    const res = await withRetry(async () => (n++, { ok: false as const, code: "gh-malformed-json" }), {
      sleep: async () => {},
    });
    assert.equal(res.ok, false);
    assert.equal(n, 1);
  });

  test("withRetry gives up after the attempt bound", async () => {
    let n = 0;
    await withRetry(async () => (n++, { ok: false as const, code: "gh-rate-limited" }), {
      attempts: 3,
      sleep: async () => {},
    });
    assert.equal(n, 3);
  });

  test("countReviewedWithoutClosingRef counts only reviewed rows lacking refs", () => {
    assert.equal(
      countReviewedWithoutClosingRef([
        { reviewed: true, closingRefs: [] },
        { reviewed: true, closingRefs: [5] },
        { reviewed: false, closingRefs: [] },
      ]),
      1,
    );
  });
});

/**
 * Moved verbatim from test/hydra-qa-prompt-verdict.test.mts (issue #5079,
 * ADR-0038 D2 — mechanical move): the prior-round phase — verdict history and re-review context cases.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  type FinalVerdict,
  type QaSeverity,
  parseQaVerdictTrailer,
  renderQaVerdictTrailer,
} from "../src/qa/verdict-trailer.ts";
import {
  decideReReviewContext,
  isReviewedFailRound,
  priorFindingsSection,
  qaVerdictHistory,
} from "../src/qa/prior-round.ts";
import { priorRoundContext } from "../src/qa/prior-round.ts";

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

describe("priorRoundContext — the composed prior-round head (issue #5079, INV-3)", () => {
  const ancestry = (isAnc: boolean | null, changed: string[] | null) => ({
    isAncestor: () => isAnc,
    changedSince: () => changed,
  });

  test("a first pass has no history, no prior and an empty context", () => {
    const r = priorRoundContext({ tier: 3, pr: 7, headSha: SHA_B, priorBodies: [], ancestry: ancestry(true, ["a.ts"]) });
    assert.deepEqual(r.history, []);
    assert.equal(r.prior, null);
    assert.equal(r.priorFindings, "");
    assert.equal(r.context.includeFindings, false);
    assert.equal(r.context.includeDiff, false);
  });

  test("a reviewed FAIL with a verifiable ancestor yields findings + diff, equal to the helpers", () => {
    const bodies = [verdictBody(1, "FAIL", SHA_A, 1, "medium")];
    const r = priorRoundContext({ tier: 3, pr: 7, headSha: SHA_B, priorBodies: bodies, ancestry: ancestry(true, ["a.ts"]) });
    assert.deepEqual(r.history, qaVerdictHistory(bodies, 7));
    assert.equal(r.priorFindings, priorFindingsSection(bodies, 7, 1));
    assert.deepEqual(
      r.context,
      decideReReviewContext({
        tier: 3,
        prior: r.prior,
        headSha: SHA_B,
        priorShaIsAncestor: true,
        changedSince: ["a.ts"],
        priorFindings: r.priorFindings,
      }),
    );
    assert.equal(r.context.includeDiff, true);
    assert.equal(r.context.baseSha, r.prior?.sha);
  });

  test("an unverifiable ancestry degrades to the findings table only", () => {
    const bodies = [verdictBody(1, "FAIL", SHA_A, 1, "medium")];
    const r = priorRoundContext({ tier: 3, pr: 7, headSha: SHA_B, priorBodies: bodies, ancestry: ancestry(null, null) });
    assert.equal(r.context.includeFindings, true);
    assert.equal(r.context.includeDiff, false);
  });
});

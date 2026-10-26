/**
 * Moved verbatim from test/hydra-qa-prompt-verdict.test.mts (issue #5079,
 * ADR-0038 D2 — mechanical move): the fold phase — severity-gated findings fold, trailer counts, report rendering cases.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  type CheckState,
  type ReviewVerdict,
  classifyVerdict,
  renderCiSummary,
} from "../src/qa/admission.ts";
import {
  type FinalVerdict,
  type QaSeverity,
  buildQaVerdictTrailer,
  isFailVerdict,
  parseQaVerdictTrailer,
  parseQaVerdictTrailers,
} from "../src/qa/verdict-trailer.ts";
import {
  MALFORMED_FINDING_ID,
  NON_MERGEABLE_LOCATIONS,
  type ReviewFinding,
  aggregateAdversarialReview,
  canonicalLocationKey,
  foldReviewFindings,
  normaliseReviewFindings,
  renderFindingsTable,
  renderReviewReport,
  reviewerGroup,
  trailerBlockerCounts,
} from "../src/qa/fold.ts";
import { foldReview, foldReviewFindings as foldDirect, renderReviewReport as renderDirect, trailerBlockerCounts as countsDirect } from "../src/qa/fold.ts";
import { redRequiredChecks } from "../src/qa/admission.ts";

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

const FULL_HEAD = "0123456789abcdef0123456789abcdef01234567";

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

describe("foldReviewFindings — severity-gated T1–T3 fold (issue #4734)", () => {
  const CASES: Array<{ name: string; tier: number; findings: ReviewFinding[]; verdict: "PASS" | "FAIL"; blockers: number; followUps: number; max: QaSeverity }> = [
    { name: "no findings → PASS", tier: 3, findings: [], verdict: "PASS", blockers: 0, followUps: 0, max: "none" },
    { name: "lone low (reviewer A only) → PASS + follow-up", tier: 3, findings: [finding({})], verdict: "PASS", blockers: 0, followUps: 1, max: "none" },
    {
      name: "both reviewers raise the same low → PASS, one merged follow-up (a low never blocks at T1–T3, #4916)",
      tier: 3,
      findings: [finding({}), finding({ reviewer: "reviewer-B-standards", finding: "wording is stale" })],
      verdict: "PASS", blockers: 0, followUps: 1, max: "none",
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
    assert.equal(keyed.reviewVerdict, "PASS", "a dual-raised low is a follow-up, never a blocker (#4916)");
    assert.equal(keyed.followUps.length, 1);
    assert.deepEqual(keyed.followUps[0]?.reviewers, ["reviewer-A-standards", "reviewer-B-spec"]);
    const sameReviewer = foldReviewFindings({
      tier: 3,
      findings: [finding({}), finding({ finding: "a second, different nit" }), finding({ reviewer: "reviewer-B-standards" })],
    });
    assert.equal(sameReviewer.blocking.length, 0);
    assert.equal(sameReviewer.followUps.length, 2, "B's row merges with ONE of A's rows; A's other row is kept, not swallowed");
    assert.equal(sameReviewer.followUps.filter((r) => r.reviewerGroups.length === 2).length, 1);
  });

  test("reviewerGroup maps the T3 fan-out to A/B, the known single reviewers to one group, and an unknown name to its OWN group", () => {
    assert.equal(reviewerGroup("reviewer-A-standards"), "A");
    assert.equal(reviewerGroup("reviewer-b-spec"), "B");
    assert.equal(reviewerGroup("REVIEWER-B-SPEC"), "B");
    for (const n of ["standards", "spec", "reviewer-single", "Standards", "SPEC"]) assert.equal(reviewerGroup(n), "primary");
    // Fail-safe: an unknown or empty name never collapses into `primary` (which
    // would misattribute its findings); it is its own group.
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

describe("foldReviewFindings — a low never blocks at T1–T3, whatever the reviewer count (issue #4916)", () => {
  const DUAL_LOW = [finding({}), finding({ reviewer: "reviewer-B-spec", axis: "spec" })];

  test("T1–T3: the same low raised by both reviewers → PASS, listed once under follow-ups", () => {
    for (const tier of [1, 2, 3]) {
      const r = foldReviewFindings({ tier, findings: DUAL_LOW });
      assert.equal(r.mode, "severity-gated");
      assert.equal(r.reviewVerdict, "PASS", `T${tier}`);
      assert.equal(r.blockers, 0);
      assert.equal(r.followUps.length, 1);
      assert.deepEqual(r.followUps[0]?.reviewerGroups, ["A", "B"]);
      assert.doesNotMatch(r.reason, /both reviewers/);
    }
  });

  test("T4: the same dual-raised low still FAILs; a lone low still FAILs", () => {
    assert.equal(foldReviewFindings({ tier: 4, findings: DUAL_LOW }).reviewVerdict, "FAIL");
    assert.equal(foldReviewFindings({ tier: 4, findings: [finding({})] }).reviewVerdict, "FAIL");
  });

  test("T3: a missing or unknown severity still blocks (normalised to high)", () => {
    for (const severity of [undefined, "", "nit", "LOWISH", 3]) {
      const row: Record<string, unknown> = { reviewer: "reviewer-A-spec", location: "a.ts:1", finding: "f", fix: "g" };
      if (severity !== undefined) row.severity = severity;
      assert.equal(normaliseReviewFindings([row])[0]?.severity, "high", String(severity));
      const r = foldReviewFindings({ tier: 3, findings: [row] });
      assert.equal(r.reviewVerdict, "FAIL", String(severity));
      assert.equal(r.maxSeverity, "high");
      assert.equal(r.followUps.length, 0);
    }
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
    assert.equal(keyed.reviewVerdict, "PASS", "a merged low is still a follow-up (#4916)");
    assert.equal(keyed.followUps.length, 1, "a shared key merges the two lows into one row");
  });

  test("(c) an unknown reviewer name is its own group; two reviewers' same low merges into one non-blocking row", () => {
    const r = foldReviewFindings({
      tier: 3,
      findings: [finding({ reviewer: "Reviewer-A-Standards" }), finding({ reviewer: "qa-bot" })],
    });
    assert.equal(r.reviewVerdict, "PASS", "two distinct reviewers raised the same low — still non-blocking (#4916)");
    assert.equal(r.followUps.length, 1);
    assert.equal(r.followUps[0]?.reviewerGroups.length, 2);
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

describe("two reviewers' same finding merges on a canonical location (PR #4752 QA r2)", () => {
  const bothLow = (tier: number, locA: string, locB: string) =>
    foldReviewFindings({
      tier,
      findings: [
        finding({ location: locA, finding: "one" }),
        finding({ reviewer: "reviewer-B-spec", location: locB, finding: "two" }),
      ],
    });

  test("the exact round-2 regression: bare path / #L12 / :L12 both-reviewer lows merge into one row", () => {
    for (const loc of ["src/foo.ts", "src/foo.ts#L12", "src/foo.ts:L12"]) {
      const r = bothLow(3, loc, loc);
      assert.equal(r.reviewVerdict, "PASS", loc);
      assert.equal(r.followUps.length, 1, loc);
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
      test(`T${tier}: ${JSON.stringify(a)} ~ ${JSON.stringify(b)} → merged into one non-blocking follow-up (#4916)`, () => {
        const r = bothLow(tier, a, b);
        assert.equal(r.reviewVerdict, "PASS");
        assert.equal(r.blocking.length, 0);
        assert.equal(r.followUps.length, 1);
        assert.deepEqual(r.followUps[0]?.reviewers, ["reviewer-A-standards", "reviewer-B-spec"]);
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

  test("round-3 regression: wrapped and parenthesised locations merge onto the same key → one merged non-blocking low", () => {
    const fold = foldReviewFindings({
      tier: 3,
      findings: {
        "reviewer-A-standards": [mrow({ location: "src/foo.ts:12", finding: "same bug" })],
        "reviewer-B-spec": [mrow({ location: "`src/foo.ts:12 (buildX)`", finding: "same bug, wrapped" })],
      },
      spawnedReviewers: SPAWNED,
    });
    assert.equal(fold.reviewVerdict, "PASS", "a low never blocks, even when both reviewers raised it");
    assert.equal(fold.blockers, 0);
    assert.equal(fold.followUps.length, 1, "the two rows merge onto one follow-up");
    assert.equal(fold.followUps[0]!.reviewers.length, 2);
  });
});

describe("foldReview — the composed fold head (issue #5079, INV-3)", () => {
  const checks: CheckState[] = [
    { name: "test", status: "completed", conclusion: "success", required: true },
    { name: "mutation-test", status: "queued", required: true },
  ];
  const input = {
    tier: 3,
    findings: [finding({ severity: "medium", location: "src/y.ts:3", finding: "real bug" })],
    checks,
    standardsSummary: "std ok",
    specSummary: "spec ok",
    fanoutReason: "fan-out line",
  };

  test("equals the helpers called in playbook order", () => {
    const r = foldReview(input);
    const fold = foldDirect({ tier: 3, findings: input.findings });
    assert.deepEqual(r.fold, fold);
    assert.deepEqual(r.counts, countsDirect(fold, redRequiredChecks(checks)));
    assert.equal(
      r.report,
      renderDirect({ fold, standardsSummary: "std ok", specSummary: "spec ok", fanoutReason: "fan-out line" }),
    );
    assert.deepEqual(r.verdict, classifyVerdict(fold.reviewVerdict, checks));
    assert.equal(r.ciSummary, renderCiSummary(r.verdict));
  });

  test("a blocking finding folds to FAIL and the final verdict is FAIL", () => {
    const r = foldReview(input);
    assert.equal(r.fold.reviewVerdict, "FAIL");
    assert.equal(r.verdict.verdict, "FAIL");
    assert.equal(r.counts.blockers, 1);
  });

  test("a clean fold with a pending required check is PASS-pending-CI", () => {
    const r = foldReview({ ...input, findings: [] });
    assert.equal(r.verdict.verdict, "PASS-pending-CI");
    assert.equal(r.counts.blockers, 0);
  });
});

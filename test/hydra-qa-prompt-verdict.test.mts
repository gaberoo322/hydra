/**
 * Regression tests for the hydra-qa one-pass verdict classifier (issue #405).
 *
 * Before #405, the hydra-qa subagent looped waiting on pending required CI
 * checks (e.g. `mutation-test: QUEUED`) before emitting any verdict. A single
 * QA pass could span hours, sometimes long enough for the PR to auto-merge
 * before the verdict landed. The classifier now returns one of four verdicts
 * in a single pass and exits — autopilot polls CI separately:
 *
 *   PASS / FAIL / PASS-pending-CI / FAIL-pending-CI
 *
 * The "smoking-gun" assertion from the issue acceptance criteria:
 *
 *   "a PR with `mutation-test: QUEUED` and all other checks green returns
 *    PASS-pending-CI, not a wait"
 *
 * is the first test below. Every other test guards an adjacent edge case so
 * the classifier doesn't silently regress to the old looping behaviour.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type FinalVerdict,
  QA_VERDICT_ERROR_PREFIX,
  QA_VERDICT_UNKNOWN_SHA,
  type QaSeverity,
  buildQaVerdictTrailer,
  classifyVerdict,
  decideDeepQaAction,
  decideQaRoundAction,
  decideReviewerFanout,
  foldReviewFindings,
  isPromptOnlyChange,
  parseQaVerdictErrors,
  parseQaVerdictTrailer,
  priorFindingsSection,
  redRequiredChecks,
  renderCiSummary,
  renderQaEscalationSummary,
  renderQaVerdictErrorLine,
  renderQaVerdictTrailer,
  renderReviewReport,
  trailerBlockerCounts,
} from "../scripts/ci/qa-verdict.ts";
import {
  type CheckState,
  renderChecksBlock,
} from "../src/qa/admission.ts";
import {
  MALFORMED_FINDING_ID,
  NON_MERGEABLE_LOCATIONS,
  QA_FINDINGS_HEADING,
  type ReviewFinding,
  aggregateAdversarialReview,
  reviewerGroup,
} from "../src/qa/fold.ts";
import {
  QA_ADMISSION_SKIP_MARKER,
  QA_FAIL_ROUND_CAP,
} from "../src/qa/round-action.ts";
import { glmLane } from "../src/glm/eligibility.ts";

// ---------------------------------------------------------------------------
// Issue #4729 — canonical `QA-Verdict:` trailer: helper shape + playbook pin.
// ---------------------------------------------------------------------------

describe("hydra-qa emits the QA-Verdict trailer on every verdict post (issue #4729)", () => {
  const playbook = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "operator-playbooks", "hydra-qa.md"),
    "utf8",
  );
  // Since #5269 (ADR-0046 Decision 7) the verdict bodies, the trailer render call and the
  // pre-verdict exits live in scripts/qa/route.ts. The golden bodies and the effect order are
  // pinned by test/qa-plumbing-scripts.test.mts; this block keeps the invariants that tie the
  // PLAYBOOK to that script.
  const routeSrc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "qa", "route.ts"),
    "utf8",
  );

  test("route renders the trailer through the engine's trailer phase; the playbook documents its shape", () => {
    assert.ok(routeSrc.includes('ports.phase("trailer"'), "route.ts must render the trailer via the engine, never by hand");
    assert.match(
      playbook,
      /QA-Verdict: <PASS\|FAIL\|PASS-pending-CI\|FAIL-pending-CI> pr=<N> round=<k> sha=<head12> blockers=<n> max_severity=<high\|medium\|low\|none>/,
    );
  });

  test("no verdict body template remains in the playbook: every posted body lives in route.ts", () => {
    assert.doesNotMatch(playbook, /--body "> \*(Automated QA|T4 Deep-QA)/, "a body template in the playbook would drift from the golden bodies");
    assert.doesNotMatch(playbook, /\$\{?QA_VERDICT_TRAILER\}?/, "no playbook variable carries the trailer any more");
    for (const heading of ["Automated QA — two-axis review", "Automated QA — two-axis review (pending CI)", "T4 Verifier-Core deep review", "PASS proof"]) {
      assert.ok(routeSrc.includes(heading), `route.ts must post the '${heading}' body`);
    }
  });

  test("fail-closed (#5306 QA round 1): the trailer and round-action results are validated BEFORE the first effect", () => {
    const trailerAt = routeSrc.indexOf('ports.phase("trailer"');
    const roundAt = routeSrc.indexOf('ports.phase("round-action"');
    const firstEffect = routeSrc.indexOf('if (verdict === "PASS")');
    assert.ok(trailerAt > 0 && roundAt > trailerAt && firstEffect > roundAt, "engine calls precede every PASS/FAIL effect");
    assert.match(routeSrc, /const trailer = requireField\(trailerOut\.trailer/, "an absent trailer is a pre-verdict exit");
    assert.match(routeSrc, /const roundAction = requireField\(round\.action/, "an action-less round-action result is a pre-verdict exit");
    assert.doesNotMatch(playbook, /trailer \| jq -r/, "a pipe into jq masks the node exit status");
  });

  test("the playbook routes skip-required-failed and defer through `route`, not a hand-run fold", () => {
    assert.match(playbook, /skip-required-failed/);
    assert.match(playbook, /scripts\/qa\/route\.ts/);
    assert.doesNotMatch(playbook, /scripts\/ci\/qa-verdict\.ts (fold|trailer|round-action)/, "INV-1: no engine shim returns to the playbook");
  });
});

// ── Change-shape reviewer sizing (issue #4733) ─────────────────────────────

describe("hydra-qa playbook — spawn step branches on change shape (issue #4733)", () => {
  const playbook = readFileSync(
    new URL("../docs/operator-playbooks/hydra-qa.md", import.meta.url),
    "utf8",
  );
  const preflightSrc = readFileSync(new URL("../scripts/qa/preflight.ts", import.meta.url), "utf8");

  test("preflight sizes the fan-out via the engine's `fanout` phase; the playbook branches on .fanout.mode", () => {
    assert.ok(preflightSrc.includes('ports.phase("fanout"'), "preflight must size the fan-out through the engine");
    assert.ok(playbook.includes("fanout.mode"), "playbook must branch on the preflight's .fanout.mode");
    assert.ok(playbook.includes("fanout.reviewers"), "playbook must carry the decided reviewer list");
  });

  test("step 7 has a single-reviewer branch; T4 and code PRs keep the full fan-out", () => {
    assert.match(playbook, /#### 7c\. [^\n]*single reviewer/i);
    assert.ok(
      playbook.includes("A T4 PR or a `code` PR always gets the full fan-out"),
      "playbook must pin the T4/code full-fan-out rule",
    );
  });

  test("fan-out fallback keeps the tier reviewers; diffs use --no-renames; the prompt-path list is the engine's", () => {
    assert.ok(preflightSrc.includes("kept the tier path"), "a failed sizing call must keep the tier fan-out");
    assert.ok(preflightSrc.includes('"reviewer-A-standards", "reviewer-A-spec", "reviewer-B-standards", "reviewer-B-spec"'));
    assert.ok(preflightSrc.includes('["standards", "spec"]'));
    assert.ok(preflightSrc.includes('"--no-renames", "--name-only"'), "CHANGED lists must use --no-renames");
    assert.ok(preflightSrc.includes("out.promptOnly === true"), "step 6 must use the engine's shared prompt-path predicate (admission .promptOnly)");
    assert.ok(!playbook.includes(".claude/skills/*|config/*|docs/operator-playbooks/*"), "the old step-6 case list must be gone");
    assert.ok(!/^CHANGED=\$\(git diff --name-only/m.test(playbook), "CHANGED lists must use --no-renames");
  });

  test("step 7.5 completeness check covers the one-reviewer fan-out", () => {
    const start = playbook.indexOf("### 7.5 ");
    const end = playbook.indexOf("### 8. ", start);
    assert.ok(start > 0 && end > start, "step 7.5 section must exist");
    const section = playbook.slice(start, end);
    assert.ok(section.includes("reviewer-single"), "7.5 must name the single-reviewer spawn");
    assert.ok(section.includes("fanout.reviewers"), "7.5 must check against the decided reviewer list");
  });
});

// ---------------------------------------------------------------------------
// Issue #4746 — harden the QA-Verdict trailer before it becomes load-bearing.
// ---------------------------------------------------------------------------

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const QA_PLAYBOOK = readFileSync(join(REPO_ROOT, "docs", "operator-playbooks", "hydra-qa.md"), "utf8");
const ALL_VERDICTS = ["PASS", "FAIL", "PASS-pending-CI", "FAIL-pending-CI"] as const;
const FULL_HEAD = "0123456789abcdef0123456789abcdef01234567";
/** The seven branch-protection contexts — the longest realistic red list. */
const ALL_REQUIRED = ["test", "dashboard-build", "tier-gate", "mutation-test", "scope-check", "secret-scan", "deep-qa-gate"];

/** Fill a step-10 issue-pointer template with worst-case (longest) field values. */
function fillWorstCase(body: string): string {
  const summaryTpl = /BLOCKER_SUMMARY="((?:[^"\\]|\\.)*)"/.exec(QA_PLAYBOOK)?.[1];
  assert.ok(summaryTpl, "BLOCKER_SUMMARY template not found");
  const trailer = renderQaVerdictTrailer({
    verdict: "FAIL-pending-CI", pr: 99999, round: 999, sha: FULL_HEAD, blockers: 999, maxSeverity: "medium",
  });
  const errorLine = renderQaVerdictErrorLine({
    verdict: "FAIL-pending-CI", pr: 99999, reason: "trailer render failed (full and minimal)",
  });
  const values: Record<string, string> = {
    VERDICT: "FAIL-pending-CI",
    pr_number: "99999",
    issue_number: "99999",
    // #4766 bounce label — both candidates are 16 chars, so either is the
    // worst case; needs-dev-resume is the primary (open-PR) arm.
    BOUNCE_LABEL: "needs-dev-resume",
    DEEP_QA_FAILNO: "99",
    BLOCKERS: "999",
    MAX_SEVERITY: "medium",
    WORST_FINDING: "w".repeat(120),
    RED_REQUIRED_LIST: ALL_REQUIRED.join(", "),
    QA_VERDICT_TRAILER: trailer.length >= errorLine.length ? trailer : errorLine,
    ESC_LABEL_NOTE:
      "**Label routing FAILED** (see the QA log): add `ready-for-human` and remove `needs-qa`, `ready-for-agent`, `needs-dev-resume` and `in-progress` by hand, or QA will re-run on this issue.",
    QA_ESCALATION_SUMMARY: renderQaEscalationSummary({
      pr: 99999,
      priorBodies: Array.from({ length: 12 }, (_, i) =>
        renderQaVerdictTrailer({ verdict: "FAIL-pending-CI", pr: 99999, round: 990 + i, sha: FULL_HEAD, blockers: 999, maxSeverity: "medium" }),
      ),
      currentTrailer: trailer,
    }),
  };
  const expand = (s: string): string =>
    s
      .replace(/\$\{(\w+):\+((?:[^{}]|\$\{\w+\})*)\}/g, (_m, _v, alt: string) => alt)
      .replace(/\$\{(\w+):-[^}]*\}/g, (m, v: string) => values[v] ?? m)
      .replace(/\$\{(\w+)\}|\$(\w+)/g, (m, a?: string, b?: string) => values[(a ?? b) as string] ?? m);
  values.BLOCKER_SUMMARY = expand(summaryTpl);
  return expand(body).replace(/\\(.)/g, "$1");
}

describe("one definition of a red required check (issue #4746)", () => {
  const CASES: Array<{ name: string; checks: CheckState[]; red: string[] }> = [
    { name: "all green", checks: [{ name: "test", status: "completed", conclusion: "success", required: true }], red: [] },
    { name: "pending only", checks: [{ name: "test", status: "queued", required: true }], red: [] },
    {
      name: "mixed red conclusions + optional red",
      checks: [
        { name: "test", status: "completed", conclusion: "failure", required: true },
        { name: "tier-gate", status: "completed", conclusion: "cancelled", required: true },
        { name: "mutation-test", status: "COMPLETED" as CheckState["status"], conclusion: "TIMED_OUT" as CheckState["conclusion"], required: true },
        { name: "advisory-checks", status: "completed", conclusion: "failure", required: false },
        { name: "scope-check", status: "completed", conclusion: "skipped", required: true },
      ],
      red: ["test", "tier-gate", "mutation-test"],
    },
    {
      name: "startup_failure / action_required / stale",
      checks: [
        { name: "a", status: "completed", conclusion: "startup_failure", required: true },
        { name: "b", status: "completed", conclusion: "action_required", required: true },
        { name: "c", status: "completed", conclusion: "stale", required: true },
      ],
      red: ["a", "b", "c"],
    },
  ];

  test("redRequiredChecks agrees with classifyVerdict's requiredFailed count and FAIL reason", () => {
    for (const c of CASES) {
      const red = redRequiredChecks(c.checks);
      assert.deepEqual(red, c.red, c.name);
      const r = classifyVerdict("PASS", c.checks);
      assert.equal(r.summary.requiredFailed, red.length, c.name);
      if (red.length > 0) {
        assert.equal(r.verdict, "FAIL");
        assert.equal(r.reason, `Required CI check(s) failed: ${red.join(", ")}`);
      }
    }
  });

  test("preflight's redRequired and route's skip-path BLOCKERS derive from the admission call's redRequired (no divergent jq filter)", () => {
    const preflightSrc = readFileSync(join(REPO_ROOT, "scripts", "qa", "preflight.ts"), "utf8");
    const routeSrc = readFileSync(join(REPO_ROOT, "scripts", "qa", "route.ts"), "utf8");
    assert.match(preflightSrc, /redRequired: Array\.isArray\(out\.redRequired\)/, "the red list is the engine's, copied verbatim");
    assert.doesNotMatch(QA_PLAYBOOK, /IN\("failure"/, "no hand-rolled conclusion filter may remain");
    assert.match(routeSrc, /blockers = Math\.max\(1, pre\.gate\.redRequired\.length\)/);
    assert.match(routeSrc, /worstFinding = `required CI check\(s\) red: \$\{redList \|\| "see checks block"\}`/);
  });
});

describe("hydra-qa FAIL path posts a comment, never a request-changes review (issue #4746)", () => {
  test("no `gh pr review --request-changes` anywhere in the playbook", () => {
    assert.doesNotMatch(QA_PLAYBOOK, /gh pr review \$pr_number[^\n]*--request-changes/);
  });

  test("route posts the T1-T3 and T4 FAIL verdict bodies as `gh pr comment`s, never a review", () => {
    const routeSrc = readFileSync(join(REPO_ROOT, "scripts", "qa", "route.ts"), "utf8");
    assert.match(routeSrc, /\["pr", "comment", String\(pr\), "--repo", repo, "--body", body\]/);
    assert.doesNotMatch(routeSrc, /"review"|request-changes/);
    assert.ok(routeSrc.includes("Automated QA — two-axis review") && routeSrc.includes("T4 Verifier-Core deep review"));
  });
});

// ---------------------------------------------------------------------------
// Issue #4734 — severity-gated T1–T3 fold + structured findings table.
// ---------------------------------------------------------------------------

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

describe("hydra-qa playbook wires the severity fold (issue #4734)", () => {
  test("reviewer prompts carry the severity rubric and the findings contract", () => {
    assert.match(QA_PLAYBOOK, /`high` — behaviou?r regression, data or work loss, or a weakened safety gate/);
    assert.match(QA_PLAYBOOK, /`medium` — a spec criterion unmet, or a real bug on a non-critical path/);
    assert.match(QA_PLAYBOOK, /`low` — wording, comments, citations, style/);
    assert.ok(QA_PLAYBOOK.includes('"severity": "high|medium|low"'), "reviewers must emit the severity field");
  });

  test("route folds through the engine's `fold` phase (rules live in the engine, not the playbook)", () => {
    const routeSrc = readFileSync(join(REPO_ROOT, "scripts", "qa", "route.ts"), "utf8");
    const s8 = QA_PLAYBOOK.slice(QA_PLAYBOOK.indexOf("### 8. Aggregate"), QA_PLAYBOOK.indexOf("### 9."));
    assert.ok(routeSrc.includes('ports.phase("fold"'), "route must call the fold phase");
    assert.ok(routeSrc.includes("const parsed = tryParse(raw);") && routeSrc.includes("if (parsed === undefined) return raw;"), "a malformed file must reach the engine RAW and fail closed there");
    assert.ok(QA_PLAYBOOK.includes("aggregateAdversarialReview()"), "T4 keeps the unchanged adversarial AND");
    assert.doesNotMatch(QA_PLAYBOOK, /renderChecksBlock\(r\)/, "verdict comments no longer repeat the full CI table");
    assert.doesNotMatch(s8, /\|\| '\[\]'\)/, "no defaulted empty findings array");
    assert.doesNotMatch(QA_PLAYBOOK, /process\.env\.REVIEWER_A_VERDICT/);
  });

  test("a non-zero exit on fold / trailer / round-action is a pre-verdict exit, with no bash verdict fallback", () => {
    assert.match(QA_PLAYBOOK, /pre-verdict exit/);
    assert.doesNotMatch(QA_PLAYBOOK, /QA_TRAILER_RE/);
    assert.doesNotMatch(QA_PLAYBOOK, /printf 'QA-Verdict-Error/);
  });
});

// ---------------------------------------------------------------------------
// PR #4752 QA round 1 — the fold must FAIL CLOSED on malformed reviewer output.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// PR #4752 QA round 2 — location canonicalisation for merging two reviewers'
// same finding into one row (non-blocking for a low at T1–T3 since #4916).
// ---------------------------------------------------------------------------

describe("qa-verdict constants pin the playbook's hand-copied text (issue #4758)", () => {
  test("step 8's hand-copied placeholder list equals NON_MERGEABLE_LOCATIONS (drift guard)", () => {
    const m = /the `NON_MERGEABLE_LOCATIONS` list \((.*?) case-insensitive\)/.exec(QA_PLAYBOOK);
    assert.ok(m, "step 8 must carry the parseable hand copy of the placeholder list");
    const copied = m[1]!
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "")
      .map((s) => s.replace(/^`|`$/g, "").toLowerCase())
      .map((s) => (s === "empty" ? "" : s));
    assert.deepEqual([...copied].sort(), [...NON_MERGEABLE_LOCATIONS].sort());
    // The prose word 'empty' stands for the '' entry — an explicit check, not an accident.
    assert.ok(copied.includes(""));
  });

  test("step 8's 'contains whitespace' wording says the test applies AFTER the stripping", () => {
    assert.match(
      QA_PLAYBOOK,
      /the whitespace test applies to the path part after the quote\/backtick\/parenthetical stripping/,
    );
  });

  test("step 8 says an extension-less path is path-like only WITH a line number", () => {
    assert.match(QA_PLAYBOOK, /`Dockerfile:12` is path-like only WITH a line number/);
  });

  test("QA_ADMISSION_SKIP_MARKER: route's skip REVIEW_REPORT carries it for humans; currentReviewed comes from the gate action, not the marker text", () => {
    const routeSrc = readFileSync(join(REPO_ROOT, "scripts", "qa", "route.ts"), "utf8");
    assert.equal(QA_ADMISSION_SKIP_MARKER, "Review skipped by the admission gate");
    assert.ok(routeSrc.includes("`_${QA_ADMISSION_SKIP_MARKER} (issue #3815)"), "route's skip report carries the marker");
    assert.ok(!routeSrc.includes(`*"${QA_ADMISSION_SKIP_MARKER}"*`), "no case pattern greps the marker out of the report");
    assert.ok(routeSrc.includes('const currentReviewed = pre.gate.action !== "skip-required-failed";'));
  });

  test("QA_FINDINGS_HEADING: priorFindingsSection keys on the heading the report writes", () => {
    assert.equal(QA_FINDINGS_HEADING, "### Findings");
    // priorFindingsSection reads the heading the report writes — one constant, both sides.
    const body = verdictBody(1, "FAIL", SHA_A, 1, "medium", `${QA_FINDINGS_HEADING}\n\n| medium | x |`);
    assert.equal(priorFindingsSection([body], 7, 1), `${QA_FINDINGS_HEADING}\n\n| medium | x |`);
  });

  test("reviewerGroup's docstring states the true empty-name behaviour (INV-7, docstring-only)", () => {
    const src = readFileSync(join(REPO_ROOT, "src/qa/fold.ts"), "utf8");
    const at = src.indexOf("export function reviewerGroup");
    assert.ok(at > 0);
    const doc = src.slice(Math.max(0, at - 800), at);
    assert.match(doc, /empty reviewer name[^.]*`primary`/, "the docstring must say an empty name maps to primary");
  });
});

// ---------------------------------------------------------------------------
// Issue #4735 — convergent QA: round cap, re-review context, class sweep.
// ---------------------------------------------------------------------------

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

describe("hydra-qa step 10 label effects stay plain text pins (issue #4735, INV-8)", () => {
  test("the playbook never uses the braced ${issue_number} form (the loader only substitutes the bare token)", () => {
    assert.ok(!QA_PLAYBOOK.includes("${issue_number}"), "found ${issue_number} in hydra-qa.md");
  });

  test("no direct state-label write survives in route.ts or the playbook: only the lifecycle seam moves state (ADR-0047 D4, #5317)", () => {
    const routeSrc = readFileSync(join(REPO_ROOT, "scripts", "qa/route.ts"), "utf8");
    assert.doesNotMatch(routeSrc, /"--(?:add|remove)-label"/, "no gh issue edit label flags");
    assert.ok(!routeSrc.includes("-X\", \"DELETE") && !/"DELETE"/.test(routeSrc), "no label DELETE call");
    assert.ok(!/\/labels`/.test(routeSrc), "no label POST/DELETE endpoint");
    assert.ok(routeSrc.includes("ports.advance(args)"), "state moves ride ports.advance -> scripts/lifecycle.ts advance");
    assert.doesNotMatch(QA_PLAYBOOK, /--(?:add|remove)-label\s+["'$]?(?:needs-qa|needs-dev-resume|ready-for-agent|ready-for-human|in-progress|qa-passed|parked)/);
  });

  test("a refused seam call ends the route non-zero and says it never edits labels by hand (INV-9)", () => {
    const routeSrc = readFileSync(join(REPO_ROOT, "scripts", "qa/route.ts"), "utf8");
    assert.ok(routeSrc.includes("not editing labels by hand"));
    assert.ok(routeSrc.includes("advanceOrThrow"));
  });

  test("a degraded disarm-failed is a HARD STOP in the playbook: manual --disable-auto, confirm autoMergeRequest == null, report loudly", () => {
    const a = QA_PLAYBOOK.indexOf('index("disarm-failed")');
    assert.ok(a > 0, "the playbook reads .degraded for disarm-failed after route");
    const block = QA_PLAYBOOK.slice(a, a + 900);
    assert.ok(block.includes("gh pr merge $pr_number --repo gaberoo322/hydra --disable-auto"), "re-disarm by hand");
    assert.ok(block.includes("autoMergeRequest"), "confirm the PR is no longer armed");
    assert.ok(/STILL auto-merge-armed/.test(block), "a still-armed FAILed PR is reported loudly");
    assert.ok(QA_PLAYBOOK.indexOf('index("disarm-failed")') < QA_PLAYBOOK.indexOf("gh pr merge $pr_number --repo gaberoo322/hydra --auto --squash"), "the hard stop is read before the auto-merge call site");
    assert.ok(/at most one `QA-Verdict-Error` comment/.test(QA_PLAYBOOK) && !/exits 1 with NOTHING posted/.test(QA_PLAYBOOK), "pre-verdict exit wording matches route");
  });

  test("the escalation summary still comes from the round-action JSON", () => {
    const routeSrc = readFileSync(join(REPO_ROOT, "scripts", "qa/route.ts"), "utf8");
    assert.ok(routeSrc.includes("roundOut.escalationSummary"));
  });
});

describe("hydra-qa playbook wires convergent review (issue #4735)", () => {
  const step10 = QA_PLAYBOOK.slice(QA_PLAYBOOK.indexOf("### 10. Verdict routing"), QA_PLAYBOOK.indexOf("### 11. Lesson capture"));
  const t13 = step10.slice(step10.indexOf("For T1 / T2 / T3"), step10.indexOf("For **T4**"));
  const t4 = step10.slice(step10.indexOf("For **T4**"));

  test("reviewer prompts carry the class-sweep instruction", () => {
    assert.match(QA_PLAYBOOK, /\*Class sweep \(issue #4735\): when you raise a finding, search the whole diff and every touched file/);
    assert.match(QA_PLAYBOOK, /3 or more instances, or the inputs are adversarial/);
  });

  test("the re-review context is APPENDED to the full packet, with the confirm-first instruction", () => {
    const packetSrc = readFileSync(join(REPO_ROOT, "scripts", "qa", "packet.ts"), "utf8");
    assert.ok(packetSrc.includes("${priorFindings}"));
    assert.ok(packetSrc.includes('["diff", "--no-renames", rereviewDiffBase, "HEAD"]'));
    assert.ok(packetSrc.includes("packet += `"), "the context is appended; the full diff and changed files stay first");
    assert.match(packetSrc, /first state fixed\/not-fixed for each prior finding; for anything new, prefer medium\+ and say why it wasn't visible before/);
    assert.match(QA_PLAYBOOK, /first state fixed\/not-fixed for each prior finding; for anything new, prefer medium\+ and say why it wasn't visible before/i, "the re-review brief stays in the reviewer prompts");
  });

  test("T1–T3: round-action runs before any effect; the seam owns the cap and parks, never ready-for-human (issue #5317 INV-5/6)", () => {
    const routeSrc = readFileSync(join(REPO_ROOT, "scripts", "qa", "route.ts"), "utf8");
    assert.ok(routeSrc.includes('ports.phase("round-action"'), "the round summary is produced by the round-action call");
    assert.ok(routeSrc.indexOf('ports.phase("round-action"') < routeSrc.indexOf("// ---- Effects (step 10). ----"), "round-action reads the PR before any effect is posted");
    const t13 = routeSrc.slice(routeSrc.indexOf("// T1/T2/T3 (and unknown-tier) FAIL"));
    // The verdict comment (this round's trailer) precedes the first seam call.
    const comment = t13.indexOf("await prComment(bodies.fail(");
    const firstAdvance = t13.indexOf("await advance(label");
    assert.ok(comment > 0 && comment < firstAdvance, "the PR verdict comment is posted before the seam counts the round");
    assert.ok(t13.includes('"parked:qa-fail-rounds"'), "enforce: a parked:qa-fail-rounds refusal is the escalation, not an error");
    assert.ok(t13.includes('adv.wouldPark === "qa-fail-rounds"'), "shadow: the would-park report is read from the advance result");
    assert.ok(t13.includes('advanceOrThrow("parked"'), "shadow: an explicit park keeps the cap live");
    const code = t13.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    assert.ok(!code.includes("ready-for-human"), "a T1-T3 round cap never writes ready-for-human");
  });

  test("T4 keeps decideDeepQaAction and never runs the T1–T3 round cap", () => {
    const routeSrc = readFileSync(join(REPO_ROOT, "scripts", "qa", "route.ts"), "utf8");
    const t4 = routeSrc.slice(routeSrc.indexOf("// T4 FAIL: the Deep-QA Remediation Loop"), routeSrc.indexOf("// T1/T2/T3 (and unknown-tier) FAIL"));
    assert.ok(t4.includes("roundOut.deepQa"), "T4 reads the deep-QA action from the round-action JSON");
    assert.ok(!t4.includes("qa-round-cap") && !t4.includes("decideQaRoundAction") && !t4.includes("roundAction"));
  });
});

// ── #4735 simplification: re-review context never reaches the verdict ─────────
// Operator decision (https://github.com/gaberoo322/hydra/issues/4735#issuecomment-5883251393):
// the re-review context is PROMPT ONLY. No code path filters, demotes or narrows
// a finding; step 9 always folds with plain foldReviewFindings.
describe("no demotion path: step 9 always folds with plain foldReviewFindings (issue #4735)", () => {
  test("route makes exactly one fold call, ALWAYS passing the spawned reviewers (#4758), and never the re-review context", () => {
    const routeSrc = readFileSync(join(REPO_ROOT, "scripts", "qa", "route.ts"), "utf8");
    assert.equal((routeSrc.match(/ports\.phase\("fold"/g) ?? []).length, 1, "one fold call, no scoped variant");
    assert.ok(routeSrc.includes("spawnedReviewers: pre.fanout.reviewers"), "spawnedReviewers is passed unconditionally (empty included)");
    const fold = routeSrc.slice(routeSrc.indexOf('ports.phase("fold"'), routeSrc.indexOf("const fold = isRecord(foldResult.fold)"));
    for (const v of ["priorFindings", "rereviewDiffBase", "PRIOR_FINDINGS", "REREVIEW_DIFF_BASE"]) {
      assert.ok(!fold.includes(v), `the fold must not read re-review context (${v})`);
    }
  });

  test("qa-verdict.ts exports no filter / scoped fold / prior-table parser", async () => {
    const mod: Record<string, unknown> = await import("../scripts/ci/qa-verdict.ts");
    for (const gone of ["filterReReviewFindings", "foldReReviewFindings", "parsePriorFindingsTable"]) {
      assert.equal(mod[gone], undefined, `${gone} must not exist`);
    }
  });

  test("the playbook keeps no per-PR re-review state", () => {
    for (const gone of ["HYDRA_QA_STATE_ROOT", "hydra-qa-state", "scope.json", "PRIOR_CHECKS_FILE", "foldReReviewFindings", "filterReReviewFindings"]) {
      assert.ok(!QA_PLAYBOOK.includes(gone), `playbook still mentions ${gone}`);
    }
  });

  test("decideQaRoundAction counts a fold-failed FAIL round as a reviewed round", () => {
    const foldFailed = (round: number, sha: string) =>
      verdictBody(round, "FAIL", sha, 1, "high", "### Findings\n\n_Findings fold failed; raw reviewer reports follow._");
    const d = decideQaRoundAction({ tier: 3, verdict: "FAIL", pr: 7, priorBodies: [foldFailed(1, SHA_A), foldFailed(2, SHA_B)], currentReviewed: true });
    assert.equal(d.action, "escalate");
    assert.equal(d.failRound, QA_FAIL_ROUND_CAP);
  });
});


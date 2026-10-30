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

describe("hydra-qa playbook emits the QA-Verdict trailer on every verdict post (issue #4729)", () => {
  const playbook = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "operator-playbooks", "hydra-qa.md"),
    "utf8",
  );
  const step10 = playbook.slice(
    playbook.indexOf("### 10. Verdict routing"),
    playbook.indexOf("### 11. Lesson capture"),
  );
  // Every `--body "…"` template in step 10 (bodies end at the first unescaped `"`).
  const bodies = [...step10.matchAll(/(gh (?:pr|issue) (?:comment|review))[^\n]*--body "((?:[^"\\]|\\.)*)"/g)].map(
    (m) => ({ cmd: m[1] as string, body: m[2] as string }),
  );

  test("step 9.5 renders the trailer via buildQaVerdictTrailer", () => {
    assert.match(playbook, /### 9\.5 Render the `QA-Verdict:` trailer/);
    assert.match(playbook, /scripts\/ci\/qa-verdict\.ts trailer/);
    assert.match(
      playbook,
      /QA-Verdict: <PASS\|FAIL\|PASS-pending-CI\|FAIL-pending-CI> pr=<N> round=<k> sha=<head12> blockers=<n> max_severity=<high\|medium\|low\|none>/,
    );
  });

  test("every verdict body in step 10 (PR and issue side, T1-T4) ends with exactly one trailer", () => {
    const verdictBodies = bodies.filter((b) => !b.body.includes("PASS proof"));
    // PASS, PASS-pending-CI, T1-T3 FAIL review + 4 issue pointers (escalated
    // #4735, GLM wording, open-PR #4766, not-open fallback), T4 review + 2
    // issue pointers = 10.
    assert.equal(verdictBodies.length, 10, `found ${verdictBodies.length} verdict bodies`);
    for (const { cmd, body } of verdictBodies) {
      const count = body.split("${QA_VERDICT_TRAILER}").length - 1;
      assert.equal(count, 1, `${cmd} body must carry exactly one trailer:\n${body.slice(0, 200)}`);
      assert.ok(body.trimEnd().endsWith("${QA_VERDICT_TRAILER}"), `${cmd} trailer must be the last line`);
    }
  });

  test("issue-side comments are short pointers that keep their bounce markers (≤800 chars with worst-case fields, #4746)", () => {
    const issueBodies = bodies.filter((b) => b.cmd === "gh issue comment").map((b) => b.body);
    // 6 since #4766: escalated #4735, GLM wording, open-PR wording, not-open
    // fallback, T4 blocked, T4 1st-FAIL bounce.
    assert.equal(issueBodies.length, 6);
    for (const body of issueBodies) {
      const filled = fillWorstCase(body);
      assert.ok(!/\$\{?\w/.test(filled), `unexpanded variable left in pointer:\n${filled}`);
      // The #4735 escalation carries the round-by-round summary (≤10 rows), so it gets a larger bound.
      const limit = body.includes("${QA_ESCALATION_SUMMARY}") ? 2500 : 800;
      assert.ok(filled.length <= limit, `issue pointer too long with worst-case fields (${filled.length} chars):\n${filled}`);
      assert.ok(!body.includes("$REVIEW_REPORT"), "the full review must live only on the PR");
      assert.match(body, /PR #\$pr_number/);
      assert.match(body, /\$\{BLOCKER_SUMMARY\}/);
      assert.match(body, /Automated QA failed|Automated QA escalated|T4 Deep-QA failed|T4 Deep-QA blocked/);
    }
  });

  test("the skip-required-failed path runs step 9.5 before step 10", () => {
    const skip = playbook.slice(playbook.indexOf("- **`skip-required-failed`** (T1/T2/T3 only"));
    assert.match(skip.slice(0, 4000), /run step 9\.5/i);
    assert.match(skip.slice(0, 4000), /MAX_SEVERITY=high/);
  });
});

// ── Change-shape reviewer sizing (issue #4733) ─────────────────────────────

describe("hydra-qa playbook — spawn step branches on change shape (issue #4733)", () => {
  const playbook = readFileSync(
    new URL("../docs/operator-playbooks/hydra-qa.md", import.meta.url),
    "utf8",
  );

  test("step 6.7 sizes the fan-out via `qa-verdict.ts fanout`", () => {
    assert.match(playbook, /### 6\.7 [^\n]*change shape/i);
    assert.ok(playbook.includes("scripts/ci/qa-verdict.ts fanout"), "step 6.7 sizes the fan-out via `qa-verdict.ts fanout`");
    assert.ok(playbook.includes("FANOUT_MODE"), "playbook must carry FANOUT_MODE");
  });

  test("step 7 has a single-reviewer branch; T4 and code PRs keep the full fan-out", () => {
    assert.match(playbook, /#### 7c\. [^\n]*single reviewer/i);
    assert.ok(
      playbook.includes("A T4 PR or a `code` PR always gets the full fan-out"),
      "playbook must pin the T4/code full-fan-out rule",
    );
  });

  test("fan-out fallback sets FANOUT_REVIEWERS; diffs use --no-renames; step 6 shares the prompt-path list", () => {
    const start = playbook.indexOf("### 6.7 ");
    const section = playbook.slice(start, playbook.indexOf("### 7. ", start));
    assert.ok(section.includes("|| FANOUT_JSON=\"\""), "6.7 CLI failure must fall to the tier fan-out");
    assert.equal(section.match(/FANOUT_REVIEWERS=/g)?.length, 3, "6.7 must set FANOUT_REVIEWERS on success AND both fallback arms");
    assert.ok(!/^CHANGED=\$\(git diff --name-only/m.test(playbook), "CHANGED lists must use --no-renames");
    assert.ok(playbook.includes("if .promptOnly == true"), "step 6 must use the engine's shared prompt-path predicate (admission .promptOnly)");
    assert.ok(!playbook.includes(".claude/skills/*|config/*|docs/operator-playbooks/*"), "the old step-6 case list must be gone");
  });

  test("step 7.5 completeness check covers the one-reviewer fan-out", () => {
    const start = playbook.indexOf("### 7.5 ");
    const end = playbook.indexOf("### 8. ", start);
    assert.ok(start > 0 && end > start, "step 7.5 section must exist");
    const section = playbook.slice(start, end);
    assert.ok(section.includes("reviewer-single"), "7.5 must name the single-reviewer spawn");
    assert.ok(section.includes("FANOUT_REVIEWERS"), "7.5 must check against the decided reviewer list");
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

  test("the playbook's RED_REQUIRED_LIST + skip-path BLOCKERS derive from the admission call's redRequired (no divergent jq filter)", () => {
    assert.match(QA_PLAYBOOK, /RED_REQUIRED_JSON=\$\(printf '%s' "\$ADMISSION_JSON" \| jq -c '\.redRequired/);
    assert.doesNotMatch(QA_PLAYBOOK, /IN\("failure"/, "no hand-rolled conclusion filter may remain");
    assert.match(QA_PLAYBOOK, /BLOCKERS=\$\(printf '%s' "\$RED_REQUIRED_JSON" \| jq 'length'/);
    assert.match(QA_PLAYBOOK, /WORST_FINDING="required CI check\(s\) red: \$\{RED_REQUIRED_LIST/);
  });
});

describe("hydra-qa FAIL path posts a comment, never a request-changes review (issue #4746)", () => {
  test("no `gh pr review --request-changes` anywhere in the playbook", () => {
    assert.doesNotMatch(QA_PLAYBOOK, /gh pr review \$pr_number[^\n]*--request-changes/);
  });

  test("the T1-T3 and T4 FAIL verdict bodies are `gh pr comment`s", () => {
    const step10 = QA_PLAYBOOK.slice(QA_PLAYBOOK.indexOf("### 10. Verdict routing"), QA_PLAYBOOK.indexOf("### 11. Lesson capture"));
    const failSection = step10.slice(step10.indexOf("**Verdict `FAIL` or `FAIL-pending-CI`**"));
    assert.match(failSection, /gh pr comment \$pr_number --repo gaberoo322\/hydra --body "> \*Automated QA — two-axis review\*/);
    assert.match(failSection, /gh pr comment \$pr_number --repo gaberoo322\/hydra --body "> \*Automated QA — T4 Verifier-Core deep review\*/);
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

  test("steps 8–9 fold through the `fold` CLI phase (rules live in the engine, not the playbook)", () => {
    const s8 = QA_PLAYBOOK.slice(QA_PLAYBOOK.indexOf("### 8. Aggregate"), QA_PLAYBOOK.indexOf("### 9.5 "));
    assert.ok(s8.includes("scripts/ci/qa-verdict.ts fold"), "step 9 must call the fold phase");
    assert.ok(s8.includes("--rawfile raw"), "the findings file is bound with --rawfile (malformed reaches the engine as a raw string)");
    assert.ok(s8.includes("try ($raw | fromjson) catch $raw"), "a malformed file must fail closed in the engine, never abort jq");
    assert.ok(s8.includes("aggregateAdversarialReview()"), "T4 keeps the unchanged adversarial AND");
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

  test("QA_ADMISSION_SKIP_MARKER: step 6.6's skip REVIEW_REPORT carries it for humans; CURRENT_REVIEWED comes from GATE_ACTION, not the marker text", () => {
    assert.equal(QA_ADMISSION_SKIP_MARKER, "Review skipped by the admission gate");
    assert.ok(QA_PLAYBOOK.includes(`REVIEW_REPORT="_${QA_ADMISSION_SKIP_MARKER}`), "step 6.6's skip report carries the marker");
    assert.ok(!QA_PLAYBOOK.includes(`*"${QA_ADMISSION_SKIP_MARKER}"*`), "no case pattern greps the marker out of REVIEW_REPORT");
    assert.ok(QA_PLAYBOOK.includes('[ "$GATE_ACTION" = "skip-required-failed" ] && CURRENT_REVIEWED=false'));
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

  test("a 404 on removing an absent label is not a failure; the label name goes in the URL path", () => {
    assert.ok(QA_PLAYBOOK.includes('*404*|*"Label does not exist"*) ;;'));
    assert.ok(QA_PLAYBOOK.includes('gh api -X DELETE "repos/gaberoo322/hydra/issues/$ESC_ISSUE/labels/$l"'));
  });

  test("a failed label call never claims `Labelled`; an unsubstituted issue number fails loud", () => {
    assert.ok(QA_PLAYBOOK.includes('ESC_LABELS_OK=0; echo "[hydra-qa] ERROR: could not add'));
    assert.ok(QA_PLAYBOOK.includes('**Label routing FAILED**'));
    assert.ok(QA_PLAYBOOK.includes("no issue number to escalate"));
  });

  test("labels and escalation text come from the round-action JSON, never spelled in the loop", () => {
    assert.ok(QA_PLAYBOOK.includes("jq -r '.labels.issueAdd[]'"));
    assert.ok(QA_PLAYBOOK.includes("jq -r '.labels.issueRemove[]'"));
    assert.ok(QA_PLAYBOOK.includes("jq -r '.labels.prAdd[]'"));
    assert.ok(QA_PLAYBOOK.includes("jq -r '.escalationSummary'"));
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
    const s7 = QA_PLAYBOOK.slice(QA_PLAYBOOK.indexOf("#### 7.0a"), QA_PLAYBOOK.indexOf("#### 7a."));
    assert.ok(s7.includes("${PRIOR_FINDINGS}"));
    assert.ok(s7.includes('git diff --no-renames "$REREVIEW_DIFF_BASE" HEAD'));
    assert.ok(s7.includes('REVIEW_PACKET="${REVIEW_PACKET}'), "the context is appended; the full diff and changed files stay");
    assert.match(s7, /first state fixed\/not-fixed for each prior finding; for anything new, prefer medium\+ and say why it wasn't visible before/);
  });

  test("T1–T3: the round cap runs before this round's comment, and escalation never re-labels for dev", () => {
    const step9 = QA_PLAYBOOK.slice(QA_PLAYBOOK.indexOf("### 9.6 "), QA_PLAYBOOK.indexOf("### 10. Verdict routing"));
    assert.ok(step9.includes("scripts/ci/qa-verdict.ts round-action"), "the round cap is decided by the round-action call in step 9.6");
    assert.ok(QA_PLAYBOOK.indexOf("### 9.6 ") < QA_PLAYBOOK.indexOf("### 10. Verdict routing"), "round-action reads the PR before any step-10 comment is posted");
    const esc = t13.indexOf('if [ "$ROUND_ACTION" = "escalate" ]; then\n  gh issue comment');
    // Re-anchored by #4766: the second routing branch is now the open-PR
    // bounce arm (step 3's qa_bounce_label helper), replacing the retired
    // GLM_AUTHORED arm — escalate must still be the FIRST branch.
    const bounce = t13.indexOf('elif [ "$BOUNCE_LABEL" = "needs-dev-resume" ]');
    assert.ok(esc > 0 && esc < bounce, "escalate must be the first routing branch");
    const branch = t13.slice(esc, bounce);
    assert.ok(!branch.includes("ready-for-agent"));
    assert.ok(branch.includes("${ESC_LABEL_NOTE}"), "the labelled claim comes from the label calls' outcome");
    assert.ok(!branch.includes("Labelled `ready-for-human`"), "no unconditional labelled claim");
  });

  test("T4 keeps decideDeepQaAction and never runs the T1–T3 round cap", () => {
    assert.ok(t4.includes(".deepQa.action"), "T4 reads the deep-QA action from the round-action JSON");
    assert.ok(!t4.includes("qa-round-cap") && !t4.includes("decideQaRoundAction") && !t4.includes('.round.action'));
  });
});

// ── #4735 simplification: re-review context never reaches the verdict ─────────
// Operator decision (https://github.com/gaberoo322/hydra/issues/4735#issuecomment-5883251393):
// the re-review context is PROMPT ONLY. No code path filters, demotes or narrows
// a finding; step 9 always folds with plain foldReviewFindings.
describe("no demotion path: step 9 always folds with plain foldReviewFindings (issue #4735)", () => {
  test("the playbook makes exactly one fold call, ALWAYS passing the spawned reviewers (#4758)", () => {
    const s9 = QA_PLAYBOOK.slice(QA_PLAYBOOK.indexOf("### 9. Classify"), QA_PLAYBOOK.indexOf("### 9.5 "));
    assert.equal((s9.match(/scripts\/ci\/qa-verdict\.ts fold/g) ?? []).length, 1, "one fold call, no scoped variant");
    assert.ok(s9.includes("spawnedReviewers: ($spawned | split"), "spawnedReviewers is passed unconditionally (empty included)");
    for (const v of ["PRIOR_FINDINGS", "REREVIEW_DIFF_BASE"]) {
      const fold = s9.slice(s9.indexOf("FOLD_JSON=$("), s9.indexOf("rm -f \"$FINDINGS_FILE\""));
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


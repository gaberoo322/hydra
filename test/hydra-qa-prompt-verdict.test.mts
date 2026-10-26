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
    assert.match(playbook, /buildQaVerdictTrailer/);
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

  test("step 6.7 sizes the fan-out via decideReviewerFanout", () => {
    assert.match(playbook, /### 6\.7 [^\n]*change shape/i);
    assert.ok(playbook.includes("decideReviewerFanout("), "playbook must call decideReviewerFanout");
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
    assert.ok(section.includes(".catch("), "6.7 helper call must log a failure cause");
    assert.equal(section.match(/FANOUT_REVIEWERS=/g)?.length, 3, "6.7 must set FANOUT_REVIEWERS on success AND both fallback arms");
    assert.ok(!/^CHANGED=\$\(git diff --name-only/m.test(playbook), "CHANGED lists must use --no-renames");
    assert.ok(playbook.includes("isPromptOnlyChange("), "step 6 must use the shared prompt-path predicate");
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

/** The bash between `# >>> <name>` and `# <<< <name>` in the playbook. */
function playbookBlock(name: string): string {
  const start = QA_PLAYBOOK.indexOf(`# >>> ${name}\n`);
  const end = QA_PLAYBOOK.indexOf(`# <<< ${name}`);
  assert.ok(start >= 0 && end > start, `playbook block ${name} not found`);
  return QA_PLAYBOOK.slice(start, end);
}

/** Run a playbook block in bash from the repo root; returns the named vars. */
function runBlock(
  name: string,
  env: Record<string, string>,
  outVars: string[],
  pathPrefix?: string,
  cwd: string = REPO_ROOT,
  render: (block: string) => string = (b) => b,
): Record<string, string> {
  const script = `${render(playbookBlock(name))}\n${outVars.map((v) => `printf '%s\\0' "$${v}"`).join("\n")}\n`;
  const r = spawnSync("bash", ["-c", script], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env, PATH: pathPrefix ? `${pathPrefix}:${process.env.PATH}` : process.env.PATH },
  });
  assert.equal(r.status, 0, `block ${name} exited ${r.status}: ${r.stderr}`);
  const parts = r.stdout.split("\0");
  return Object.fromEntries(outVars.map((v, i) => [v, parts[i] ?? ""]));
}

/** A PATH dir whose `node` always fails — simulates the render step erroring. */
function brokenNodeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "qa-4746-node-"));
  writeFileSync(join(dir, "node"), "#!/bin/sh\necho 'simulated node failure' >&2\nexit 1\n");
  chmodSync(join(dir, "node"), 0o755);
  return dir;
}

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

describe("hydra-qa step 9.5 trailer block — executed verbatim from the playbook (issue #4746)", () => {
  function priorFile(bodies: string[]): string {
    const f = join(mkdtempSync(join(tmpdir(), "qa-4746-prior-")), "prior.json");
    writeFileSync(f, JSON.stringify(bodies));
    return f;
  }
  // > 128 KiB of prior review history — larger than a single env var may be.
  const bigHistory = [
    ...Array.from({ length: 40 }, (_, i) => `> *Automated QA* review ${i}\n\n${"lorem ipsum ".repeat(500)}`),
    "x\n\nQA-Verdict: FAIL pr=77 round=1 sha=0123456789ab blockers=2 max_severity=high",
    "QA-Verdict: FAIL pr=77 round=2 sha=0123456789ab blockers=1 max_severity=low",
    "QA-Verdict: FAIL pr=78 round=1 sha=0123456789ab blockers=1 max_severity=low",
  ];
  const baseEnv = {
    VERDICT: "FAIL", pr_number: "77", HEAD_SHA: FULL_HEAD, BLOCKERS: "2", MAX_SEVERITY: "medium",
  };

  test("prior bodies travel through a file, not an env var", () => {
    assert.match(playbookBlock("qa-verdict-trailer"), /PRIOR_BODIES_FILE/);
    assert.doesNotMatch(QA_PLAYBOOK, /PRIOR_BODIES_JSON|PRIOR_COMMENTS_JSON=/);
  });

  test("renders the full trailer from a >128 KiB comment history", () => {
    const file = priorFile(bigHistory);
    assert.ok(readFileSync(file).length > 128 * 1024, "fixture must exceed the 128 KiB env limit");
    const { QA_VERDICT_TRAILER } = runBlock("qa-verdict-trailer", { ...baseEnv, PRIOR_BODIES_FILE: file }, ["QA_VERDICT_TRAILER"]);
    assert.equal(QA_VERDICT_TRAILER, "QA-Verdict: FAIL pr=77 round=3 sha=0123456789ab blockers=2 max_severity=medium");
  });

  test("render failure → minimal shell-built trailer that still parses (same round)", () => {
    const { QA_VERDICT_TRAILER } = runBlock(
      "qa-verdict-trailer", { ...baseEnv, PRIOR_BODIES_FILE: priorFile(bigHistory) }, ["QA_VERDICT_TRAILER"], brokenNodeDir(),
    );
    assert.deepEqual(parseQaVerdictTrailer(QA_VERDICT_TRAILER), {
      verdict: "FAIL", pr: 77, round: 3, sha: "0123456789ab", blockers: 2, maxSeverity: "medium",
    });
  });

  test("render failure with an empty head SHA → minimal trailer carries sha=unknown", () => {
    const { QA_VERDICT_TRAILER } = runBlock(
      "qa-verdict-trailer", { ...baseEnv, HEAD_SHA: "", PRIOR_BODIES_FILE: priorFile([]) }, ["QA_VERDICT_TRAILER"], brokenNodeDir(),
    );
    const t = parseQaVerdictTrailer(QA_VERDICT_TRAILER);
    assert.equal(t?.sha, QA_VERDICT_UNKNOWN_SHA);
    assert.equal(t?.round, 1);
  });

  test("full AND minimal render fail → explicit QA-Verdict-Error line, never trailer-less", () => {
    const { QA_VERDICT_TRAILER } = runBlock(
      "qa-verdict-trailer", { ...baseEnv, VERDICT: "BOGUS VERDICT", PRIOR_BODIES_FILE: priorFile([]) }, ["QA_VERDICT_TRAILER"], brokenNodeDir(),
    );
    assert.ok(QA_VERDICT_TRAILER.startsWith(QA_VERDICT_ERROR_PREFIX), QA_VERDICT_TRAILER);
    assert.deepEqual(parseQaVerdictErrors(QA_VERDICT_TRAILER), [
      { verdict: null, pr: 77, reason: "trailer render failed (full and minimal)" },
    ]);
  });
});

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

  test("the playbook's RED_REQUIRED_LIST + skip-path BLOCKERS derive from redRequiredChecks (no divergent jq filter)", () => {
    assert.match(playbookBlock("red-required-checks"), /redRequiredChecks/);
    assert.doesNotMatch(QA_PLAYBOOK, /IN\("failure"/, "no hand-rolled conclusion filter may remain");
    assert.match(QA_PLAYBOOK, /BLOCKERS=\$\(printf '%s' "\$RED_REQUIRED_JSON" \| jq 'length'/);
    assert.match(QA_PLAYBOOK, /WORST_FINDING="required CI check\(s\) red: \$\{RED_REQUIRED_LIST/);
  });

  test("executed block: RED_REQUIRED_LIST names the red checks (the pre-#4746 list was always empty)", () => {
    for (const c of CASES) {
      const out = runBlock("red-required-checks", { CHECKS_JSON: JSON.stringify(c.checks) }, ["RED_REQUIRED_LIST", "RED_REQUIRED_JSON"]);
      assert.equal(out.RED_REQUIRED_LIST, c.red.join(", "), c.name);
      assert.equal(JSON.parse(out.RED_REQUIRED_JSON as string).length, c.red.length, c.name);
    }
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

  test("steps 8–9 fold via foldReviewFindings and render via renderReviewReport; CI via renderCiSummary", () => {
    const s8 = QA_PLAYBOOK.slice(QA_PLAYBOOK.indexOf("### 8. Aggregate"), QA_PLAYBOOK.indexOf("### 9.5 "));
    assert.ok(s8.includes("foldReviewFindings("), "step 8/9 must call foldReviewFindings");
    assert.ok(s8.includes("renderReviewReport("), "step 8 must render the findings table");
    assert.ok(s8.includes("trailerBlockerCounts("), "trailer counts must come from the table");
    assert.ok(s8.includes("renderCiSummary("), "the CI line must list only non-green required checks");
    assert.ok(s8.includes("aggregateAdversarialReview("), "T4 keeps the unchanged adversarial AND");
    assert.doesNotMatch(QA_PLAYBOOK, /renderChecksBlock\(r\)/, "verdict comments no longer repeat the full CI table");
  });

  // Step 9 always folds the step-8 per-reviewer map (issue #4758), so the
  // executed block is fed one named reviewer and its rows under that key.
  function findingsFile(rows: unknown): string {
    const f = join(mkdtempSync(join(tmpdir(), "qa-4734-findings-")), "findings.json");
    writeFileSync(f, JSON.stringify({ "reviewer-A-standards": rows }));
    return f;
  }
  const OUT = ["REVIEW_VERDICT", "REVIEW_REPORT", "BLOCKERS", "MAX_SEVERITY", "WORST_FINDING"];
  const env = {
    STANDARDS_SUMMARY: "std",
    SPEC_SUMMARY: "spec",
    FANOUT_REASON: "fan",
    RED_REQUIRED_JSON: "[]",
    FANOUT_REVIEWERS: "reviewer-A-standards",
  };

  test("executed fold block: T3 lone low → PASS with a follow-up, blockers=0", () => {
    const out = runBlock("severity-fold", { ...env, PR_TIER_NUM: "3", FINDINGS_FILE: findingsFile([finding({})]) }, OUT);
    assert.equal(out.REVIEW_VERDICT, "PASS");
    assert.equal(out.BLOCKERS, "0");
    assert.equal(out.MAX_SEVERITY, "none");
    assert.match(out.REVIEW_REPORT as string, /### Follow-ups \(non-blocking\)/);
  });

  test("executed fold block: T3 medium + a red required check → FAIL, blockers from the table + CI", () => {
    const out = runBlock(
      "severity-fold",
      { ...env, PR_TIER_NUM: "3", RED_REQUIRED_JSON: '["test"]', FINDINGS_FILE: findingsFile([finding({ severity: "medium" })]) },
      OUT,
    );
    assert.equal(out.REVIEW_VERDICT, "FAIL");
    assert.equal(out.BLOCKERS, "2");
    assert.equal(out.MAX_SEVERITY, "high");
    assert.ok((out.WORST_FINDING as string).startsWith("src/x.ts:10 — "));
  });

  test("executed fold block: T4 lone low still FAILs (unchanged any-blocker)", () => {
    const out = runBlock("severity-fold", { ...env, PR_TIER_NUM: "4", FINDINGS_FILE: findingsFile([finding({})]) }, OUT);
    assert.equal(out.REVIEW_VERDICT, "FAIL");
    assert.equal(out.MAX_SEVERITY, "low");
  });

  test("executed fold block: a fold failure fails closed to FAIL, never PASS", () => {
    const out = runBlock(
      "severity-fold",
      { ...env, PR_TIER_NUM: "3", FINDINGS_FILE: findingsFile([]) },
      OUT,
      brokenNodeDir(),
    );
    assert.equal(out.REVIEW_VERDICT, "FAIL");
    assert.equal(out.MAX_SEVERITY, "high");
  });

  // PR #4752 QA r1: the executed block must fail CLOSED on a bad findings file.
  function rawFile(text: string): string {
    const f = join(mkdtempSync(join(tmpdir(), "qa-4734-raw-")), "findings.json");
    writeFileSync(f, text);
    return f;
  }
  const BAD_FILES: Array<{ name: string; path: () => string }> = [
    { name: "missing file", path: () => join(mkdtempSync(join(tmpdir(), "qa-4734-missing-")), "never-written.json") },
    { name: "empty file", path: () => rawFile("") },
    { name: "unparseable file", path: () => rawFile("looks fine to me") },
    { name: "object wrapper", path: () => rawFile(JSON.stringify({ findings: [{ severity: "high" }] })) },
    { name: "string row", path: () => rawFile(JSON.stringify(["high: gate bypassed"])) },
  ];
  for (const tier of ["1", "3", "4"]) {
    for (const bad of BAD_FILES) {
      test(`executed fold block: T${tier} ${bad.name} → FAIL, blockers>=1, max_severity=high`, () => {
        const out = runBlock("severity-fold", { ...env, PR_TIER_NUM: tier, FINDINGS_FILE: bad.path() }, OUT);
        assert.equal(out.REVIEW_VERDICT, "FAIL");
        assert.ok(Number(out.BLOCKERS) >= 1, `BLOCKERS=${out.BLOCKERS}`);
        assert.equal(out.MAX_SEVERITY, "high");
      });
    }
  }

  test("executed fold block: an explicit [] from the spawned reviewer is a PASS", () => {
    const out = runBlock("severity-fold", { ...env, PR_TIER_NUM: "4", FINDINGS_FILE: rawFile('{"reviewer-A-standards":[]}') }, OUT);
    assert.equal(out.REVIEW_VERDICT, "PASS");
    assert.equal(out.BLOCKERS, "0");
  });

  test("the playbook has no `|| '[]'` findings default and no dead REVIEWER_A/B_VERDICT cross-check", () => {
    assert.doesNotMatch(playbookBlock("severity-fold"), /\|\| '\[\]'\);/);
    assert.doesNotMatch(QA_PLAYBOOK, /process\.env\.REVIEWER_A_VERDICT/);
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

  test("QA_ADMISSION_SKIP_MARKER: step 6.6's REVIEW_REPORT and step 10's case pattern both contain it (INV-10)", () => {
    assert.equal(QA_ADMISSION_SKIP_MARKER, "Review skipped by the admission gate");
    assert.ok(QA_PLAYBOOK.includes(`REVIEW_REPORT="_${QA_ADMISSION_SKIP_MARKER}`), "step 6.6's skip report carries the marker");
    assert.ok(QA_PLAYBOOK.includes(`*"${QA_ADMISSION_SKIP_MARKER}"*`), "step 10's CURRENT_REVIEWED case pattern carries the marker");
  });

  test("QA_FINDINGS_HEADING: the fold-failure fallback and priorFindingsSection key on the same heading", () => {
    assert.equal(QA_FINDINGS_HEADING, "### Findings");
    assert.ok(QA_PLAYBOOK.includes(`REVIEW_REPORT="${QA_FINDINGS_HEADING}`), "the fold-failure fallback report starts with the heading");
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

describe("hydra-qa step 9 severity-fold block — per-reviewer map executed verbatim (issue #4758)", () => {
  const OUT = ["REVIEW_VERDICT", "REVIEW_REPORT", "BLOCKERS", "MAX_SEVERITY"];
  const env = { STANDARDS_SUMMARY: "std", SPEC_SUMMARY: "spec", FANOUT_REASON: "fan", RED_REQUIRED_JSON: "[]" };
  function findingsFile(rows: unknown): string {
    const f = join(mkdtempSync(join(tmpdir(), "qa-4758-fold-")), "findings.json");
    writeFileSync(f, JSON.stringify(rows));
    return f;
  }
  const FANOUT = { FANOUT_REVIEWERS: "reviewer-A-standards,reviewer-B-spec" };
  const mrow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    severity: "low", axis: "standards", location: "src/x.ts:10", finding: "nit", fix: "fix", ...over,
  });

  test("FANOUT_REVIEWERS set + per-reviewer map with every entry → the lone lows PASS at T3", () => {
    const out = runBlock(
      "severity-fold",
      {
        ...env,
        ...FANOUT,
        PR_TIER_NUM: "3",
        FINDINGS_FILE: findingsFile({ "reviewer-A-standards": [], "reviewer-B-spec": [mrow({})] }),
      },
      OUT,
    );
    assert.equal(out.REVIEW_VERDICT, "PASS");
    assert.equal(out.BLOCKERS, "0");
  });

  test("FANOUT_REVIEWERS set + a reviewer omitted from the map → FAIL naming the reviewer", () => {
    const out = runBlock(
      "severity-fold",
      { ...env, ...FANOUT, PR_TIER_NUM: "3", FINDINGS_FILE: findingsFile({ "reviewer-A-standards": [mrow({})] }) },
      OUT,
    );
    assert.equal(out.REVIEW_VERDICT, "FAIL");
    assert.equal(out.MAX_SEVERITY, "high");
    assert.match(out.REVIEW_REPORT as string, /reviewer-B-spec/);
    assert.match(out.REVIEW_REPORT as string, new RegExp(MALFORMED_FINDING_ID));
  });

  test("FANOUT_REVIEWERS set but the file holds a flat array → FAIL (the map shape is checked)", () => {
    const out = runBlock("severity-fold", { ...env, ...FANOUT, PR_TIER_NUM: "3", FINDINGS_FILE: findingsFile([mrow({})]) }, OUT);
    assert.equal(out.REVIEW_VERDICT, "FAIL");
    assert.match(out.REVIEW_REPORT as string, /per-reviewer map/);
  });

  // PR #4775 QA r1/r2: an empty or unset FANOUT_REVIEWERS must NOT revert to the
  // flat-array fold, where a flat [] (or flat lows) would PASS.
  for (const tier of ["3", "4"]) {
    for (const fanout of [{ FANOUT_REVIEWERS: "" }, {}] as Array<Record<string, string>>) {
      const label = "FANOUT_REVIEWERS" in fanout ? "empty" : "unset";
      test(`FANOUT_REVIEWERS ${label} + flat [] → FAIL at T${tier}, never the flat-array PASS`, () => {
        const out = runBlock("severity-fold", { ...env, ...fanout, PR_TIER_NUM: tier, FINDINGS_FILE: findingsFile([]) }, OUT);
        assert.equal(out.REVIEW_VERDICT, "FAIL");
        assert.equal(out.MAX_SEVERITY, "high");
        assert.match(out.REVIEW_REPORT as string, new RegExp(MALFORMED_FINDING_ID));
      });
      test(`FANOUT_REVIEWERS ${label} + flat low array → FAIL at T${tier}`, () => {
        const out = runBlock(
          "severity-fold",
          { ...env, ...fanout, PR_TIER_NUM: tier, FINDINGS_FILE: findingsFile([mrow({ reviewer: "reviewer-A-standards" })]) },
          OUT,
        );
        assert.equal(out.REVIEW_VERDICT, "FAIL");
        assert.equal(out.MAX_SEVERITY, "high");
      });
    }
  }
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

// ── #4735 playbook wiring: the blocks run verbatim against a fake `gh` ──────

/**
 * A PATH dir with a fake `gh`: `pr view` prints $FAKE_GH_BODIES (or fails),
 * `api` succeeds unless $FAKE_GH_API_FAIL is set (404 or 500), every call is logged.
 */
function fakeGhDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "qa-4735-gh-"));
  writeFileSync(
    join(dir, "gh"),
    [
      "#!/bin/sh",
      'printf \'%s\\n\' "$*" >> "$FAKE_GH_LOG"',
      'case "$1" in',
      '  pr) [ "$FAKE_GH_FAIL" = 1 ] && exit 1; cat "$FAKE_GH_BODIES" ;;',
      '  api) case "$FAKE_GH_API_FAIL" in',
      '         404) case "$*" in *DELETE*) echo "gh: Label does not exist (HTTP 404)" >&2; exit 1 ;; esac ;;',
      '         500) echo "gh: Server Error (HTTP 500)" >&2; exit 1 ;;',
      "       esac ;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(join(dir, "gh"), 0o755);
  return dir;
}

function ghFixture(bodies: string[]): { FAKE_GH_BODIES: string; FAKE_GH_LOG: string } {
  const dir = mkdtempSync(join(tmpdir(), "qa-4735-fx-"));
  writeFileSync(join(dir, "bodies.json"), JSON.stringify(bodies));
  writeFileSync(join(dir, "gh.log"), "");
  return { FAKE_GH_BODIES: join(dir, "bodies.json"), FAKE_GH_LOG: join(dir, "gh.log") };
}

/** A throwaway repo: c1 → c2 (adds src/changed.ts), plus an orphan commit that is no ancestor of HEAD. */
function scratchRepo(): { dir: string; c1: string; c2: string; orphan: string } {
  const dir = mkdtempSync(join(tmpdir(), "qa-4735-repo-"));
  const git = (...args: string[]): string => {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git("init", "-q");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "c1");
  const c1 = git("rev-parse", "HEAD");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "changed.ts"), "export const x = 1;\n");
  git("add", "src/changed.ts");
  git("commit", "-q", "-m", "c2");
  const c2 = git("rev-parse", "HEAD");
  const orphan = git("commit-tree", git("rev-parse", "HEAD^{tree}"), "-m", "orphan");
  // The blocks import ./scripts/ci/qa-verdict.ts relative to cwd.
  symlinkSync(join(REPO_ROOT, "scripts"), join(dir, "scripts"));
  return { dir, c1, c2, orphan };
}

/** The Skill loader's argument substitution: the bare `$issue_number` token becomes the number. */
const skillRender = (issue: number) => (block: string): string => block.split("$issue_number").join(String(issue));

describe("hydra-qa step 7.0a re-review context block — executed verbatim (issue #4735)", () => {
  const repo = scratchRepo();
  const gh = fakeGhDir();
  const TABLE = findingsSection(["| medium | standards | reviewer-A-standards | src/changed.ts:1 | bug | fix |"]);
  const prior = (sha: string, verdict: FinalVerdict = "FAIL") => [verdictBody(1, verdict, sha, 1, "medium", TABLE)];
  const OUT = ["PRIOR_FINDINGS", "REREVIEW_DIFF_BASE"];
  const run = (bodies: string[], over: Record<string, string> = {}, extraPath = "") =>
    runBlock(
      "rereview-context",
      { pr_number: "7", PR_TIER_NUM: "3", PRIOR_QA_FILE: join(mkdtempSync(join(tmpdir(), "qa-4735-p-")), "p.json"), ...ghFixture(bodies), ...over },
      OUT,
      `${extraPath}${gh}`,
      repo.dir,
    );

  test("prior FAIL at an ancestor with new commits → prior table + incremental diff base as context", () => {
    const out = run(prior(repo.c1));
    assert.equal(out.REREVIEW_DIFF_BASE, repo.c1.slice(0, 12));
    assert.ok((out.PRIOR_FINDINGS as string).startsWith("### Findings"));
  });

  // The prior table is still useful context when only the diff base is unusable.
  const TABLE_ONLY: Array<{ name: string; bodies: () => string[] }> = [
    { name: "prior sha=unknown", bodies: () => prior("") },
    { name: "prior sha not in the repo (force-pushed away)", bodies: () => prior("0123456789ab") },
    { name: "prior sha not an ancestor of HEAD (rebase)", bodies: () => prior(repo.orphan) },
    { name: "prior verdict at HEAD (no new commits)", bodies: () => prior(repo.c2) },
  ];
  for (const c of TABLE_ONLY) {
    test(`${c.name} → prior table as context, the incremental diff omitted`, () => {
      const out = run(c.bodies());
      assert.equal(out.REREVIEW_DIFF_BASE, "");
      assert.ok((out.PRIOR_FINDINGS as string).startsWith("### Findings"));
    });
  }

  const NONE: Array<{ name: string; bodies: () => string[]; over?: Record<string, string>; broken?: boolean }> = [
    { name: "no prior verdict", bodies: () => [] },
    { name: "prior verdict was a PASS", bodies: () => prior(repo.c1, "PASS-pending-CI") },
    { name: "prior round had no findings table (CI-only)", bodies: () => [ciOnlyBody(1, repo.c1)] },
    { name: "T4", bodies: () => prior(repo.c1), over: { PR_TIER_NUM: "4" } },
    { name: "unknown tier", bodies: () => prior(repo.c1), over: { PR_TIER_NUM: "" } },
    { name: "gh read fails", bodies: () => prior(repo.c1), over: { FAKE_GH_FAIL: "1" } },
    { name: "node fails", bodies: () => prior(repo.c1), broken: true },
  ];
  for (const c of NONE) {
    test(`${c.name} → no re-review context (a plain first-pass review)`, () => {
      const out = run(c.bodies(), c.over, c.broken ? `${brokenNodeDir()}:` : "");
      assert.equal(out.REREVIEW_DIFF_BASE, "");
      assert.equal(out.PRIOR_FINDINGS, "");
    });
  }
});

describe("hydra-qa step 10 round-cap block — executed as the Skill loader renders it (issue #4735)", () => {
  const gh = fakeGhDir();
  const current = renderQaVerdictTrailer({ verdict: "FAIL", pr: 7, round: 3, sha: SHA_C, blockers: 1, maxSeverity: "medium" });
  const OUT = ["ROUND_ACTION", "QA_ESCALATION_SUMMARY", "ESC_LABELS_OK", "ESC_LABEL_NOTE"];
  // No `issue_number` in the env: the Skill loader substitutes the bare token and never sets a shell var.
  const setup = (bodies: string[], over: Record<string, string> = {}) => {
    const fx = ghFixture(bodies);
    const env = {
      pr_number: "7",
      PR_TIER_NUM: "3",
      VERDICT: "FAIL",
      QA_VERDICT_TRAILER: current,
      REVIEW_REPORT: "### Findings\n\n| medium | ... |",
      ROUND_PRIOR_FILE: join(mkdtempSync(join(tmpdir(), "qa-4735-r-")), "r.json"),
      ...fx,
      ...over,
    };
    return { fx, env };
  };
  const run = (env: Record<string, string>, extraPath = "") => runBlock("qa-round-cap", env, OUT, `${extraPath}${gh}`, REPO_ROOT, skillRender(70));
  const twoFails = [verdictBody(1, "FAIL", SHA_A, 3, "high"), verdictBody(2, "FAIL", SHA_B, 2, "medium")];

  test("the playbook never uses the braced ${issue_number} form (the loader only substitutes the bare token)", () => {
    assert.ok(!QA_PLAYBOOK.includes("${issue_number}"), "found ${issue_number} in hydra-qa.md");
    assert.ok(!("issue_number" in process.env), "the regression test must not get issue_number from the env");
  });

  test("3rd FAIL → escalate: ready-for-human on issue 70 AND the PR, every dev-lane label removed from issue 70", () => {
    const { fx, env } = setup(twoFails);
    const out = run(env);
    assert.equal(out.ROUND_ACTION, "escalate");
    assert.equal(out.ESC_LABELS_OK, "1");
    assert.match(out.ESC_LABEL_NOTE as string, /Labelled `ready-for-human`/);
    assert.match(out.QA_ESCALATION_SUMMARY as string, /\| 3 \| FAIL \| cccccccccccc \| 1 \| medium \|/);
    assert.match(out.QA_ESCALATION_SUMMARY as string, /Recommendation: accept with follow-ups/);
    const log = readFileSync(fx.FAKE_GH_LOG, "utf8");
    assert.doesNotMatch(log, /issues\/\/labels/);
    assert.match(log, /api -X POST repos\/gaberoo322\/hydra\/issues\/70\/labels -f labels\[\]=ready-for-human/);
    assert.match(log, /api -X POST repos\/gaberoo322\/hydra\/issues\/7\/labels -f labels\[\]=ready-for-human/);
    for (const l of ["needs-qa", "ready-for-agent", "needs-dev-resume", "in-progress"]) {
      assert.match(log, new RegExp(`api -X DELETE repos/gaberoo322/hydra/issues/70/labels/${l}\\n`));
    }
    assert.doesNotMatch(log, /labels\[\]=(ready-for-agent|needs-dev-resume)/);
  });

  test("a 404 on removing an absent label is not a failure", () => {
    const { env } = setup(twoFails, { FAKE_GH_API_FAIL: "404" });
    const out = run(env);
    assert.equal(out.ROUND_ACTION, "escalate");
    assert.equal(out.ESC_LABELS_OK, "1");
  });

  test("a failed label call → the escalation note says so and never claims `Labelled`", () => {
    const { env } = setup(twoFails, { FAKE_GH_API_FAIL: "500" });
    const out = run(env);
    assert.equal(out.ROUND_ACTION, "escalate");
    assert.equal(out.ESC_LABELS_OK, "0");
    assert.doesNotMatch(out.ESC_LABEL_NOTE as string, /^Labelled/);
    assert.match(out.ESC_LABEL_NOTE as string, /FAILED/);
  });

  test("an unsubstituted issue number (loader skipped) fails loud instead of calling issues//labels", () => {
    const { fx, env } = setup(twoFails);
    const out = runBlock("qa-round-cap", env, OUT, gh, REPO_ROOT);
    assert.equal(out.ESC_LABELS_OK, "0");
    assert.doesNotMatch(readFileSync(fx.FAKE_GH_LOG, "utf8"), /issues\/\/labels/);
  });

  test("a CI-only current round (admission-gate skip) never escalates", () => {
    const { env } = setup(twoFails, { REVIEW_REPORT: "_Review skipped by the admission gate (issue #3815): a required CI check already failed._" });
    assert.equal(run(env).ROUND_ACTION, "bounce");
  });

  const BOUNCE: Array<{ name: string; bodies: string[]; over?: Record<string, string>; broken?: boolean }> = [
    { name: "2nd FAIL", bodies: [twoFails[0] as string] },
    { name: "gh read fails (pre-#4735 behaviour)", bodies: twoFails, over: { FAKE_GH_FAIL: "1" } },
    { name: "node fails (pre-#4735 behaviour)", bodies: twoFails, broken: true },
  ];
  for (const c of BOUNCE) {
    test(`${c.name} → bounce, no label writes`, () => {
      const { fx, env } = setup(c.bodies, c.over);
      const out = run(env, c.broken ? `${brokenNodeDir()}:` : "");
      assert.equal(out.ROUND_ACTION, "bounce");
      assert.equal(out.QA_ESCALATION_SUMMARY, "");
      assert.doesNotMatch(readFileSync(fx.FAKE_GH_LOG, "utf8"), /^api /m);
    });
  }
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
    assert.ok(t13.indexOf("# >>> qa-round-cap") < t13.indexOf("gh pr comment $pr_number"), "round cap must read the PR before this round is posted");
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
    assert.ok(t4.includes("decideDeepQaAction("));
    assert.ok(!t4.includes("qa-round-cap") && !t4.includes("decideQaRoundAction"));
  });
});

// ── #4735 simplification: re-review context never reaches the verdict ─────────
// Operator decision (https://github.com/gaberoo322/hydra/issues/4735#issuecomment-5883251393):
// the re-review context is PROMPT ONLY. No code path filters, demotes or narrows
// a finding; step 9 always folds with plain foldReviewFindings.
describe("no demotion path: step 9 always folds with plain foldReviewFindings (issue #4735)", () => {
  const OUT = ["REVIEW_VERDICT", "REVIEW_REPORT", "BLOCKERS", "MAX_SEVERITY"];
  const env = { STANDARDS_SUMMARY: "std", SPEC_SUMMARY: "spec", FANOUT_REASON: "fan", RED_REQUIRED_JSON: "[]" };
  function findingsFile(rows: unknown): string {
    const f = join(mkdtempSync(join(tmpdir(), "qa-4735-nodemote-")), "findings.json");
    writeFileSync(f, JSON.stringify({ "reviewer-A-standards": rows }));
    return f;
  }

  test("the severity-fold block calls exactly one fold, ALWAYS passing the spawned reviewers (#4758)", () => {
    const block = playbookBlock("severity-fold");
    assert.ok(
      block.includes("q.foldReviewFindings({ tier, findings, spawnedReviewers: spawned })"),
      "the fold call must pass spawnedReviewers unconditionally (empty included)",
    );
    assert.ok(!block.includes("spawned.length > 0"), "no conditional spread may revert an empty fan-out to the flat-array fold");
    assert.ok(block.includes('SPAWNED_REVIEWERS="$FANOUT_REVIEWERS"'), "the block must feed $FANOUT_REVIEWERS in");
    assert.equal((block.match(/q\.fold\w*\(/g) ?? []).length, 1, "one fold call, no scoped variant");
    for (const v of ["PRIOR_FINDINGS", "REREVIEW_DIFF_BASE", "scope", "prior"]) {
      assert.ok(!block.includes(v), `the fold must not read re-review context (${v})`);
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

  test("executed fold with re-review context set: a new medium in an unchanged file still FAILs at T3", () => {
    const out = runBlock(
      "severity-fold",
      {
        ...env,
        FANOUT_REVIEWERS: "reviewer-A-standards",
        PR_TIER_NUM: "3",
        PRIOR_FINDINGS: findingsSection(["| medium | standards | reviewer-A-standards | src/changed.ts:1 | bug | fix |"]),
        REREVIEW_DIFF_BASE: "aaaaaaaaaaaa",
        FINDINGS_FILE: findingsFile([finding({ severity: "medium", location: "src/never-touched.ts:5", finding: "new bug, no why-new" })]),
      },
      OUT,
    );
    assert.equal(out.REVIEW_VERDICT, "FAIL");
    assert.equal(out.MAX_SEVERITY, "medium");
    assert.equal(out.BLOCKERS, "1");
  });

  test("a failed fold keeps a ### Findings heading, so the round counts toward the cap", () => {
    const out = runBlock("severity-fold", { ...env, PR_TIER_NUM: "3", FINDINGS_FILE: findingsFile([]) }, OUT, `${brokenNodeDir()}:`);
    assert.equal(out.REVIEW_VERDICT, "FAIL");
    assert.ok((out.REVIEW_REPORT as string).startsWith("### Findings"), String(out.REVIEW_REPORT));
  });

  test("decideQaRoundAction counts a fold-failed FAIL round as a reviewed round", () => {
    const foldFailed = (round: number, sha: string) =>
      verdictBody(round, "FAIL", sha, 1, "high", "### Findings\n\n_Findings fold failed; raw reviewer reports follow._");
    const d = decideQaRoundAction({ tier: 3, verdict: "FAIL", pr: 7, priorBodies: [foldFailed(1, SHA_A), foldFailed(2, SHA_B)], currentReviewed: true });
    assert.equal(d.action, "escalate");
    assert.equal(d.failRound, QA_FAIL_ROUND_CAP);
  });
});


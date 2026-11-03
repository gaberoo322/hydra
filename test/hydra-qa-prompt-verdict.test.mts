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

describe("hydra-qa emits the QA-Verdict trailer on every verdict post (issue #4729; route.ts owns the posts since #5269)", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const playbook = readFileSync(join(root, "docs", "operator-playbooks", "hydra-qa.md"), "utf8");
  const route = readFileSync(join(root, "scripts", "qa", "route.ts"), "utf8");

  test("the playbook routes every verdict through route.ts; the trailer comes from the engine's trailer phase", () => {
    assert.match(playbook, /scripts\/qa\/route\.ts/);
    assert.match(playbook, /Every verdict body ends with exactly one `QA-Verdict:` trailer line/);
    assert.match(route, /callPhase\(phase, "trailer"/, "the trailer is rendered by the engine, never hand-built in the script");
    assert.doesNotMatch(route, /QA-Verdict: (?:PASS|FAIL)/, "route.ts spells no trailer literal");
  });

  test("every verdict body route.ts posts (PR and issue side, T1-T4) ends with its trailer", () => {
    // Behaviour (exactly one trailer, last line) is pinned arm by arm in
    // test/qa-plumbing-scripts.test.mts "golden: ..."; this is the structural pin:
    // the three PR-side verdict bodies share verdictBody() and every other verdict
    // template ends with the trailer.
    assert.equal((route.match(/verdictBody\(/g) ?? []).length, 3, "PASS, T1-T3 FAIL, T4 FAIL share the one body builder");
    assert.equal((route.match(/\\n\\n\$\{trailer\}`/g) ?? []).length, 8, "pending-CI, escalated, GLM, open-PR, not-open, T4 blocked, T4 bounce + the verdictBody helper");
    assert.doesNotMatch(route, /\$\{trailer\}[^`]/, "the trailer is always the last thing in a template");
  });

  test("issue-side comments are short pointers: they never carry the review report", () => {
    const issueCalls = [...route.matchAll(/issueComment\(([\s\S]*?)\n\s*\);?\n/g)].map((m) => m[1] as string);
    assert.ok(issueCalls.length >= 5, "the issue-side pointer templates are found");
    for (const t of issueCalls) assert.ok(!t.includes("reviewReport"), "the full review must live only on the PR");
  });

  test("fail-closed: an empty trailer, an action-less round-action or a fold without its fields is a pre-verdict exit", () => {
    assert.match(route, /trailer === null \|\| trailer === ""/);
    assert.match(route, /typeof roundObj\.action !== "string"/);
    assert.match(route, /rv === null \|\| rep === null \|\| ci === null/, "required fold fields are checked, never the literal null");
    assert.match(route, /exitCode: 1, result: null, reason/);
    assert.doesNotMatch(route, /printf 'QA-Verdict-Error/);
  });

  test("the skip-required-failed path reviews nothing: nominal PASS review, maxSeverity high, currentReviewed false", () => {
    assert.match(route, /currentReviewed: !skipPath/);
    assert.match(route, /maxSeverity = "high"/);
    assert.match(route, /reviewVerdict = "PASS"/);
    assert.match(playbook, /\*\*\`skip-required-failed\`\*\* \(T1\/T2\/T3 only/);
  });
});

// ── Change-shape reviewer sizing (issue #4733) ─────────────────────────────

describe("hydra-qa — spawn step branches on change shape (issue #4733; sized by preflight since #5269)", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const playbook = readFileSync(join(root, "docs", "operator-playbooks", "hydra-qa.md"), "utf8");
  const preflight = readFileSync(join(root, "scripts", "qa", "preflight.ts"), "utf8");

  test("preflight sizes the fan-out via the engine's fanout phase", () => {
    assert.match(preflight, /phase\("fanout"/);
    assert.match(playbook, /\.fanout\.\{mode,reviewers,reason\}/);
  });

  test("step 7 has a single-reviewer branch; T4 and code PRs keep the full fan-out", () => {
    assert.match(playbook, /#### 7c\. [^\n]*single reviewer/i);
    assert.ok(
      playbook.includes("A T4 PR or a `code` PR always gets the full fan-out"),
      "playbook must pin the T4/code full-fan-out rule",
    );
  });

  test("fan-out fallback keeps the tier path; diffs use --no-renames; the prompt-only predicate is the engine's", () => {
    assert.ok(preflight.includes("change-shape sizing unavailable, kept the tier path"), "a failed sizing call must fall to the tier fan-out");
    assert.equal((preflight.match(/"reviewer-A-standards", "reviewer-A-spec", "reviewer-B-standards", "reviewer-B-spec"/g) ?? []).length, 1);
    assert.ok(preflight.includes('"--no-renames", "--name-only"'), "CHANGED lists must use --no-renames");
    assert.ok(preflight.includes("adm?.promptOnly === true"), "the Tier-1 bypass uses the engine's shared prompt-path predicate (admission .promptOnly)");
    assert.ok(!playbook.includes(".claude/skills/*|config/*|docs/operator-playbooks/*"), "the old step-6 case list must be gone");
  });

  test("step 7.5 completeness check covers the one-reviewer fan-out", () => {
    const start = playbook.indexOf("### 7.5 ");
    const end = playbook.indexOf("### 8. ", start);
    assert.ok(start > 0 && end > start, "step 7.5 section must exist");
    const section = playbook.slice(start, end);
    assert.ok(section.includes("reviewer-single"), "7.5 must name the single-reviewer spawn");
    assert.ok(section.includes(".fanout.reviewers"), "7.5 must check against the decided reviewer list");
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

  test("route's red-required list + skip-path blockers derive from the admission call's redRequired (no divergent filter)", () => {
    const route = readFileSync(join(REPO_ROOT, "scripts", "qa", "route.ts"), "utf8");
    const preflight = readFileSync(join(REPO_ROOT, "scripts", "qa", "preflight.ts"), "utf8");
    assert.match(preflight, /adm && Array\.isArray\(adm\.redRequired\)/, "preflight reads the engine's redRequired");
    assert.match(route, /const redList = pre\.gate\.redRequired\.join\(", "\)/);
    assert.doesNotMatch(route + preflight + QA_PLAYBOOK, /IN\("failure"/, "no hand-rolled conclusion filter may remain");
    assert.match(route, /blockers = Math\.max\(pre\.gate\.redRequired\.length, 1\)/);
    assert.match(route, /worstFinding = `required CI check\(s\) red: \$\{redList/);
  });
});

describe("hydra-qa FAIL path posts a comment, never a request-changes review (issue #4746)", () => {
  test("no `gh pr review --request-changes` anywhere in the playbook", () => {
    assert.doesNotMatch(QA_PLAYBOOK, /gh pr review \$pr_number[^\n]*--request-changes/);
  });

  test("the T1-T3 and T4 FAIL verdict bodies are PR comments (route.ts never spells a review verb)", () => {
    const route = readFileSync(join(REPO_ROOT, "scripts", "qa", "route.ts"), "utf8");
    assert.doesNotMatch(route, /"pr",\s*"review"/);
    assert.match(route, /"Automated QA — two-axis review"/);
    assert.match(route, /"Automated QA — T4 Verifier-Core deep review"/);
    assert.match(route, /prComment\(\s*verdictBody\(/);
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

  test("route folds through the engine's `fold` phase, once (rules live in the engine, not the playbook)", () => {
    const route = readFileSync(join(REPO_ROOT, "scripts", "qa", "route.ts"), "utf8");
    assert.equal((route.match(/callPhase\(phase, "fold"/g) ?? []).length, 1, "one fold call");
    assert.match(route, /findings = JSON\.parse\(opts\.findingsText\)/);
    assert.match(route, /a malformed findings file travels RAW so the engine fails closed/, "a malformed file reaches the engine as a raw string");
    assert.ok(QA_PLAYBOOK.includes("aggregateAdversarialReview()"), "T4 keeps the unchanged adversarial AND");
    assert.doesNotMatch(QA_PLAYBOOK, /renderChecksBlock\(r\)/, "verdict comments no longer repeat the full CI table");
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
    const route = readFileSync(join(REPO_ROOT, "scripts", "qa", "route.ts"), "utf8");
    assert.equal(QA_ADMISSION_SKIP_MARKER, "Review skipped by the admission gate");
    assert.ok(route.includes(`"_${QA_ADMISSION_SKIP_MARKER}`), "the skip report carries the marker");
    assert.ok(!route.includes(`*"${QA_ADMISSION_SKIP_MARKER}"*`), "no pattern greps the marker out of the report");
    assert.ok(route.includes('const skipPath = pre.gate.action === "skip-required-failed"'));
    assert.ok(route.includes("currentReviewed: !skipPath"));
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
    const route = readFileSync(join(REPO_ROOT, "scripts", "qa", "route.ts"), "utf8");
    assert.ok(route.includes("/404|Label does not exist/"));
    assert.ok(route.includes("labels/${encodeURIComponent(l)}"));
    assert.ok(!route.includes("-f name="), "a DELETE with -f name= wipes ALL labels");
  });

  test("a failed label call never claims `Labelled`; the issue number is a schema-validated integer", () => {
    const route = readFileSync(join(REPO_ROOT, "scripts", "qa", "route.ts"), "utf8");
    assert.ok(route.includes("labelsOk = false;"));
    assert.ok(route.includes("**Label routing FAILED**"));
    const schema = readFileSync(join(REPO_ROOT, "src", "schemas", "qa-plumbing-cli.ts"), "utf8");
    assert.match(schema, /issue: z\.number\(\)\.int\(\),\n\s*repo:/, "an unsubstituted issue number cannot reach the label calls");
  });

  test("labels and escalation text come from the round-action JSON, never spelled in the loop", () => {
    const route = readFileSync(join(REPO_ROOT, "scripts", "qa", "route.ts"), "utf8");
    for (const f of ["labels.issueAdd", "labels.issueRemove", "labels.prAdd", "roundOut.escalationSummary"]) {
      assert.ok(route.includes(f), f);
    }
    assert.ok(!route.includes('"needs-dev-resume", "in-progress"'), "no hand-spelled escalation label list");
  });
});

describe("hydra-qa playbook wires convergent review (issue #4735)", () => {
  const route = readFileSync(join(REPO_ROOT, "scripts", "qa", "route.ts"), "utf8");
  const packet = readFileSync(join(REPO_ROOT, "scripts", "qa", "packet.ts"), "utf8");

  test("reviewer prompts carry the class-sweep instruction", () => {
    assert.match(QA_PLAYBOOK, /\*Class sweep \(issue #4735\): when you raise a finding, search the whole diff and every touched file/);
    assert.match(QA_PLAYBOOK, /3 or more instances, or the inputs are adversarial/);
  });

  test("the re-review context is APPENDED to the full packet, with the confirm-first instruction", () => {
    assert.ok(packet.includes("RE-REVIEW CONTEXT"));
    assert.ok(packet.includes('["diff", "--no-renames", rereviewDiffBase, "HEAD"]'));
    assert.match(packet, /reviewPacket \+=\n?\s*`\\n\\nRE-REVIEW CONTEXT/, "the context is appended; the full diff and changed files stay first");
    const s7 = QA_PLAYBOOK.slice(QA_PLAYBOOK.indexOf("#### 7.0a"), QA_PLAYBOOK.indexOf("#### 7.0b"));
    assert.match(s7, /first state fixed\/not-fixed for each prior finding; for anything new, prefer medium\+ and say why it wasn't visible before/i);
    assert.match(packet, /first state fixed\/not-fixed for each prior finding; for anything new, prefer medium\+ and say why it wasn't visible before/);
  });

  test("T1–T3: the round cap runs before this round's comment, and escalation never re-labels for dev", () => {
    const roundAt = route.indexOf('callPhase(phase, "round-action"');
    const firstVerdictComment = route.indexOf('if (verdict === "PASS") {');
    assert.ok(roundAt > 0 && roundAt < firstVerdictComment, "round-action reads the PR before any verdict comment is posted");
    const esc = route.indexOf('if (roundObj.action === "escalate") {');
    const bounce = route.indexOf("const label = bounceLabel();", esc);
    assert.ok(esc > 0 && esc < bounce, "escalate must be the first routing branch");
    const branch = route.slice(esc, bounce);
    assert.ok(!branch.includes("issueEdit("), "an escalated issue is never re-labelled for dev (labels come from the engine's escalation sets)");
    assert.ok(branch.includes("${note}"), "the labelled claim comes from the label calls' outcome");
    assert.ok(branch.includes("labelsOk\n        ? \"Labelled"), "no unconditional labelled claim");
  });

  test("T4 keeps decideDeepQaAction and never runs the T1–T3 round cap", () => {
    const t4 = route.slice(route.indexOf("// T4: the Deep-QA Remediation Loop."));
    assert.ok(t4.includes("deepQa.action"), "T4 reads the deep-QA action from the round-action result");
    assert.ok(!t4.includes("roundObj.action") && !t4.includes("decideQaRoundAction"));
  });
});

// ── #4735 simplification: re-review context never reaches the verdict ─────────
// Operator decision (https://github.com/gaberoo322/hydra/issues/4735#issuecomment-5883251393):
// the re-review context is PROMPT ONLY. No code path filters, demotes or narrows
// a finding; step 9 always folds with plain foldReviewFindings.
describe("no demotion path: step 9 always folds with plain foldReviewFindings (issue #4735)", () => {
  test("route makes exactly one fold call, ALWAYS passing the spawned reviewers (#4758)", () => {
    const route = readFileSync(join(REPO_ROOT, "scripts", "qa", "route.ts"), "utf8");
    assert.equal((route.match(/callPhase\(phase, "fold"/g) ?? []).length, 1, "one fold call, no scoped variant");
    const fold = route.slice(route.indexOf('callPhase(phase, "fold"'), route.indexOf("const fold = foldResult"));
    assert.ok(fold.includes("spawnedReviewers: pre.fanout.reviewers"), "spawnedReviewers is passed unconditionally (empty included)");
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


/**
 * Regression test for issue #638 — hydra-qa MUST clear `needs-qa` from the
 * source issue in every verdict-routing branch (PASS, PASS-pending-CI,
 * FAIL/FAIL-pending-CI).
 *
 * Before #638, the PASS-pending-CI branch deliberately left `needs-qa`
 * on the source issue so autopilot would "re-dispatch on the next tick"
 * — but `src/autopilot/turn-snapshot/orch-board.ts` counts `needs-qa` on
 * issues to drive `signals.needs_qa_orch`, and `decide.py` fires
 * `qa_orch` whenever that signal is True. The result was a busy-loop:
 * every autopilot tick re-ran hydra-qa against PRs whose verdict was
 * already filed and awaiting CI, burning 30-65k tokens per re-dispatch
 * with no progress until the PR merged.
 *
 * Since issue #5269 (ADR-0046 Decision 7) the step-10 effects live in
 * `scripts/qa/route.ts`, not in playbook bash. This file pins the SAME
 * invariants at their new home: a text pin on route.ts (the branch structure
 * and effect order) plus the playbook's retained merge fence. The behaviour
 * itself — argv order through a recording fake `gh` — is exercised in
 * test/qa-plumbing-scripts.test.mts.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLAYBOOK_PATH = join(__dirname, "..", "docs", "operator-playbooks", "hydra-qa.md");
const ROUTE = readFileSync(join(__dirname, "..", "scripts", "qa", "route.ts"), "utf8");
const PLAYBOOK = readFileSync(PLAYBOOK_PATH, "utf8");

/** Slice `src` between two literal markers (both must exist, in order). */
function between(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  assert.ok(a >= 0, `route.ts marker not found: ${from}`);
  const b = src.indexOf(to, a + from.length);
  assert.ok(b > a, `route.ts end marker not found after ${from}: ${to}`);
  return src.slice(a, b);
}

const PASS_ARM = between(ROUTE, 'if (verdict === "PASS") {', '} else if (verdict === "PASS-pending-CI") {');
const PENDING_ARM = between(ROUTE, '} else if (verdict === "PASS-pending-CI") {', "} else if (!tier4) {");
const FAIL_ARM = between(ROUTE, "} else if (!tier4) {", "// T4: the Deep-QA Remediation Loop.");
const T4_ARM = between(ROUTE, "// T4: the Deep-QA Remediation Loop.", "return {\n    exitCode: 0,\n    result: {\n      verdict,");
const DEFER_ARM = between(ROUTE, "if (opts.defer) {", "// ---- 9. fold + classify");

describe("hydra-qa route clears needs-qa on every verdict (issue #638)", () => {
  test("every label edit route makes strips needs-qa in the same call that adds the destination label", () => {
    const edit = between(ROUTE, "const issueEdit = (add: string) =>", "const disarm = () =>");
    assert.match(edit, /"--remove-label", "needs-qa", "--add-label", add/, "issueEdit always removes needs-qa and adds exactly one label");
    assert.equal((ROUTE.match(/"--remove-label"/g) ?? []).length, 1, "no other code path edits labels without the strip");
  });

  test("PASS arm strips needs-qa (via issueEdit)", () => {
    assert.match(PASS_ARM, /issueEdit\("in-progress"\)/, "PASS must clear needs-qa and bridge with in-progress");
  });

  describe("PASS arm strips needs-qa reachably (issue #974)", () => {
    test("the PASS arm never uses the self-aborting approval path", () => {
      assert.doesNotMatch(ROUTE, /"pr",\s*"review"/, "route must NOT `gh pr review` — it always errors on a self-authored PR (reference_qa_cannot_self_approve)");
      assert.doesNotMatch(ROUTE, /--approve/);
    });

    test("PASS verdict is recorded via a PR comment, not an approval", () => {
      assert.match(PASS_ARM, /prComment\(/);
    });

    test("the needs-qa strip precedes the PR comment, and route never merges", () => {
      assert.ok(PASS_ARM.indexOf("issueEdit(") >= 0 && PASS_ARM.indexOf("issueEdit(") < PASS_ARM.indexOf("prComment("),
        "needs-qa strip must run BEFORE anything that can abort — the #974 fix");
      assert.ok(!ROUTE.includes("--auto"), "route never arms auto-merge: the merge call stays in the playbook");
      assert.ok(!ROUTE.includes("--squash"));
      assert.match(PASS_ARM, /nextStep = "arm-auto-merge"/);
    });

    test("the playbook's merge fence runs only AFTER the route call (so the strip is already done)", () => {
      const routeCall = PLAYBOOK.indexOf("scripts/qa/route.ts");
      const merge = PLAYBOOK.indexOf("gh pr merge $pr_number --repo gaberoo322/hydra --auto --squash --delete-branch");
      assert.ok(routeCall > 0 && merge > routeCall, "the merge fence must follow the route call");
      assert.match(PLAYBOOK, /needs-qa` was already stripped/);
    });
  });

  test("PASS-pending-CI arm removes needs-qa from the source issue", () => {
    assert.match(PENDING_ARM, /issueEdit\("in-progress"\)/, "PASS-pending-CI must clear needs-qa — the busy-loop fix from issue #638");
    assert.doesNotMatch(PENDING_ARM, /Leave the needs-qa label in place/i);
  });

  test("every FAIL bounce arm strips needs-qa in the same edit that adds the bounce label (#638/#974)", () => {
    const openIdx = FAIL_ARM.indexOf('if (label === "needs-dev-resume") {');
    const notOpenIdx = FAIL_ARM.indexOf("// Not-open fallback");
    assert.ok(openIdx > 0, "FAIL routing must branch on the bounce-label read (issue #4766)");
    assert.ok(notOpenIdx > openIdx, "FAIL routing must have a not-open fallback arm after the open-PR arm");
    assert.match(FAIL_ARM.slice(openIdx, notOpenIdx), /issueEdit\("needs-dev-resume"\)/);
    assert.match(FAIL_ARM.slice(notOpenIdx), /issueEdit\("ready-for-agent"\)/);
    // T4: 1st-FAIL bounce and block-and-escalate both go through issueEdit.
    assert.match(T4_ARM, /issueEdit\("ready-for-human"\)/);
    assert.match(T4_ARM, /issueEdit\(label\)/);
  });
});

/**
 * Issue #4766 — the QA bounce label keys on "the linked PR is still open at
 * bounce time", not on GLM provenance.
 *
 * `ready-for-agent` is a FRESH dev pick: since #4518 the durable resume pin
 * (the Turn Snapshot's orch_dev_resume_pick → decide.py's pinned forward-fix)
 * owns any open PR, and it only consumes `needs-dev-resume`. A
 * `ready-for-agent` relabel on an open PR therefore opened a DUPLICATE PR or
 * forced a hand relabel. Pinned in route.ts's single `bounceLabel` read.
 */
describe("hydra-qa bounce label keys on open-PR state, not GLM provenance (issue #4766)", () => {
  test("the bounce decision is defined once in route.ts and the playbook no longer carries a shell helper", () => {
    assert.equal((ROUTE.match(/const bounceLabel = /g) ?? []).length, 1, "the helper is defined exactly once — no per-site re-implementation");
    assert.ok(!PLAYBOOK.includes("qa_bounce_label"), "the bash helper left the playbook (issue #5269 INV-10)");
    assert.equal((ROUTE.match(/bounceLabel\(\)/g) ?? []).length, 3, "three call sites: defer, T1-T3 FAIL, T4 1st deep-QA FAIL");
  });

  test("the helper reads PR state LIVE and defaults to needs-dev-resume unless CLOSED/MERGED", () => {
    const helper = between(ROUTE, "const bounceLabel = ", "const prComment = ");
    assert.match(helper, /"pr", "view", String\(prNum\), "--repo", repo, "--json", "state"/, "a live per-call read, not the preflight snapshot");
    assert.ok(helper.includes('state === "CLOSED" || state === "MERGED"'), "only a confirmed CLOSED/MERGED read may yield ready-for-agent");
    const rfa = helper.indexOf('"ready-for-agent"', helper.indexOf("state ==="));
    const ndr = helper.lastIndexOf('"needs-dev-resume"');
    assert.ok(rfa > 0 && ndr > rfa, "needs-dev-resume is the else default, so a failed/empty read lands there");
    assert.match(helper, /r\.ok \? r\.stdout\.trim\(\) : ""/, "a failed read becomes the empty state");
  });

  test("open-PR bounce arms add needs-dev-resume, never ready-for-agent; the fallback keeps ready-for-agent", () => {
    const openIdx = FAIL_ARM.indexOf('if (label === "needs-dev-resume") {');
    const notOpenIdx = FAIL_ARM.indexOf("// Not-open fallback");
    assert.ok(!FAIL_ARM.slice(openIdx, notOpenIdx).includes('issueEdit("ready-for-agent")'));
    assert.match(FAIL_ARM.slice(notOpenIdx), /issueEdit\("ready-for-agent"\)/);

    const deferOpen = DEFER_ARM.slice(DEFER_ARM.indexOf('if (label === "needs-dev-resume") {'), DEFER_ARM.indexOf("// Not-open fallback"));
    assert.match(deferOpen, /issueEdit\("needs-dev-resume"\)/);
    assert.ok(!deferOpen.includes('issueEdit("ready-for-agent")'));
    assert.match(DEFER_ARM.slice(DEFER_ARM.indexOf("// Not-open fallback")), /issueEdit\("ready-for-agent"\)/);

    // T4 1st deep-QA FAIL bounce consults the same read and never hard-codes a label.
    assert.match(T4_ARM, /const label = bounceLabel\(\);\n\s*issueEdit\(label\)/);
    assert.ok(!T4_ARM.includes('issueEdit("ready-for-agent")'), "the T4 bounce must not hard-code ready-for-agent");
  });

  test("the disarm runs first on every FAIL arm", () => {
    assert.ok(FAIL_ARM.trimStart().startsWith("// FAIL / FAIL-pending-CI, T1-T3") || FAIL_ARM.includes("disarm();"));
    assert.ok(FAIL_ARM.indexOf("disarm();") < FAIL_ARM.indexOf("prComment("), "T1-T3: disarm before the verdict comment");
    assert.ok(T4_ARM.indexOf("disarm();") < T4_ARM.indexOf("prComment("), "T4: disarm before the verdict comment");
    assert.match(ROUTE, /"pr", "merge", String\(prNum\), "--repo", repo, "--disable-auto"/, "the only `gh pr merge` in route is the --disable-auto disarm");
    assert.equal((ROUTE.match(/"merge"/g) ?? []).length, 1);
  });

  test("GLM_AUTHORED selects comment wording only, never the bounce label", () => {
    assert.equal((ROUTE.match(/glmAuthored/g) ?? []).length, 2, "glmAuthored is read in exactly the two open-PR comment selectors");
    assert.equal((ROUTE.match(/issueComment\(\s*pre\.pr\.glmAuthored/g) ?? []).length, 2, "each use opens an issueComment argument, not a label edit");
  });
});

describe("the needs-qa collector documents the needs-qa contract (issue #638)", () => {
  // The needs-qa read moved from collect-state.sh into the typed Turn Snapshot
  // orch-board collector (ADR-0043 slice 2); collect-state.sh was deleted in #4934.
  const collectorPath = join(__dirname, "..", "src", "autopilot", "turn-snapshot", "orch-board.ts");
  const script = readFileSync(collectorPath, "utf8");

  test("the needs-qa collector's doc references issue #638", () => {
    // needs-qa on an issue means "diff not yet reviewed", NOT "PR is in CI".
    assert.match(
      script,
      /needs[_-]qa[\s\S]{0,800}#638/,
      "the orch-board collector's needs-qa doc must reference issue #638's contract",
    );
  });
});

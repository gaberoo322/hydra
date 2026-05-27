/**
 * Regression test for issue #638 — hydra-qa needs-qa label-leak between PR
 * and source issue causes autopilot qa_orch busy-loop.
 *
 * Background: the `hydra-qa` skill files its verdict on the PR (review
 * comment / approve / request-changes) but, before #638, never cleared the
 * `needs-qa` label from the linked SOURCE ISSUE. The autopilot's signal
 * collector (`scripts/autopilot/collect-state.sh`, line ~33) counts
 * `needs-qa` on issues (not PRs) to drive `signals.needs_qa_orch`. So every
 * autopilot tick re-dispatched `hydra-qa` against PRs whose verdict was
 * already filed — burning 30-65k tokens per re-dispatch while the PR sat
 * awaiting operator merge or pending CI.
 *
 * The fix is in the skill, not in the signal collector: on every PASS-class
 * verdict (`PASS` and `PASS-pending-CI`), the skill MUST `gh issue edit
 * --remove-label needs-qa` on the parent issue resolved from the PR body's
 * `Closes #N` back-reference. The skill source of truth is the playbook;
 * `scripts/sync-skills.sh` regenerates `~/.claude/skills/hydra-qa/SKILL.md`
 * on every master deploy.
 *
 * This is a cheap canary — it asserts the playbook contains the
 * load-bearing recipe in both PASS branches so a future edit that silently
 * removes them is caught at `npm test` time rather than at the
 * "autopilot is wasting 30-65k tokens per tick" detection time, which is
 * how the original incident (autopilot run ab97a2d5, 2026-05-27)
 * surfaced.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

function readRepoFile(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf-8");
}

/**
 * Slice the playbook text around a Verdict heading down to the next `---`
 * separator that ends that branch's recipe block. This lets each test
 * assert on the recipe local to one verdict (PASS vs PASS-pending-CI vs
 * FAIL) without false positives from a sibling branch's text.
 */
function sliceVerdictBlock(playbook: string, header: string): string {
  const startIdx = playbook.indexOf(header);
  assert.notEqual(
    startIdx,
    -1,
    `playbook is missing the "${header}" heading — has the verdict-routing section been restructured?`,
  );
  // The PASS / PASS-pending-CI / FAIL / FAIL-pending-CI blocks are each
  // bounded by the next bold "**Verdict …" header or the start of Step 11.
  const tail = playbook.slice(startIdx + header.length);
  const nextVerdict = tail.search(/^\*\*Verdict\s+`/m);
  const nextSection = tail.search(/^### \d+\./m);
  let endRel = Math.min(
    nextVerdict === -1 ? Infinity : nextVerdict,
    nextSection === -1 ? Infinity : nextSection,
  );
  if (!Number.isFinite(endRel)) endRel = tail.length;
  return tail.slice(0, endRel);
}

describe("hydra-qa playbook — source-issue needs-qa label discipline (issue #638)", () => {
  const playbook = readRepoFile("docs/operator-playbooks/hydra-qa.md");

  test("Step 10 references issue #638 as the origin of the needs-qa label discipline", () => {
    // The prose explanation MUST cite #638 so a future editor reading the
    // verdict-routing section understands WHY both PASS branches clear the
    // source-issue label. The classic failure mode this guards is "tidy-up
    // refactor removes the label-clear because it looks redundant".
    assert.match(
      playbook,
      /Source-issue `needs-qa` label discipline \(issue #638\)/,
    );
    assert.match(
      playbook,
      /collect-state\.sh.*counts.*needs-qa.*on issues/i,
    );
    assert.match(
      playbook,
      /busy[- ]loop|re-dispatch.*every.*tick|30-65k tokens/i,
    );
  });

  test("PASS verdict branch clears needs-qa from the source issue before merging", () => {
    const block = sliceVerdictBlock(playbook, "**Verdict `PASS`**");
    // The recipe MUST run BEFORE `gh pr merge` so a merge-fail still leaves
    // the issue label cleared (defense-in-depth — collect-state.sh polls the
    // issue, not the merge state). We can't assert "before" textually
    // without parsing, but we CAN assert both lines exist in the same
    // verdict block and that the label-clear references PARENT_ISSUE
    // (not the issue argument to the skill, which may be empty when
    // operators invoke QA on a PR directly).
    assert.match(
      block,
      /gh issue edit "\$PARENT_ISSUE".*--remove-label "needs-qa"/,
      "PASS branch must remove needs-qa from $PARENT_ISSUE (the PR's parent issue, resolved in Step 4)",
    );
    assert.match(
      block,
      /gh pr merge \$pr_number --repo gaberoo322\/hydra --squash --delete-branch/,
      "PASS branch must still call gh pr merge after the label-clear",
    );
    // Defensive: the label-clear must be guarded by a $PARENT_ISSUE
    // non-empty check, because PRs without a Closes/Fixes/Refs back-ref
    // leave PARENT_ISSUE empty (see Step 4). Calling `gh issue edit ""`
    // would error confusingly.
    assert.match(
      block,
      /if \[ -n "\$\{PARENT_ISSUE:-\}" \]/,
      "PASS branch must guard the label-clear with a $PARENT_ISSUE non-empty check",
    );
  });

  test("PASS-pending-CI verdict branch clears needs-qa from the source issue", () => {
    const block = sliceVerdictBlock(playbook, "**Verdict `PASS-pending-CI`**");
    assert.match(
      block,
      /gh issue edit "\$PARENT_ISSUE".*--remove-label "needs-qa"/,
      "PASS-pending-CI branch must remove needs-qa from $PARENT_ISSUE — this is the primary busy-loop fix (issue #638)",
    );
    assert.match(
      block,
      /if \[ -n "\$\{PARENT_ISSUE:-\}" \]/,
      "PASS-pending-CI branch must guard the label-clear with a $PARENT_ISSUE non-empty check",
    );
    // The autopilot polls CI directly via the PR's check status — it does
    // NOT need needs-qa on the issue as the re-poll signal. This comment
    // in the playbook is what stops a future editor from "putting the
    // label back" thinking they're restoring the autopilot's re-poll hook.
    assert.match(
      block,
      /[Aa]utopilot polls CI/,
      "PASS-pending-CI branch must document WHY clearing needs-qa is safe (autopilot polls CI separately)",
    );
  });

  test("FAIL verdict branch leaves needs-qa cleared via the ready-for-agent transition (no double-add)", () => {
    // FAIL routing replaces `needs-qa` with `ready-for-agent` on the
    // source issue (Step 10, FAIL block). This test guards the
    // pre-existing behaviour — issue #638 must NOT regress the FAIL
    // path's label transition into something that re-adds `needs-qa`.
    const block = sliceVerdictBlock(
      playbook,
      "**Verdict `FAIL` or `FAIL-pending-CI`**",
    );
    assert.match(
      block,
      /--remove-label "needs-qa".*--add-label "ready-for-agent"/,
      "FAIL branch must still remove needs-qa and add ready-for-agent (pre-existing behaviour, not regressed by #638)",
    );
  });
});

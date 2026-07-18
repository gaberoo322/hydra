/**
 * Regression guard — the autopilot `auto-merge` action MUST NOT prefix
 * `gh pr review --approve`.
 *
 * ROOT CAUSE (2026-07-17): the `auto-merge` action row in
 * `docs/operator-playbooks/hydra-autopilot.md` used to be
 * `gh pr review --approve && gh pr merge --auto --squash`. Every agent shares
 * the `gaberoo322` identity, and GitHub 422s a self-approval
 * ("Can not approve your own pull request"; reference_qa_cannot_self_approve /
 * #848). The failing `gh pr review --approve` short-circuits the `&&`, so
 * `gh pr merge --auto` NEVER runs — auto-merge is never armed and green PRs pile
 * up for manual admin-merge. There is no approving-review branch-protection gate
 * (CI required-status-checks are the merge gate), so the approval is a pure
 * no-op even when it doesn't error.
 *
 * hydra-qa already removed this exact trap from its PASS path (issue #974,
 * guarded by test/hydra-qa-needs-qa-clear.test.mts); the autopilot action row is
 * its twin. This test parses the playbook + the Phase-6 ops fragment and fails
 * loudly if a future edit re-introduces the self-aborting approve prefix.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLAYBOOK = join(__dirname, "..", "docs", "operator-playbooks", "hydra-autopilot.md");
const PHASE6 = join(
  __dirname,
  "..",
  "docs",
  "operator-playbooks",
  "_fragments",
  "hydra-autopilot-phase6-ops.md",
);

/** Extract the `| \`auto-merge\` | ... |` action-table row from the playbook. */
function autoMergeRow(playbook: string): string {
  const row = playbook.split("\n").find((l) => /^\|\s*`auto-merge`\s*\|/.test(l));
  assert.ok(row, "hydra-autopilot.md is missing the `auto-merge` action-table row");
  return row!;
}

describe("autopilot auto-merge action does not self-approve (2026-07-17 regression)", () => {
  const playbook = readFileSync(PLAYBOOK, "utf8");
  const phase6 = readFileSync(PHASE6, "utf8");

  test("the `auto-merge` action row arms `gh pr merge --auto --squash`", () => {
    assert.match(
      autoMergeRow(playbook),
      /gh pr merge --auto --squash/,
      "the auto-merge action must arm `gh pr merge --auto --squash`",
    );
  });

  test("the `auto-merge` action row does NOT prefix `gh pr review --approve`", () => {
    assert.doesNotMatch(
      autoMergeRow(playbook),
      /gh pr review\s+--approve/,
      "the auto-merge action must NOT `gh pr review --approve` — it 422s on the shared gaberoo322 identity and short-circuits the `&&`, silently skipping the merge-enable (reference_qa_cannot_self_approve / #848).",
    );
  });

  test("the Phase-6 ops fragment does not reference the approve prefix either", () => {
    assert.doesNotMatch(
      phase6,
      /gh pr review\s+--approve/,
      "hydra-autopilot-phase6-ops.md must not reintroduce `gh pr review --approve` in the auto-merge flow.",
    );
  });
});

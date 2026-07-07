/**
 * Regression test for issue #846 — hydra-dev MUST transition the source
 * issue from `ready-for-agent`/`in-progress` → `needs-qa` after opening a
 * PR.
 *
 * Observed twice on 2026-06-01: hydra-dev opened PRs (#842, #845) but left
 * the originating issues (#840, #841) on `ready-for-agent`. A stale
 * `ready-for-agent`:
 *   1. keeps the issue in the `ready_for_agent` count, so `dev_orch` can
 *      re-select it and open a DUPLICATE PR (the #770/#754 failure mode), and
 *   2. never raises the `needs_qa` board signal, so `qa_orch` won't
 *      auto-dispatch on the open PR.
 *
 * The transition step already existed in `docs/operator-playbooks/hydra-dev.md`
 * Step 6 "Post-agent" Success branch — the agent just dropped it on a bad
 * turn, and it only removed `in-progress` (not `ready-for-agent`). The fix
 * (#846) hardens that branch: remove BOTH `ready-for-agent` and
 * `in-progress`, add `needs-qa`, with a `|| echo WARN` guard so it can't abort
 * the run.
 *
 * This test parses the playbook's Success block and asserts the transition,
 * directly mirroring `test/hydra-qa-needs-qa-clear.test.mts` (#638). If a
 * future edit deletes or weakens the transition, this test fails loudly.
 *
 * Recorded limitation: this guards playbook TEXT against drift, not runtime
 * execution. It cannot prove a given dispatch actually ran the command — only
 * that the contract the dispatch follows still says to.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Issue #2947 split the hydra-dev playbook: the parent-flow reaping steps
// (including the Step 6 Success needs-qa transition) moved into the
// _fragments/hydra-dev-parent-flow.md reference file that sync-skills.sh emits
// as a sibling of SKILL.md. The obligation now lives there.
const PLAYBOOK_PATH = join(
  __dirname,
  "..",
  "docs",
  "operator-playbooks",
  "_fragments",
  "hydra-dev-parent-flow.md",
);

/**
 * Extract the bash block that follows the "**Success (PR URL returned):**"
 * heading in Step 6, up to the first closing triple-fence. The playbook
 * structure is documented and stable; this parser is intentionally literal so
 * a docs reflow surfaces here as a test failure (which is the right place to
 * notice).
 */
function extractSuccessBlock(playbook: string): string {
  const pattern =
    /\*\*Success \(PR URL returned\):\*\*[\s\S]*?```bash\n([\s\S]*?)\n```/;
  const m = playbook.match(pattern);
  assert.ok(
    m,
    "playbook missing Step 6 Success bash block — did the section heading change?",
  );
  return m![1];
}

describe("hydra-dev playbook transitions issue to needs-qa after opening a PR (issue #846)", () => {
  const playbook = readFileSync(PLAYBOOK_PATH, "utf8");
  const block = extractSuccessBlock(playbook);

  test("Success branch adds needs-qa to the source issue", () => {
    assert.match(
      block,
      /gh issue edit\s+"?\$issue_number"?[\s\S]*--add-label\s+["']needs-qa["']/,
      "Success branch must add needs-qa to the source issue so qa_orch auto-fires (#846)",
    );
  });

  test("Success branch removes ready-for-agent (not just in-progress)", () => {
    // The #846 failures left issues stuck on `ready-for-agent`, so removing
    // only `in-progress` is insufficient — BOTH must be stripped.
    assert.match(
      block,
      /--remove-label\s+["']ready-for-agent["']/,
      "Success branch must remove ready-for-agent — leaving it stale re-surfaces the issue for a duplicate dispatch (#770/#754)",
    );
    assert.match(
      block,
      /--remove-label\s+["']in-progress["']/,
      "Success branch must also remove in-progress",
    );
  });

  test("Success branch transition is non-fatal (|| echo WARN guard)", () => {
    // Mirror hydra-qa Step 10 discipline: a transient gh failure must not
    // abort the run. The transition drop on a bad turn is what #846 fixes.
    assert.match(
      block,
      /\|\|\s*echo\s+["']?WARN/i,
      "the label transition must be guarded with `|| echo WARN` so it can't abort the run",
    );
  });
});

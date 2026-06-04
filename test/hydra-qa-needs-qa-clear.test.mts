/**
 * Regression test for issue #638 — hydra-qa skill MUST clear `needs-qa`
 * from the source issue in every verdict-routing branch (PASS,
 * PASS-pending-CI, FAIL/FAIL-pending-CI).
 *
 * Before #638, the PASS-pending-CI branch deliberately left `needs-qa`
 * on the source issue so autopilot would "re-dispatch on the next tick"
 * — but `scripts/autopilot/collect-state.sh:33` counts `needs-qa` on
 * issues to drive `signals.needs_qa_orch`, and `decide.py:1135` fires
 * `qa_orch` whenever that signal is True. The result was a busy-loop:
 * every autopilot tick re-ran hydra-qa against PRs whose verdict was
 * already filed and awaiting CI, burning 30-65k tokens per re-dispatch
 * with no progress until the PR merged.
 *
 * The fix landed in `docs/operator-playbooks/hydra-qa.md` (Step 10).
 * This test parses the playbook and asserts each verdict-routing branch
 * removes `needs-qa` from `$issue_number`. If a future edit deletes the
 * clear-on-verdict block, this test fails loudly.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLAYBOOK_PATH = join(__dirname, "..", "docs", "operator-playbooks", "hydra-qa.md");

/**
 * Extract the bash block that follows a given "**Verdict `X`**" heading,
 * up to the next blank-line-terminated triple-fence. The playbook
 * structure is documented and stable; this parser is intentionally
 * literal so a docs reflow surfaces here as a test failure (which is
 * the right place to notice).
 */
function extractVerdictBlock(playbook: string, verdict: string): string {
  // Match the heading then capture until the closing ```.
  const pattern = new RegExp(
    "\\*\\*Verdict\\s+`" + verdict.replace(/[-]/g, "\\-") + "`[^`]*```bash\\n([\\s\\S]*?)\\n```",
  );
  const m = playbook.match(pattern);
  assert.ok(
    m,
    `playbook missing verdict block for \`${verdict}\` — did the section heading change?`,
  );
  return m![1];
}

describe("hydra-qa playbook clears needs-qa on every verdict (issue #638)", () => {
  const playbook = readFileSync(PLAYBOOK_PATH, "utf8");

  test("PASS verdict block removes needs-qa from the source issue", () => {
    const block = extractVerdictBlock(playbook, "PASS");
    // The `gh issue edit ... --remove-label "needs-qa"` call MUST be present.
    // We intentionally match the issue handle (`$issue_number`) too so that
    // a future refactor that swaps issue for PR is caught.
    assert.match(
      block,
      /gh issue edit\s+\$issue_number[^\n]*--remove-label\s+["']needs-qa["']/,
      "PASS branch must clear needs-qa from the source issue (belt-and-braces; the PR's `Closes #N` should also auto-close it, but explicit clearing is the contract)",
    );
  });

  // Issue #974 — the QA-side twin of the dev-side #846 gap.
  // ROOT CAUSE: the PASS branch's FIRST command used to be
  // `gh pr review --approve`, which ALWAYS errors on a self-authored PR
  // (shared gaberoo322 identity; reference_qa_cannot_self_approve / #848).
  // That abort meant the trailing `gh issue edit --remove-label needs-qa`
  // never ran, so the label lingered until a LATER autopilot run stripped it
  // (~1h23m busy-loop, PR#970/#961). The fix makes the strip REACHABLE
  // irrespective of the approve/merge outcome: remove the self-approve and
  // ensure the strip runs before any command that aborts on self-author.
  describe("PASS branch strips needs-qa reachably (issue #974)", () => {
    const block = extractVerdictBlock(playbook, "PASS");

    test("PASS branch does not use the self-aborting `gh pr review --approve`", () => {
      // `--approve` on a self-authored PR (shared identity) errors and would
      // abort the sequence before the needs-qa strip. The documented pattern
      // is to record the verdict as a comment instead.
      assert.doesNotMatch(
        block,
        /gh pr review\s+\$pr_number[^\n]*--approve/,
        "PASS branch must NOT `gh pr review --approve` — it always errors on a self-authored PR and aborts before the needs-qa strip (issue #974 / reference_qa_cannot_self_approve). Post the verdict as `gh pr comment` instead.",
      );
    });

    test("PASS verdict is recorded via `gh pr comment`, not an approval", () => {
      assert.match(
        block,
        /gh pr comment\s+\$pr_number/,
        "PASS branch must record its verdict as a PR comment (self-author cannot self-approve — #848).",
      );
    });

    test("needs-qa strip precedes the merge call (reachable before any abort)", () => {
      const stripIdx = block.search(
        /gh issue edit\s+\$issue_number[^\n]*--remove-label\s+["']needs-qa["']/,
      );
      const mergeIdx = block.search(/gh pr merge\s+\$pr_number/);
      assert.ok(stripIdx >= 0, "PASS branch must contain a needs-qa strip");
      assert.ok(mergeIdx >= 0, "PASS branch must contain a merge call");
      assert.ok(
        stripIdx < mergeIdx,
        "needs-qa strip must run BEFORE the merge call so it is reachable even if the merge (or any self-author-hostile command) aborts the sequence — the #974 fix.",
      );
    });
  });

  test("PASS-pending-CI verdict block removes needs-qa from the source issue", () => {
    const block = extractVerdictBlock(playbook, "PASS-pending-CI");
    assert.match(
      block,
      /gh issue edit\s+\$issue_number[^\n]*--remove-label\s+["']needs-qa["']/,
      "PASS-pending-CI branch must clear needs-qa — this is the busy-loop fix from issue #638",
    );
    // Critical: the block MUST NOT contain the old "Leave the needs-qa label in place" comment.
    assert.doesNotMatch(
      block,
      /Leave the needs-qa label in place/i,
      "The pre-#638 'leave needs-qa in place' instruction must be removed",
    );
  });

  test("FAIL verdict block removes needs-qa from the source issue", () => {
    // The FAIL block uses a different heading shape: `**Verdict `FAIL` or `FAIL-pending-CI`**`.
    const m = playbook.match(
      /\*\*Verdict\s+`FAIL`\s+or\s+`FAIL-pending-CI`[^`]*```bash\n([\s\S]*?)\n```/,
    );
    assert.ok(m, "playbook missing FAIL verdict block");
    const block = m![1];
    assert.match(
      block,
      /gh issue edit\s+\$issue_number[^\n]*--remove-label\s+["']needs-qa["']/,
      "FAIL branch must clear needs-qa (this branch already did before #638)",
    );
    // The FAIL branch also re-adds ready-for-agent so the issue cycles back to dev.
    assert.match(
      block,
      /--add-label\s+["']ready-for-agent["']/,
      "FAIL branch must re-label the issue ready-for-agent for retry",
    );
  });
});

describe("collect-state.sh documents the needs-qa contract (issue #638)", () => {
  const collectStatePath = join(
    __dirname,
    "..",
    "scripts",
    "autopilot",
    "collect-state.sh",
  );
  const script = readFileSync(collectStatePath, "utf8");

  test("comment near needs_qa jq counter references issue #638", () => {
    // The comment block above the jq aggregator (line ~33) should mention
    // issue #638 so future readers know the contract — needs-qa on an issue
    // means "diff not yet reviewed", NOT "PR is in CI".
    assert.match(
      script,
      /needs[_-]qa[\s\S]{0,800}#638/,
      "collect-state.sh needs_qa block must reference issue #638's contract",
    );
  });
});

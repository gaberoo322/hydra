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
    // Issue #4766: the FAIL bounce now branches (open PR vs not-open
    // fallback), so the #638/#974 strip contract is asserted per arm —
    // EVERY bounce arm must strip needs-qa in the same gh issue edit that
    // adds the bounce label, or the issue busy-loops QA again.
    const openArmIdx = block.indexOf('elif [ "$BOUNCE_LABEL" = "needs-dev-resume" ]');
    assert.ok(openArmIdx > 0, "FAIL routing must branch on the bounce-label helper (issue #4766)");
    const fallbackIdx = block.indexOf("# Not-open fallback");
    assert.ok(fallbackIdx > openArmIdx, "FAIL routing must have a not-open fallback arm after the open-PR arm");
    for (const [armName, arm] of [
      ["open-PR arm", block.slice(openArmIdx, fallbackIdx)],
      ["not-open fallback arm", block.slice(fallbackIdx)],
    ] as const) {
      // The edit may wrap across continuation lines, hence [\s\S] not [^\n].
      assert.match(
        arm,
        /gh issue edit\s+\$issue_number[\s\S]{0,300}?--remove-label\s+["']needs-qa["']/,
        `the ${armName} must clear needs-qa in the same edit that adds the bounce label (issues #638/#974)`,
      );
    }
  });
});

/**
 * Issue #4766 — the QA bounce label keys on "the linked PR is still open at
 * bounce time", not on GLM provenance.
 *
 * Before #4766, step 6.6's defer and step 10's T1/T2/T3 FAIL routing sent
 * every NON-GLM open PR back to `ready-for-agent`. But `ready-for-agent` is
 * a FRESH dev pick: since #4518 the durable resume pin (collect-state.sh's
 * orch_dev_resume_pick → decide.py's pinned forward-fix) owns any open PR,
 * and it only consumes `needs-dev-resume`. A `ready-for-agent` relabel on an
 * open PR therefore opened a DUPLICATE PR or forced a hand relabel (live
 * evidence in the issue: #4594/PR #4763 FAIL path, #4591/PR #4751 defer
 * path). The GLM-only arm dated from #4460, written before #4518 existed.
 *
 * Same literal-parse approach as the #638 tests above: a playbook reflow
 * that breaks the extraction surfaces here as a failure.
 */
describe("hydra-qa bounce label keys on open-PR state, not GLM provenance (issue #4766)", () => {
  const playbook = readFileSync(PLAYBOOK_PATH, "utf8");

  /** The step-3 fence (pin the fixed point), where the helper is defined. */
  const step3 = playbook.slice(
    playbook.indexOf("### 3. Pin the fixed point"),
    playbook.indexOf("### 4. Resolve the spec source"),
  );

  /** Step 6.6's defer bullet, fence included (the table row above uses the same bold marker, so anchor on the bullet prose). */
  const deferBlock = playbook.slice(
    playbook.indexOf("- **`defer`** — the PR cannot merge"),
    playbook.indexOf("- **`skip-required-failed`** (T1/T2/T3 only"),
  );

  /** Step 10's T1/T2/T3 FAIL-routing fence (the first FAIL bash block). */
  const failBlock = playbook.match(
    /\*\*Verdict\s+`FAIL`\s+or\s+`FAIL-pending-CI`[^`]*```bash\n([\s\S]*?)\n```/,
  )![1];

  /** Step 10's T4 deep-QA loop, from its heading to step 11. */
  const t4Block = playbook.slice(
    playbook.indexOf("For **T4**"),
    playbook.indexOf("### 11."),
  );

  test("step 3 defines qa_bounce_label exactly once — the single decision point", () => {
    assert.ok(
      step3.includes("qa_bounce_label() {"),
      "step 3 must define the qa_bounce_label helper (INV-3)",
    );
    assert.equal(
      (playbook.match(/qa_bounce_label\(\) \{/g) ?? []).length,
      1,
      "the helper must be defined exactly once (INV-3) — no per-site re-implementation of the open/not-open logic",
    );
    // Every bounce site consults the helper; nothing else picks the label.
    assert.equal(
      (playbook.match(/\$\(qa_bounce_label\)/g) ?? []).length,
      3,
      "exactly three call sites: step 6.6 defer, step-10 T1/T2/T3 FAIL, step-10 T4 1st deep-QA FAIL",
    );
  });

  test("the helper reads PR state LIVE and defaults to needs-dev-resume unless CLOSED/MERGED", () => {
    assert.match(
      step3,
      /gh pr view "\$pr_number"[\s\S]{0,120}?--json state/,
      "the bounce label must come from a live gh pr view --json state read at bounce time, not step 3's snapshot (INV-2)",
    );
    const helper = step3.slice(step3.indexOf("qa_bounce_label() {"));
    assert.ok(
      helper.includes('QA_PR_STATE" = "CLOSED"') && helper.includes('QA_PR_STATE" = "MERGED"'),
      "only a confirmed CLOSED/MERGED read may yield ready-for-agent (INV-2)",
    );
    const closedIdx = helper.indexOf('QA_PR_STATE" = "CLOSED"');
    const rfaIdx = helper.indexOf('echo "ready-for-agent"');
    const ndrIdx = helper.indexOf('echo "needs-dev-resume"');
    assert.ok(
      closedIdx > 0 && rfaIdx > closedIdx && ndrIdx > rfaIdx,
      "ready-for-agent only inside the CLOSED/MERGED arm; needs-dev-resume is the else default, so a failed/empty read lands there (INV-2)",
    );
  });

  test("open-PR bounce arms add needs-dev-resume, never ready-for-agent; the fallback keeps ready-for-agent", () => {
    // T1/T2/T3 FAIL routing (also the landing zone of step 6.6's
    // skip-required-failed short-circuit, which jumps here).
    const openArmIdx = failBlock.indexOf('elif [ "$BOUNCE_LABEL" = "needs-dev-resume" ]');
    assert.ok(openArmIdx > 0, "T1/T2/T3 FAIL routing must branch on the bounce-label helper");
    const fallbackIdx = failBlock.indexOf("# Not-open fallback");
    assert.ok(fallbackIdx > openArmIdx, "the not-open fallback arm must follow the open-PR arm");
    const openArm = failBlock.slice(openArmIdx, fallbackIdx);
    const fallbackArm = failBlock.slice(fallbackIdx);
    assert.match(openArm, /--add-label\s+["']needs-dev-resume["']/, "the open-PR arm adds needs-dev-resume (INV-1)");
    assert.doesNotMatch(openArm, /--add-label\s+["']ready-for-agent["']/, "the open-PR arm must NOT add ready-for-agent (INV-1)");
    assert.match(fallbackArm, /--add-label\s+["']ready-for-agent["']/, "the not-open fallback arm adds ready-for-agent (INV-2)");

    // Step 6.6 defer.
    const deferOpenIdx = deferBlock.indexOf('if [ "$BOUNCE_LABEL" = "needs-dev-resume" ]; then');
    assert.ok(deferOpenIdx > 0, "the defer bounce must branch on the bounce-label helper");
    const deferFallbackIdx = deferBlock.indexOf("# Not-open fallback");
    assert.ok(deferFallbackIdx > deferOpenIdx, "the defer not-open fallback must follow the open-PR arm");
    const deferOpen = deferBlock.slice(deferOpenIdx, deferFallbackIdx);
    assert.match(deferOpen, /--add-label\s+["']needs-dev-resume["']/, "the defer open-PR arm adds needs-dev-resume (INV-1)");
    assert.doesNotMatch(deferOpen, /--add-label\s+["']ready-for-agent["']/, "the defer open-PR arm must NOT add ready-for-agent (INV-1)");
    assert.match(deferBlock.slice(deferFallbackIdx), /--add-label\s+["']ready-for-agent["']/, "the defer not-open fallback adds ready-for-agent (INV-2)");

    // Step 10 T4 1st deep-QA FAIL bounce — same rule, single arm.
    const t4Bounce = t4Block.slice(t4Block.indexOf("1st deep-QA FAIL"));
    assert.match(t4Bounce, /BOUNCE_LABEL=\$\(qa_bounce_label\)/, "the T4 1st-FAIL bounce consults the helper (INV-1)");
    assert.match(t4Bounce, /--add-label\s+"\$BOUNCE_LABEL"/, "the T4 bounce adds the helper's label");
    assert.doesNotMatch(t4Bounce, /--add-label\s+["']ready-for-agent["']/, "the T4 bounce must not hard-code ready-for-agent (INV-1)");
  });

  test("GLM_AUTHORED selects comment wording only, never the bounce label", () => {
    // Inside each open-PR arm the GLM conditional (if any) must open with a
    // comment call — wording — not a label edit.
    const failOpenArm = failBlock.slice(
      failBlock.indexOf('elif [ "$BOUNCE_LABEL" = "needs-dev-resume" ]'),
      failBlock.indexOf("# Not-open fallback"),
    );
    const glmFail = failOpenArm.match(/if \[ "\$GLM_AUTHORED" = "1" \]; then\n\s*gh issue comment/);
    assert.ok(glmFail, "the T1/T2/T3 open-PR arm's GLM conditional selects the comment, not the label (INV-3)");
    const deferOpenArm = deferBlock.slice(
      deferBlock.indexOf('if [ "$BOUNCE_LABEL" = "needs-dev-resume" ]; then'),
      deferBlock.indexOf("# Not-open fallback"),
    );
    const glmDefer = deferOpenArm.match(/if \[ "\$GLM_AUTHORED" = "1" \]; then\n\s*gh issue comment/);
    assert.ok(glmDefer, "the defer open-PR arm's GLM conditional selects the comment, not the label (INV-3)");
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

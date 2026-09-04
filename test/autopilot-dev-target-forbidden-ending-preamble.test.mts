/**
 * Regression guard — issue #4196: `dev_target` dispatches carried no
 * forbidden-ending preamble at all, and `hydra-target-build`'s own contract
 * actively instructed the parent to delegate to a nested background Agent
 * and go quiet.
 *
 * ROOT CAUSE (autopilot run 155f6d3c, turn 1, 2026-08-21): a `dev_target`
 * dispatch spawned `Agent(run_in_background=true)` to run the whole build,
 * said "I'll relay its summary once it completes", and ended its turn 101s
 * in — 78.6k tokens, 6 tool uses, zero deliverable. `hydra-autopilot.md`
 * scoped the `## NEVER END WAITING` preamble to `dev_orch` / `qa_orch` only
 * (line ~558), and `hydra-target-build.md` Step 2 said the parent "only does
 * pre-flight + relays the summary" with no instruction to block on the child.
 *
 * Two follow-on recurrences (runs `ad07927f`, `b123538c`) showed that simply
 * copying the `dev_orch`/`qa_orch` flat Agent-tool ban onto `dev_target`
 * would be WRONG, not just insufficient: `hydra-target-build`'s delegated
 * mode exists for context-window protection (#1782), and the same flat ban
 * degraded `qa_orch` when applied there (run 8e50460f skipped its
 * Standards+Spec Agent fan-out). The operator's resolution (2026-08-31
 * `/hydra-review`, option 2): delegation stays permitted, but the parent
 * must poll the child to a terminal state in the FOREGROUND before its final
 * message — never end the turn on a still-running child, a narrated future
 * wait, or an armed Monitor (the `ad07927f` recurrence rearmed a Monitor a
 * SECOND time after being woken once, and a follow-on self-report claimed a
 * push and merge that had not actually happened).
 *
 * Same shape as test/autopilot-dev-target-preamble.test.mts (#4178) and
 * test/autopilot-forbidden-ending-preamble.test.mts (#4109/#4158): parse the
 * playbooks, pin the load-bearing clause strings on whitespace-normalised
 * text (wrapped lines must not defeat matching), fail loudly on drift.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTOPILOT_PLAYBOOK = join(
  __dirname,
  "..",
  "docs",
  "operator-playbooks",
  "hydra-autopilot.md",
);
const TARGET_BUILD_PLAYBOOK = join(
  __dirname,
  "..",
  "docs",
  "operator-playbooks",
  "hydra-target-build.md",
);

const autopilot = readFileSync(AUTOPILOT_PLAYBOOK, "utf8");
const targetBuild = readFileSync(TARGET_BUILD_PLAYBOOK, "utf8");
const targetBuildFlat = targetBuild.replace(/\s+/g, " ").trim();

/**
 * Extract every fenced `## NEVER END WAITING` block, whitespace-normalised so
 * wrapped lines don't defeat matching. Mirrors
 * test/autopilot-forbidden-ending-preamble.test.mts's single-block extractor,
 * generalised to find ALL such blocks (that file only ever expects one, and
 * relies on it being the FIRST occurrence in the file — a load-bearing
 * ordering constraint this suite also verifies below).
 */
function neverEndWaitingBlocks(
  text: string,
): { heading: string; body: string; index: number }[] {
  const blocks: { heading: string; body: string; index: number }[] = [];
  let searchFrom = 0;
  for (;;) {
    const start = text.indexOf("## NEVER END WAITING", searchFrom);
    if (start === -1) break;
    const end = text.indexOf("\n```", start);
    assert.ok(
      end !== -1,
      `a "## NEVER END WAITING" block starting at ${start} has no closing fence`,
    );
    const body = text.slice(start, end);
    const headingEnd = body.indexOf("\n");
    blocks.push({
      heading: body.slice(0, headingEnd === -1 ? body.length : headingEnd).trim(),
      body: body.replace(/\s+/g, " ").trim(),
      index: start,
    });
    searchFrom = end;
  }
  return blocks;
}

const blocks = neverEndWaitingBlocks(autopilot);
// As of issue #4272, `dev_orch` and `qa_orch` no longer share one block —
// each carries its own variant. The dev_orch block is the one whose heading
// carries neither "dev_target" nor "qa_orch"; it retains the original flat
// Agent-tool ban unchanged (see test/autopilot-forbidden-ending-preamble.test.mts,
// which independently pins that block via a first-match extractor).
const devOrchBlock = blocks.find(
  (b) => !b.heading.includes("dev_target") && !b.heading.includes("qa_orch"),
);
const qaOrchBlock = blocks.find((b) => b.heading.includes("qa_orch"));
const devTargetBlock = blocks.find((b) => b.heading.includes("dev_target"));

describe("autopilot dev_target forbidden-ending preamble — exists and is additive (#4196)", () => {
  test("exactly three NEVER END WAITING blocks exist in hydra-autopilot.md", () => {
    assert.equal(
      blocks.length,
      3,
      `expected exactly three "## NEVER END WAITING" blocks (dev_orch, qa_orch, dev_target), found ${blocks.length}`,
    );
  });

  test("a dev_target-scoped block exists", () => {
    assert.ok(
      devTargetBlock,
      "hydra-autopilot.md is missing a dev_target-scoped '## NEVER END WAITING' block (issue #4196)",
    );
  });

  test("file order is dev_orch -> dev_target -> qa_orch (#4272 INV-1)", () => {
    // test/autopilot-forbidden-ending-preamble.test.mts's extractor takes the
    // FIRST "## NEVER END WAITING" match — inserting the dev_target block
    // earlier would make that existing regression test silently pin the
    // wrong block (design-concept invariant for #4196). The design-concept
    // artifact for issue #4272 (INV-1) fixes the dev_target/qa_orch relative
    // order: qa_orch is appended AFTER the dev_target block's closing fence,
    // not before it.
    assert.ok(devOrchBlock && qaOrchBlock && devTargetBlock);
    assert.ok(
      devTargetBlock.index > devOrchBlock.index,
      "the dev_target NEVER END WAITING block must appear AFTER the dev_orch block in hydra-autopilot.md",
    );
    assert.ok(
      qaOrchBlock.index > devTargetBlock.index,
      "the qa_orch NEVER END WAITING block must appear AFTER the dev_target block in hydra-autopilot.md (issue #4272 INV-1)",
    );
  });

  test("the pre-existing dev_orch block still carries the flat Agent-tool ban (out of scope per the operator decision)", () => {
    assert.ok(devOrchBlock);
    assert.match(
      devOrchBlock.body,
      /Do NOT use the Agent tool at all\. Search with Grep\/Glob\/Read yourself, inline, in THIS session\. There is no sub-agent that keeps you alive\./,
      "the dev_orch block's flat Agent-tool ban must remain byte-for-byte intact — #4196 is additive, not a rewrite of the existing block, and #4272 narrows qa_orch only",
    );
  });
});

describe("autopilot dev_target forbidden-ending preamble — permits the delegated spawn, forbids going quiet (#4196)", () => {
  test("the variant explicitly permits Agent(run_in_background=true) for the build child", () => {
    assert.ok(devTargetBlock);
    assert.match(
      devTargetBlock.body,
      /PERMITS spawning `Agent\(run_in_background=true\)` for the build child/,
      "the dev_target variant must explicitly permit the hydra-target-build delegated-mode spawn — a flat Agent-tool ban here would contradict hydra-target-build's own contract",
    );
  });

  test("the variant does NOT carry the dev_orch/qa_orch flat Agent-tool ban", () => {
    assert.ok(devTargetBlock);
    assert.doesNotMatch(
      devTargetBlock.body,
      /Do NOT use the Agent tool at all/,
      "the dev_target variant must not ban the Agent tool outright — that would recreate the qa_orch fan-out degradation observed on run 8e50460f",
    );
  });

  test("the variant forbids going quiet while the delegated child is still running", () => {
    assert.ok(devTargetBlock);
    assert.match(
      devTargetBlock.body,
      /forbidden ending is spawning the child and then going quiet/,
    );
  });

  test("the variant names re-arming a wait after a wake-up as the same forbidden ending repeated", () => {
    // ad07927f recurrence: the dispatch was woken by its own armed Monitor
    // and re-armed a second wait instead of finishing. The variant must
    // close this loop explicitly, not just the first-wait case.
    assert.ok(devTargetBlock);
    assert.match(
      devTargetBlock.body,
      /re-arming the wait and ending your turn again is the same forbidden ending repeated/,
    );
  });

  test("the variant requires polling the child to a terminal state in the FOREGROUND", () => {
    assert.ok(devTargetBlock);
    assert.match(
      devTargetBlock.body,
      /poll it to a terminal state in the FOREGROUND/,
    );
  });

  test("the variant instructs commit-and-push BEFORE verification, same as dev_orch/qa_orch", () => {
    assert.ok(devTargetBlock);
    assert.match(
      devTargetBlock.body,
      /Commit and push your work to the branch BEFORE running verification/,
    );
  });

  test("the variant warns against self-reporting a push/merge that was not directly observed", () => {
    // ad07927f: a follow-on self-report claimed "committed, and pushed...
    // CI went green... merged" for a commit that was never actually pushed.
    assert.ok(devTargetBlock);
    assert.match(devTargetBlock.body, /Your final report is not verification/);
    assert.match(
      devTargetBlock.body,
      /never assert a push, a green run, or a merge you did not just watch happen/,
    );
  });
});

describe("autopilot dispatch action-to-tool table — dev_target forbidden-ending split documented (#4196)", () => {
  test("the dispatch row names the dev_target forbidden-ending preamble variant", () => {
    const dispatchRow = autopilot
      .split("\n")
      .find((l) => l.startsWith("| `dispatch` |"));
    assert.ok(dispatchRow, "the dispatch action-to-tool table row is missing");
    assert.match(
      dispatchRow,
      /dev_target.*forbidden-ending preamble variant.*issue #4196/,
      "the dispatch table's dev_target exception must also point at the new forbidden-ending preamble variant, alongside the existing worktree-guard split note (#4178)",
    );
  });
});

describe("hydra-target-build.md Step 2 — parent blocks on the delegated child in the foreground (#4196)", () => {
  test("delegated mode states the parent blocks on the child before its final message", () => {
    assert.match(
      targetBuildFlat,
      /blocks on the child in the FOREGROUND until it reaches a terminal state/,
      "hydra-target-build.md Step 2 must state the parent blocks on the delegated child in the FOREGROUND before relaying its outcome",
    );
  });

  test("relaying a summary for a still-running child is named as a forbidden ending", () => {
    assert.match(
      targetBuildFlat,
      /relaying a summary for a still-running child.*is a forbidden ending/,
      "hydra-target-build.md must explicitly name 'relaying a summary for a still-running child' as a forbidden ending, not a valid handoff",
    );
  });

  test("Step 2's delegated-mode instruction restates the foreground poll at the spawn site", () => {
    // The spawn instruction itself (not just the earlier Step-2 preamble)
    // must carry the poll-to-terminal-state instruction, per the operator
    // brief's observation that a rule stated only far away from the actual
    // spawn call is easy to satisfy the letter of while violating the spirit.
    const stepTwoStart = targetBuild.indexOf("## Step 2: Delegate");
    assert.ok(stepTwoStart !== -1, "Step 2 heading not found");
    const stepTwoSection = targetBuild
      .slice(stepTwoStart, stepTwoStart + 2000)
      .replace(/\s+/g, " ");
    assert.match(stepTwoSection, /poll the child to a terminal state in the FOREGROUND/);
    assert.match(stepTwoSection, /run_in_background=true/);
  });
});

/**
 * Regression guard — issue #4272: the #3866 "## NEVER END WAITING" preamble's
 * blanket "Do NOT use the Agent tool at all" silently degraded `qa_orch` from
 * its designed 2-reviewer (Standards + Spec) parallel fan-out to a single
 * inline review, because `hydra-qa` step 7 IS an `Agent(*)`-based fan-out by
 * construction and every spawn in it already carries the #3789/#3880
 * blocking mandate (`run_in_background: false`) — mechanically incapable of
 * the #3866 end-turn-on-a-background-child hazard the flat ban exists to
 * prevent.
 *
 * ROOT CAUSE (autopilot run `8e50460f`, turn 7, 2026-08-28): a `qa_orch`
 * dispatch reviewing PR #4270 / issue #4257 complied with the flat wording by
 * skipping the parallel Standards+Spec fan-out and reviewing both axes
 * itself, inline, in one context — a competent single review, but not the
 * two independent, context-isolated reviewers `hydra-qa/SKILL.md` (lines
 * 48/103) designs for. Nothing errored; only a disclosure line the agent
 * volunteered revealed the deviation.
 *
 * Operator decision (2026-08-31 `/hydra-review`, then reaffirmed
 * 2026-09-03 once blocker #4196 shipped): narrow the prohibition from the
 * *tool* to the *hazard*, per class. `dev_orch` keeps its blanket ban
 * unchanged (pinned by test/autopilot-forbidden-ending-preamble.test.mts and
 * test/autopilot-dev-target-forbidden-ending-preamble.test.mts). `qa_orch`
 * gets a variant that still forbids ending the turn on a background spawn,
 * but explicitly permits the BLOCKING (`run_in_background: false`) reviewer
 * spawns step 7's fan-out requires — a blocking spawn cannot outlive the
 * turn, so it sits in the same safety class as a foreground `Bash` call.
 *
 * Same shape as test/autopilot-dev-target-forbidden-ending-preamble.test.mts
 * (#4196): parse the playbook, pin the load-bearing clause strings on
 * whitespace-normalised text (wrapped lines must not defeat matching), fail
 * loudly on drift.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLAYBOOK = join(__dirname, "..", "docs", "operator-playbooks", "hydra-autopilot.md");

const autopilot = readFileSync(PLAYBOOK, "utf8");

/**
 * Extract every fenced `## NEVER END WAITING` block, whitespace-normalised so
 * wrapped lines don't defeat matching. Mirrors the extractor in
 * test/autopilot-dev-target-forbidden-ending-preamble.test.mts.
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
const qaOrchBlock = blocks.find((b) => b.heading.includes("qa_orch"));

describe("autopilot qa_orch forbidden-ending preamble — hazard-scoped variant exists (#4272)", () => {
  test("a qa_orch-scoped block exists", () => {
    assert.ok(
      qaOrchBlock,
      "hydra-autopilot.md is missing a qa_orch-scoped '## NEVER END WAITING' block (issue #4272)",
    );
  });

  test("the qa_orch block does NOT carry the flat Agent-tool ban", () => {
    assert.ok(qaOrchBlock);
    assert.doesNotMatch(
      qaOrchBlock.body,
      /Do NOT use the Agent tool at all/,
      "the qa_orch variant must not ban the Agent tool outright — that recreates the Standards+Spec fan-out degradation observed on run 8e50460f",
    );
  });

  test("the qa_orch block forbids spawning a background agent and ending the turn on it", () => {
    assert.ok(qaOrchBlock);
    assert.match(
      qaOrchBlock.body,
      /Do NOT spawn a background agent \(`Agent\(run_in_background: true\)`\) and end\s+your turn waiting on it/,
    );
  });

  test("the qa_orch block explicitly permits blocking reviewer spawns directed by step 7", () => {
    assert.ok(qaOrchBlock);
    assert.match(
      qaOrchBlock.body,
      /You MAY spawn blocking reviewer sub-agents \(`run_in_background: false`\) where this skill's step 7 fan-out directs/,
    );
  });

  test("the qa_orch block explains a blocking spawn cannot outlive the turn", () => {
    assert.ok(qaOrchBlock);
    assert.match(
      qaOrchBlock.body,
      /a\s*blocking spawn cannot outlive your turn/,
    );
  });

  test("the qa_orch block still forbids ending the turn with ANY child still running, blocking or not", () => {
    assert.ok(qaOrchBlock);
    assert.match(
      qaOrchBlock.body,
      /Never end\s*your turn with any child still running, blocking or not/,
    );
  });

  test("the qa_orch block names a backgrounded Bash process and an armed Monitor as NOT keeping the dispatch alive", () => {
    assert.ok(qaOrchBlock);
    assert.match(
      qaOrchBlock.body,
      /backgrounded Bash process and an armed Monitor are the same class of handle/,
    );
  });

  test("the qa_orch block instructs commit-and-push BEFORE running verification, same as dev_orch", () => {
    assert.ok(qaOrchBlock);
    assert.match(
      qaOrchBlock.body,
      /Commit and push your work to the branch BEFORE running verification/,
    );
  });

  test("the qa_orch block's final-message contract names a verdict, not a PR, as the deliverable", () => {
    assert.ok(qaOrchBlock);
    assert.match(
      qaOrchBlock.body,
      /your final message reports one of: a verdict was posted, OR a\s*hard blocker via ## Friction Report/,
    );
  });
});

describe("autopilot dispatch action-to-tool table — qa_orch forbidden-ending split documented (#4272)", () => {
  test("the dispatch row names the qa_orch forbidden-ending preamble variant", () => {
    const dispatchRow = autopilot
      .split("\n")
      .find((l) => l.startsWith("| `dispatch` |"));
    assert.ok(dispatchRow, "the dispatch action-to-tool table row is missing");
    assert.match(
      dispatchRow,
      /qa_orch.*forbidden-ending preamble variant.*issue #4272/,
      "the dispatch table must point qa_orch at its own forbidden-ending preamble variant, alongside the existing dev_target split note (#4196)",
    );
  });
});

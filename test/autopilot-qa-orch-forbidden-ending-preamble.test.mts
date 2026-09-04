/**
 * Regression guard — issue #4272: the #3866 "## NEVER END WAITING" preamble's
 * blanket "Do NOT use the Agent tool at all" silently degraded `qa_orch` from
 * its designed 2-reviewer (Standards + Spec) parallel fan-out to a single
 * inline review, because `hydra-qa` step 7 IS an `Agent(*)`-based fan-out by
 * construction and every spawn in it already carries the #3789/#3880
 * blocking mandate (`run_in_background: false`) plus the step 7.5
 * incomplete-fan-out exit — mechanically incapable of the #3866 end-turn-
 * on-a-background-child hazard the flat ban exists to prevent.
 *
 * ROOT CAUSE (autopilot run `8e50460f`, turn 7, 2026-08-28): a `qa_orch`
 * dispatch reviewing PR #4270 / issue #4257 complied with the flat wording by
 * skipping the parallel Standards+Spec fan-out and reviewing both axes
 * itself, inline, in one context — a competent single review, but not the
 * two independent, context-isolated reviewers `hydra-qa/SKILL.md` (lines
 * 48/103) designs for. Nothing errored; only a disclosure line the agent
 * volunteered revealed the deviation.
 *
 * Operator decision (2026-08-31 `/hydra-review`, reaffirmed 2026-09-03 once
 * blocker #4196 shipped) + design-concept artifact `issue-4272`: narrow the
 * prohibition from the *tool* to the *hazard*, per class. `dev_orch` keeps
 * its blanket ban unchanged (pinned by
 * test/autopilot-forbidden-ending-preamble.test.mts and
 * test/autopilot-dev-target-forbidden-ending-preamble.test.mts). `qa_orch`
 * gets a THIRD, separately-headed block — "## NEVER END WAITING — qa_orch
 * blocking-fan-out variant (issue #4272)" — appended after the `dev_target`
 * block, that still forbids a background spawn (`Agent(run_in_background:
 * true)`) for ANY purpose and ending the turn on any live child, but
 * explicitly permits the BLOCKING (`run_in_background: false`) reviewer
 * spawns step 7's fan-out requires — a blocking spawn cannot outlive the
 * turn, so it sits in the same safety class as a foreground `Bash` call.
 *
 * Same shape as test/autopilot-dev-target-forbidden-ending-preamble.test.mts
 * (#4196): parse the playbook, pin the load-bearing clause strings on
 * whitespace-normalised text (wrapped lines must not defeat matching), fail
 * loudly on drift. Pins design-concept invariants INV-1..INV-5.
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
const devOrchBlock = blocks.find(
  (b) => !b.heading.includes("dev_target") && !b.heading.includes("qa_orch"),
);
const devTargetBlock = blocks.find((b) => b.heading.includes("dev_target"));
const qaOrchBlock = blocks.find((b) => b.heading.includes("qa_orch"));

describe("autopilot qa_orch forbidden-ending preamble — hazard-scoped variant exists, correctly ordered (#4272 INV-1)", () => {
  test("exactly three NEVER END WAITING blocks exist", () => {
    assert.equal(blocks.length, 3, `expected 3 blocks, found ${blocks.length}`);
  });

  test("the qa_orch block has the exact heading INV-3 requires", () => {
    assert.ok(qaOrchBlock, "hydra-autopilot.md is missing a qa_orch-scoped block (issue #4272)");
    assert.equal(
      qaOrchBlock.heading,
      "## NEVER END WAITING — qa_orch blocking-fan-out variant (issue #4272)",
    );
  });

  test("file order is dev_orch -> dev_target -> qa_orch", () => {
    assert.ok(devOrchBlock && devTargetBlock && qaOrchBlock);
    assert.ok(
      devOrchBlock.index < devTargetBlock.index,
      "the dev_orch block must precede the dev_target block",
    );
    assert.ok(
      devTargetBlock.index < qaOrchBlock.index,
      "the qa_orch block must be appended AFTER the dev_target block",
    );
  });
});

describe("autopilot qa_orch forbidden-ending preamble — never bans the tool, only the hazard (#4272 INV-3)", () => {
  test("the qa_orch block does NOT carry the flat Agent-tool ban", () => {
    assert.ok(qaOrchBlock);
    assert.doesNotMatch(
      qaOrchBlock.body,
      /Do NOT use the Agent tool at all/,
      "the qa_orch variant must not ban the Agent tool outright — that recreates the Standards+Spec fan-out degradation observed on run 8e50460f",
    );
  });

  test("the qa_orch block does NOT retain the retired read-only-helper carve-out", () => {
    assert.ok(qaOrchBlock);
    assert.doesNotMatch(qaOrchBlock.body, /Read-only helper sub-agents for search are fine/);
  });

  test("the permitted Agent use is named by mechanism (run_in_background: false, step 7, one message)", () => {
    assert.ok(qaOrchBlock);
    assert.match(
      qaOrchBlock.body,
      /ONLY where hydra-qa step 7 directs, ONLY\s*with `run_in_background: false`, and ONLY all in one message/,
    );
  });
});

describe("autopilot qa_orch forbidden-ending preamble — background spawn banned for ANY purpose (#4272 INV-4)", () => {
  test("bans Agent(run_in_background: true) for ANY purpose", () => {
    assert.ok(qaOrchBlock);
    assert.match(
      qaOrchBlock.body,
      /Do NOT spawn a background agent \(`Agent\(run_in_background: true\)`\) for ANY\s*purpose/,
    );
  });

  test("states NEVER end your turn with any child still running", () => {
    assert.ok(qaOrchBlock);
    assert.match(qaOrchBlock.body, /NEVER end your turn with any child still running/);
  });

  test("names the consequence: run 793fa896, background children cannot outlive the parent worktree", () => {
    assert.ok(qaOrchBlock);
    assert.match(qaOrchBlock.body, /run 793fa896 spawned 9\s*background children and quit/);
    assert.match(qaOrchBlock.body, /orphan-prune reaped the parent\s*worktree and every child died with it/);
  });

  test("requires step 7.5's incomplete-fan-out exit instead of aggregating a partial reviewer set", () => {
    assert.ok(qaOrchBlock);
    assert.match(
      qaOrchBlock.body,
      /run step 7\.5: if any reviewer came back empty, post\s*the incomplete-fan-out comment and exit — never aggregate a partial set/,
    );
  });
});

describe("autopilot qa_orch forbidden-ending preamble — shared hazard clauses survive (#4272)", () => {
  test("names a backgrounded Bash process and an armed Monitor as NOT keeping the dispatch alive", () => {
    assert.ok(qaOrchBlock);
    assert.match(
      qaOrchBlock.body,
      /backgrounded Bash process and an armed Monitor are the same class of handle/,
    );
  });

  test("the final-message contract names a verdict, or hydra-qa's own pre-verdict exit, as the deliverable", () => {
    assert.ok(qaOrchBlock);
    assert.match(
      qaOrchBlock.body,
      /your final message reports one of: a verdict was posted, OR\s*hydra-qa's own pre-verdict exit was executed/,
    );
  });
});

describe("autopilot forbidden-ending preamble — exactly one block per class (#4272 INV-5)", () => {
  test("the dev_orch block still carries the flat Agent-tool ban, byte-identical (INV-2)", () => {
    assert.ok(devOrchBlock);
    assert.match(
      devOrchBlock.body,
      /Do NOT use the Agent tool at all\. Search with Grep\/Glob\/Read yourself, inline, in THIS session\. There is no sub-agent that keeps you alive\./,
    );
    assert.match(
      devOrchBlock.body,
      /your final message reports one of: a PR is open \(dev_orch\) \/ a\s*verdict was posted \(qa_orch\), OR a hard/,
      "the dev_orch fenced block must stay byte-identical to the original text, including the vestigial '(qa_orch)' parenthetical — #4272 rescopes only the surrounding prose, not this block",
    );
  });

  test("the dispatch row states the three-way class -> block mapping", () => {
    const dispatchRow = autopilot.split("\n").find((l) => l.startsWith("| `dispatch` |"));
    assert.ok(dispatchRow);
    assert.match(dispatchRow, /never the `dev_orch` block/);
    assert.match(dispatchRow, /qa_orch.*forbidden-ending preamble variant.*issue #4272/);
  });

  test("the Safety rules list states the three-way class -> block mapping", () => {
    const safetyRulesStart = autopilot.indexOf("## Safety rules");
    assert.ok(safetyRulesStart !== -1, "hydra-autopilot.md is missing a '## Safety rules' section");
    const safetyRulesSection = autopilot
      .slice(safetyRulesStart, safetyRulesStart + 2000)
      .replace(/\s+/g, " ");
    assert.match(
      safetyRulesSection,
      /dev_orch.*gets the flat Agent-tool ban.*qa_orch.*gets the blocking-fan-out variant \(issue #4272\).*dev_target.*gets the delegated-mode variant \(issue #4196\)/,
    );
  });
});

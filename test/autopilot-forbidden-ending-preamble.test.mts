/**
 * Regression guard — the `## NEVER END WAITING` preamble appended to every
 * `dev_orch` / `qa_orch` dispatch must impose a FLAT Agent-tool ban, with no
 * read-only-helper carve-out (issue #4109).
 *
 * ROOT CAUSE (2026-08-16, autopilot run 62e8020d, turn 2): the post-#4052
 * preamble (PR #4091) ended with "Read-only helper sub-agents for search are
 * fine; handing off the implementation is not." A `dev_orch` dispatch
 * satisfied that sentence exactly — it spawned a read-only exploration
 * sub-agent and ended its turn "Now waiting for the exploration agent's
 * findings before writing code" — while still committing the actual harm,
 * which is ENDING THE TURN ON A CHILD. Cost: 111,625 tokens, 50 tool uses,
 * ~3.5 min, zero deliverable; recovered only via a manual SendMessage resume.
 * The clause banned delegating *the implementation*; it did not ban *going
 * quiet while a child runs*. Those are different failures and only the second
 * kills the dispatch (a background child does not keep the parent alive).
 *
 * #4052 closed the delegate-the-whole-skill route; #4109 closes the adjacent
 * delegate-a-slice-then-wait route by removing the carve-out entirely. The
 * flat ban matches the operator-memory guidance
 * (feedback_dispatch_must_not_spawn_nested_background_agent): fan-out from a
 * worktree-isolated dispatch is strictly worse on both axes — children cannot
 * outlive the parent's worktree (run 793fa896: ~790k tokens, zero verdicts,
 * every child died when the orphan-prune reaped the parent), while the
 * serial-inline re-dispatch of the same qa_orch work cost 260k and produced
 * 5 verdicts + 2 merges.
 *
 * Same shape as test/autopilot-auto-merge-no-self-approve.test.mts: parse
 * the playbook, fail loudly if a future edit re-introduces the carve-out.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLAYBOOK = join(__dirname, "..", "docs", "operator-playbooks", "hydra-autopilot.md");

/**
 * Extract the fenced `## NEVER END WAITING` preamble block — the text the
 * playbook instructs the autopilot to append verbatim to every `dev_orch` /
 * `qa_orch` dispatch — whitespace-normalised so wrapped lines don't defeat
 * matching. The block opens with the `## NEVER END WAITING` heading inside a
 * fenced code block; the slice runs to that block's closing fence.
 */
function neverEndWaitingPreamble(playbook: string): string {
  const start = playbook.indexOf("## NEVER END WAITING");
  assert.ok(
    start !== -1,
    "hydra-autopilot.md is missing the NEVER END WAITING preamble block",
  );
  const end = playbook.indexOf("\n```", start);
  assert.ok(
    end !== -1,
    "the NEVER END WAITING preamble block has no closing fence",
  );
  return playbook.slice(start, end).replace(/\s+/g, " ").trim();
}

describe("autopilot forbidden-ending preamble — flat Agent-tool ban (#4109)", () => {
  const playbook = readFileSync(PLAYBOOK, "utf8");
  const preamble = neverEndWaitingPreamble(playbook);

  test("the preamble carries the flat Agent-tool ban", () => {
    assert.match(
      preamble,
      /Do NOT use the Agent tool at all\. Search with Grep\/Glob\/Read yourself, inline, in THIS session\. There is no sub-agent that keeps you alive\./,
      "the NEVER END WAITING preamble must carry the flat Agent-tool ban (issue #4109): 'Do NOT use the Agent tool at all. Search with Grep/Glob/Read yourself, inline, in THIS session. There is no sub-agent that keeps you alive.'",
    );
  });

  test("the preamble does NOT retain the read-only-helper carve-out", () => {
    assert.doesNotMatch(
      preamble,
      /Read-only helper sub-agents for search are fine/,
      "the NEVER END WAITING preamble must NOT carry the 'Read-only helper sub-agents for search are fine' carve-out — run 62e8020d proved an agent can satisfy it verbatim while still ending its turn on a child (issue #4109).",
    );
  });

  test("the carve-out sentence is gone from the playbook entirely", () => {
    assert.doesNotMatch(
      playbook.replace(/\s+/g, " "),
      /Read-only helper sub-agents for search are fine/,
      "the carve-out sentence must not survive anywhere in hydra-autopilot.md — quoted in prose it reads as sanctioned guidance and seeds the next recurrence.",
    );
  });

  test("the edit was sentence-level: the you-must-do-this-yourself clause survives", () => {
    assert.match(
      preamble,
      /You MUST do this work yourself, in THIS session\./,
      "the flat ban REPLACES the carve-out sentence; the surrounding preamble clauses (the reap-consequence rationale) must survive — issue #4109 AC1 is a sentence replacement, not a paragraph rewrite.",
    );
  });
});

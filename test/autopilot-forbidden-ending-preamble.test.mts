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

/**
 * Regression guard — the `## NEVER END WAITING` preamble must also name a
 * backgrounded Bash process and an armed Monitor as evasion routes that do
 * NOT keep a dispatch session alive, and must instruct commit-and-push
 * BEFORE verification (issue #4158, #4052/#4109 follow-up).
 *
 * ROOT CAUSE (2026-08-19, autopilot run 54dc0756, turn 2): a `dev_orch`
 * dispatch pinned to #4153 did ~10 minutes of real implementation, then
 * backgrounded `npm test` and armed a Monitor to resume it, ending its turn
 * with the message "I'll pause here and resume automatically on that
 * notification". Neither a backgrounded Bash process nor a Monitor keeps a
 * print-mode dispatch session alive — reap.py recorded the session's end as
 * a completion with zero deliverable, and the three modified files sat
 * uncommitted, minutes from the hourly worktree-orphan-prune. #4052 closed
 * the delegate-the-whole-skill route and #4109 closed the
 * delegate-a-slice-then-wait route; this is the third route, which uses no
 * sub-agent at all.
 */
describe("autopilot forbidden-ending preamble — Bash/Monitor evasion + commit-before-verify (#4158)", () => {
  const playbook = readFileSync(PLAYBOOK, "utf8");
  const preamble = neverEndWaitingPreamble(playbook);

  test("the preamble names a backgrounded Bash process and an armed Monitor as NOT keeping the dispatch alive", () => {
    assert.match(
      preamble,
      /backgrounded Bash process and an armed Monitor are the same class of handle/,
      "the NEVER END WAITING preamble must explicitly generalize the 'does not keep you alive' framing to a backgrounded Bash process and an armed Monitor (issue #4158) — a Monitor-armed resume is not a route back into a stalled dispatch session.",
    );
  });

  test("the preamble instructs commit-and-push BEFORE running verification", () => {
    assert.match(
      preamble,
      /Commit and push your work to the branch BEFORE running verification/,
      "the NEVER END WAITING preamble must instruct the dispatch to commit and push to the branch BEFORE npm test / typecheck, not after (issue #4158) — otherwise an interrupted dispatch's work is destroyed by the worktree-orphan-prune instead of being resumable from a pushed branch.",
    );
  });

  test("the flat Agent-tool ban survives the #4158 edit unchanged", () => {
    assert.match(
      preamble,
      /Do NOT use the Agent tool at all\. Search with Grep\/Glob\/Read yourself, inline, in THIS session\. There is no sub-agent that keeps you alive\./,
      "the #4158 additions must be appended after the existing text, not replace it — the #4109 flat Agent-tool ban must remain byte-for-byte intact.",
    );
  });
});

/**
 * Regression guard — `dev_target` gets its OWN forbidden-ending preamble
 * variant, additive after the existing dev_orch/qa_orch block, that permits
 * the Step 2 build-delegation spawn while still forbidding the parent from
 * ending its turn on a live child (issue #4196).
 *
 * ROOT CAUSE: dev_target carried no forbidden-ending preamble at all, and
 * hydra-target-build's own Step 2 instructs the parent to spawn a nested
 * Agent(run_in_background=true) for context-window protection — so a
 * dispatch that followed its skill exactly still ended its turn ~100s in
 * with zero deliverable (autopilot run 155f6d3c). Pasting the existing flat
 * "Do NOT use the Agent tool at all" block onto dev_target was rejected
 * (operator decision, option 2, 2026-08-31 /hydra-review): it would
 * contradict hydra-target-build's own delegating design, the way an
 * identical flat ban already broke qa_orch's Standards+Spec fan-out when
 * tried (run 8e50460f).
 */
describe("autopilot forbidden-ending preamble — dev_target variant (#4196)", () => {
  const playbook = readFileSync(PLAYBOOK, "utf8");

  test("the dev_target variant block exists and is positioned AFTER the existing dev_orch/qa_orch block", () => {
    const originalIdx = playbook.indexOf("## NEVER END WAITING");
    assert.ok(originalIdx !== -1, "the original dev_orch/qa_orch block must still exist");
    const variantIdx = playbook.indexOf("## NEVER END WAITING — dev_target variant");
    assert.ok(
      variantIdx !== -1,
      "hydra-autopilot.md is missing the dev_target variant of the NEVER END WAITING preamble (issue #4196)",
    );
    assert.ok(
      variantIdx > originalIdx,
      "the dev_target variant block must be positioned AFTER the original dev_orch/qa_orch block — " +
        "test's own neverEndWaitingPreamble() helper does playbook.indexOf('## NEVER END WAITING') and " +
        "takes the FIRST match, so inserting the variant earlier would make that helper silently pin the " +
        "wrong block (issue #4196 design-concept INV-2).",
    );
  });

  function devTargetVariantPreamble(pb: string): string {
    const start = pb.indexOf("## NEVER END WAITING — dev_target variant");
    assert.ok(start !== -1, "dev_target NEVER END WAITING variant block is missing");
    const end = pb.indexOf("\n```", start);
    assert.ok(end !== -1, "the dev_target variant block has no closing fence");
    return pb.slice(start, end).replace(/\s+/g, " ").trim();
  }

  const variant = devTargetVariantPreamble(playbook);

  test("the dev_target variant permits Agent(run_in_background=true) for the Step 2 build delegation", () => {
    assert.match(
      variant,
      /you MAY spawn a nested `Agent\(run_in_background=true\)`\s*for hydra-target-build's Step 2 build delegation/,
      "the dev_target variant must explicitly permit the Step 2 delegation spawn — unlike the flat dev_orch/qa_orch ban, delegation itself is not the forbidden behaviour here (issue #4196).",
    );
  });

  test("the dev_target variant forbids ending the turn while the delegated child is still running", () => {
    assert.match(
      variant,
      /What is forbidden is ending your turn WHILE THAT CHILD IS STILL RUNNING/,
      "the dev_target variant must name 'ending the turn on a live child' — not delegation itself — as the forbidden behaviour (issue #4196).",
    );
  });

  test("the dev_target variant does NOT re-permit backgrounding elsewhere (npm test / Monitor stay forbidden)", () => {
    assert.match(
      variant,
      /This block does NOT re-permit backgrounding elsewhere.*permitted ONLY for the Step 2 build-delegation spawn/,
      "the Agent(run_in_background=true) carve-out must be scoped ONLY to the Step 2 spawn — backgrounded npm test / an armed Monitor must remain forbidden endings for dev_target exactly as they are for dev_orch/qa_orch (issue #4196 design-concept INV-3).",
    );
    assert.match(
      variant,
      /Backgrounding `npm test`, a CI poll, or any other command, or arming a Monitor to resume you later, remains exactly as forbidden for `dev_target` as it is for `dev_orch`\/`qa_orch`/,
      "the dev_target variant must explicitly restate that backgrounding non-delegation work remains forbidden (issue #4196 design-concept INV-3).",
    );
  });

  test("the dev_target variant's three-state ending matches the general framing (PR / verdict / Friction Report)", () => {
    assert.match(
      variant,
      /Your final message must report one of: a PR is open, a verdict was posted, or a hard blocker via ## Friction Report/,
      "the dev_target variant's closing three-state rule must match the general NEVER END WAITING framing (issue #4196 design-concept INV-1).",
    );
  });

  test("the dev_target variant instructs commit-and-push BEFORE running verification, same as the general block", () => {
    assert.match(
      variant,
      /Commit and push your work to the branch BEFORE running verification/,
      "the dev_target variant must carry the same commit-before-verify discipline as the general block (issue #4158/#4196).",
    );
  });

  test("the action-to-tool dispatch entry documents the new forbidden-ending split alongside the #4178 worktree-guard split", () => {
    assert.match(
      playbook,
      /forbidden-ending.*preamble carries a parallel split \(issue #4196\)/,
      "the dispatch action-to-tool table entry must document that dev_target carries TWO class-specific preambles — the #4178 worktree-guard split and this #4196 forbidden-ending split (issue #4196 design-concept INV-6).",
    );
  });

  test("hydra-target-build.md Step 2 states the parent blocks on the child in the foreground before its final message", () => {
    const buildPlaybook = readFileSync(
      join(__dirname, "..", "docs", "operator-playbooks", "hydra-target-build.md"),
      "utf8",
    );
    assert.match(
      buildPlaybook,
      /The parent MUST block on the child in the FOREGROUND before its final message \(issue #4196\)/,
      "hydra-target-build.md Step 2 must restate the foreground-blocking obligation at the point the delegated spawn actually happens, so it agrees with the hydra-autopilot.md preamble instead of recreating the #4196/#4272 contradiction (design-concept INV-4).",
    );
    assert.match(
      buildPlaybook,
      /Relaying a summary for a still-running child.*is a \*\*forbidden ending\*\*/,
      "hydra-target-build.md Step 2 must explicitly name 'relaying a summary for a still-running child' as a forbidden ending, matching the hydra-autopilot.md preamble wording (design-concept INV-4).",
    );
  });

  test("dev_orch/qa_orch's existing forbidden-ending text and hydra-target-build's delegated-mode spawn shape are untouched (out of scope per the operator decision)", () => {
    assert.match(
      playbook.replace(/\s+/g, " "),
      /Do NOT use the Agent tool at all\. Search with Grep\/Glob\/Read yourself, inline, in THIS session\. There is no sub-agent that keeps you alive\./,
      "the existing dev_orch/qa_orch flat Agent-tool ban must remain byte-for-byte intact — rejected option 1 was to alter it (issue #4196 design-concept INV-7).",
    );
    const buildPlaybook = readFileSync(
      join(__dirname, "..", "docs", "operator-playbooks", "hydra-target-build.md"),
      "utf8",
    );
    assert.match(
      buildPlaybook,
      /spawn the child with the prompt below using `Agent\(run_in_background=true\)`/,
      "hydra-target-build's delegated mode must still spawn via Agent(run_in_background=true) — rejected option 1 was to drop the delegating mode itself (issue #4196 design-concept INV-7).",
    );
  });
});

/**
 * Regression guard — issue #4178: the shared worktree-guard preamble is a
 * guaranteed false-abort for `dev_target`, the one dispatch class launched
 * WITHOUT harness worktree isolation (#3889).
 *
 * ROOT CAUSE (autopilot run 84b070ff, turn 2; third confirmed recurrence
 * 6320c46f, 2026-08-31): the mandatory preamble instructs
 * `cwd == /home/gabe/hydra → ABORT`, and safety rule 2 mandated that same
 * preamble for `dev_target` / `dev_orch` alike. But #3889 launches
 * `dev_target` with NO `isolation="worktree"`, so its cwd at launch IS
 * `/home/gabe/hydra` — the expected, correct state. A compliant `dev_target`
 * subagent therefore aborts at its first tool call 100% of the time (~46k
 * tokens for zero deliverable per occurrence). The fix splits the preamble
 * into two variants: the default (unchanged) for every harness-isolated
 * class, and a `dev_target` variant that REPLACES it — never composes with
 * it — asserting the real invariant ("never Edit/Write into either main
 * checkout"), not the false one ("your cwd must be a worktree").
 *
 * Assertions pin the LOAD-BEARING clause strings (the ABORT conditions, the
 * write prohibition, the replace-don't-compose composition rule), not
 * headings or step numbers — same discipline as
 * test/hydra-target-build-worktree-guard.test.mts (the
 * `playbook-text-asserted-by-test` friction, 11× recurrence, issue #1899).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLAYBOOK = join(
  __dirname,
  "..",
  "docs",
  "operator-playbooks",
  "hydra-autopilot.md",
);
const playbook = readFileSync(PLAYBOOK, "utf8");
const flat = playbook.replace(/\s+/g, " ").trim();

/**
 * Extract every fenced code block whose content opens with the CRITICAL
 * SAFETY RULE heading — the prompt-ready preamble blocks the playbook
 * instructs the composer to prepend verbatim to code-writing dispatches.
 * Whitespace-normalised so wrapped lines don't defeat matching.
 */
function safetyRuleBlocks(text: string): string[] {
  const blocks: string[] = [];
  const fence = /```[^\n]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    const body = m[1];
    if (body.includes("## CRITICAL SAFETY RULE")) {
      blocks.push(body.replace(/\s+/g, " ").trim());
    }
  }
  return blocks;
}

const blocks = safetyRuleBlocks(playbook);
// The default block is the safety preamble that does NOT name dev_target;
// the variant is the one whose heading carries "dev_target variant".
const defaultBlock = blocks.find((b) => !b.includes("dev_target"));
const targetVariant = blocks.find((b) => b.includes("dev_target variant"));

describe("autopilot worktree-guard preamble — default variant unchanged (#4178)", () => {
  test("the default safety preamble keeps its cwd-ABORT contract for harness-isolated classes", () => {
    // dev_orch and every other class launched with isolation="worktree" keep
    // today's preamble byte-identical (design-concept INV-2 for issue #4178).
    // The whole normalized block is compared for equality, not clause
    // matchers, so no wording inside it can drift either.
    assert.ok(defaultBlock, "the default CRITICAL SAFETY RULE block is missing");
    assert.equal(
      defaultBlock,
      "## CRITICAL SAFETY RULE — READ FIRST " +
        "Run `pwd` and `git rev-parse --git-dir` first. " +
        "- Worktree path AND `.git/worktrees/...` gitdir → proceed. " +
        "- cwd == `/home/gabe/hydra` (or `/home/gabe/hydra-betting`) → ABORT. " +
        "No fallback. No `git checkout` in the main tree.",
      "the default preamble must stay byte-identical (whitespace-normalised) for harness-isolated classes",
    );
  });

  test("exactly one default block exists — the split did not fork the orchestrator path", () => {
    const defaults = blocks.filter((b) => !b.includes("dev_target"));
    assert.equal(
      defaults.length,
      1,
      `expected exactly one non-dev_target CRITICAL SAFETY RULE block, found ${defaults.length}`,
    );
  });
});

describe("autopilot worktree-guard preamble — dev_target variant (#4178)", () => {
  test("a dev_target variant block exists", () => {
    assert.ok(
      targetVariant,
      "hydra-autopilot.md is missing the dev_target variant of the CRITICAL SAFETY RULE preamble (issue #4178)",
    );
  });

  test("the variant states the launch cwd is EXPECTED and NOT an abort condition", () => {
    // The false-abort clause itself: for the one class launched without
    // isolation="worktree" (#3889), pwd == /home/gabe/hydra is the correct
    // launch state. The variant must say so explicitly enough that a
    // compliant subagent cannot read it as an abort.
    assert.ok(targetVariant);
    assert.match(targetVariant, /pwd == \/home\/gabe\/hydra/);
    assert.match(targetVariant, /NOT an abort condition/);
  });

  test("the variant forbids writes into BOTH main checkouts", () => {
    // The invariant that actually binds dev_target is "never Edit/Write into
    // either main checkout" — not "your cwd must be a worktree". The variant
    // must name the write prohibition and BOTH trees.
    assert.ok(targetVariant);
    assert.match(targetVariant, /Edit\/Write/);
    assert.match(targetVariant, /\/home\/gabe\/hydra/);
    assert.match(targetVariant, /\/home\/gabe\/hydra-betting/);
  });

  test("the variant scopes ABORT to Step 0.6 worktree creation/verification failing", () => {
    // ABORT remains the right response to a real isolation failure — the
    // variant narrows the abort trigger from "cwd looks wrong" to "Step 0.6
    // could not establish the worktree".
    assert.ok(targetVariant);
    assert.match(targetVariant, /ABORT only if Step 0\.6/);
  });

  test("the variant carries no ABORT-on-launch-cwd instruction", () => {
    // Design-concept INV-1 for issue #4178: a composed dev_target prompt must
    // never contain a literal ABORT-on-cwd==/home/gabe/hydra instruction as
    // its first-read safety rule — that cwd is dev_target's expected start.
    // The default block's exact clause must be absent from the variant (the
    // composition rule above keeps the default block out of a dev_target
    // prompt entirely).
    assert.ok(targetVariant);
    assert.doesNotMatch(
      targetVariant,
      /cwd == `?\/home\/gabe\/hydra`? \(or `?\/home\/gabe\/hydra-betting`?\) → ABORT/,
      "the dev_target variant must not carry the default block's ABORT-on-launch-cwd clause",
    );
  });

  test("the variant still ABORTs on Step 0.6 failure and forbids main-checkout writes", () => {
    // Design-concept INV-3 for issue #4178: removing the false trigger must
    // not remove the real ones. Both halves asserted in one place — the
    // Step 0.6 abort trigger AND the never-Edit/Write-either-main-checkout
    // prohibition (with both trees named).
    assert.ok(targetVariant);
    assert.match(targetVariant, /ABORT only if Step 0\.6/);
    assert.match(targetVariant, /Edit\/Write/);
    assert.match(targetVariant, /\/home\/gabe\/hydra-betting/);
    assert.match(targetVariant, /\/home\/gabe\/hydra/);
  });
});

describe("autopilot playbook — variant composition rule (#4178)", () => {
  test("the playbook says the variant REPLACES the default for dev_target, never composes both", () => {
    // The original defect was a composed prompt carrying two mutually
    // exclusive gates. The composition rule — replace, don't append — is the
    // load-bearing instruction to whoever builds the dispatch prompt.
    assert.match(flat, /replaces the default/i);
    assert.match(flat, /never compose both/i);
  });

  test("the dispatch action-to-tool entry routes dev_target to the variant", () => {
    // The composer reads the dispatch table row when building the Agent
    // call; the dev_target exception there must name the variant, or the
    // table and the preamble section drift apart again.
    const dispatchRow = playbook
      .split("\n")
      .find((l) => l.startsWith("| `dispatch` |"));
    assert.ok(dispatchRow, "the dispatch action-to-tool table row is missing");
    assert.match(
      dispatchRow,
      /dev_target variant/i,
      "the dispatch table's dev_target exception must point at the dev_target variant preamble (issue #4178)",
    );
  });

  test("safety rule 2 reflects the two-variant split", () => {
    // Rule 2 previously read "mandatory for dev_orch / dev_target" as one
    // shared preamble — the sentence that made the false-abort mandatory.
    // It must now point at TWO named variants (design-concept INV-4 for
    // issue #4178) so a composing model cannot resolve the ambiguity toward
    // the false-abort reading again.
    const rules = playbook.slice(playbook.indexOf("## Safety rules"));
    assert.match(
      rules,
      /dev_target variant/i,
      "safety rule 2 must name the dev_target variant rather than mandating the default preamble for dev_target",
    );
    assert.match(
      rules,
      /default variant/i,
      "safety rule 2 must name the default variant too — two named variants, not one",
    );
  });
});

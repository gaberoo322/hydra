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
// Issue #4476: the variant moved out of the playbook body into a shared
// fragment @included by hydra-autopilot.md (and hydra-target-build Step 0.6),
// and it now covers every `isolation: "self"` class, not dev_target alone.
const FRAGMENT_REL = "_fragments/target-self-isolation-preamble.md";
const fragment = readFileSync(
  join(__dirname, "..", "docs", "operator-playbooks", FRAGMENT_REL),
  "utf8",
);

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
// The default block is the (only) safety preamble left in the playbook body;
// the variant is the one in the shared fragment whose heading carries
// "self-isolation variant".
const defaultBlock = blocks.find((b) => !b.includes("self-isolation variant"));
const targetVariant = safetyRuleBlocks(fragment).find((b) =>
  b.includes("self-isolation variant"),
);

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
    assert.equal(
      blocks.length,
      1,
      `expected exactly one CRITICAL SAFETY RULE block in the playbook body (the variant lives in the fragment), found ${blocks.length}`,
    );
  });
});

describe("autopilot worktree-guard preamble — self-isolation variant (#4178, #4476)", () => {
  test("a self-isolation variant block exists in the shared fragment, @included by the playbook", () => {
    assert.ok(
      targetVariant,
      `${FRAGMENT_REL} is missing the self-isolation variant of the CRITICAL SAFETY RULE preamble (issue #4476)`,
    );
    assert.match(playbook, /^@include _fragments\/target-self-isolation-preamble\.md$/m);
  });

  test("the variant states the launch cwd is EXPECTED and NOT an abort condition", () => {
    // The false-abort clause itself: for every class launched without
    // isolation="worktree" (#3889, #4476), pwd == /home/gabe/hydra is the correct
    // launch state. The variant must say so explicitly enough that a
    // compliant subagent cannot read it as an abort.
    assert.ok(targetVariant);
    assert.match(targetVariant, /pwd == \/home\/gabe\/hydra/);
    assert.match(targetVariant, /NOT an abort condition/);
  });

  test("the variant forbids writes into BOTH main checkouts", () => {
    // The invariant that actually binds a self-isolated class is "never
    // mutate either main checkout" — not "your cwd must be a worktree". The
    // variant must name the write prohibition and BOTH trees (the Target
    // through the seam var, never a literal — issue #4476 INV-8).
    assert.ok(targetVariant);
    assert.match(targetVariant, /Edit\/Write/);
    assert.match(targetVariant, /\/home\/gabe\/hydra/);
    assert.match(targetVariant, /\$TARGET_WS/);
    assert.doesNotMatch(fragment, /hydra-betting/, "the fragment must not name the Target literally");
  });

  test("the variant scopes ABORT to Target worktree creation/verification failing", () => {
    // ABORT remains the right response to a real isolation failure — the
    // variant narrows the abort trigger from "cwd looks wrong" to "the Target
    // worktree could not be established".
    assert.ok(targetVariant);
    assert.match(targetVariant, /ABORT only if the Target worktree creation or its rev-parse verification fails/);
  });

  test("the variant carries the precedence rule for playbook-prescribed Target git ops", () => {
    // Issue #4476 INV-5: cleanup/research/qa playbooks run git ops against the
    // Target checkout; the variant redirects them into $TARGET_WT so the
    // preamble and the skill body never contradict (a new #4178-shaped trap).
    assert.ok(targetVariant);
    assert.match(targetVariant, /PRECEDENCE/);
    assert.match(targetVariant, /cwd = \$TARGET_WT/);
    assert.match(targetVariant, /\$TARGET_APP_DIR\/\.worktrees\//);
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
      "the self-isolation variant must not carry the default block's ABORT-on-launch-cwd clause",
    );
    assert.doesNotMatch(targetVariant, /cwd == `?\/home\/gabe\/hydra`?[^,]*→ ABORT/);
  });

  test("the variant still ABORTs on worktree failure and forbids main-checkout writes", () => {
    // Design-concept INV-3 for issue #4178: removing the false trigger must
    // not remove the real ones. Both halves asserted in one place — the
    // worktree-failure abort trigger AND the never-mutate-either-main-checkout
    // prohibition (with both trees named).
    assert.ok(targetVariant);
    assert.match(targetVariant, /ABORT only if the Target worktree creation/);
    assert.match(targetVariant, /Edit\/Write/);
    assert.match(targetVariant, /\$TARGET_WS/);
    assert.match(targetVariant, /\/home\/gabe\/hydra/);
  });
});

describe("autopilot playbook — variant composition rule (#4178)", () => {
  test("the playbook says the variant REPLACES the default for self-isolated classes, never composes both", () => {
    // The original defect was a composed prompt carrying two mutually
    // exclusive gates. The composition rule — replace, don't append — is the
    // load-bearing instruction to whoever builds the dispatch prompt.
    assert.match(flat, /replaces the default/i);
    assert.match(flat, /never compose both/i);
  });

  test("the dispatch action-to-tool entry routes self-isolated dispatches to the variant via action.isolation", () => {
    // The composer reads the dispatch table row when building the Agent
    // call; it must key isolation (and the preamble choice) on the plan's
    // `action.isolation` field and name the variant, or the table and the
    // preamble section drift apart again. No class is hardcoded as THE
    // exception any more (issue #4476 INV-4).
    const dispatchRow = playbook
      .split("\n")
      .find((l) => l.startsWith("| `dispatch` |"));
    assert.ok(dispatchRow, "the dispatch action-to-tool table row is missing");
    assert.match(
      dispatchRow,
      /self-isolation variant/i,
      "the dispatch table must point self-isolated dispatches at the self-isolation variant preamble (issues #4178, #4476)",
    );
    assert.match(dispatchRow, /action\.isolation == "worktree"/);
    assert.match(dispatchRow, /action\.isolation == "self"/);
    assert.doesNotMatch(dispatchRow, /dev_target` dispatches ONLY/);
    assert.doesNotMatch(dispatchRow, /hydra-betting/);
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
      /self-isolation variant/i,
      "safety rule 2 must name the self-isolation variant rather than mandating the default preamble for self-isolated classes",
    );
    assert.match(
      rules,
      /default variant/i,
      "safety rule 2 must name the default variant too — two named variants, not one",
    );
  });
});

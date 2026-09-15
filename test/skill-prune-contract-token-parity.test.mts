/**
 * test/skill-prune-contract-token-parity.test.mts — proves the skill_prune
 * deletion-test scorer is NON-VACUOUS (issue #4268).
 *
 * # Why this file exists
 *
 * `evals/skill-prune.yaml` (pre-#4268) asserted a hardcoded `skill_body`
 * literal against itself through promptfoo's `echo` provider — a constant
 * string containing substrings of itself, which returns green for every
 * possible prune. `evals/scorers/contract-token-parity.ts` is the fix: a
 * pure function computing SET-based parity between a real before/after pair.
 * But the eval-gate step that runs it is itself advisory
 * (`.github/workflows/advisory-checks.yml`, exits 0 regardless of pass/fail
 * per docs/evals.md), so nothing about a promptfoo run PROVES the scorer's
 * own discrimination in the REQUIRED `test` job. This suite is that proof —
 * plain node:test assertions over the same pure functions the promptfoo
 * `file://` adapter calls, run inside `npm test`.
 *
 * Four cases (mirroring the module's own JSDoc contract):
 *   1. an over-prune dropping a load-bearing token FAILS
 *   2. a duplication/sediment-only prune (no load-bearing token dropped) PASSES
 *   3. identical before/after FAILS (nothing pruned, nothing to verify)
 *   4. a `before` with zero load-bearing tokens FAILS (cannot exercise the skill)
 *
 * This file imports the pure functions directly rather than only exercising
 * them through the promptfoo YAML fixture, so tsc pulls
 * `evals/scorers/contract-token-parity.ts` into `tsconfig.test.json`'s
 * program on the strength of this import — proving the module resolves
 * cleanly under `npm run typecheck:test` with no `promptfoo` import inside it
 * (issue #4268, INV-5).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  TOKEN_CLASSES,
  computeContractTokenParity,
  extractLoadBearingTokens,
  default as scoreContractTokenParity,
} from "../evals/scorers/contract-token-parity.ts";

const AUTOPILOT_PLAYBOOK_PATH = fileURLToPath(
  new URL("../docs/operator-playbooks/hydra-autopilot.md", import.meta.url),
);

/**
 * Strip the fenced code block (```...```) that CONTAINS `marker`, including
 * its opening/closing fences, from `text`. Used to simulate a Pocock-taxonomy
 * misjudgment that treats two `## CRITICAL SAFETY RULE` blocks sharing a
 * generic heading as duplicates and deletes one of them verbatim.
 */
function stripFencedBlockContaining(text: string, marker: string): string {
  const markerIdx = text.indexOf(marker);
  assert.ok(markerIdx >= 0, `marker not found in fixture text: ${marker}`);
  const openFenceIdx = text.lastIndexOf("```", markerIdx);
  assert.ok(openFenceIdx >= 0, "no opening fence found before marker");
  const closeFenceIdx = text.indexOf("```", markerIdx + marker.length);
  assert.ok(closeFenceIdx >= 0, "no closing fence found after marker");
  const closeFenceEnd = closeFenceIdx + "```".length;
  return text.slice(0, openFenceIdx) + text.slice(closeFenceEnd);
}

const VALID_BODY =
  "CRITICAL SAFETY RULE: run this in a fresh git worktree; never push " +
  "directly to master (always a feature branch). Before opening the PR run " +
  "npm test && npm run typecheck && npm run typecheck:test && npm run build. " +
  "Operator escalation is the closed ADR-0005 list only. The PR body must " +
  "carry closes #2949.";

describe("skill-prune contract-token-parity (pure)", () => {
  test("extractLoadBearingTokens finds one token per class present in the text", () => {
    const tokens = extractLoadBearingTokens(VALID_BODY);
    assert.ok(tokens.has("closes #2949"));
    assert.ok(tokens.has("never push directly to master"));
    assert.ok(tokens.has("npm test"));
    assert.ok(tokens.has("npm run typecheck"));
    assert.ok(tokens.has("npm run typecheck:test"));
    assert.ok(tokens.has("npm run build"));
    assert.ok(tokens.has("ADR-0005"));
    assert.ok(tokens.has("critical safety rule"));
    assert.ok(tokens.has("git worktree"));
  });

  test("extractLoadBearingTokens returns an empty set for prose with no load-bearing tokens", () => {
    const tokens = extractLoadBearingTokens(
      "This paragraph is pure motivational prose and names no contract token at all.",
    );
    assert.equal(tokens.size, 0);
  });

  test("TOKEN_CLASSES is exactly the five Step 2 load-bearing classes", () => {
    const names = TOKEN_CLASSES.map((c) => c.name).sort();
    assert.deepEqual(names, [
      "adr-reference",
      "closes-issue-ref",
      "never-push-to-master",
      "verification-command",
      "worktree-guard-preamble",
    ]);
  });

  test("case 1: an over-prune dropping a load-bearing token FAILS", () => {
    const after = VALID_BODY.replace(
      "; never push directly to master (always a feature branch)",
      "",
    );
    const result = computeContractTokenParity(VALID_BODY, after);
    assert.equal(result.pass, false);
    assert.deepEqual(result.droppedTokens, ["never push directly to master"]);
  });

  test("case 1b: dropping one of two distinct closes-# references is caught individually", () => {
    const before = VALID_BODY + " See also closes #3001 for the follow-up.";
    const after = VALID_BODY; // #3001 reference silently dropped
    const result = computeContractTokenParity(before, after);
    assert.equal(result.pass, false);
    assert.deepEqual(result.droppedTokens, ["closes #3001"]);
  });

  test("case 2: a duplication/sediment-only prune (no token dropped) PASSES", () => {
    const before =
      VALID_BODY +
      "\n\nReminder: this MUST run inside a git worktree, per the CRITICAL SAFETY RULE above.";
    // The duplicated reminder sentence is removed; every load-bearing token
    // from `before` still appears in the untouched first paragraph.
    const after = VALID_BODY;
    const result = computeContractTokenParity(before, after);
    assert.equal(result.pass, true);
    assert.deepEqual(result.droppedTokens, []);
  });

  test("case 2b: a duplicate occurrence collapsing to one copy still passes (set semantics)", () => {
    const before = `${VALID_BODY} closes #2949 again, restated.`;
    const after = VALID_BODY; // one of the two "closes #2949" copies removed
    const result = computeContractTokenParity(before, after);
    assert.equal(result.pass, true);
  });

  test("case 3: identical before/after FAILS (nothing pruned, nothing to verify)", () => {
    const result = computeContractTokenParity(VALID_BODY, VALID_BODY);
    assert.equal(result.pass, false);
    assert.match(result.reason, /identical/);
  });

  test("case 3b: whitespace-only differences still count as identical", () => {
    const result = computeContractTokenParity(VALID_BODY, `  ${VALID_BODY}  `);
    assert.equal(result.pass, false);
    assert.match(result.reason, /identical/);
  });

  test("case 4: a `before` with zero load-bearing tokens FAILS (cannot exercise the skill)", () => {
    const before = "This playbook is pure prose with no contract tokens whatsoever.";
    const after = "This playbook is now shorter prose with no contract tokens whatsoever.";
    const result = computeContractTokenParity(before, after);
    assert.equal(result.pass, false);
    assert.match(result.reason, /zero load-bearing/);
  });

  test("missing or empty before/after fail closed", () => {
    assert.equal(computeContractTokenParity(null, VALID_BODY).pass, false);
    assert.equal(computeContractTokenParity(undefined, VALID_BODY).pass, false);
    assert.equal(computeContractTokenParity("", VALID_BODY).pass, false);
    assert.equal(computeContractTokenParity(VALID_BODY, "").pass, false);
    assert.equal(computeContractTokenParity(VALID_BODY, null).pass, false);
  });

  test("the promptfoo adapter reads context.vars.before/after and mirrors the pure result", () => {
    const after = VALID_BODY.replace("never push directly to master", "");
    const failing = scoreContractTokenParity("ignored output", {
      vars: { before: VALID_BODY, after },
    });
    assert.equal(failing.pass, false);
    assert.equal(failing.score, 0);

    const passing = scoreContractTokenParity("ignored output", {
      vars: { before: VALID_BODY, after: VALID_BODY.replace(/\s+/g, " ") + " trailing note." },
    });
    assert.equal(passing.pass, true);
    assert.equal(passing.score, 1);
  });

  test("the promptfoo adapter fails closed when vars are absent", () => {
    const result = scoreContractTokenParity("ignored output", {});
    assert.equal(result.pass, false);
  });

  // --- QA fold on PR #4490 (issue #4268 follow-up): block-scoped
  // worktree-guard-preamble tracking. The flat `/critical safety rule/i`
  // presence check alone false-PASSED deleting one of several distinct
  // `## CRITICAL SAFETY RULE` blocks because a surviving sibling block kept
  // the single flat token alive. These cases prove the fix without
  // regressing the pre-existing duplication-collapse case above (case 2b).

  test("case 5: two distinct blocks sharing an identical heading — deleting one FAILS", () => {
    const before =
      "## CRITICAL SAFETY RULE — READ FIRST\n" +
      "Default variant: abort if cwd is the main checkout.\n" +
      "\n" +
      "## CRITICAL SAFETY RULE — READ FIRST\n" +
      "dev_target variant: do NOT abort; this dispatch is not worktree-isolated.\n";
    const after =
      "## CRITICAL SAFETY RULE — READ FIRST\n" + "Default variant: abort if cwd is the main checkout.\n";
    const result = computeContractTokenParity(before, after);
    assert.equal(result.pass, false);
    assert.ok(
      result.droppedTokens.some((t) => t.includes("dev_target variant")),
      `expected a dropped worktree-guard block token, got: ${result.droppedTokens.join(", ")}`,
    );
  });

  test("case 6: two byte-identical heading blocks still collapse to one token (set semantics preserved)", () => {
    const block =
      "## CRITICAL SAFETY RULE — READ FIRST\n" + "Abort if cwd is the main checkout.\n";
    const before = `${block}\n${block}`;
    const after = block; // one of the two identical copies removed
    const result = computeContractTokenParity(before, after);
    assert.equal(result.pass, true);
  });

  test("case 7: docs/operator-playbooks/hydra-autopilot.md — deleting the self-isolation safety-rule block is caught (real content)", () => {
    // Issue #4476 moved the variant into a shared fragment the playbook
    // @includes; skill-prune sees the sync-expanded SKILL.md, so expand the
    // include the way scripts/sync-skills.sh does before pruning.
    const fragment = readFileSync(
      fileURLToPath(
        new URL(
          "../docs/operator-playbooks/_fragments/target-self-isolation-preamble.md",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    const before = readFileSync(AUTOPILOT_PLAYBOOK_PATH, "utf8").replace(
      /^@include _fragments\/target-self-isolation-preamble\.md$/m,
      () => fragment,
    );
    const after = stripFencedBlockContaining(
      before,
      "## CRITICAL SAFETY RULE — READ FIRST (self-isolation variant, issue #4476)",
    );
    assert.notEqual(before, after, "fixture must actually remove the self-isolation block");
    const result = computeContractTokenParity(before, after);
    assert.equal(result.pass, false);
    assert.ok(
      result.droppedTokens.some((t) => t.toLowerCase().includes("self-isolation variant")),
      `expected a dropped worktree-guard block token, got: ${result.droppedTokens.join(", ")}`,
    );
  });

  test("case 8: docs/operator-playbooks/hydra-autopilot.md — an unrelated, harmless edit still PASSES (no false positive)", () => {
    const before = readFileSync(AUTOPILOT_PLAYBOOK_PATH, "utf8");
    // Simulate a legitimate sediment prune elsewhere in the doc that touches
    // neither safety-rule block.
    const after = before + "\n<!-- prune: removed unrelated stale note -->\n";
    const result = computeContractTokenParity(before, after);
    assert.equal(result.pass, true);
  });
});

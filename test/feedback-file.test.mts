/**
 * Regression tests for the Feedback File grammar Module (issue #940).
 *
 * The markdown grammar of `config/feedback/to-{agent}.md` — path resolution,
 * the `## Auto-Promoted Rules` / `## Stale Rules` section layout, the
 * `### <category> (Nx since <date>)` block format, and the three block
 * operations (append / archive / remove) — used to be re-derived at three
 * call sites across two modules. These tests pin the consolidated grammar,
 * with special attention to the WRITE (append/render) side, which had no
 * direct unit test before this Module existed (it was only exercised
 * transitively through `recordPattern`'s Redis path).
 *
 * Pure transforms only — no I/O.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_PROMOTED_SECTION,
  STALE_RULES_SECTION,
  appendPromotedRuleBlock,
  feedbackFilePath,
  removePromotedRuleBlock,
  renderPromotedRuleBlock,
  type PromotedRuleInput,
} from "../src/pattern-memory/feedback-file.ts";

const RULE: PromotedRuleInput = {
  category: "scope-creep",
  hitCount: 12,
  firstSeen: "2026-05-01",
  action: "Stay within the planned file set.",
  lastCycleId: "cycle-2026-06-03-0900",
  examples: ["touched src/foo.ts outside scope"],
  lastSeen: "2026-06-03",
};

describe("feedbackFilePath (issue #940)", () => {
  test("resolves to-{agent}.md under config/feedback", () => {
    const p = feedbackFilePath("planner");
    assert.ok(p.endsWith("/feedback/to-planner.md"), `got: ${p}`);
  });
});

describe("renderPromotedRuleBlock (issue #940)", () => {
  test("emits the canonical heading + auto-promoted trailer", () => {
    const block = renderPromotedRuleBlock(RULE, "2026-06-03");
    assert.ok(block.includes("### scope-creep (12x since 2026-05-01)"));
    assert.ok(block.includes("Stay within the planned file set."));
    assert.ok(block.includes("Last: cycle-2026-06-03-0900 (touched src/foo.ts outside scope)"));
    assert.ok(block.includes("<!-- auto-promoted 2026-06-03, last hit 2026-06-03 -->"));
  });

  test("falls back to 'no example' when examples is empty", () => {
    const block = renderPromotedRuleBlock({ ...RULE, examples: [] }, "2026-06-03");
    assert.ok(block.includes("(no example)"));
  });
});

describe("appendPromotedRuleBlock (issue #940)", () => {
  test("creates the Auto-Promoted section + preamble when absent", () => {
    const before = "# Planner Guidance\n\nSome preamble.\n";
    const after = appendPromotedRuleBlock(before, RULE, "2026-06-03");
    assert.ok(after.includes(AUTO_PROMOTED_SECTION));
    assert.ok(after.includes("auto-promoted from agent memory"));
    assert.ok(after.includes("### scope-creep (12x since 2026-05-01)"));
    // Original content is preserved ahead of the new section.
    assert.ok(after.startsWith("# Planner Guidance"));
  });

  test("inserts after the existing header when the section is present", () => {
    const before =
      "# Planner Guidance\n\n" + AUTO_PROMOTED_SECTION + "\n\n" +
      "### existing-rule (3x since 2026-04-01)\nbody\n<!-- auto-promoted 2026-04-01, last hit 2026-04-02 -->\n";
    const after = appendPromotedRuleBlock(before, RULE, "2026-06-03");
    // The new rule lands immediately under the header, ahead of the existing one.
    const newIdx = after.indexOf("### scope-creep (12x");
    const existingIdx = after.indexOf("### existing-rule (3x");
    assert.ok(newIdx !== -1 && existingIdx !== -1);
    assert.ok(newIdx < existingIdx, "new rule should be inserted before the existing one");
    // Exactly one Auto-Promoted header — no duplicate section created.
    assert.equal(after.split(AUTO_PROMOTED_SECTION).length - 1, 1);
  });
});

describe("append → remove round-trip shares one grammar (issue #940)", () => {
  test("a block written by appendPromotedRuleBlock is removable by removePromotedRuleBlock", () => {
    const base = "# Planner Guidance\n\nIntro.\n";
    const withRule = appendPromotedRuleBlock(base, RULE, "2026-06-03");
    assert.ok(withRule.includes("### scope-creep (12x"));

    const { newContent, removed } = removePromotedRuleBlock(withRule, "scope-creep");
    assert.equal(removed, true, "the writer's heading format must be parseable by the reader");
    assert.ok(!newContent.includes("### scope-creep (12x"));
    // No orphaned triple-blank-lines after the strip.
    assert.ok(!/\n{3,}/.test(newContent));
  });

  test("removePromotedRuleBlock does not cross into the Stale Rules section", () => {
    const withRule = appendPromotedRuleBlock("# Planner\n", RULE, "2026-06-03");
    const withStale =
      withRule + "\n" + STALE_RULES_SECTION + "\n\n" +
      "### scope-creep (2x since 2026-01-01)\nold\n<!-- auto-promoted 2026-01-01, last hit 2026-01-02 -->\n";
    const { newContent, removed } = removePromotedRuleBlock(withStale, "scope-creep");
    assert.equal(removed, true);
    // The identically-named stale block survives.
    assert.ok(newContent.includes(STALE_RULES_SECTION));
    assert.ok(newContent.includes("### scope-creep (2x since 2026-01-01)"));
    // The auto-promoted one is gone.
    assert.ok(!newContent.includes("### scope-creep (12x"));
  });
});

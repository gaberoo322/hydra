/**
 * Regression tests for staleness detection of auto-promoted feedback rules (issue #163).
 *
 * Tests the pure functions detectStalePromotedRules() and processStaleRules()
 * with mock feedback file content. No Redis required.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { detectStalePromotedRules, processStaleRules } from "../src/pattern-memory/feedback-file.ts";

// Reference date for all tests: 2026-05-07
const NOW = new Date("2026-05-07T12:00:00Z");

const FRESH_RULE = `### scope-creep (231x since 2026-04-27)
The executor consistently touches files beyond the planned scope.
Last: cycle-2026-05-06-1219
<!-- auto-promoted 2026-04-28, last hit 2026-05-06 -->`;

const STALE_30D_RULE = `### old-pattern (5x since 2026-03-01)
Some rule that hasn't fired recently.
Last: cycle-2026-03-30-0800
<!-- auto-promoted 2026-03-01, last hit 2026-03-30 -->`;

const STALE_60D_RULE = `### ancient-pattern (7x since 2026-02-01)
A very old rule that should be archived.
Last: cycle-2026-02-15-1000
<!-- auto-promoted 2026-02-01, last hit 2026-02-15 -->`;

const NO_LAST_HIT_RULE = `### no-diff (6x since 2026-04-26)
Actually write code and commit.
Last: cycle-2026-04-28-1746
<!-- auto-promoted 2026-02-10 -->`;

function buildFeedback(...ruleBlocks: string[]): string {
  return [
    "# Agent Guidance",
    "",
    "Some preamble text.",
    "",
    "## Auto-Promoted Rules",
    "",
    "Rules below were auto-promoted from agent memory.",
    "",
    ...ruleBlocks,
    "",
  ].join("\n");
}

describe("detectStalePromotedRules (issue #163)", () => {
  test("rules within 30 days are NOT flagged as stale", () => {
    const content = buildFeedback(FRESH_RULE);
    const result = detectStalePromotedRules(content, "planner", NOW);

    assert.equal(result.active.length, 1);
    assert.equal(result.stale30.length, 0);
    assert.equal(result.stale60.length, 0);
    assert.equal(result.active[0].heading, "### scope-creep (231x since 2026-04-27)");
    assert.equal(result.active[0].lastHitDate, "2026-05-06");
  });

  test("rules 30-60 days old are flagged as stale30", () => {
    const content = buildFeedback(STALE_30D_RULE);
    const result = detectStalePromotedRules(content, "planner", NOW);

    assert.equal(result.active.length, 0);
    assert.equal(result.stale30.length, 1);
    assert.equal(result.stale60.length, 0);
    assert.equal(result.stale30[0].heading, "### old-pattern (5x since 2026-03-01)");
    assert.equal(result.stale30[0].lastHitDate, "2026-03-30");
    assert.ok(result.stale30[0].daysSinceLastHit > 30);
    assert.ok(result.stale30[0].daysSinceLastHit <= 60);
  });

  test("rules >60 days old are flagged as stale60", () => {
    const content = buildFeedback(STALE_60D_RULE);
    const result = detectStalePromotedRules(content, "executor", NOW);

    assert.equal(result.active.length, 0);
    assert.equal(result.stale30.length, 0);
    assert.equal(result.stale60.length, 1);
    assert.equal(result.stale60[0].heading, "### ancient-pattern (7x since 2026-02-01)");
    assert.ok(result.stale60[0].daysSinceLastHit > 60);
  });

  test("rules without last hit date fall back to promoted date", () => {
    const content = buildFeedback(NO_LAST_HIT_RULE);
    const result = detectStalePromotedRules(content, "executor", NOW);

    // promoted 2026-02-10, no last hit => uses promoted date => >60 days stale
    assert.equal(result.stale60.length, 1);
    assert.equal(result.stale60[0].lastHitDate, "2026-02-10");
    assert.equal(result.stale60[0].promotedDate, "2026-02-10");
  });

  test("handles mixed fresh and stale rules", () => {
    const content = buildFeedback(FRESH_RULE, STALE_30D_RULE, STALE_60D_RULE);
    const result = detectStalePromotedRules(content, "planner", NOW);

    assert.equal(result.active.length, 1);
    assert.equal(result.stale30.length, 1);
    assert.equal(result.stale60.length, 1);
  });

  test("returns empty results when no auto-promoted section exists", () => {
    const content = "# Agent Guidance\n\nNo promoted rules here.\n";
    const result = detectStalePromotedRules(content, "skeptic", NOW);

    assert.equal(result.active.length, 0);
    assert.equal(result.stale30.length, 0);
    assert.equal(result.stale60.length, 0);
  });

  test("returns empty results for empty string", () => {
    const result = detectStalePromotedRules("", "planner", NOW);
    assert.equal(result.active.length, 0);
    assert.equal(result.stale30.length, 0);
    assert.equal(result.stale60.length, 0);
  });

  test("handles malformed comment dates gracefully", () => {
    const malformedRule = `### bad-date (3x since 2026-01-01)
Some text.
<!-- auto-promoted not-a-date -->`;
    const content = buildFeedback(malformedRule);
    const result = detectStalePromotedRules(content, "planner", NOW);

    // Malformed date doesn't match the regex, so this rule is skipped
    assert.equal(result.active.length, 0);
    assert.equal(result.stale30.length, 0);
    assert.equal(result.stale60.length, 0);
  });

  test("skips rules already in Stale Rules section", () => {
    const content = buildFeedback(FRESH_RULE) +
      "\n\n## Stale Rules (review needed)\n\n" + STALE_30D_RULE;
    const result = detectStalePromotedRules(content, "planner", NOW);

    // Only the fresh rule in the Auto-Promoted section is parsed
    assert.equal(result.active.length, 1);
    assert.equal(result.stale30.length, 0);
    assert.equal(result.stale60.length, 0);
  });
});

describe("processStaleRules (issue #163)", () => {
  test("moves 30-day stale rules to review section", () => {
    const content = buildFeedback(FRESH_RULE, STALE_30D_RULE);
    const { newContent, archived } = processStaleRules(content, "planner", NOW);

    assert.equal(archived.length, 0);
    assert.ok(newContent.includes("## Stale Rules (review needed)"));
    assert.ok(newContent.includes("old-pattern"));
    // Fresh rule stays in auto-promoted section
    assert.ok(newContent.includes("scope-creep"));
    // Stale rule should be under the stale section, not auto-promoted
    const staleIdx = newContent.indexOf("## Stale Rules (review needed)");
    const oldPatternIdx = newContent.lastIndexOf("old-pattern");
    assert.ok(oldPatternIdx > staleIdx, "stale rule should be after Stale Rules header");
  });

  test("removes and archives 60-day stale rules", () => {
    const content = buildFeedback(FRESH_RULE, STALE_60D_RULE);
    const { newContent, archived } = processStaleRules(content, "executor", NOW);

    assert.equal(archived.length, 1);
    assert.equal(archived[0].heading, "### ancient-pattern (7x since 2026-02-01)");
    // 60-day rule should be completely removed
    assert.ok(!newContent.includes("ancient-pattern"));
    // Fresh rule stays
    assert.ok(newContent.includes("scope-creep"));
  });

  test("handles all three categories in one file", () => {
    const content = buildFeedback(FRESH_RULE, STALE_30D_RULE, STALE_60D_RULE);
    const { newContent, archived } = processStaleRules(content, "planner", NOW);

    assert.equal(archived.length, 1, "one 60d rule archived");
    assert.ok(!newContent.includes("ancient-pattern"), "60d rule removed");
    assert.ok(newContent.includes("scope-creep"), "fresh rule kept in place");
    assert.ok(newContent.includes("## Stale Rules (review needed)"), "stale section created");
    assert.ok(newContent.includes("old-pattern"), "30d rule moved to stale section");
  });

  test("returns unchanged content when nothing is stale", () => {
    const content = buildFeedback(FRESH_RULE);
    const { newContent, archived } = processStaleRules(content, "planner", NOW);

    assert.equal(archived.length, 0);
    assert.equal(newContent, content);
  });

  test("returns unchanged content when no auto-promoted section exists", () => {
    const content = "# Agent Guidance\n\nNo promoted rules here.\n";
    const { newContent, archived } = processStaleRules(content, "skeptic", NOW);

    assert.equal(archived.length, 0);
    assert.equal(newContent, content);
  });

  test("appends to existing Stale Rules section", () => {
    const existingStale = `### previously-stale (3x since 2026-02-15)
Old rule already in stale section.
<!-- auto-promoted 2026-02-15, last hit 2026-03-20 -->`;

    const content = buildFeedback(FRESH_RULE, STALE_30D_RULE) +
      "\n\n## Stale Rules (review needed)\n\nRules below have not fired in >30 days.\n\n" + existingStale;

    const { newContent } = processStaleRules(content, "planner", NOW);

    // Both stale rules should be in the stale section
    assert.ok(newContent.includes("old-pattern"));
    assert.ok(newContent.includes("previously-stale"));
    // Fresh rule stays
    assert.ok(newContent.includes("scope-creep"));
  });

  test("does not produce triple blank lines after removal", () => {
    const content = buildFeedback(STALE_60D_RULE);
    const { newContent } = processStaleRules(content, "executor", NOW);

    assert.ok(!newContent.includes("\n\n\n"), "should not have triple blank lines");
  });
});

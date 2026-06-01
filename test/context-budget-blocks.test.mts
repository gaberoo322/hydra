/**
 * Issue #804 PR-B — block-aware budget for the learning source.
 *
 * The monolithic char-slice in applyContextBudget could sever a reflection
 * body while leaving its header intact, corrupting the post-budget count and
 * handing the planner half a reflection. PR-B replaces that slice (for the
 * learning bundle ONLY) with a whole-block drop: shed entire blocks
 * lowest-dropPriority-first until the bundle fits, never cutting mid-block.
 *
 * These tests pin:
 *   1. the canonical drop order (global → knowledge-base → agent-memory →
 *      by-file → per-anchor), lowest-dropPriority dropped first;
 *   2. the never-slice guarantee — surviving blocks keep their exact content;
 *   3. the #193 retry invariant — per-anchor reflections survive last;
 *   4. the OV-once dedup — knowledge-base is excludable from the render
 *      without being dropped from the trace;
 *   5. that telemetry over survivors is exact (these replace the deleted
 *      brittle header-regex tests).
 *
 * Pure functions — no Redis, no filesystem.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  applyLearningBlockBudget,
  LEARNING_SOURCE_NAME,
} from "../src/context-builder.ts";
import {
  reflectionTelemetry,
  LEARNING_DROP_PRIORITY,
  type LearningContext,
  type LearningContextBlock,
  type LearningContextSource,
} from "../src/learning.ts";

/** Build a hit block of `len` chars for `source`, with the canonical priority. */
function block(source: LearningContextSource, len: number, itemCount = 1): LearningContextBlock {
  return {
    source,
    status: "hit",
    content: source[0] + "x".repeat(Math.max(0, len - 1)),
    itemCount,
    dropPriority: LEARNING_DROP_PRIORITY[source],
  };
}

/** All five blocks in canonical prompt order, each `len` chars. */
function fiveBlocks(len: number): LearningContextBlock[] {
  return [
    block("agent-memory", len, 1),
    block("knowledge-base", len, 4),
    block("per-anchor-reflections", len, 2),
    block("by-file-reflections", len, 3),
    block("global-reflections", len, 5),
  ];
}

function ctxOf(blocks: LearningContextBlock[]): LearningContext {
  return {
    blocks,
    toPrompt: () =>
      blocks.filter((b) => b.status === "hit" && b.content.length > 0).map((b) => b.content).join("\n\n"),
  };
}

describe("applyLearningBlockBudget — whole-block drop order (issue #804 PR-B)", () => {
  test("under budget: every block survives, content untouched", () => {
    const blocks = fiveBlocks(100);
    const { survivors, content } = applyLearningBlockBudget(blocks, 100_000);
    assert.equal(survivors.length, 5, "all five survive under budget");
    // never-slice: rendered content is the exact hit-join, no truncation notice
    const expected = blocks.map((b) => b.content).join("\n\n");
    assert.equal(content, expected, "content is byte-identical to the full hit-join");
  });

  test("drops lowest-dropPriority block first: global goes before knowledge-base", () => {
    // 5 blocks * 1000 chars + 4 separators = 5008. Budget 4500 sheds exactly one
    // block. The lowest dropPriority is global-reflections (0) → it goes first.
    const blocks = fiveBlocks(1000);
    const { survivors } = applyLearningBlockBudget(blocks, 4500);
    const survivingSources = survivors.map((b) => b.source);
    assert.ok(!survivingSources.includes("global-reflections"), "global dropped first");
    assert.ok(survivingSources.includes("knowledge-base"), "knowledge-base survives a single drop");
    assert.ok(survivingSources.includes("per-anchor-reflections"), "per-anchor never the first to go");
  });

  test("full drop sequence under escalating pressure follows the contract order", () => {
    const blocks = fiveBlocks(1000);
    // Drop order (first → last): global, knowledge-base, agent-memory, by-file, per-anchor.
    // Shrinking the budget drops them in exactly that order.
    const order: LearningContextSource[] = [];
    // Each step picks a budget that forces exactly one more drop than the last.
    for (const budget of [4500, 3200, 2100, 1100]) {
      const { survivors } = applyLearningBlockBudget(blocks, budget);
      order.push(...blocks.filter((b) => !survivors.includes(b)).map((b) => b.source));
      // de-dup while preserving first-seen order
    }
    // The cumulative "first dropped" sequence across tightening budgets:
    const firstSeen: LearningContextSource[] = [];
    for (const s of order) if (!firstSeen.includes(s)) firstSeen.push(s);
    assert.deepEqual(
      firstSeen,
      ["global-reflections", "knowledge-base", "agent-memory", "by-file-reflections"],
      "blocks shed lowest-dropPriority-first per the design-concept drop order",
    );
  });

  test("#193 retry invariant: per-anchor reflections are the LAST learning block dropped", () => {
    const blocks = fiveBlocks(1000);
    // A budget tight enough to keep only one block must keep per-anchor.
    const { survivors } = applyLearningBlockBudget(blocks, 500);
    assert.equal(survivors.length, 1, "only one block fits");
    assert.equal(survivors[0].source, "per-anchor-reflections",
      "per-anchor reflections survive last — retry correctness (#193)");
  });

  test("never slices: a lone over-budget block is kept whole, not truncated", () => {
    const blocks = [block("per-anchor-reflections", 5000, 9)];
    const { survivors, content } = applyLearningBlockBudget(blocks, 500);
    assert.equal(survivors.length, 1, "the single block is kept");
    assert.equal(content, blocks[0].content, "content is the full block — never sliced");
    assert.ok(!content.includes("truncated"), "no truncation notice on a block-budgeted bundle");
  });

  test("miss/error blocks never enter the rendered bundle or the survivor set", () => {
    const blocks: LearningContextBlock[] = [
      block("agent-memory", 100),
      { source: "knowledge-base", status: "miss", content: "", itemCount: 0, dropPriority: LEARNING_DROP_PRIORITY["knowledge-base"] },
      { source: "global-reflections", status: "error", content: "", itemCount: 0, error: "boom", dropPriority: LEARNING_DROP_PRIORITY["global-reflections"] },
    ];
    const { survivors, content } = applyLearningBlockBudget(blocks, 100_000);
    assert.deepEqual(survivors.map((b) => b.source), ["agent-memory"], "only the hit block survives");
    assert.equal(content, blocks[0].content);
  });

  test("OV-once dedup: knowledge-base is excludable from render without affecting reflection telemetry", () => {
    const blocks = fiveBlocks(100);
    const exclude = new Set(["knowledge-base"]);
    const { survivors, content } = applyLearningBlockBudget(blocks, 100_000, exclude);
    assert.ok(!survivors.some((b) => b.source === "knowledge-base"),
      "knowledge-base is excluded from the rendered bundle (OV injected once via `memory`)");
    assert.ok(!content.includes(blocks[1].content), "KB content is not in the prompt string");
    // KB is not a reflection, so its exclusion never changes the reflection count.
    const stats = reflectionTelemetry(ctxOf(survivors));
    assert.equal(stats.count, 2 + 3 + 5, "per-anchor(2)+by-file(3)+global(5) survive and count exactly");
    assert.deepEqual(stats.sources, ["per-anchor", "by-file", "global"], "canonical reflection order");
  });

  test("telemetry over survivors is exact post-budget (replaces header-regex tests)", () => {
    const blocks = fiveBlocks(1000);
    // Tighten until global is dropped — its itemCount (5) must leave the count.
    const { survivors } = applyLearningBlockBudget(blocks, 4500);
    const stats = reflectionTelemetry(ctxOf(survivors));
    assert.ok(!stats.sources.includes("global"), "dropped global no longer counts");
    // per-anchor(2) + by-file(3) survive; global(5) dropped.
    assert.equal(stats.count, 5, "exact post-budget count = surviving reflection itemCounts");
  });
});

describe("LEARNING_DROP_PRIORITY contract (issue #804 PR-B)", () => {
  test("canonical drop order: global < knowledge-base < agent-memory < by-file < per-anchor", () => {
    assert.deepEqual(
      (Object.entries(LEARNING_DROP_PRIORITY) as [LearningContextSource, number][])
        .sort((a, b) => a[1] - b[1])
        .map(([s]) => s),
      ["global-reflections", "knowledge-base", "agent-memory", "by-file-reflections", "per-anchor-reflections"],
      "drop order matches the design-concept (per-anchor last)",
    );
  });

  test("per-anchor carries the strictly-highest dropPriority (#193 retry correctness)", () => {
    const max = Math.max(...Object.values(LEARNING_DROP_PRIORITY));
    assert.equal(LEARNING_DROP_PRIORITY["per-anchor-reflections"], max,
      "per-anchor must be dropped last of all learning blocks");
  });

  test("LEARNING_SOURCE_NAME names the planner-context slot the bundle occupies", () => {
    assert.equal(LEARNING_SOURCE_NAME, "reflections");
  });
});

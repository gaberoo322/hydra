/**
 * Regression test: getContext() returns a structured LearningContext with
 * per-source diagnostic blocks, and .toPrompt() reproduces the legacy
 * `\n\n`-joined prompt string.
 *
 * The composition is over Pattern Memory + Reflections only (see CONTEXT.md
 * — Knowledge Base sits at a different seam queried by subagents directly).
 * Test exercises the pure shape; doesn't require Redis-resident reflections
 * to be present (the four-block layout holds even when every block misses).
 *
 * Issue #1454: the dead global-reflections block was removed — getContext()
 * composes four blocks (agent-memory, knowledge-base, per-anchor-reflections,
 * by-file-reflections).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

process.env.REDIS_URL = "redis://localhost:6379/1";

const learning = await import("../src/learning.ts");
const { closeRedisConnections } = await import("../src/redis/connection.ts");

describe("getContext returns a structured LearningContext", () => {
  test("four blocks in canonical order, every block has a status", async (t) => {
    let ctx;
    try {
      ctx = await learning.getContext("planner", {
        type: "codebase-health",
        reference: "context-trace test — should never match a real anchor",
      });
    } catch (err: any) {
      if (err?.code === "ECONNREFUSED") {
        t.skip("Redis unavailable on REDIS_URL — skipping");
        return;
      }
      throw err;
    }

    // Issue #804: the Knowledge Base (OpenViking) is now its own honest block,
    // composed between agent-memory and the reflection sources.
    // Issue #1454: the dead global-reflections block was removed — four blocks.
    assert.equal(ctx.blocks.length, 4, "four sources contribute one block each");
    assert.deepEqual(
      ctx.blocks.map((b: any) => b.source),
      [
        "agent-memory",
        "knowledge-base",
        "per-anchor-reflections",
        "by-file-reflections",
      ],
      "block order is the prompt order — agent-memory first, by-file-reflections last",
    );
    // Issue #804 PR-B: per-anchor carries the highest dropPriority of all five
    // blocks (dropped last under budget pressure — #193 retry correctness).
    const bySource = new Map(ctx.blocks.map((b: any) => [b.source, b.dropPriority]));
    const maxDrop = Math.max(...ctx.blocks.map((b: any) => b.dropPriority));
    assert.equal(bySource.get("per-anchor-reflections"), maxDrop,
      "per-anchor reflections must be the last learning block dropped");
    for (const block of ctx.blocks) {
      assert.ok(
        ["hit", "miss", "error"].includes(block.status),
        `block ${block.source} status must be hit/miss/error, got ${block.status}`,
      );
      // Issue #804: every block carries a numeric itemCount; 0 for miss/error.
      assert.equal(typeof block.itemCount, "number", `block ${block.source} carries a numeric itemCount`);
      // Issue #804 PR-B: every block declares its within-bundle drop priority.
      assert.equal(typeof block.dropPriority, "number", `block ${block.source} carries a numeric dropPriority`);
      if (block.status === "miss") {
        assert.equal(block.content, "", "miss blocks carry no content");
        assert.equal(block.itemCount, 0, "miss blocks carry itemCount 0");
        assert.equal(block.error, undefined, "miss blocks carry no error");
      }
      if (block.status === "error") {
        assert.equal(block.content, "", "error blocks carry no content");
        assert.equal(block.itemCount, 0, "error blocks carry itemCount 0");
        assert.equal(typeof block.error, "string", "error blocks carry an error message");
      }
    }
  });

  test("toPrompt() concatenates hit blocks with \\n\\n and omits miss/error", async (t) => {
    let ctx;
    try {
      ctx = await learning.getContext("planner", {
        type: "codebase-health",
        reference: "context-trace test — should never match a real anchor",
      });
    } catch (err: any) {
      if (err?.code === "ECONNREFUSED") {
        t.skip("Redis unavailable on REDIS_URL — skipping");
        return;
      }
      throw err;
    }

    const prompt = ctx.toPrompt();
    const hitBlocks = ctx.blocks.filter((b: any) => b.status === "hit");
    const expected = hitBlocks.map((b: any) => b.content).join("\n\n");
    assert.equal(prompt, expected, "toPrompt() must equal hits joined by \\n\\n");

    // Prompt MUST NOT include miss/error block content (there is none) and
    // MUST NOT include the source names — those are diagnostic, not prompt.
    for (const block of ctx.blocks) {
      if (block.status !== "hit") continue;
      assert.ok(
        !prompt.includes(`source: ${block.source}`),
        "diagnostic metadata must not leak into the prompt",
      );
    }
  });

  test("missing or empty agent name still returns four blocks", async (t) => {
    // The function shouldn't throw on weird-but-non-crashing inputs; it
    // should return a structured trace where each source decided what
    // to do. The contract is "four blocks, one per source" (issue #804 added
    // the knowledge-base block; issue #1454 removed global-reflections).
    let ctx;
    try {
      ctx = await learning.getContext("", {
        type: "codebase-health",
        reference: "context-trace test — empty agent",
      });
    } catch (err: any) {
      if (err?.code === "ECONNREFUSED") {
        t.skip("Redis unavailable on REDIS_URL — skipping");
        return;
      }
      throw err;
    }

    assert.equal(ctx.blocks.length, 4);
  });

  test("after() — close Redis connections", () => {
    closeRedisConnections();
  });
});

/**
 * Issue #1455: the four bespoke block loaders collapsed into ONE generic
 * loader (`loadBlock`) over per-source descriptors. The hit/miss/error envelope
 * mapping is therefore covered by a SINGLE test exercising the loader directly
 * with stub thunks — no Redis, no four near-identical per-source variants.
 */
describe("loadBlock maps a source read into the hit/miss/error envelope", () => {
  test("hit / miss / error from one loader, dropPriority stamped from the table", async () => {
    // hit: non-empty content → status "hit", itemCount carried from the read.
    const hit = await learning.loadBlock({
      source: "agent-memory",
      load: async () => ({ content: "rendered patterns", itemCount: 3 }),
    });
    assert.equal(hit.status, "hit");
    assert.equal(hit.content, "rendered patterns");
    assert.equal(hit.itemCount, 3);
    assert.equal(hit.dropPriority, learning.LEARNING_DROP_PRIORITY["agent-memory"]);
    assert.equal(hit.error, undefined);

    // miss: empty content → status "miss", itemCount forced to 0 regardless of
    // what the read reported (the seam never emits a count for an empty block).
    const miss = await learning.loadBlock({
      source: "knowledge-base",
      load: async () => ({ content: "", itemCount: 7 }),
    });
    assert.equal(miss.status, "miss");
    assert.equal(miss.content, "");
    assert.equal(miss.itemCount, 0);
    assert.equal(miss.dropPriority, learning.LEARNING_DROP_PRIORITY["knowledge-base"]);
    assert.equal(miss.error, undefined);

    // error: thunk throws → status "error", content "", itemCount 0, error msg.
    const err = await learning.loadBlock({
      source: "by-file-reflections",
      load: async () => { throw new Error("redis down"); },
    });
    assert.equal(err.status, "error");
    assert.equal(err.content, "");
    assert.equal(err.itemCount, 0);
    assert.equal(err.dropPriority, learning.LEARNING_DROP_PRIORITY["by-file-reflections"]);
    assert.equal(err.error, "redis down");
  });
});

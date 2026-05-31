/**
 * Regression test: getContext() returns a structured LearningContext with
 * per-source diagnostic blocks, and .toPrompt() reproduces the legacy
 * `\n\n`-joined prompt string.
 *
 * The composition is over Pattern Memory + Reflections only (see CONTEXT.md
 * — Knowledge Base sits at a different seam queried by subagents directly).
 * Test exercises the pure shape; doesn't require Redis-resident reflections
 * to be present (the four-block layout holds even when every block misses).
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
    assert.equal(ctx.blocks.length, 5, "five sources contribute one block each");
    assert.deepEqual(
      ctx.blocks.map((b: any) => b.source),
      [
        "agent-memory",
        "knowledge-base",
        "per-anchor-reflections",
        "by-file-reflections",
        "global-reflections",
      ],
      "block order is the prompt order — agent-memory first, global-reflections last",
    );
    for (const block of ctx.blocks) {
      assert.ok(
        ["hit", "miss", "error"].includes(block.status),
        `block ${block.source} status must be hit/miss/error, got ${block.status}`,
      );
      // Issue #804: every block carries a numeric itemCount; 0 for miss/error.
      assert.equal(typeof block.itemCount, "number", `block ${block.source} carries a numeric itemCount`);
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

  test("missing or empty agent name still returns five blocks", async (t) => {
    // The function shouldn't throw on weird-but-non-crashing inputs; it
    // should return a structured trace where each source decided what
    // to do. The contract is "five blocks, one per source" (issue #804 added
    // the knowledge-base block).
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

    assert.equal(ctx.blocks.length, 5);
  });

  test("after() — close Redis connections", () => {
    closeRedisConnections();
  });
});

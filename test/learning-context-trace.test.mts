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

process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

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
    // Issue #2198: the within-bundle drop-priority machinery (the
    // LEARNING_DROP_PRIORITY table that fed the retired in-process budgeter)
    // was removed when learning.ts collapsed to a diagnostic-only composer.
    // Blocks no longer carry a `dropPriority`, and the trace's HTTP response
    // never put it on the wire, so nothing observable changed.
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

  // Issue #2141: getContext now accepts an optional `deps` bag of the four
  // primitive source-loaders. Injecting stubs drives a realistic HIT scenario
  // (non-empty agent-memory + non-empty per-anchor-reflections) WITHOUT a live
  // Redis connection — exercising the production composition logic (the
  // formatMemoryForPrompt adaptation in the agent-memory thunk, the count===0
  // gate + backfill-then-read ordering in the per-anchor thunk) on stubs. These
  // are NESTED in this describe block deliberately: a sibling top-level block
  // would run after this block's after()-style closeRedisConnections() teardown
  // and fail with "Connection is closed".
  test("injected stubs drive a Redis-free hit scenario through the composition seam", async () => {
    const ctx = await learning.getContext(
      "planner",
      { type: "codebase-health", reference: "issue-2141-stub", files: ["src/learning.ts"] },
      {
        // Non-empty raw memory → formatMemoryForPrompt's line-fallback yields a
        // real agent-memory HIT (itemCount = number of "- " lines kept).
        loadAgentMemory: async () => "- prefer the deps-bag idiom\n- never inject the whole thunk",
        // per-anchor HIT: non-empty content, count 1.
        loadAnchorReflections: async () => ({ content: "PRIOR ATTEMPT: stubbed reflection", count: 1 }),
        // knowledge-base + by-file both MISS (empty content). The KB stub also
        // proves the dynamic OV import is skipped — no Redis/OV touched.
        loadKnowledgeBaseForPrompt: async () => ({ content: "", itemCount: 0 }),
        loadAnchorReflectionsByFile: async () => ({ content: "", count: 0 }),
      },
    );

    const bySource = new Map(ctx.blocks.map((b: any) => [b.source, b]));

    const agentMemory = bySource.get("agent-memory");
    assert.equal(agentMemory.status, "hit", "injected non-empty agent-memory → hit");
    assert.ok(agentMemory.content.includes("prefer the deps-bag idiom"),
      "agent-memory block carries the injected memory, formatted for the prompt");
    assert.equal(agentMemory.itemCount, 2, "two memory lines → itemCount 2 (count-from-data)");

    const perAnchor = bySource.get("per-anchor-reflections");
    assert.equal(perAnchor.status, "hit", "injected per-anchor reflection → hit");
    assert.equal(perAnchor.content, "PRIOR ATTEMPT: stubbed reflection");
    assert.equal(perAnchor.itemCount, 1, "per-anchor itemCount carried from the read's count");

    assert.equal(bySource.get("knowledge-base").status, "miss", "empty KB stub → miss");
    assert.equal(bySource.get("by-file-reflections").status, "miss", "empty by-file stub → miss");

    // toPrompt() joins exactly the two HIT contents with "\n\n", in block order.
    assert.equal(
      ctx.toPrompt(),
      `${agentMemory.content}\n\nPRIOR ATTEMPT: stubbed reflection`,
      "toPrompt() concatenates only the two hit blocks with \\n\\n",
    );
  });

  // Issue #2141: a partial deps bag overrides only the named field; the rest
  // default to the real implementations. With no Redis the defaulted loaders
  // miss/error rather than throwing out of getContext, but the INJECTED
  // agent-memory loader still drives a deterministic HIT — proving the
  // `deps?.field ?? realImpl` default is per-field, not all-or-nothing.
  test("partial deps bag overrides one loader and defaults the rest", async (t) => {
    let ctx;
    try {
      ctx = await learning.getContext(
        "planner",
        { type: "codebase-health", reference: "issue-2141-partial — should never match a real anchor" },
        { loadAgentMemory: async () => "- only this loader is injected" },
      );
    } catch (err: any) {
      if (err?.code === "ECONNREFUSED") {
        t.skip("Redis unavailable on REDIS_URL — skipping");
        return;
      }
      throw err;
    }

    assert.equal(ctx.blocks.length, 4, "still four blocks regardless of partial deps");
    const agentMemory = ctx.blocks.find((b: any) => b.source === "agent-memory");
    assert.equal(agentMemory.status, "hit", "injected loader produces a hit");
    assert.ok(agentMemory.content.includes("only this loader is injected"));
  });

  // Issue #2198: the hit/miss/error envelope mapping (previously exercised via
  // the now-removed generic `loadBlock`) is covered through getContext's stub
  // path above — the injected-stubs test drives a real hit + two misses, and an
  // error block is produced whenever a defaulted Redis-backed source throws.
  // The standalone `loadBlock` describe was dropped with the abstraction.

  test("after() — close Redis connections", () => {
    closeRedisConnections();
  });
});

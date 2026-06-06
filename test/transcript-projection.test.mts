/**
 * Transcript Projection — pure-helper tests (issue #987).
 *
 * Exercises the schema-knowledge functions extracted out of the
 * `src/api/dispatches.ts` route into `src/transcript-projection.ts`:
 * `isConversationRecord`, `normaliseContent`, `projectMessage`,
 * `parseTranscript`, and `paginate`. These are pure (no Express, no Redis, no
 * filesystem) and so are unit-testable directly without standing up the route.
 *
 * The route-contract + layout/IO tests (isUuidShaped, confineToRoot,
 * encodeProjectDir, resolveTranscriptPath, sessionMetadataFrom, and the
 * GET-route contract) keep their home in `test/dispatches-transcript.test.mts`.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const {
  parseTranscript,
  paginate,
  normaliseContent,
  isConversationRecord,
  projectMessage,
  stringifyToolResult,
} = await import("../src/transcript-projection.ts");

type TranscriptBlock = import("../src/transcript-projection.ts").TranscriptBlock;

/**
 * Read the `text` off a transcript block in a type-safe way. `TranscriptBlock`
 * is a discriminated union and only the text/thinking/tool_result variants
 * carry a `text` field — `tool_use` does not — so a bare `block.text` access
 * fails strict-test typecheck (issue #774). These assertions only ever inspect
 * text blocks, so narrow explicitly and fail loud if the variant is wrong.
 */
function textOf(block: TranscriptBlock): string {
  if (block.type === "tool_use") {
    throw new Error(`expected a text-bearing block, got tool_use(${block.name})`);
  }
  return block.text;
}

// ---------------------------------------------------------------------------
// isConversationRecord
// ---------------------------------------------------------------------------

describe("isConversationRecord", () => {
  test("keeps user/assistant records", () => {
    assert.equal(isConversationRecord({ type: "user", message: { content: "hi" } }), true);
    assert.equal(isConversationRecord({ type: "assistant", message: { content: [] } }), true);
  });
  test("drops isMeta records", () => {
    assert.equal(isConversationRecord({ type: "user", isMeta: true, message: { content: "x" } }), false);
  });
  test("drops non-conversation record types", () => {
    assert.equal(isConversationRecord({ type: "file-history-snapshot" }), false);
    assert.equal(isConversationRecord({ type: "attachment" }), false);
    assert.equal(isConversationRecord({ type: "ai-title" }), false);
  });
  test("drops content-less system rows but keeps system rows with content", () => {
    assert.equal(isConversationRecord({ type: "system", subtype: "turn_duration" }), false);
    assert.equal(isConversationRecord({ type: "system", content: "a warning" }), true);
  });
});

// ---------------------------------------------------------------------------
// normaliseContent — string + block-array flattening
// ---------------------------------------------------------------------------

describe("normaliseContent", () => {
  test("wraps a string in a single text block", () => {
    assert.deepEqual(normaliseContent("hello"), [{ type: "text", text: "hello" }]);
  });
  test("empty string yields no blocks", () => {
    assert.deepEqual(normaliseContent(""), []);
  });
  test("maps text/thinking/tool_use/tool_result blocks", () => {
    const out = normaliseContent([
      { type: "text", text: "t" },
      { type: "thinking", thinking: "th", signature: "sig" },
      { type: "tool_use", name: "Bash", input: { command: "ls" } },
      { type: "tool_result", content: "ok", is_error: false },
    ]);
    assert.deepEqual(out, [
      { type: "text", text: "t" },
      { type: "thinking", text: "th" },
      { type: "tool_use", name: "Bash", input: { command: "ls" } },
      { type: "tool_result", text: "ok", isError: false },
    ]);
  });
  test("flags an error tool_result", () => {
    const out = normaliseContent([{ type: "tool_result", content: "boom", is_error: true }]);
    assert.deepEqual(out, [{ type: "tool_result", text: "boom", isError: true }]);
  });
  test("flattens an array-shaped tool_result content", () => {
    const out = normaliseContent([
      { type: "tool_result", content: [{ type: "text", text: "line1" }, { type: "text", text: "line2" }] },
    ]);
    assert.deepEqual(out, [{ type: "tool_result", text: "line1\nline2", isError: false }]);
  });
});

// ---------------------------------------------------------------------------
// stringifyToolResult — flatten string / block-array tool_result content
// ---------------------------------------------------------------------------

describe("stringifyToolResult", () => {
  test("passes a string through unchanged", () => {
    assert.equal(stringifyToolResult("done"), "done");
  });
  test("null/undefined content yields empty string", () => {
    assert.equal(stringifyToolResult(null), "");
    assert.equal(stringifyToolResult(undefined), "");
  });
  test("joins a text-block array with newlines", () => {
    assert.equal(
      stringifyToolResult([{ type: "text", text: "a" }, { type: "text", text: "b" }]),
      "a\nb",
    );
  });
  test("stringifies a non-text block in the array", () => {
    assert.equal(
      stringifyToolResult([{ type: "image", source: "x" }]),
      JSON.stringify({ type: "image", source: "x" }),
    );
  });
  test("stringifies a non-string, non-array content", () => {
    assert.equal(stringifyToolResult({ k: 1 }), JSON.stringify({ k: 1 }));
  });
});

// ---------------------------------------------------------------------------
// projectMessage
// ---------------------------------------------------------------------------

describe("projectMessage", () => {
  test("projects an assistant text record", () => {
    const msg = projectMessage({
      type: "assistant",
      timestamp: "2026-05-30T00:00:00Z",
      message: { content: [{ type: "text", text: "hi" }] },
    });
    assert.deepEqual(msg, {
      role: "assistant",
      blocks: [{ type: "text", text: "hi" }],
      timestamp: "2026-05-30T00:00:00Z",
    });
  });
  test("returns null for a record that filters out", () => {
    assert.equal(projectMessage({ type: "file-history-snapshot" }), null);
  });
  test("returns null for a conversation record with no renderable blocks", () => {
    assert.equal(projectMessage({ type: "assistant", message: { content: [] } }), null);
  });
});

// ---------------------------------------------------------------------------
// parseTranscript — malformed line skipping + filtering
// ---------------------------------------------------------------------------

describe("parseTranscript", () => {
  test("filters to the conversation set, oldest-first", () => {
    const body = [
      JSON.stringify({ type: "file-history-snapshot" }),
      JSON.stringify({ type: "user", message: { content: "q1" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "a1" }] } }),
      JSON.stringify({ type: "user", isMeta: true, message: { content: "meta" } }),
    ].join("\n");
    const out = parseTranscript(body);
    assert.equal(out.length, 2);
    assert.equal(out[0].role, "user");
    assert.equal(textOf(out[0].blocks[0]), "q1");
    assert.equal(out[1].role, "assistant");
  });

  test("skips a malformed JSONL line without crashing or truncating", () => {
    const body = [
      JSON.stringify({ type: "user", message: { content: "before" } }),
      "{ this is not valid json",
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "after" }] } }),
    ].join("\n");
    const out = parseTranscript(body);
    // The bad middle line is skipped; the two valid lines survive.
    assert.equal(out.length, 2);
    assert.equal(textOf(out[0].blocks[0]), "before");
    assert.equal(textOf(out[1].blocks[0]), "after");
  });

  test("tolerates blank lines and trailing newline", () => {
    const body = "\n" + JSON.stringify({ type: "user", message: { content: "x" } }) + "\n\n";
    assert.equal(parseTranscript(body).length, 1);
  });
});

// ---------------------------------------------------------------------------
// paginate — total counts the FULL filtered set
// ---------------------------------------------------------------------------

describe("paginate", () => {
  const mk = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ role: "user" as const, blocks: [{ type: "text" as const, text: `m${i}` }] }));

  test("default-style first page", () => {
    const { page, total } = paginate(mk(500), 0, 200);
    assert.equal(total, 500);
    assert.equal(page.length, 200);
    assert.equal(textOf(page[0].blocks[0]), "m0");
  });
  test("second page slices oldest-first from the offset", () => {
    const { page, total } = paginate(mk(500), 200, 200);
    assert.equal(total, 500);
    assert.equal(page.length, 200);
    assert.equal(textOf(page[0].blocks[0]), "m200");
  });
  test("offset past the end yields an empty page but the true total", () => {
    const { page, total } = paginate(mk(10), 999, 200);
    assert.equal(total, 10);
    assert.equal(page.length, 0);
  });
  test("limit smaller than the set caps the page", () => {
    const { page, total } = paginate(mk(10), 0, 3);
    assert.equal(total, 10);
    assert.equal(page.length, 3);
  });
});

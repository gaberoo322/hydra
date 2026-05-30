/**
 * Subagent transcript viewer — pure-helper + route-contract tests (issue #695).
 *
 * Two surfaces:
 *
 *   1. The pure JSONL parsing/pagination/path helpers exported from
 *      `src/api/dispatches.ts` (parseTranscript, paginate, normaliseContent,
 *      isConversationRecord, projectMessage, resolveTranscriptPath,
 *      confineToRoot, isUuidShaped, encodeProjectDir).
 *   2. The `GET /api/dispatches/:dispatchId/transcript` route contract, driven
 *      against a real Redis on DB 1 (same convention as dispatches.test.mts)
 *      plus a temp-dir transcript root — exercising 404 (unknown dispatch),
 *      200 not-available (known dispatch, missing JSONL), 200 available with
 *      pagination, and malformed-line skipping.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";
import express from "express";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.REDIS_URL = "redis://localhost:6379/1";

const {
  parseTranscript,
  paginate,
  normaliseContent,
  isConversationRecord,
  projectMessage,
  resolveTranscriptPath,
  confineToRoot,
  isUuidShaped,
  encodeProjectDir,
  sessionMetadataFrom,
  createDispatchesRouter,
} = await import("../src/api/dispatches.ts");

const { registerSubagentDispatch } = await import("../src/redis/dispatches.ts");

type TranscriptBlock = import("../src/api/dispatches.ts").TranscriptBlock;

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

const UUID = "11111111-2222-4333-8444-555555555555";

// ---------------------------------------------------------------------------
// isUuidShaped — the path-traversal guard
// ---------------------------------------------------------------------------

describe("isUuidShaped", () => {
  test("accepts a canonical UUID", () => {
    assert.equal(isUuidShaped(UUID), true);
  });
  test("rejects a traversal attempt", () => {
    assert.equal(isUuidShaped("../../etc/passwd"), false);
    assert.equal(isUuidShaped("not-a-uuid"), false);
    assert.equal(isUuidShaped(""), false);
  });
});

// ---------------------------------------------------------------------------
// confineToRoot — defence in depth
// ---------------------------------------------------------------------------

describe("confineToRoot", () => {
  test("returns the resolved path when inside root", () => {
    const out = confineToRoot("/home/x/.claude/projects", "/home/x/.claude/projects/d/f.jsonl");
    assert.equal(out, "/home/x/.claude/projects/d/f.jsonl");
  });
  test("returns null when the candidate escapes root", () => {
    const out = confineToRoot("/home/x/.claude/projects", "/home/x/.claude/projects/../../../etc/passwd");
    assert.equal(out, null);
  });
});

// ---------------------------------------------------------------------------
// encodeProjectDir
// ---------------------------------------------------------------------------

describe("encodeProjectDir", () => {
  test("replaces non-alphanumerics with dashes, harness-style", () => {
    assert.equal(encodeProjectDir("/home/gabe/hydra"), "-home-gabe-hydra");
  });
});

// ---------------------------------------------------------------------------
// isConversationRecord — the filter
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

// ---------------------------------------------------------------------------
// resolveTranscriptPath — projectDir-direct + scan fallback + confinement
// ---------------------------------------------------------------------------

describe("resolveTranscriptPath", () => {
  test("returns null for a non-UUID sessionId (traversal guard)", async () => {
    const out = await resolveTranscriptPath("../../etc/passwd", undefined, {
      root: "/tmp/root",
      stat: async () => true,
    });
    assert.equal(out, null);
  });

  test("resolves directly from a known projectDir", async () => {
    const root = "/tmp/root";
    const seen: string[] = [];
    const out = await resolveTranscriptPath(UUID, "/home/gabe/hydra", {
      root,
      stat: async (p) => {
        seen.push(p);
        return p.includes("-home-gabe-hydra");
      },
      listProjectDirs: async () => {
        throw new Error("scan should not run when direct path hits");
      },
    });
    assert.equal(out, join(root, "-home-gabe-hydra", `${UUID}.jsonl`));
  });

  test("falls back to scanning project dirs when projectDir is unknown", async () => {
    const root = "/tmp/root";
    const out = await resolveTranscriptPath(UUID, undefined, {
      root,
      stat: async (p) => p.includes("dir-b"),
      listProjectDirs: async () => ["dir-a", "dir-b"],
    });
    assert.equal(out, join(root, "dir-b", `${UUID}.jsonl`));
  });

  test("returns null when no dir contains the session file", async () => {
    const out = await resolveTranscriptPath(UUID, undefined, {
      root: "/tmp/root",
      stat: async () => false,
      listProjectDirs: async () => ["dir-a"],
    });
    assert.equal(out, null);
  });
});

// ---------------------------------------------------------------------------
// sessionMetadataFrom
// ---------------------------------------------------------------------------

describe("sessionMetadataFrom", () => {
  test("projects required + optional fields, nulling absent optionals", () => {
    const meta = sessionMetadataFrom({
      sessionId: UUID,
      skill: "hydra-dev",
      dispatchId: "wt-abc",
      startedAt: "2026-05-30T00:00:00Z",
    });
    assert.deepEqual(meta, {
      skill: "hydra-dev",
      dispatchId: "wt-abc",
      runId: null,
      startedAt: "2026-05-30T00:00:00Z",
      projectDir: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Route contract — real Redis (DB 1) + temp transcript root
// ---------------------------------------------------------------------------

describe("GET /dispatches/:dispatchId/transcript — route contract", () => {
  let testRedis: any;
  let server: any;
  let baseUrl: string;
  let tmpRoot: string;
  const origHome = process.env.HOME;

  beforeEach(async () => {
    if (!testRedis) testRedis = new Redis("redis://localhost:6379/1");
    const keys = await testRedis.keys("hydra:dispatches:subagent:*");
    if (keys.length > 0) await testRedis.del(...keys);
  });

  after(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    if (testRedis) await testRedis.quit();
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
    if (origHome !== undefined) process.env.HOME = origHome;
  });

  async function startServer() {
    // Point HOME at a temp dir so transcriptRoot() -> <tmp>/.claude/projects.
    tmpRoot = mkdtempSync(join(tmpdir(), "hydra-transcript-"));
    process.env.HOME = tmpRoot;
    const app = express();
    app.use(express.json());
    app.use("/api", createDispatchesRouter());
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }

  function writeTranscript(sessionId: string, projectDir: string, lines: string[]) {
    const encoded = projectDir.replace(/[^A-Za-z0-9]/g, "-");
    const dir = join(tmpRoot, ".claude", "projects", encoded);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sessionId}.jsonl`), lines.join("\n"), "utf8");
  }

  test("unknown dispatchId → 404", async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/api/dispatches/${UUID}/transcript`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.code, "dispatch-not-found");
  });

  test("known dispatch but missing JSONL → 200 not-available with metadata", async () => {
    // server already started by the previous test (same describe scope).
    await registerSubagentDispatch({
      sessionId: UUID,
      skill: "hydra-dev",
      dispatchId: "wt-xyz",
      startedAt: "2026-05-30T00:00:00Z",
      projectDir: "/home/gabe/hydra",
    });
    const res = await fetch(`${baseUrl}/api/dispatches/${UUID}/transcript`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.transcriptStatus, "not-available");
    assert.deepEqual(body.messages, []);
    assert.equal(body.total, 0);
    assert.equal(body.sessionMetadata.skill, "hydra-dev");
    assert.equal(body.sessionMetadata.dispatchId, "wt-xyz");
  });

  test("known dispatch with intact JSONL → 200 available + paginated messages, malformed line skipped", async () => {
    await registerSubagentDispatch({
      sessionId: UUID,
      skill: "hydra-dev",
      dispatchId: "wt-xyz",
      startedAt: "2026-05-30T00:00:00Z",
      projectDir: "/home/gabe/hydra",
    });
    writeTranscript(UUID, "/home/gabe/hydra", [
      JSON.stringify({ type: "file-history-snapshot" }),
      JSON.stringify({ type: "user", message: { content: "question" } }),
      "{ broken json line",
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "answer" }] } }),
    ]);
    const res = await fetch(`${baseUrl}/api/dispatches/${UUID}/transcript?offset=0&limit=200`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.transcriptStatus, "available");
    assert.equal(body.total, 2);
    assert.equal(body.messages.length, 2);
    assert.equal(body.messages[0].role, "user");
    assert.equal(body.messages[1].blocks[0].text, "answer");
    assert.equal(body.offset, 0);
    assert.equal(body.limit, 200);
  });

  test("invalid query params → 400 schema-validation-failed", async () => {
    await registerSubagentDispatch({
      sessionId: UUID,
      skill: "hydra-dev",
      dispatchId: "wt-xyz",
      startedAt: "2026-05-30T00:00:00Z",
      projectDir: "/home/gabe/hydra",
    });
    const res = await fetch(`${baseUrl}/api/dispatches/${UUID}/transcript?limit=-5`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "schema-validation-failed");
  });
});

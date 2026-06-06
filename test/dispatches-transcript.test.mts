/**
 * Subagent transcript viewer — layout/IO-helper + route-contract tests
 * (issues #695, #951).
 *
 * Two surfaces:
 *
 *   1. The path/layout helpers the route consumes from the **Transcript Store**
 *      Seam (`src/transcript-store.ts`): resolveTranscriptPath, confineToRoot,
 *      isUuidShaped, encodeProjectDir — plus the route-local sessionMetadataFrom
 *      projection of a dispatch record (`src/api/dispatches.ts`).
 *   2. The `GET /api/dispatches/:dispatchId/transcript` route contract, driven
 *      against a real Redis on DB 1 (same convention as dispatches.test.mts)
 *      plus a temp-dir transcript root — exercising 404 (unknown dispatch),
 *      200 not-available (known dispatch, missing JSONL), 200 available with
 *      pagination, and malformed-line skipping.
 *
 * The pure JSONL projection helpers (parseTranscript, paginate, normaliseContent,
 * isConversationRecord, projectMessage) moved to the **Transcript Projection**
 * Seam and are tested in `test/transcript-projection.test.mts` (issue #987).
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
  resolveTranscriptPath,
  confineToRoot,
  isUuidShaped,
  encodeProjectDir,
} = await import("../src/transcript-store.ts");

const {
  sessionMetadataFrom,
  createDispatchesRouter,
} = await import("../src/api/dispatches.ts");

const { registerSubagentDispatch } = await import("../src/redis/dispatches.ts");

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

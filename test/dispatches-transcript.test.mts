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

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";
import express from "express";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

const {
  resolveTranscriptPath,
  findSubagentTranscriptPathByAgentId,
  resetAgentScanCache,
  confineToRoot,
  isUuidShaped,
  encodeProjectDir,
} = await import("../src/transcript-store.ts");

const {
  sessionMetadataFrom,
  createDispatchesRouter,
} = await import("../src/api/dispatches.ts");

const { registerSubagentDispatch, getSubagentDispatch } = await import("../src/redis/dispatches.ts");

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

describe("findSubagentTranscriptPathByAgentId (#5325)", () => {
  const hit = "/r/-proj/sess/subagents/agent-abcdef0123456789a.jsonl";
  const deps = {
    root: "/r",
    listProjectDirs: async (p: string) =>
      p === "/r" ? ["-proj", "-other"] : p === "/r/-proj" ? ["sess"] : [],
    stat: async (p: string) => p === hit,
  };
  test("finds the child under any project/session dir", async () => {
    assert.equal(await findSubagentTranscriptPathByAgentId("abcdef0123456789a", deps), hit);
  });
  test("malformed or traversal ids return null before any scan", async () => {
    resetAgentScanCache();
    let calls = 0;
    const counting = {
      ...deps,
      listProjectDirs: async (p: string) => {
        calls++;
        return deps.listProjectDirs(p);
      },
      stat: async (p: string) => {
        calls++;
        return deps.stat(p);
      },
    };
    for (const bad of ["../../etc", UUID, "abcdef0123456789", "abcdef0123456789ab", "ABCDEF0123456789A"]) {
      assert.equal(await findSubagentTranscriptPathByAgentId(bad, counting), null);
    }
    assert.equal(calls, 0, "guard must reject before any listing/stat");
    // Sibling: a correctly shaped id with a matching file is found (guard not over-tight).
    assert.equal(await findSubagentTranscriptPathByAgentId("abcdef0123456789a", counting), hit);
    assert.ok(calls > 0);
  });
  test("waiter queue is bounded: overflow sheds load with null, uncached (INV-bound)", async () => {
    resetAgentScanCache();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let rootListings = 0;
    const blocked = {
      ...deps,
      listProjectDirs: async (p: string) => {
        if (p === "/r") rootListings++;
        await gate;
        return [];
      },
    };
    const ids = Array.from({ length: 50 }, (_, i) => `1234567890abcde${String(i).padStart(2, "0")}`);
    const probes = ids.map((id) => findSubagentTranscriptPathByAgentId(id, blocked));
    await new Promise((r) => setTimeout(r, 30));
    release();
    await Promise.all(probes);
    assert.ok(rootListings <= 2 + 32, `scans ${rootListings} must be <= running(2)+waiters(32)`);
    // Shed requests were not negatively cached: a later probe scans afresh.
    const before = rootListings;
    await findSubagentTranscriptPathByAgentId(ids[49], blocked);
    assert.ok(rootListings > before, "shed id must not be cached");
  });
  test("a throwing stat resolves null (never rejects), uncached; sibling clean path still hits", async () => {
    resetAgentScanCache();
    let boom = true;
    const flaky = {
      ...deps,
      stat: async (p: string) => {
        if (boom) throw new Error("EIO");
        return deps.stat(p);
      },
    };
    assert.equal(await findSubagentTranscriptPathByAgentId("abcdef0123456789a", flaky), null);
    boom = false;
    assert.equal(await findSubagentTranscriptPathByAgentId("abcdef0123456789a", flaky), hit);
  });
  test("misses never evict hits (separate caches)", async () => {
    resetAgentScanCache();
    let scans = 0;
    const counting = {
      ...deps,
      listProjectDirs: async (p: string) => {
        scans++;
        return deps.listProjectDirs(p);
      },
    };
    assert.equal(await findSubagentTranscriptPathByAgentId("abcdef0123456789a", counting), hit);
    for (let i = 0; i < 300; i++) {
      await findSubagentTranscriptPathByAgentId(`2${String(i).padStart(16, "0")}`.replace(/[^0-9a-f]/g, "0"), counting);
    }
    const before = scans;
    assert.equal(await findSubagentTranscriptPathByAgentId("abcdef0123456789a", counting), hit);
    assert.equal(scans, before, "hit must survive a flood of misses");
  });
  test("miss returns null", async () => {
    resetAgentScanCache();
    assert.equal(await findSubagentTranscriptPathByAgentId("0123456789abcdefa", deps), null);
  });
  test("repeat probes (hit and miss) are served from the short-TTL cache, not re-scanned", async () => {
    resetAgentScanCache();
    let scans = 0;
    const counting = {
      ...deps,
      listProjectDirs: async (p: string) => {
        scans++;
        return deps.listProjectDirs(p);
      },
    };
    await findSubagentTranscriptPathByAgentId("fedcba9876543210a", counting);
    const afterFirstMiss = scans;
    assert.ok(afterFirstMiss > 0);
    await findSubagentTranscriptPathByAgentId("fedcba9876543210a", counting);
    await findSubagentTranscriptPathByAgentId("fedcba9876543210a", counting);
    assert.equal(scans, afterFirstMiss, "cached miss must not re-scan");
    // Sibling shape: a cached hit still returns the same path with no re-scan.
    assert.equal(await findSubagentTranscriptPathByAgentId("abcdef0123456789a", counting), hit);
    const afterHit = scans;
    assert.equal(await findSubagentTranscriptPathByAgentId("abcdef0123456789a", counting), hit);
    assert.equal(scans, afterHit);
  });
  test("concurrent probes for one id share a single in-flight scan (single-flight)", async () => {
    resetAgentScanCache();
    let rootListings = 0;
    const slow = {
      ...deps,
      listProjectDirs: async (p: string) => {
        if (p === "/r") rootListings++;
        await new Promise((r) => setTimeout(r, 20));
        return deps.listProjectDirs(p);
      },
    };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => findSubagentTranscriptPathByAgentId("abcdef0123456789a", slow)),
    );
    assert.ok(results.every((r) => r === hit));
    assert.equal(rootListings, 1, "5 concurrent probes -> 1 scan");
  });
  test("concurrent scans of DISTINCT ids are capped", async () => {
    resetAgentScanCache();
    let live = 0;
    let peak = 0;
    const slow = {
      ...deps,
      listProjectDirs: async (p: string) => {
        if (p !== "/r") return [];
        live++;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 15));
        live--;
        return [];
      },
    };
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        findSubagentTranscriptPathByAgentId(`0000000000000000${i}`.slice(-17), slow),
      ),
    );
    assert.ok(peak <= 2, `peak concurrent scans ${peak} must be <= 2`);
  });
  test("a miss caused by a listing error is not cached; a clean miss still is", async () => {
    resetAgentScanCache();
    let calls = 0;
    let fail = true;
    const flaky = {
      ...deps,
      listProjectDirs: async (p: string) => {
        calls++;
        if (fail) throw new Error("EIO");
        return deps.listProjectDirs(p);
      },
    };
    assert.equal(await findSubagentTranscriptPathByAgentId("abcdef0123456789a", flaky), null);
    fail = false;
    assert.equal(
      await findSubagentTranscriptPathByAgentId("abcdef0123456789a", flaky),
      hit,
      "errored miss must not be negatively cached",
    );
    // Sibling: clean miss is cached.
    calls = 0;
    await findSubagentTranscriptPathByAgentId("1111111111111111a", flaky);
    const c = calls;
    await findSubagentTranscriptPathByAgentId("1111111111111111a", flaky);
    assert.equal(calls, c);
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
    if (!testRedis) testRedis = new Redis(process.env.REDIS_URL);
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

  test("Agent-tool child (#4965): POST with parentSessionId then GET /transcript resolves <parent>/subagents/agent-<id>.jsonl", async () => {
    const agentId = "a1b2c3d4e5f60718";
    const post = await fetch(`${baseUrl}/api/dispatches/subagent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: agentId,
        parentSessionId: UUID,
        skill: "hydra-dev",
        dispatchId: "worktree-agent-a1b2c3d4e5f60718-t1-dev_orch",
        startedAt: "2026-10-17T00:00:00Z",
        projectDir: "/home/gabe/hydra",
      }),
    });
    assert.equal(post.status, 200);
    // Child JSONL lives under the PARENT's dir, in a different project dir
    // than the child's own cwd - the resolver must scan for it.
    const subDir = join(tmpRoot, ".claude", "projects", "-home-gabe-hydra", UUID, "subagents");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(subDir, `agent-${agentId}.jsonl`),
      [
        JSON.stringify({ type: "user", message: { content: "child question" } }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "child answer" }] } }),
      ].join("\n"),
      "utf8",
    );
    const res = await fetch(`${baseUrl}/api/dispatches/${agentId}/transcript`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.transcriptStatus, "available");
    assert.equal(body.total, 2);
    assert.equal(body.messages[1].blocks[0].text, "child answer");
    assert.equal(body.sessionMetadata.dispatchId, "worktree-agent-a1b2c3d4e5f60718-t1-dev_orch");
  });

  test("registry hit carries resolvedVia registry", async () => {
    await registerSubagentDispatch({
      sessionId: UUID,
      skill: "hydra-dev",
      dispatchId: "wt-xyz",
      startedAt: "2026-05-30T00:00:00Z",
      projectDir: "/home/gabe/hydra",
    });
    const res = await fetch(`${baseUrl}/api/dispatches/${UUID}/transcript`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).resolvedVia, "registry");
  });

  function writeChild(agentId: string, parent: string) {
    resetAgentScanCache();
    const subDir = join(tmpRoot, ".claude", "projects", "-home-gabe-hydra", parent, "subagents");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(subDir, `agent-${agentId}.jsonl`),
      JSON.stringify({ type: "user", message: { content: "child question" } }),
      "utf8",
    );
  }

  test("reaped Agent-tool child (#5325): row DELETEd after completion still resolves via disk-fallback", async () => {
    const agentId = "b1b2c3d4e5f60718a";
    const post = await fetch(`${baseUrl}/api/dispatches/subagent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: agentId,
        parentSessionId: UUID,
        skill: "hydra-dev",
        dispatchId: "worktree-agent-b1b2c3d4e5f60718a-t1-dev_orch",
        startedAt: "2026-10-17T00:00:00Z",
      }),
    });
    assert.equal(post.status, 200);
    writeChild(agentId, UUID);
    const del = await fetch(`${baseUrl}/api/dispatches/subagent/${agentId}`, { method: "DELETE" });
    assert.equal(del.status, 200);
    const res = await fetch(`${baseUrl}/api/dispatches/${agentId}/transcript`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.transcriptStatus, "available");
    assert.equal(body.resolvedVia, "disk-fallback");
    assert.equal(body.total, 1);
    assert.deepEqual(body.sessionMetadata, {
      skill: null,
      dispatchId: null,
      runId: null,
      startedAt: null,
      projectDir: null,
    });
  });

  test("unregistered agent hash with no file on disk -> 404 dispatch-not-found", async () => {
    const res = await fetch(`${baseUrl}/api/dispatches/c1c2c3d4e5f60718a/transcript`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.code, "dispatch-not-found");
  });

  test("UUID-shaped unregistered id never takes the disk fallback", async () => {
    const other = "99999999-2222-4333-8444-555555555555";
    resetAgentScanCache();
    const subDir = join(tmpRoot, ".claude", "projects", "-home-gabe-hydra", UUID, "subagents");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, `agent-${other}.jsonl`), JSON.stringify({ type: "user", message: { content: "secret" } }), "utf8");
    const dir = join(tmpRoot, ".claude", "projects", "-home-gabe-hydra");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${other}.jsonl`), JSON.stringify({ type: "user", message: { content: "secret" } }), "utf8");
    const res = await fetch(`${baseUrl}/api/dispatches/${other}/transcript`);
    assert.equal(res.status, 404);
  });

  test("16-hex id with a file on disk is NOT served (exact 17-hex gate)", async () => {
    const short = "d1d2d3d4d5d6d7d8";
    writeChild(short, UUID);
    const res = await fetch(`${baseUrl}/api/dispatches/${short}/transcript`);
    assert.equal(res.status, 404);
    // Sibling: the 17-hex shape with a file is served.
    writeChild(short + "9", UUID);
    assert.equal((await fetch(`${baseUrl}/api/dispatches/${short}9/transcript`)).status, 200);
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

// ---------------------------------------------------------------------------
// DELETE /dispatches/subagent/:sessionId — route contract (issue #5142)
// ---------------------------------------------------------------------------

describe("DELETE /dispatches/subagent/:sessionId — route contract (#5142)", () => {
  let testRedis: any;
  let server: any;
  let baseUrl: string;

  before(async () => {
    testRedis = new Redis(process.env.REDIS_URL);
    const app = express();
    app.use(express.json());
    app.use("/api", createDispatchesRouter());
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  beforeEach(async () => {
    const keys = await testRedis.keys("hydra:dispatches:subagent:*");
    if (keys.length > 0) await testRedis.del(...keys);
  });

  after(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    if (testRedis) await testRedis.quit();
  });

  const reg = (sessionId: string) =>
    registerSubagentDispatch({
      sessionId,
      skill: "hydra-dev",
      dispatchId: `wt-${sessionId}`,
      startedAt: "2026-05-30T00:00:00Z",
      projectDir: "/home/gabe/hydra",
    });

  test("existing row -> 200 and the row is gone", async () => {
    await reg("sess-del-1");
    const res = await fetch(`${baseUrl}/api/dispatches/subagent/sess-del-1`, { method: "DELETE" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ended, true);
    assert.equal(body.sessionId, "sess-del-1");
    assert.equal(await getSubagentDispatch("sess-del-1"), null);
  });

  test("sibling shape: a different live row survives the delete", async () => {
    await reg("sess-del-a");
    await reg("sess-del-b");
    await fetch(`${baseUrl}/api/dispatches/subagent/sess-del-a`, { method: "DELETE" });
    assert.equal(await getSubagentDispatch("sess-del-a"), null);
    assert.notEqual(await getSubagentDispatch("sess-del-b"), null);
  });

  test("missing row -> idempotent 200", async () => {
    const res = await fetch(`${baseUrl}/api/dispatches/subagent/never-registered`, { method: "DELETE" });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ended, true);
  });

  test("malformed sessionId -> 400 schema-validation-failed", async () => {
    const res = await fetch(`${baseUrl}/api/dispatches/subagent/bad%20id%21`, { method: "DELETE" });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "schema-validation-failed");
  });
});

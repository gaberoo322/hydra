/**
 * Regression tests for `GET /api/reflections?anchor=&files=` (issue #841).
 *
 * This is the LIVE reflection-injection path that re-homes the per-anchor
 * Reflection narrative onto the dispatch path (the role the dead in-process
 * `buildPlannerContext` used to play). The #193 retry-correctness invariant
 * requires that a RETRY dispatch of a prior-failure anchor demonstrably
 * receives that anchor's per-anchor reflection content — this test asserts
 * the endpoint the dispatch skills (`hydra-dev`, `hydra-target-build`) fetch
 * actually returns the narrative.
 *
 * Requires Redis running on localhost:6379. Uses Redis DB 1 for tests —
 * never touches production (DB 0).
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import Redis from "ioredis";

process.env.REDIS_URL = "redis://localhost:6379/1";

const { createReflectionsRouter } = await import("../src/api/reflections.ts");
const reflections = await import("../src/reflections/reflections.ts");

let testRedis: any;
let redisAvailable = false;
let server: any;
let baseUrl: string;

function requireRedis(t: any) {
  if (!redisAvailable) t.skip("Redis unavailable");
}

async function startApi(): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use("/api", createReflectionsRouter());
  return new Promise((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve(baseUrl);
    });
  });
}

async function stopApi(): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  server = null;
}

async function cleanReflectionKeys() {
  const keys = await testRedis.keys("hydra:reflections:*");
  if (keys.length > 0) await testRedis.del(...keys);
}

describe("GET /api/reflections?anchor= (#841 live injection)", () => {
  beforeEach(async () => {
    if (!testRedis) {
      testRedis = new Redis(process.env.REDIS_URL!);
      try {
        await testRedis.ping();
        redisAvailable = true;
      } catch {
        console.error("Redis unavailable at localhost:6379/1, skipping #841 tests");
        return;
      }
      await startApi();
    }
    if (!redisAvailable) return;
    await cleanReflectionKeys();
  });

  after(async () => {
    if (testRedis) {
      if (redisAvailable) await cleanReflectionKeys();
      testRedis.disconnect();
    }
    await stopApi();
    const { closeRedisConnections } = await import("../src/redis/connection.ts");
    closeRedisConnections();
  });

  test("anchor mode returns the per-anchor reflection narrative for a retry", async (t) => {
    requireRedis(t);
    const anchorRef = "issue-841-retry-demo";

    // Simulate a prior FAILED attempt recording a reflection for this anchor.
    await reflections.recordAnchorReflection({
      cycleId: "cycle-prior-fail-001",
      anchorRef,
      taskTitle: "Re-home reflection injection",
      outcome: "verification-failure",
      reason: "tsc error: missing import in api/reflections.ts",
      verificationErrors: ["tsc: missing import"],
    });

    // The dispatch skill fetches the live endpoint at planning time.
    const res = await fetch(`${baseUrl}/api/reflections?anchor=${encodeURIComponent(anchorRef)}`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.anchor, anchorRef);
    assert.ok(body.count >= 1, "count should reflect at least the prior attempt");
    // The narrative the subagent receives must carry the prior-failure content.
    assert.ok(body.formatted.includes("PRIOR ATTEMPTS"), "formatted must contain the prior-attempts header");
    assert.ok(body.formatted.includes("cycle-prior-fail-001"), "formatted must name the prior cycle");
    assert.ok(
      body.formatted.includes("missing import"),
      "formatted must carry the why-it-failed narrative the retry needs",
    );
    // Per-anchor block is attributed in the structured blocks list.
    const perAnchor = body.blocks.find((b: any) => b.source === "per-anchor-reflections");
    assert.ok(perAnchor && perAnchor.count >= 1);
  });

  test("anchor mode misses cleanly (empty narrative, count 0) for an unknown anchor", async (t) => {
    requireRedis(t);
    const res = await fetch(`${baseUrl}/api/reflections?anchor=never-attempted-anchor`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.anchor, "never-attempted-anchor");
    assert.equal(body.count, 0);
    assert.equal(body.formatted, "", "a miss must yield an empty narrative so the skill no-ops");
  });

  test("files= surfaces reflections from a DIFFERENT anchor that touched the same file (#326)", async (t) => {
    requireRedis(t);
    const sharedFile = "src/api/reflections.ts";

    // A DIFFERENT anchor failed while touching the shared file.
    await reflections.recordAnchorReflection({
      cycleId: "cycle-other-anchor-002",
      anchorRef: `unrelated work touching ${sharedFile}`,
      taskTitle: "Some other change",
      outcome: "verification-failure",
      reason: "broke the reflections route",
      scopeFiles: [sharedFile],
    });

    // Retry of a fresh anchor that touches the same file — by-file fan-out
    // must surface the other anchor's reflection.
    const res = await fetch(
      `${baseUrl}/api/reflections?anchor=${encodeURIComponent("fresh-anchor-no-prior")}` +
        `&files=${encodeURIComponent(sharedFile)}`,
    );
    assert.equal(res.status, 200);
    const body = await res.json();

    const byFile = body.blocks.find((b: any) => b.source === "by-file-reflections");
    assert.ok(byFile && byFile.count >= 1, "by-file block should surface the related-anchor failure");
    assert.ok(body.formatted.includes("RELATED FILES"), "formatted must contain the related-files header");
    assert.ok(body.formatted.includes("cycle-other-anchor-002"));
  });

  test("no anchor param is a 400 (issue #1454: anchor is required)", async (t) => {
    requireRedis(t);
    // The legacy no-anchor "mode 1" returned the dead global reflection buffer.
    // That buffer subsystem was deleted (#1454); `anchor` is now required, so a
    // missing anchor is a schema-validation failure rather than a buffer dump.
    const res = await fetch(`${baseUrl}/api/reflections`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "schema-validation-failed");
    assert.ok(Array.isArray(body.issues), "400 carries the zod issues array");
  });

  test("blank anchor param is a 400 (trimmed to empty)", async (t) => {
    requireRedis(t);
    const res = await fetch(`${baseUrl}/api/reflections?anchor=${encodeURIComponent("   ")}`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "schema-validation-failed");
  });
});

/**
 * Regression tests for the design-concept exempt-log endpoint (issue #464).
 *
 * The `design-concept-exempt` PR label is an operator-only marker that
 * lets a dev PR ship without a fresh design-concept artifact. Every
 * application of the label is funnelled through a GH Action that
 * appends an audit entry to `hydra:dc:exempt_log` via this endpoint.
 *
 * These tests use Redis DB 1 (mirrors `design-concept.test.mts`) so they
 * never touch production data.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import Redis from "ioredis";

// Force test DB before any module that reads REDIS_URL is loaded.
process.env.REDIS_URL = "redis://localhost:6379/1";

const { createDesignConceptsRouter } = await import(
  "../src/api/design-concepts.ts"
);

const EXEMPT_LOG_KEY = "hydra:dc:exempt_log";

let testRedis: any;
let server: any;
let baseUrl: string;

async function startApi(): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use("/api", createDesignConceptsRouter());
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

describe("design-concept exempt-log API (#464)", () => {
  beforeEach(async () => {
    if (!testRedis) testRedis = new Redis("redis://localhost:6379/1");
    await testRedis.del(EXEMPT_LOG_KEY);
  });

  after(async () => {
    if (testRedis) {
      await testRedis.del(EXEMPT_LOG_KEY);
      testRedis.disconnect();
    }
    await stopApi();
  });

  test("POST /api/design-concepts/exempt-log writes a Redis entry", async () => {
    await startApi();

    const entry = {
      pr: 999,
      applier: "gaberoo322",
      ts: 1747000000000,
      anchorRef: "456",
      gate_fail_reasons: ["qaTrace.length < 6", "no invariants"],
    };

    const res = await fetch(`${baseUrl}/api/design-concepts/exempt-log`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(entry),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.pr, 999);
    assert.equal(body.applier, "gaberoo322");
    assert.equal(body.anchorRef, "456");
    assert.deepEqual(body.gate_fail_reasons, [
      "qaTrace.length < 6",
      "no invariants",
    ]);

    // Redis round-trip
    const stored = await testRedis.lrange(EXEMPT_LOG_KEY, 0, -1);
    assert.equal(stored.length, 1);
    const parsed = JSON.parse(stored[0]);
    assert.equal(parsed.pr, 999);
    assert.equal(parsed.applier, "gaberoo322");
    assert.equal(parsed.anchorRef, "456");
  });

  test("POST defaults ts to Date.now() when omitted", async () => {
    await startApi();
    const before = Date.now();
    const res = await fetch(`${baseUrl}/api/design-concepts/exempt-log`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pr: 1,
        applier: "auto",
        anchorRef: "x",
        gate_fail_reasons: [],
      }),
    });
    const body = await res.json();
    const after = Date.now();
    assert.ok(
      body.ts >= before && body.ts <= after,
      `ts ${body.ts} should be in [${before}, ${after}]`,
    );
  });

  test("POST rejects missing pr/applier/anchorRef with 400", async () => {
    await startApi();

    const missingPr = await fetch(`${baseUrl}/api/design-concepts/exempt-log`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ applier: "x", anchorRef: "y" }),
    });
    assert.equal(missingPr.status, 400);

    const missingApplier = await fetch(
      `${baseUrl}/api/design-concepts/exempt-log`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pr: 1, anchorRef: "y" }),
      },
    );
    assert.equal(missingApplier.status, 400);

    const missingAnchor = await fetch(
      `${baseUrl}/api/design-concepts/exempt-log`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pr: 1, applier: "x" }),
      },
    );
    assert.equal(missingAnchor.status, 400);
  });

  test("POST truncates long gate_fail_reasons entries to 500 chars", async () => {
    await startApi();
    const longReason = "x".repeat(600);
    const res = await fetch(`${baseUrl}/api/design-concepts/exempt-log`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pr: 7,
        applier: "auto",
        anchorRef: "z",
        gate_fail_reasons: [longReason],
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.gate_fail_reasons.length, 1);
    assert.equal(body.gate_fail_reasons[0].length, 500);
    assert.ok(body.gate_fail_reasons[0].endsWith("..."));
  });

  test("GET /api/design-concepts/exempt-log returns entries newest-first", async () => {
    await startApi();

    for (const pr of [1, 2, 3]) {
      const res = await fetch(`${baseUrl}/api/design-concepts/exempt-log`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pr,
          applier: "gaberoo322",
          ts: 1747000000000 + pr,
          anchorRef: String(pr * 100),
          gate_fail_reasons: [`reason-${pr}`],
        }),
      });
      assert.equal(res.status, 201);
    }

    const res = await fetch(`${baseUrl}/api/design-concepts/exempt-log`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.count, 3);
    // LPUSH ordering: newest (pr=3) first.
    assert.deepEqual(
      body.items.map((e: any) => e.pr),
      [3, 2, 1],
    );
  });

  test("GET respects limit query param", async () => {
    await startApi();
    for (const pr of [10, 11, 12, 13, 14]) {
      await fetch(`${baseUrl}/api/design-concepts/exempt-log`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pr,
          applier: "x",
          anchorRef: "y",
          gate_fail_reasons: [],
        }),
      });
    }
    const res = await fetch(
      `${baseUrl}/api/design-concepts/exempt-log?limit=2`,
    );
    const body = await res.json();
    assert.equal(body.count, 2);
    assert.deepEqual(
      body.items.map((e: any) => e.pr),
      [14, 13],
    );
  });

  test("GET caps limit at 500 even when client requests more", async () => {
    await startApi();
    await fetch(`${baseUrl}/api/design-concepts/exempt-log`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pr: 1,
        applier: "x",
        anchorRef: "y",
        gate_fail_reasons: [],
      }),
    });
    // 9999 should be silently capped to 500 — endpoint shouldn't 400.
    const res = await fetch(
      `${baseUrl}/api/design-concepts/exempt-log?limit=9999`,
    );
    assert.equal(res.status, 200);
  });

  test("GET skips malformed entries but returns the rest", async () => {
    await startApi();

    // Write one good entry through the API.
    await fetch(`${baseUrl}/api/design-concepts/exempt-log`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pr: 42,
        applier: "gaberoo322",
        anchorRef: "a",
        gate_fail_reasons: [],
      }),
    });

    // Poison the list with a non-JSON entry directly via Redis.
    await testRedis.lpush(EXEMPT_LOG_KEY, "not json {{{");
    // And one with a valid-JSON-but-bad-shape entry.
    await testRedis.lpush(
      EXEMPT_LOG_KEY,
      JSON.stringify({ pr: "not-a-number", applier: "x" }),
    );

    const res = await fetch(`${baseUrl}/api/design-concepts/exempt-log`);
    const body = await res.json();
    // Only the good entry survives.
    assert.equal(body.count, 1);
    assert.equal(body.items[0].pr, 42);
  });
});

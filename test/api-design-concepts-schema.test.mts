/**
 * Regression tests for the schema migration of `src/api/design-concepts.ts`
 * (ADR-0011 slice 1).
 *
 * Each of the three `POST` handlers in `src/api/design-concepts.ts` now
 * parses its body through a zod schema from
 * `src/schemas/design-concept.ts` and returns the structured envelope
 *
 *   400 { code: "schema-validation-failed", issues: [...] }
 *
 * on rejection — replacing the previous per-handler prose 400 messages
 * (`"anchorRef (string) is required"`, etc). These tests pin that
 * envelope shape so future refactors can't accidentally regress to ad-hoc
 * 400 prose.
 *
 * Companion to (and follows the setup pattern of) the existing
 * `test/design-concept-exempt-log.test.mts`. Uses Redis DB 1 so it never
 * touches production data.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import Redis from "ioredis";

// Force test DB before any module that reads REDIS_URL is loaded.
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

const { createDesignConceptsRouter } = await import(
  "../src/api/design-concepts.ts"
);

const TEST_NS = "hydra:design-concept:";
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

/** Build a complete `POST /api/design-concepts` body that passes the schema. */
function buildValidConceptBody(overrides: Record<string, unknown> = {}) {
  return {
    anchorRef: "test:schema:1",
    scope: "orch",
    glossaryTerms: ["Target", "Orchestrator"],
    glossaryGaps: [],
    modulesTouched: [
      {
        path: "src/foo.ts",
        interfaceImpact: "extend",
        depthClassification: "deep",
      },
    ],
    invariants: ["never throw from gate"],
    rejectedAlternatives: [{ alt: "noop", why: "doesn't ship" }],
    qaTrace: [
      { q: "what is the target?", a: "hydra-betting" },
      { q: "what module?", a: "src/foo.ts" },
      { q: "interface impact?", a: "extend" },
      { q: "invariants?", a: "never throw" },
      { q: "rejected?", a: "noop" },
      { q: "tier?", a: "3" },
    ],
    prototypes: [],
    ...overrides,
  };
}

describe("design-concepts schema migration — ADR-0011 slice 1", () => {
  beforeEach(async () => {
    if (!testRedis) testRedis = new Redis(process.env.REDIS_URL);
    const keys = await testRedis.keys(TEST_NS + "*");
    if (keys.length > 0) await testRedis.del(...keys);
    await testRedis.del(EXEMPT_LOG_KEY);
  });

  after(async () => {
    const keys = await testRedis.keys(TEST_NS + "*");
    if (keys.length > 0) await testRedis.del(...keys);
    await testRedis.del(EXEMPT_LOG_KEY);
    if (testRedis) testRedis.disconnect();
    await stopApi();
  });

  // ---------------------------------------------------------------------
  // POST /api/design-concepts (create / overwrite)
  // ---------------------------------------------------------------------

  describe("POST /api/design-concepts", () => {
    test("empty body returns 400 with structured envelope", async () => {
      await startApi();
      const res = await fetch(`${baseUrl}/api/design-concepts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.code, "schema-validation-failed");
      assert.ok(
        Array.isArray(body.issues),
        "issues must be an array",
      );
      assert.ok(body.issues.length > 0, "issues must be non-empty");
      for (const issue of body.issues) {
        assert.ok(
          Array.isArray(issue.path),
          "each issue must have a path array",
        );
        assert.equal(
          typeof issue.message,
          "string",
          "each issue must have a message string",
        );
      }
    });

    test("invalid scope returns 400 with structured envelope", async () => {
      await startApi();
      const res = await fetch(`${baseUrl}/api/design-concepts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ anchorRef: "x", scope: "bogus" }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.code, "schema-validation-failed");
      assert.ok(Array.isArray(body.issues));
      // At least one issue should mention the `scope` field by path.
      const hasScopeIssue = body.issues.some((i: any) =>
        Array.isArray(i.path) && i.path.includes("scope"),
      );
      assert.ok(hasScopeIssue, "should report on the scope field");
    });

    test("well-formed body still returns 201 with the persisted artifact", async () => {
      await startApi();
      const res = await fetch(`${baseUrl}/api/design-concepts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildValidConceptBody()),
      });
      assert.equal(res.status, 201);
      const body = await res.json();
      assert.equal(body.anchorRef, "test:schema:1");
      assert.equal(body.scope, "orch");
      // The server fills in createdAt / artifactHash.
      assert.equal(typeof body.createdAt, "number");
      assert.equal(typeof body.artifactHash, "string");
      assert.ok(body.artifactHash.length > 0);
    });
  });

  // ---------------------------------------------------------------------
  // POST /api/design-concepts/:anchorRef/approve
  // ---------------------------------------------------------------------

  describe("POST /api/design-concepts/:anchorRef/approve", () => {
    test("empty body still approves (default auto-gate)", async () => {
      // The approve endpoint accepts an empty body — `by` is optional and
      // defaults to "auto-gate" server-side. This pins that behaviour
      // through the migration so the schema can't accidentally make `by`
      // required.
      await startApi();
      // Seed an artifact to approve.
      const seed = await fetch(`${baseUrl}/api/design-concepts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildValidConceptBody({ anchorRef: "test:approve:1" })),
      });
      assert.equal(seed.status, 201);

      const res = await fetch(
        `${baseUrl}/api/design-concepts/test:approve:1/approve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.status, "approved");
      assert.equal(body.approvedBy, "auto-gate");
    });

    test("malformed `by` returns 400 with structured envelope", async () => {
      await startApi();
      // Seed an artifact (the schema runs before the existence check, but
      // we keep the artifact around for a clean round-trip on the happy
      // path too).
      const seed = await fetch(`${baseUrl}/api/design-concepts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          buildValidConceptBody({ anchorRef: "test:approve:2" }),
        ),
      });
      assert.equal(seed.status, 201);

      const res = await fetch(
        `${baseUrl}/api/design-concepts/test:approve:2/approve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ by: "random-junk" }),
        },
      );
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.code, "schema-validation-failed");
      assert.ok(Array.isArray(body.issues));
      assert.ok(body.issues.length > 0);
      const hasByIssue = body.issues.some(
        (i: any) => Array.isArray(i.path) && i.path.includes("by"),
      );
      assert.ok(hasByIssue, "should report on the by field");
    });

    test("`by: 'operator:<name>'` is accepted", async () => {
      await startApi();
      await fetch(`${baseUrl}/api/design-concepts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          buildValidConceptBody({ anchorRef: "test:approve:3" }),
        ),
      });
      const res = await fetch(
        `${baseUrl}/api/design-concepts/test:approve:3/approve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ by: "operator:gabe" }),
        },
      );
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.approvedBy, "operator:gabe");
    });
  });

  // ---------------------------------------------------------------------
  // POST /api/design-concepts/exempt-log
  // ---------------------------------------------------------------------

  describe("POST /api/design-concepts/exempt-log", () => {
    test("empty body returns 400 with structured envelope", async () => {
      await startApi();
      const res = await fetch(`${baseUrl}/api/design-concepts/exempt-log`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.code, "schema-validation-failed");
      assert.ok(Array.isArray(body.issues));
      assert.ok(body.issues.length > 0);
      for (const issue of body.issues) {
        assert.ok(Array.isArray(issue.path));
        assert.equal(typeof issue.message, "string");
      }
    });

    test("non-positive pr returns 400 with structured envelope", async () => {
      await startApi();
      const res = await fetch(`${baseUrl}/api/design-concepts/exempt-log`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pr: 0,
          applier: "x",
          anchorRef: "y",
          gate_fail_reasons: [],
        }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.code, "schema-validation-failed");
      const hasPrIssue = body.issues.some(
        (i: any) => Array.isArray(i.path) && i.path.includes("pr"),
      );
      assert.ok(hasPrIssue, "should report on the pr field");
    });

    test("well-formed body still returns 201 with the persisted entry", async () => {
      await startApi();
      const entry = {
        pr: 42,
        applier: "gaberoo322",
        ts: 1747000000000,
        anchorRef: "abc",
        gate_fail_reasons: ["no invariants"],
      };
      const res = await fetch(`${baseUrl}/api/design-concepts/exempt-log`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(entry),
      });
      assert.equal(res.status, 201);
      const body = await res.json();
      assert.equal(body.pr, 42);
      assert.equal(body.applier, "gaberoo322");
      assert.equal(body.ts, 1747000000000);
      assert.equal(body.anchorRef, "abc");
      assert.deepEqual(body.gate_fail_reasons, ["no invariants"]);
    });
  });
});

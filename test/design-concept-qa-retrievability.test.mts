/**
 * Regression tests for QA-time design-concept retrievability (issue #1450).
 *
 * The design-concept artifact is meant to be the DURABLE spec a PR is QA'd
 * against (ADR-0008 / epic #437). Before #1450 there was no single tested
 * retrieval path for QA: the playbook did ad-hoc curl+jq and silently
 * degraded on a miss (falling back to `recordAnchorReflection` side-effects),
 * so an unreachable artifact was a quiet no-op rather than a loud, diagnosable
 * gap.
 *
 * These tests pin two surfaces:
 *   1. `resolveDesignConceptForQa` — the pure-ish resolver that NEVER returns
 *      a bare null: on a miss it returns `{found:false, handle, reason}` with
 *      a loud reason naming the canonical handle the artifact was probed at.
 *   2. `GET /api/design-concepts/:anchorRef/resolve` — the HTTP surface QA
 *      consumes: 200 {found:true, handle, concept} on a hit, 404
 *      {found:false, handle, reason} on a miss.
 *
 * Uses Redis DB 1 (suite convention) with a test-only anchorRef namespace so
 * it never collides with production data. Mirrors the setup pattern in
 * test/api-design-concepts-schema.test.mts.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import Redis from "ioredis";

// Force test DB before any module that reads REDIS_URL is loaded.
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

const dc = await import("../src/design-concept.ts");
const { createDesignConceptsRouter } = await import(
  "../src/api/design-concepts.ts"
);

const TEST_NS = "hydra:design-concept:";

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

/** Persist a complete artifact under `anchorRef` and return the saved record. */
async function persistArtifact(anchorRef: string) {
  return dc.saveDesignConcept({
    anchorRef,
    scope: "orch",
    glossaryTerms: ["Target", "Orchestrator"],
    glossaryGaps: [],
    modulesTouched: [
      { path: "src/foo.ts", interfaceImpact: "extend", depthClassification: "deep" },
    ],
    invariants: ["never throw from gate"],
    rejectedAlternatives: [{ alt: "noop", why: "doesn't ship" }],
    qaTrace: [
      { q: "q1", a: "a1" },
      { q: "q2", a: "a2" },
      { q: "q3", a: "a3" },
      { q: "q4", a: "a4" },
      { q: "q5", a: "a5" },
      { q: "q6", a: "a6" },
    ],
    prototypes: [],
  });
}

describe("design-concept QA retrievability (#1450)", () => {
  beforeEach(async () => {
    if (!testRedis) testRedis = new Redis(process.env.REDIS_URL);
    const keys = await testRedis.keys(TEST_NS + "*");
    if (keys.length > 0) await testRedis.del(...keys);
  });

  after(async () => {
    const keys = await testRedis.keys(TEST_NS + "*");
    if (keys.length > 0) await testRedis.del(...keys);
    if (testRedis) testRedis.disconnect();
    await stopApi();
  });

  // ---------------------------------------------------------------------
  // designConceptHandle — pure stable handle
  // ---------------------------------------------------------------------

  describe("designConceptHandle", () => {
    test("derives the canonical Redis key + API path from either anchorRef form", () => {
      const fromBare = dc.designConceptHandle("1450");
      const fromCanonical = dc.designConceptHandle("issue-1450");
      // Producer (bare) and consumer (canonical) resolve to the SAME handle.
      assert.deepEqual(fromBare, fromCanonical);
      assert.equal(fromBare.anchorRef, "issue-1450");
      assert.equal(fromBare.redisKey, "hydra:design-concept:issue-1450");
      assert.equal(fromBare.apiPath, "/api/design-concepts/issue-1450");
    });

    test("passes non-issue refs through unchanged", () => {
      const h = dc.designConceptHandle("test:complete");
      assert.equal(h.anchorRef, "test:complete");
      assert.equal(h.redisKey, "hydra:design-concept:test:complete");
    });
  });

  // ---------------------------------------------------------------------
  // resolveDesignConceptForQa — never a bare null
  // ---------------------------------------------------------------------

  describe("resolveDesignConceptForQa", () => {
    test("found:true with concept + handle for a persisted artifact", async () => {
      const saved = await persistArtifact("issue-145001");
      const result = await dc.resolveDesignConceptForQa("issue-145001");
      assert.equal(result.found, true);
      if (result.found) {
        assert.equal(result.concept.anchorRef, saved.anchorRef);
        assert.equal(result.handle.redisKey, "hydra:design-concept:issue-145001");
      }
    });

    test("resolves a persisted artifact via the OTHER anchorRef form (canonicalization)", async () => {
      // Persist under the bare number, resolve via the canonical form.
      await persistArtifact("145002");
      const result = await dc.resolveDesignConceptForQa("issue-145002");
      assert.equal(result.found, true);
      if (result.found) {
        assert.equal(result.concept.anchorRef, "issue-145002");
      }
    });

    test("found:false with a LOUD handle-named reason for a missing artifact", async () => {
      const result = await dc.resolveDesignConceptForQa("issue-145099");
      assert.equal(result.found, false);
      if (!result.found) {
        // Handle is present even on a miss — names exactly where we looked.
        assert.equal(result.handle.redisKey, "hydra:design-concept:issue-145099");
        // Reason is loud + structured (not a bare null / empty string).
        assert.ok(result.reason.length > 0);
        assert.match(result.reason, /hydra:design-concept:issue-145099/);
        assert.match(result.reason, /recordAnchorReflection/);
      }
    });

    test("found:false for a blank anchorRef (names the bad input)", async () => {
      const result = await dc.resolveDesignConceptForQa("");
      assert.equal(result.found, false);
      if (!result.found) {
        assert.match(result.reason, /blank\/invalid anchorRef/);
      }
    });
  });

  // ---------------------------------------------------------------------
  // GET /api/design-concepts/:anchorRef/resolve
  // ---------------------------------------------------------------------

  describe("GET /design-concepts/:anchorRef/resolve", () => {
    test("200 {found:true, handle, concept} for a persisted artifact", async () => {
      await startApi();
      await persistArtifact("issue-145010");
      const res = await fetch(
        `${baseUrl}/api/design-concepts/issue-145010/resolve`,
      );
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.found, true);
      assert.equal(body.handle.redisKey, "hydra:design-concept:issue-145010");
      // The inner artifact stays FLAT (ADR-0008) under `.concept`, gate included.
      assert.equal(body.concept.anchorRef, "issue-145010");
      assert.ok(body.concept.gate, ".concept.gate must be present");
    });

    test("resolves via the issue-number form too (canonicalization at the seam)", async () => {
      await startApi();
      await persistArtifact("issue-145011");
      // Probe with the bare number — must hit the same persisted artifact.
      const res = await fetch(`${baseUrl}/api/design-concepts/145011/resolve`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.found, true);
      assert.equal(body.concept.anchorRef, "issue-145011");
    });

    test("404 {found:false, handle, reason} for a missing artifact", async () => {
      await startApi();
      const res = await fetch(
        `${baseUrl}/api/design-concepts/issue-145098/resolve`,
      );
      assert.equal(res.status, 404);
      const body = await res.json();
      assert.equal(body.found, false);
      assert.equal(body.handle.redisKey, "hydra:design-concept:issue-145098");
      assert.match(body.reason, /NOT persisted\/retrievable/);
    });

    test("the bare /:anchorRef route is NOT shadowed by /resolve", async () => {
      await startApi();
      await persistArtifact("issue-145012");
      // The flat (non-envelope) route still returns the top-level artifact.
      const res = await fetch(`${baseUrl}/api/design-concepts/issue-145012`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.anchorRef, "issue-145012");
      // No `.concept` envelope on the flat route (ADR-0008).
      assert.equal(body.concept, undefined);
    });
  });
});

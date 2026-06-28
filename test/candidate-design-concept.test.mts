/**
 * Regression tests for the Candidate design-concept annotation assembler
 * (issue #2499 — extracted from `src/anchor-candidates.ts`).
 *
 * `loadDesignConceptImpl(anchorRef, now)` is the production reader wired into
 * `CandidateFeedDeps.loadDesignConcept`. It reads the persisted design-concept
 * artifact and projects it into the flat `CandidateDesignConcept` block
 * decide.py consumes per candidate. These tests pin the annotation POLICY this
 * module now owns, orthogonal to the enumeration-loop tests in
 * `test/api-anchor-candidates.test.mts`:
 *   - absent artifact (and empty anchor ref) → ABSENT_DESIGN_CONCEPT
 *   - a fresh, approved artifact → present + isFresh + status passthrough + gateOk
 *   - the DERIVED `stale` label: artifact exists but aged out of freshness
 *   - never-throws: a failing read degrades to ABSENT, never throws
 *
 * Uses Redis DB 1 (the design-concept test DB) so it never touches production
 * data — mirrors `test/design-concept.test.mts`. New top-level describe with
 * its own before/after lifecycle (never nested under a sibling's teardown).
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";
import type { DesignConcept } from "../src/design-concept.ts";
import type { DesignConceptInput } from "../src/schemas/design-concept.ts";

// Force test DB before any module that reads REDIS_URL is loaded.
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

// Runtime value namespaces via dynamic import (after REDIS_URL is set).
const dc = await import("../src/design-concept.ts");
const cdc = await import("../src/backlog/candidate-design-concept.ts");

// The 7-day freshness window is module-private in src/design-concept.ts (issue
// #2442); pin the same literal to build "stale" (>7d) fixtures. If the source
// window changes this must follow.
const DESIGN_CONCEPT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const TEST_NS = "hydra:design-concept:";
let testRedis: any;

// Build a minimal artifact that passes every gate rule by default.
function buildComplete(overrides: Partial<DesignConcept> = {}): DesignConceptInput {
  return {
    anchorRef: "issue-2499-test",
    scope: "orch",
    glossaryTerms: ["Candidate Feed"],
    glossaryGaps: [],
    modulesTouched: [
      {
        path: "src/backlog/candidate-design-concept.ts",
        interfaceImpact: "extend",
        depthClassification: "deep",
      },
    ],
    invariants: ["never drop a candidate"],
    rejectedAlternatives: [{ alt: "noop", why: "doesn't ship" }],
    qaTrace: [
      { q: "what module?", a: "candidate-design-concept.ts" },
      { q: "interface impact?", a: "extend" },
      { q: "invariants?", a: "never drop" },
      { q: "rejected?", a: "noop" },
      { q: "tier?", a: "3" },
      { q: "fresh?", a: "yes" },
    ],
    prototypes: [],
    ...overrides,
  } as DesignConceptInput;
}

describe("candidate-design-concept assembler (issue #2499)", () => {
  beforeEach(async () => {
    if (!testRedis) testRedis = new Redis(process.env.REDIS_URL!);
    const keys = await testRedis.keys(TEST_NS + "*");
    if (keys.length > 0) await testRedis.del(...keys);
  });

  after(async () => {
    const keys = await testRedis.keys(TEST_NS + "*");
    if (keys.length > 0) await testRedis.del(...keys);
    if (testRedis) testRedis.disconnect();
  });

  test("empty anchor ref → ABSENT projection (no Redis read)", async () => {
    const out = await cdc.loadDesignConceptImpl("", Date.now());
    assert.deepEqual(out, cdc.ABSENT_DESIGN_CONCEPT);
    assert.equal(out.present, false);
    assert.equal(out.status, null);
    assert.equal(out.gateOk, false);
  });

  test("no artifact persisted → ABSENT projection", async () => {
    const out = await cdc.loadDesignConceptImpl("issue-does-not-exist", Date.now());
    assert.deepEqual(out, cdc.ABSENT_DESIGN_CONCEPT);
    assert.equal(out.present, false);
  });

  test("fresh + approved artifact → present, isFresh, status passthrough, gateOk", async () => {
    const now = Date.now();
    await dc.saveDesignConcept(
      buildComplete({ anchorRef: "issue-2499-fresh", status: "approved", approvedBy: "auto-gate" } as any),
      now,
    );
    const out = await cdc.loadDesignConceptImpl("issue-2499-fresh", now);
    assert.equal(out.present, true);
    assert.equal(out.isFresh, true);
    assert.equal(out.status, "approved");
    assert.equal(out.gateOk, true, "an approved, fresh, complete artifact clears the gate");
  });

  test("fresh draft artifact → present, status 'draft', gate NOT ok (status must be approved)", async () => {
    const now = Date.now();
    await dc.saveDesignConcept(buildComplete({ anchorRef: "issue-2499-draft", status: "draft" } as any), now);
    const out = await cdc.loadDesignConceptImpl("issue-2499-draft", now);
    assert.equal(out.present, true);
    assert.equal(out.isFresh, true);
    assert.equal(out.status, "draft");
    assert.equal(out.gateOk, false, "a draft artifact fails gateCheck rule 7");
  });

  test("aged artifact → status DERIVED to 'stale', isFresh false, gate NOT ok", async () => {
    // Persist at an old createdAt so the read-time `now` is past the freshness window.
    const createdAt = Date.now() - DESIGN_CONCEPT_MAX_AGE_MS - 60_000;
    await dc.saveDesignConcept(
      buildComplete({ anchorRef: "issue-2499-stale", status: "approved", approvedBy: "auto-gate" } as any),
      createdAt,
    );
    const now = Date.now();
    const out = await cdc.loadDesignConceptImpl("issue-2499-stale", now);
    assert.equal(out.present, true, "the artifact still exists in Redis");
    assert.equal(out.isFresh, false, "it has aged out of the freshness window");
    assert.equal(out.status, "stale", "stale is a DERIVED label, not the stored status (which is 'approved')");
    assert.equal(out.gateOk, false, "a stale artifact fails gateCheck rule 6 (freshness)");
  });

  test("ABSENT_DESIGN_CONCEPT is the canonical no-artifact projection shape", () => {
    assert.deepEqual(cdc.ABSENT_DESIGN_CONCEPT, {
      present: false,
      isFresh: false,
      status: null,
      gateOk: false,
    });
  });
});

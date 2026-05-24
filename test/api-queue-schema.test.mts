/**
 * Regression tests for the POST /api/queue body schema (issue #562 seed PR).
 *
 * Why this test exists:
 *   - Pre-zod, `/api/queue` rejected only the literal `!reference` case.
 *     Whitespace-only refs, refs with the wrong type, and bodies containing
 *     unknown fields all slipped through and reached the work queue, where
 *     they later confused fuzzy dedup or surfaced as `undefined`-shaped
 *     items in the dashboard.
 *   - The schema is the new boundary contract. These tests pin the
 *     accepted-shape so future refactors don't accidentally loosen it.
 *
 * Tests run against the pure schema (no Express, no Redis). This matches
 * the codebase convention (see test/work-queue-dedup.test.mts) — exercise
 * the pure function, not the wired route.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { QueuePostBodySchema } from "../src/schemas/queue.ts";

describe("QueuePostBodySchema — happy path", () => {
  test("accepts the minimum valid body (reference only)", () => {
    const result = QueuePostBodySchema.safeParse({ reference: "Add stream freshness" });
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.reference, "Add stream freshness");
      assert.equal(result.data.reason, undefined);
      assert.equal(result.data.context, undefined);
    }
  });

  test("accepts reference + reason", () => {
    const result = QueuePostBodySchema.safeParse({
      reference: "Add stream freshness",
      reason: "queued by sweep",
    });
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.reason, "queued by sweep");
    }
  });

  test("accepts an arbitrary context payload (string)", () => {
    const result = QueuePostBodySchema.safeParse({
      reference: "Add stream freshness",
      context: "operator note",
    });
    assert.equal(result.success, true);
  });

  test("accepts an arbitrary context payload (object)", () => {
    const result = QueuePostBodySchema.safeParse({
      reference: "Add stream freshness",
      context: { sourceIssue: 562, link: "https://example.com" },
    });
    assert.equal(result.success, true);
  });

  test("trims surrounding whitespace from reference", () => {
    const result = QueuePostBodySchema.safeParse({ reference: "  Add stream freshness  " });
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.reference, "Add stream freshness");
    }
  });
});

describe("QueuePostBodySchema — rejection cases", () => {
  test("rejects empty body — missing reference", () => {
    const result = QueuePostBodySchema.safeParse({});
    assert.equal(result.success, false);
    if (!result.success) {
      // Stable schema for downstream agents: error.issues[] with a path
      assert.ok(Array.isArray(result.error.issues));
      assert.ok(result.error.issues.some((i) => i.path.includes("reference")));
    }
  });

  test("rejects empty-string reference", () => {
    const result = QueuePostBodySchema.safeParse({ reference: "" });
    assert.equal(result.success, false);
  });

  test("rejects whitespace-only reference (would slip past pre-zod !reference check)", () => {
    // Pre-zod, `if (!reference)` only caught empty string / undefined. A
    // body of `{ reference: "   " }` reached the work queue as a useless
    // entry. The trim+min(1) chain in the schema closes that gap.
    const result = QueuePostBodySchema.safeParse({ reference: "   " });
    assert.equal(result.success, false);
  });

  test("rejects non-string reference (number)", () => {
    const result = QueuePostBodySchema.safeParse({ reference: 123 });
    assert.equal(result.success, false);
  });

  test("rejects non-string reference (null)", () => {
    const result = QueuePostBodySchema.safeParse({ reference: null });
    assert.equal(result.success, false);
  });

  test("rejects unknown top-level fields (strict mode)", () => {
    // Strict mode is intentional — it catches typos like { ref: "..." } or
    // { references: [...] } at the boundary instead of silently dropping
    // the field. Loosen this only with a deliberate schema bump.
    const result = QueuePostBodySchema.safeParse({
      reference: "Add stream freshness",
      ref: "typo",
    });
    assert.equal(result.success, false);
  });

  test("rejects non-string reason", () => {
    const result = QueuePostBodySchema.safeParse({
      reference: "Add stream freshness",
      reason: 42,
    });
    assert.equal(result.success, false);
  });
});

describe("QueuePostBodySchema — error shape contract", () => {
  test("error.issues[] is stable JSON the gateway can echo back", () => {
    const result = QueuePostBodySchema.safeParse({ reference: "" });
    assert.equal(result.success, false);
    if (!result.success) {
      // Each issue must have at least { path, message } — that's the contract
      // documented to /api/queue clients via the schema-validation-failed code.
      for (const issue of result.error.issues) {
        assert.ok(Array.isArray(issue.path), "issue.path must be an array");
        assert.equal(typeof issue.message, "string", "issue.message must be a string");
      }
    }
  });
});

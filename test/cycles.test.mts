/**
 * Boundary tests for the cycle control POST body schemas (issue #3170).
 *
 * `POST /cycle/register` and `POST /cycle/complete` (src/api/cycles.ts) moved
 * their inline, untyped input guards to dedicated zod schemas under
 * src/schemas/cycles.ts, per ADR-0011 (HTTP request bodies validate through the
 * Schemas seam; a failure returns 400 `{ code: "schema-validation-failed",
 * issues }`).
 *
 * These assert the ingress boundary directly against the pure schemas — no
 * Express, no Redis — matching the codebase convention (see
 * test/holdback-pending-schema.test.mts, test/tier-query-schema.test.mts):
 *   - register requires cycleId AND source (both non-empty);
 *   - complete requires only cycleId, source/status stay optional;
 *   - both are .strict() (reject unknown keys), preserving the empty-string-400
 *     behaviour of the legacy truthy guards.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  CycleRegisterBodySchema,
  CycleCompleteBodySchema,
} from "../src/schemas/cycles.ts";

describe("CycleRegisterBodySchema (#3170)", () => {
  test("accepts a body with cycleId AND source", () => {
    const result = CycleRegisterBodySchema.safeParse({
      cycleId: "cyc-1",
      source: "claude",
    });
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.cycleId, "cyc-1");
      assert.equal(result.data.source, "claude");
    }
  });

  test("rejects a body missing source", () => {
    const result = CycleRegisterBodySchema.safeParse({ cycleId: "cyc-1" });
    assert.equal(result.success, false);
  });

  test("rejects a body missing cycleId", () => {
    const result = CycleRegisterBodySchema.safeParse({ source: "claude" });
    assert.equal(result.success, false);
  });

  test("rejects an empty-string cycleId (preserves the legacy truthy guard's 400)", () => {
    const result = CycleRegisterBodySchema.safeParse({
      cycleId: "",
      source: "claude",
    });
    assert.equal(result.success, false);
  });

  test("rejects an empty-string source (preserves the legacy truthy guard's 400)", () => {
    const result = CycleRegisterBodySchema.safeParse({
      cycleId: "cyc-1",
      source: "",
    });
    assert.equal(result.success, false);
  });

  test("rejects unknown keys (schema is .strict() — surfaces a cycleID typo)", () => {
    const result = CycleRegisterBodySchema.safeParse({
      cycleId: "cyc-1",
      source: "claude",
      cycleID: "typo",
    });
    assert.equal(result.success, false);
  });
});

describe("CycleCompleteBodySchema (#3170)", () => {
  test("accepts a body with cycleId, source, and status", () => {
    const result = CycleCompleteBodySchema.safeParse({
      cycleId: "cyc-1",
      source: "claude",
      status: "failed",
    });
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.cycleId, "cyc-1");
      assert.equal(result.data.source, "claude");
      assert.equal(result.data.status, "failed");
    }
  });

  test("accepts a body with only cycleId — source and status are optional", () => {
    const result = CycleCompleteBodySchema.safeParse({ cycleId: "cyc-1" });
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.source, undefined);
      assert.equal(result.data.status, undefined);
    }
  });

  test("rejects a body missing cycleId", () => {
    const result = CycleCompleteBodySchema.safeParse({ status: "completed" });
    assert.equal(result.success, false);
  });

  test("rejects an empty-string cycleId (preserves the legacy truthy guard's 400)", () => {
    const result = CycleCompleteBodySchema.safeParse({ cycleId: "" });
    assert.equal(result.success, false);
  });

  test("rejects an empty-string status when supplied (optional, but non-empty if present)", () => {
    const result = CycleCompleteBodySchema.safeParse({
      cycleId: "cyc-1",
      status: "",
    });
    assert.equal(result.success, false);
  });

  test("accepts an arbitrary free-string status (no enum constraint)", () => {
    const result = CycleCompleteBodySchema.safeParse({
      cycleId: "cyc-1",
      status: "some-custom-status",
    });
    assert.equal(result.success, true);
  });

  test("rejects unknown keys (schema is .strict())", () => {
    const result = CycleCompleteBodySchema.safeParse({
      cycleId: "cyc-1",
      bogus: true,
    });
    assert.equal(result.success, false);
  });
});

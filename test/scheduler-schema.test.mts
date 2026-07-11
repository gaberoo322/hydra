/**
 * Boundary tests for the scheduler POST body schema (issue #3171).
 *
 * `POST /scheduler/start` (src/api/scheduler.ts) moved its bare
 * `req.body?.intervalMs` access to a zod schema under src/schemas/scheduler.ts,
 * per ADR-0011 (HTTP request bodies validate through the Schemas seam; a failure
 * returns 400 `{ code: "schema-validation-failed", issues }`).
 *
 * These assert the ingress boundary directly against the pure schema — no
 * Express, no Redis — matching the codebase convention (see
 * test/cycles.test.mts, test/tier-query-schema.test.mts):
 *   - intervalMs is optional (omit → uses scheduler default);
 *   - when provided, intervalMs must be a positive integer;
 *   - schema is .strict() (rejects unknown keys).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SchedulerStartBodySchema } from "../src/schemas/scheduler.ts";

describe("SchedulerStartBodySchema (#3171)", () => {
  test("accepts an empty body (intervalMs is optional)", () => {
    const result = SchedulerStartBodySchema.safeParse({});
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.intervalMs, undefined);
    }
  });

  test("accepts a body with a valid positive intervalMs", () => {
    const result = SchedulerStartBodySchema.safeParse({ intervalMs: 60000 });
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.intervalMs, 60000);
    }
  });

  test("rejects intervalMs: 0 (must be positive)", () => {
    const result = SchedulerStartBodySchema.safeParse({ intervalMs: 0 });
    assert.equal(result.success, false);
  });

  test("rejects a negative intervalMs", () => {
    const result = SchedulerStartBodySchema.safeParse({ intervalMs: -1000 });
    assert.equal(result.success, false);
  });

  test("rejects a non-integer intervalMs (float)", () => {
    const result = SchedulerStartBodySchema.safeParse({ intervalMs: 30000.5 });
    assert.equal(result.success, false);
  });

  test("rejects a string intervalMs", () => {
    const result = SchedulerStartBodySchema.safeParse({ intervalMs: "60000" });
    assert.equal(result.success, false);
  });

  test("rejects unknown keys (schema is .strict())", () => {
    const result = SchedulerStartBodySchema.safeParse({
      intervalMs: 60000,
      bogus: true,
    });
    assert.equal(result.success, false);
  });
});

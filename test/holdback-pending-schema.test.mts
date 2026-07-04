/**
 * Regression tests for the `POST /api/holdback/pending` body schema's optional
 * `anchorType` field (issue #2800).
 *
 * Why this test exists:
 *   - 32% of cycles over a 50-cycle window recorded `anchorType: "unclassified"`
 *     because the merge-watch enrichment (src/scheduler/chores/holdback-merge-
 *     watch.ts) fired the FIRST cycle-record write for a bare-UUID cycleId (the
 *     qa_orch relay case, where reap never wrote a record) carrying NO
 *     anchorType — so classifyAnchorType fell through the slot-suffix inference
 *     to the `unclassified` sentinel.
 *   - #2800 threads an explicit `anchorType` through the pending-enroll
 *     registry: the arming caller supplies it, and the merge-watch chore
 *     forwards it on the enrichment. This schema is the ingress boundary — it
 *     must accept a non-empty anchorType and keep it OPTIONAL (a legacy/omitting
 *     caller degrades to the prior inference behaviour).
 *
 * Tests run against the pure schema (no Express, no Redis), matching the
 * codebase convention (see test/tier-query-schema.test.mts).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { HoldbackPendingBodySchema } from "../src/schemas/holdback.ts";

describe("HoldbackPendingBodySchema — anchorType (#2800)", () => {
  test("accepts a body WITH an explicit anchorType", () => {
    const result = HoldbackPendingBodySchema.safeParse({
      prNumber: 501,
      tier: 3,
      cycleId: "cyc-501",
      anchorType: "work-queue",
    });
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.anchorType, "work-queue");
    }
  });

  test("accepts a body WITHOUT anchorType — the field is optional (backward compatible)", () => {
    const result = HoldbackPendingBodySchema.safeParse({
      prNumber: 502,
      tier: 2,
      cycleId: "cyc-502",
    });
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.anchorType, undefined);
    }
  });

  test("rejects an empty-string anchorType (an empty/whitespace value is what buckets as unclassified)", () => {
    const result = HoldbackPendingBodySchema.safeParse({
      prNumber: 503,
      tier: 3,
      cycleId: "cyc-503",
      anchorType: "",
    });
    assert.equal(result.success, false);
  });

  test("still rejects unknown keys (schema is .strict())", () => {
    const result = HoldbackPendingBodySchema.safeParse({
      prNumber: 504,
      tier: 3,
      cycleId: "cyc-504",
      anchorType: "work-queue",
      bogus: true,
    });
    assert.equal(result.success, false);
  });
});

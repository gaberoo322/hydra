/**
 * Regression tests for the `GET /api/tier?files=` query schema (issue #2183).
 *
 * Why this test exists:
 *   - `TierQuerySchema` used to be inline in `src/api/misc.ts`, so it could only
 *     be exercised through the live route. Issue #2183 moved it to
 *     `src/schemas/tier.ts` (the Schemas seam), which makes it directly
 *     unit-testable like every other API boundary contract — a stated benefit
 *     of the migration.
 *   - The schema pins the "present-but-may-be-empty" contract: `files` must be
 *     supplied (string or repeated-param array) so an ABSENT param 400s, but an
 *     empty value is accepted (it classifies the empty change set).
 *
 * Tests run against the pure schema (no Express, no Redis), matching the
 * codebase convention (see test/api-queue-schema.test.mts).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { TierQuerySchema } from "../src/schemas/tier.ts";

describe("TierQuerySchema — accepted shapes", () => {
  test("accepts a CSV string", () => {
    const result = TierQuerySchema.safeParse({ files: "src/a.ts,src/b.ts" });
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.files, "src/a.ts,src/b.ts");
    }
  });

  test("accepts a repeated-param array (Express ?files=a&files=b)", () => {
    const result = TierQuerySchema.safeParse({ files: ["src/a.ts", "src/b.ts"] });
    assert.equal(result.success, true);
    if (result.success) {
      assert.deepEqual(result.data.files, ["src/a.ts", "src/b.ts"]);
    }
  });

  test("accepts an empty string (classifies the empty change set, does not 400)", () => {
    const result = TierQuerySchema.safeParse({ files: "" });
    assert.equal(result.success, true);
  });

  test("ignores unknown query params (non-strict)", () => {
    const result = TierQuerySchema.safeParse({ files: "src/a.ts", extra: "ignored" });
    assert.equal(result.success, true);
  });
});

describe("TierQuerySchema — rejected shapes", () => {
  test("rejects an absent `files` param (the route's bespoke 400 case)", () => {
    const result = TierQuerySchema.safeParse({});
    assert.equal(result.success, false);
    if (!result.success) {
      assert.ok(result.error.issues.some((i) => i.path.includes("files")));
    }
  });

  test("rejects a non-string / non-array `files` value (number)", () => {
    const result = TierQuerySchema.safeParse({ files: 123 });
    assert.equal(result.success, false);
  });

  test("rejects a null `files` value", () => {
    const result = TierQuerySchema.safeParse({ files: null });
    assert.equal(result.success, false);
  });
});

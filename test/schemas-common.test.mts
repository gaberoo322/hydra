/**
 * Unit tests for `src/schemas/common.ts` — the shared query-param coercion
 * helpers introduced in ADR-0022 slice 1.
 *
 * Pure surface: no Express, no Redis. We assert the two helpers' behaviour
 * directly against the parsed result, pinning the lenient-default contract
 * (bad/absent input collapses to the default — the legacy `parseInt() || N`
 * and `=== "1"` semantics) the metrics.ts migration depends on.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { countQuerySchema, booleanFlag } from "../src/schemas/common.ts";
import { z } from "zod";

// ---------------------------------------------------------------------------
// countQuerySchema
// ---------------------------------------------------------------------------

describe("countQuerySchema — happy path", () => {
  test("parses a valid numeric string into a number", () => {
    const parsed = countQuerySchema(20).safeParse({ count: "37" });
    assert.equal(parsed.success, true);
    assert.equal(parsed.data?.count, 37);
  });

  test("accepts a numeric (non-string) value too", () => {
    const parsed = countQuerySchema(20).safeParse({ count: 5 });
    assert.equal(parsed.data?.count, 5);
  });

  test("floors a fractional value to an integer", () => {
    const parsed = countQuerySchema(20).safeParse({ count: "12.9" });
    assert.equal(parsed.data?.count, 12);
  });
});

describe("countQuerySchema — default-on-garbage (legacy `|| N` semantics)", () => {
  test("falls back to the default when the param is absent", () => {
    const parsed = countQuerySchema(20).safeParse({});
    assert.equal(parsed.success, true);
    assert.equal(parsed.data?.count, 20);
  });

  test("falls back to the default on a non-numeric string", () => {
    const parsed = countQuerySchema(50).safeParse({ count: "abc" });
    assert.equal(parsed.success, true);
    assert.equal(parsed.data?.count, 50);
  });

  test("falls back to the default on an empty string", () => {
    const parsed = countQuerySchema(20).safeParse({ count: "" });
    assert.equal(parsed.data?.count, 20);
  });

  test("never fails — success is always true (no 400 on a read route)", () => {
    for (const bad of ["abc", "", "NaN", "-0", undefined, null, {}]) {
      const parsed = countQuerySchema(20).safeParse({ count: bad });
      assert.equal(parsed.success, true, `expected success for count=${String(bad)}`);
    }
  });
});

describe("countQuerySchema — clamping", () => {
  test("clamps below the minimum (1) to the default", () => {
    // 0 and negatives are out of [1, max] → catch → default
    assert.equal(countQuerySchema(20).safeParse({ count: "0" }).data?.count, 20);
    assert.equal(countQuerySchema(20).safeParse({ count: "-5" }).data?.count, 20);
  });

  test("clamps above the default cap (1000) to the default", () => {
    assert.equal(countQuerySchema(20).safeParse({ count: "5000" }).data?.count, 20);
  });

  test("respects a custom max", () => {
    assert.equal(countQuerySchema(10, 100).safeParse({ count: "100" }).data?.count, 100);
    // 101 exceeds the custom cap → default
    assert.equal(countQuerySchema(10, 100).safeParse({ count: "101" }).data?.count, 10);
  });

  test("a default outside [1, max] is itself clamped", () => {
    assert.equal(countQuerySchema(0).safeParse({}).data?.count, 1);
    assert.equal(countQuerySchema(9999, 100).safeParse({}).data?.count, 100);
  });
});

describe("countQuerySchema — ignores unrelated query params", () => {
  test("non-strict: extra keys do not cause a failure", () => {
    const parsed = countQuerySchema(20).safeParse({ count: "30", date: "2026-06-06", foo: "bar" });
    assert.equal(parsed.success, true);
    assert.equal(parsed.data?.count, 30);
  });
});

// ---------------------------------------------------------------------------
// booleanFlag
// ---------------------------------------------------------------------------

describe("booleanFlag — truthy wire values", () => {
  test("treats 1/true/yes/on (any case) as true", () => {
    const Q = z.object({ flag: booleanFlag() });
    for (const v of ["1", "true", "TRUE", "yes", "YES", "on", "On", " true "]) {
      assert.equal(Q.safeParse({ flag: v }).data?.flag, true, `expected true for ${v}`);
    }
  });

  test("accepts a real boolean true", () => {
    const Q = z.object({ flag: booleanFlag() });
    assert.equal(Q.safeParse({ flag: true }).data?.flag, true);
  });
});

describe("booleanFlag — falsy wire values", () => {
  test("treats 0/false/other strings as false", () => {
    const Q = z.object({ flag: booleanFlag() });
    for (const v of ["0", "false", "no", "off", "anything", ""]) {
      assert.equal(Q.safeParse({ flag: v }).data?.flag, false, `expected false for "${v}"`);
    }
  });

  test("accepts a real boolean false", () => {
    const Q = z.object({ flag: booleanFlag() });
    assert.equal(Q.safeParse({ flag: false }).data?.flag, false);
  });
});

describe("booleanFlag — absent param honours the default", () => {
  test("absent → false by default", () => {
    const Q = z.object({ flag: booleanFlag() });
    assert.equal(Q.safeParse({}).data?.flag, false);
  });

  test("absent → true when defaultValue is true", () => {
    const Q = z.object({ flag: booleanFlag(true) });
    assert.equal(Q.safeParse({}).data?.flag, true);
  });

  test("an explicit value still overrides a true default", () => {
    const Q = z.object({ flag: booleanFlag(true) });
    assert.equal(Q.safeParse({ flag: "0" }).data?.flag, false);
  });
});

/**
 * Regression test for issue #302 — backfill promotion metadata for legacy
 * promoted patterns.
 *
 * Bug: `/api/learning/ineffective-rules` returned `totalIneffective: 0`
 * because every existing promoted pattern (scope-creep at 292x, no-diff at
 * 456x) was promoted BEFORE the issue #289 instrumentation landed. The
 * detector skips patterns without `promotedAt` / `hitsAtPromotion`, so
 * long-standing repeat offenders were invisible.
 *
 * Fix: `backfillPatternPromotionMetadata()` walks an array of patterns and
 * fills the missing fields in place. `backfillPromotionMetadata()` is the
 * Redis-backed one-shot wrapper called from `initLearning()` exactly once,
 * guarded by a Redis flag.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  backfillPatternPromotionMetadata,
  evaluatePromotedPatternEffectiveness,
  type MemoryPattern,
} from "../src/pattern-memory/agent-memory.ts";

function makePattern(overrides: Partial<MemoryPattern>): MemoryPattern {
  return {
    category: "scope-creep",
    severity: "prevent",
    hitCount: 100,
    firstSeen: "2026-04-01",
    lastSeen: "2026-05-07",
    lastCycleId: "cycle-1",
    action: "Narrow scope.",
    examples: ["example"],
    promoted: true,
    ...overrides,
  };
}

describe("backfill promotion metadata (issue #302)", () => {
  test("legacy promoted pattern (no metadata) is backfilled and flagged ineffective", () => {
    // The real-world failure: scope-creep at 292 hits, promoted: true, but
    // promotedAt / hitsAtPromotion are absent because promotion predated #289.
    const patterns: MemoryPattern[] = [
      makePattern({
        category: "scope-creep",
        hitCount: 292,
        firstSeen: "2026-04-01",
        lastSeen: "2026-05-07",
      }),
    ];

    // Pre-backfill: detector cannot evaluate it.
    assert.equal(
      evaluatePromotedPatternEffectiveness(patterns[0], new Date("2026-05-07T00:00:00Z")),
      null,
      "legacy promoted patterns must be skipped before backfill",
    );

    const mutated = backfillPatternPromotionMetadata(patterns, "2026-05-07");
    assert.equal(mutated, 1);
    assert.equal(patterns[0].promotedAt, "2026-04-01", "promotedAt should be firstSeen so window covers full lifetime");
    assert.equal(
      patterns[0].hitsAtPromotion,
      0,
      "hitsAtPromotion=0 when promotedAt was synthesized from firstSeen — all historical hits count as post-promotion",
    );

    // After backfill the detector immediately surfaces the pattern, which is
    // exactly the acceptance criterion: "After deploy ... /api/learning/
    // ineffective-rules should return at least the two known offenders."
    const ev = evaluatePromotedPatternEffectiveness(patterns[0], new Date("2026-05-07T00:00:00Z"));
    assert.ok(ev, "scope-creep at 292 hits MUST be flagged after backfill");
    assert.equal(ev!.category, "scope-creep");
    assert.equal(ev!.hitsAtPromotion, 0);
    assert.equal(ev!.hitsSincePromotion, 292);
  });

  test("idempotent — running backfill twice mutates nothing on the second pass", () => {
    const patterns: MemoryPattern[] = [
      makePattern({ category: "no-diff", hitCount: 456 }),
    ];
    const first = backfillPatternPromotionMetadata(patterns, "2026-05-11");
    const second = backfillPatternPromotionMetadata(patterns, "2026-05-11");
    assert.equal(first, 1, "first pass should fill in the legacy pattern");
    assert.equal(second, 0, "second pass should be a no-op");
  });

  test("non-promoted patterns are left untouched", () => {
    const patterns: MemoryPattern[] = [
      makePattern({
        category: "rare-failure",
        promoted: false,
        hitCount: 2,
      }),
    ];
    const mutated = backfillPatternPromotionMetadata(patterns, "2026-05-11");
    assert.equal(mutated, 0);
    assert.equal(patterns[0].promotedAt, undefined);
    assert.equal(patterns[0].hitsAtPromotion, undefined);
  });

  test("patterns already carrying both fields are not modified", () => {
    const patterns: MemoryPattern[] = [
      makePattern({
        promotedAt: "2026-05-01",
        hitsAtPromotion: 5,
        hitCount: 100,
      }),
    ];
    const before = JSON.stringify(patterns[0]);
    const mutated = backfillPatternPromotionMetadata(patterns, "2026-05-11");
    assert.equal(mutated, 0);
    assert.equal(JSON.stringify(patterns[0]), before, "no field should change");
  });

  test("partial metadata — promotedAt present, hitsAtPromotion missing — is completed", () => {
    const patterns: MemoryPattern[] = [
      makePattern({
        promotedAt: "2026-04-15",
        hitsAtPromotion: undefined,
        hitCount: 42,
      }),
    ];
    const mutated = backfillPatternPromotionMetadata(patterns, "2026-05-11");
    assert.equal(mutated, 1);
    assert.equal(patterns[0].promotedAt, "2026-04-15", "existing promotedAt is preserved");
    assert.equal(patterns[0].hitsAtPromotion, 42);
  });

  test("partial metadata — hitsAtPromotion present, promotedAt missing — is completed using firstSeen", () => {
    const patterns: MemoryPattern[] = [
      makePattern({
        promotedAt: undefined,
        hitsAtPromotion: 5,
        firstSeen: "2026-03-20",
        hitCount: 80,
      }),
    ];
    const mutated = backfillPatternPromotionMetadata(patterns, "2026-05-11");
    assert.equal(mutated, 1);
    assert.equal(patterns[0].promotedAt, "2026-03-20", "missing promotedAt should be firstSeen");
    assert.equal(patterns[0].hitsAtPromotion, 5, "existing hitsAtPromotion is preserved");
  });

  test("falls back to lastSeen, then today, when firstSeen is empty", () => {
    const patterns: MemoryPattern[] = [
      makePattern({
        firstSeen: "",
        lastSeen: "2026-05-01",
        promotedAt: undefined,
        hitsAtPromotion: undefined,
      }),
    ];
    backfillPatternPromotionMetadata(patterns, "2026-05-11");
    assert.equal(patterns[0].promotedAt, "2026-05-01");

    const patterns2: MemoryPattern[] = [
      makePattern({
        firstSeen: "",
        lastSeen: "",
        promotedAt: undefined,
        hitsAtPromotion: undefined,
      }),
    ];
    backfillPatternPromotionMetadata(patterns2, "2026-05-11");
    assert.equal(patterns2[0].promotedAt, "2026-05-11", "final fallback is today");
  });

  test("empty input is handled cleanly", () => {
    const patterns: MemoryPattern[] = [];
    const mutated = backfillPatternPromotionMetadata(patterns, "2026-05-11");
    assert.equal(mutated, 0);
    assert.equal(patterns.length, 0);
  });

  test("acceptance criterion: no-diff at 456 hits is surfaced after backfill", () => {
    // The issue body's second known offender: executor `no-diff` at 456 hits,
    // promoted: true, missing metadata.
    const patterns: MemoryPattern[] = [
      makePattern({
        category: "no-diff",
        hitCount: 456,
        firstSeen: "2026-03-15",
        lastSeen: "2026-05-10",
        promoted: true,
      }),
    ];
    backfillPatternPromotionMetadata(patterns, "2026-05-11");
    const ev = evaluatePromotedPatternEffectiveness(patterns[0], new Date("2026-05-11T00:00:00Z"));
    assert.ok(ev, "no-diff must surface after backfill");
    assert.equal(ev!.category, "no-diff");
    assert.equal(ev!.hitsSincePromotion, 456);
  });
});

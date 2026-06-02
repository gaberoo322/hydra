/**
 * Regression test for issue #289 — detect promoted-but-ineffective patterns.
 *
 * Bug: When a pattern in `hydra:memory:{agent}:patterns` reaches PROMOTION_THRESHOLD
 * hits it is auto-appended to `config/feedback/to-{agent}.md`. Hit count keeps
 * climbing afterward but nothing flags the case where the promoted rule isn't
 * actually changing agent behavior (scope-creep at 231x, verification-failure at
 * 438x — both grew at the SAME rate after promotion).
 *
 * Fix:
 *   - Record `promotedAt` and `hitsAtPromotion` when a pattern is promoted.
 *   - `evaluatePromotedPatternEffectiveness()` (pure) and
 *     `getIneffectivePromotedPatterns()` flag patterns whose post-promotion
 *     firing rate is >= pre-promotion rate.
 *   - `/api/learning/ineffective-rules` exposes the list.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluatePromotedPatternEffectiveness,
  MIN_DAYS_POST_PROMOTION,
} from "../src/pattern-memory/rule-effectiveness.ts";
import { type MemoryPattern } from "../src/pattern-memory/agent-memory.ts";

function makePattern(overrides: Partial<MemoryPattern>): MemoryPattern {
  return {
    category: "scope-creep",
    severity: "prevent",
    hitCount: 5,
    firstSeen: "2026-04-18",
    lastSeen: "2026-05-05",
    lastCycleId: "cycle-1",
    action: "Narrow scope.",
    examples: ["example"],
    promoted: true,
    promotedAt: "2026-04-28",
    hitsAtPromotion: 5,
    ...overrides,
  };
}

describe("ineffective promoted patterns (issue #289)", () => {
  test("synthetic pattern: 5 hits promoted, then 200 hits over 7 days post-promotion → flagged", () => {
    // Pre-promotion: 5 hits in 10 days = 0.5/day
    // Post-promotion: 200 hits in 7 days = ~28.6/day → way higher than pre
    const pattern = makePattern({
      firstSeen: "2026-04-18",
      promotedAt: "2026-04-28",
      hitsAtPromotion: 5,
      hitCount: 205,
      lastSeen: "2026-05-05",
    });
    const ev = evaluatePromotedPatternEffectiveness(pattern, new Date("2026-05-05T12:00:00Z"));
    assert.ok(ev, "expected pattern to be flagged ineffective");
    assert.equal(ev!.hitsAtPromotion, 5);
    assert.equal(ev!.hitsSincePromotion, 200);
    assert.equal(ev!.daysToPromotion, 10);
    assert.equal(ev!.daysSincePromotion, 7);
    // postRate (≈28.6) must be ≫ preRate (0.5)
    assert.ok(ev!.postRate > ev!.preRate, `postRate ${ev!.postRate} should exceed preRate ${ev!.preRate}`);
    assert.ok(ev!.rateRatio > 10, "rate ratio should be huge for this real-world failure mode");
  });

  test("real-world scope-creep example (231x in ~9d post-promotion) is flagged", () => {
    // Mirrors the issue body: scope-creep promoted at 5 hits on 2026-04-28,
    // 231 hits by 2026-05-07 → 226 post-promotion hits in 9 days.
    const pattern = makePattern({
      firstSeen: "2026-04-18",
      promotedAt: "2026-04-28",
      hitsAtPromotion: 5,
      hitCount: 231,
      lastSeen: "2026-05-07",
    });
    const ev = evaluatePromotedPatternEffectiveness(pattern, new Date("2026-05-07T00:00:00Z"));
    assert.ok(ev);
    assert.ok(ev!.postRate >= ev!.preRate);
  });

  test("pattern still firing at the SAME rate is flagged (post == pre)", () => {
    // 10 days to promotion at 0.5/day → 5 hits at promotion.
    // 10 more days at exactly the same rate → 10 hits since (15 total).
    // post >= pre, so it qualifies as ineffective.
    const pattern = makePattern({
      firstSeen: "2026-04-01",
      promotedAt: "2026-04-11",
      hitsAtPromotion: 5,
      hitCount: 10,
      lastSeen: "2026-04-21",
    });
    const ev = evaluatePromotedPatternEffectiveness(pattern, new Date("2026-04-21T00:00:00Z"));
    assert.ok(ev, "same-rate post-promotion means rule isn't working — should be flagged");
  });

  test("pattern that goes quiet after promotion is NOT flagged", () => {
    // 5 hits in 10 days pre, 0 hits in 10 days post → rule worked.
    const pattern = makePattern({
      firstSeen: "2026-04-01",
      promotedAt: "2026-04-11",
      hitsAtPromotion: 5,
      hitCount: 5,
      lastSeen: "2026-04-11",
    });
    const ev = evaluatePromotedPatternEffectiveness(pattern, new Date("2026-04-21T00:00:00Z"));
    assert.equal(ev, null, "no post-promotion hits means rule is working");
  });

  test("pattern that drops in rate after promotion is NOT flagged", () => {
    // Pre: 10 hits in 10 days = 1/day. Post: 2 hits in 10 days = 0.2/day.
    const pattern = makePattern({
      firstSeen: "2026-04-01",
      promotedAt: "2026-04-11",
      hitsAtPromotion: 10,
      hitCount: 12,
      lastSeen: "2026-04-20",
    });
    const ev = evaluatePromotedPatternEffectiveness(pattern, new Date("2026-04-21T00:00:00Z"));
    assert.equal(ev, null);
  });

  test("non-promoted patterns are never flagged", () => {
    const pattern = makePattern({ promoted: false, promotedAt: undefined, hitsAtPromotion: undefined });
    const ev = evaluatePromotedPatternEffectiveness(pattern);
    assert.equal(ev, null);
  });

  test("legacy promoted pattern without promotedAt/hitsAtPromotion is skipped", () => {
    // Patterns promoted before issue #289 lack the new fields — we cannot
    // judge them, so we just skip rather than mis-flag.
    const pattern = makePattern({ promotedAt: undefined, hitsAtPromotion: undefined });
    const ev = evaluatePromotedPatternEffectiveness(pattern);
    assert.equal(ev, null);
  });

  test("recently-promoted patterns are skipped until the observation window passes", () => {
    const pattern = makePattern({
      firstSeen: "2026-05-01",
      promotedAt: "2026-05-10",
      hitsAtPromotion: 5,
      hitCount: 50,
      lastSeen: "2026-05-10",
    });
    // Only 1 day post-promotion < MIN_DAYS_POST_PROMOTION.
    const ev = evaluatePromotedPatternEffectiveness(pattern, new Date("2026-05-11T00:00:00Z"));
    assert.equal(ev, null);
    assert.ok(MIN_DAYS_POST_PROMOTION >= 2, "need at least a small window before judging");
  });

  test("zero days-to-promotion clamps to 1 day (no divide-by-zero crash)", () => {
    // If a pattern hits PROMOTION_THRESHOLD on the same day it first appeared,
    // daysToPromotion is clamped to 1 to avoid divide-by-zero. The helper must
    // still produce a sane comparison rather than throw.
    const pattern = makePattern({
      firstSeen: "2026-04-28",
      promotedAt: "2026-04-28",
      hitsAtPromotion: 5,
      hitCount: 200, // 195 hits in 10 days = 19.5/day, way above pre 5/day
      lastSeen: "2026-05-08",
    });
    const ev = evaluatePromotedPatternEffectiveness(pattern, new Date("2026-05-08T00:00:00Z"));
    assert.ok(ev, "should flag when post-promotion rate >> clamped pre-rate");
    assert.equal(ev!.daysToPromotion, 1);
  });
});

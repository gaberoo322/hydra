/**
 * Regression test for issue #365 — promoted-rule effectiveness math + action loop.
 *
 * Symptoms (from /api/learning/ineffective-rules in production):
 *   planner verification-failure  postRate=29.75/day  hitsSincePromotion=476
 *   executor no-diff              postRate=26.88/day  hitsSincePromotion=457
 *   ... and 5 more rules with similar disposition.
 *
 * Either promotion was actively counterproductive, or the system never closed
 * the loop on auto-promoted rules. Issue #365 closes the loop:
 *
 *   1. `qualifiesForRuleAction()` distinguishes "surface in diagnostic"
 *      (postRate >= preRate) from "auto-demote-worthy" (postRate >= preRate*1.5
 *      OR absolute postRate >= 5/day with daysSincePromotion >= 14).
 *   2. `processPromotedPatternEffectiveness()` walks promoted patterns,
 *      mutates the Redis record (`promoted: false`, `demoted: true`,
 *      `demotedReason: "ineffective"`), and rewrites the feedback file to
 *      remove the rule block.
 *   3. `lastEffectivenessCheckAt` throttles re-evaluation so we don't spam
 *      the operator on every cycle.
 *   4. `HYDRA_RULE_AUTO_DEMOTE=false` disables the mutation; the check still
 *      logs an "alerted" entry to the rule-action audit log.
 *   5. `removePromotedRuleFromFeedback()` is pure — given the feedback file
 *      content + category, it strips the `### <category> (...)` block from
 *      the Auto-Promoted Rules section.
 *
 * These tests cover the pure helpers + the in-memory orchestration around
 * Redis. They do not exercise actual Redis writes — the integration with
 * `consolidate()` is checked by the existing learning-module-boundaries test.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  ABSOLUTE_AGE_DAYS,
  ABSOLUTE_POSTRATE_THRESHOLD,
  EFFECTIVENESS_CHECK_COOLDOWN_HOURS,
  RATE_RATIO_MULTIPLIER,
  applyDemotionToPattern,
  evaluatePromotedPatternEffectiveness,
  isAutoDemoteEnabled,
  isEffectivenessCooldownExpired,
  qualifiesForRuleAction,
  removePromotedRuleFromFeedback,
  type IneffectivePromotedPattern,
} from "../src/pattern-memory/rule-effectiveness.ts";
import { type MemoryPattern } from "../src/pattern-memory/agent-memory.ts";

function makePattern(overrides: Partial<MemoryPattern>): MemoryPattern {
  return {
    category: "verification-failure",
    severity: "prevent",
    hitCount: 5,
    firstSeen: "2026-04-01",
    lastSeen: "2026-05-12",
    lastCycleId: "cycle-x",
    action: "Verification must pass.",
    examples: ["example"],
    promoted: true,
    promotedAt: "2026-04-11",
    hitsAtPromotion: 5,
    ...overrides,
  };
}

function makeEv(overrides: Partial<IneffectivePromotedPattern>): IneffectivePromotedPattern {
  return {
    category: "verification-failure",
    promotedAt: "2026-04-27",
    hitsAtPromotion: 5,
    hitsSincePromotion: 100,
    daysToPromotion: 10,
    daysSincePromotion: 16,
    preRate: 0.5,
    postRate: 6.25,
    rateRatio: 12.5,
    rateRatioLabel: "12.50",
    reasonCode: "rate-ratio",
    lastSeen: "2026-05-13",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// evaluatePromotedPatternEffectiveness — new fields (issue #365)
// ---------------------------------------------------------------------------

describe("evaluatePromotedPatternEffectiveness — JSON-safe rateRatio (#365)", () => {
  test("backfilled pattern (preRate=0, hits still firing) reports rateRatioLabel='infinite'", () => {
    // Mirrors the live data: hitsAtPromotion=0, promotedAt=firstSeen → preRate=0.
    const pattern = makePattern({
      firstSeen: "2026-04-27",
      promotedAt: "2026-04-27",
      hitsAtPromotion: 0,
      hitCount: 476,
      lastSeen: "2026-05-13",
    });
    const ev = evaluatePromotedPatternEffectiveness(pattern, new Date("2026-05-13T00:00:00Z"));
    assert.ok(ev, "backfilled pattern with continued firing must be flagged");
    assert.equal(ev!.preRate, 0);
    assert.equal(ev!.rateRatioLabel, "infinite", "label is JSON-safe, unlike Infinity");
    // JSON.stringify round-trip must not corrupt the envelope.
    const round = JSON.parse(JSON.stringify(ev));
    assert.equal(round.rateRatioLabel, "infinite");
    // reasonCode propagates so downstream consumers know this is the no-baseline case.
    assert.equal(ev!.reasonCode, "no-baseline");
  });

  test("real-data ratio (postRate=6.25, preRate=0.5) carries numeric label", () => {
    const pattern = makePattern({
      firstSeen: "2026-04-01",
      promotedAt: "2026-04-11",
      hitsAtPromotion: 5,
      hitCount: 105,
      lastSeen: "2026-04-27",
    });
    const ev = evaluatePromotedPatternEffectiveness(pattern, new Date("2026-04-27T00:00:00Z"));
    assert.ok(ev);
    assert.equal(ev!.preRate, 0.5);
    assert.equal(ev!.postRate, 6.25);
    assert.equal(ev!.rateRatioLabel, "12.50");
    assert.equal(ev!.reasonCode, "rate-ratio");
  });
});

// ---------------------------------------------------------------------------
// qualifiesForRuleAction — stricter than "surface for display"
// ---------------------------------------------------------------------------

describe("qualifiesForRuleAction — action thresholds (#365)", () => {
  test("postRate >= preRate * RATE_RATIO_MULTIPLIER → 'rate-ratio'", () => {
    const ev = makeEv({ preRate: 1, postRate: 1 * RATE_RATIO_MULTIPLIER });
    assert.equal(qualifiesForRuleAction(ev), "rate-ratio");
  });

  test("postRate just under multiplier with low absolute rate → null (don't act)", () => {
    const ev = makeEv({
      preRate: 1,
      postRate: 1.2, // < 1 * 1.5
      daysSincePromotion: 5,
    });
    assert.equal(qualifiesForRuleAction(ev), null);
  });

  test("postRate barely above preRate but well above absolute threshold over 14d → 'absolute-postrate'", () => {
    const ev = makeEv({
      preRate: ABSOLUTE_POSTRATE_THRESHOLD - 0.1,
      postRate: ABSOLUTE_POSTRATE_THRESHOLD + 0.1, // ratio 1.04 < multiplier
      daysSincePromotion: ABSOLUTE_AGE_DAYS,
    });
    assert.equal(qualifiesForRuleAction(ev), "absolute-postrate");
  });

  test("no baseline (preRate=0) + postRate >= 5/day + age >= 14d → 'no-baseline'", () => {
    const ev = makeEv({
      preRate: 0,
      postRate: 29.75,
      daysSincePromotion: 16,
      reasonCode: "no-baseline",
    });
    assert.equal(qualifiesForRuleAction(ev), "no-baseline");
  });

  test("no baseline but young (< 14d) and low postRate → null", () => {
    // Backfilled rule that's been quiet — surface for diagnostic but DON'T
    // auto-demote.
    const ev = makeEv({
      preRate: 0,
      postRate: 0.5,
      daysSincePromotion: 10,
      reasonCode: "no-baseline",
    });
    assert.equal(qualifiesForRuleAction(ev), null);
  });

  test("AC4 simulation — hitsAtPromotion=10, hitsSincePromotion=300 over 10d → auto-demote fires", () => {
    // Pre: 10 hits / daysToPromotion=? — the issue body says
    // "simulating a rule with hitsAtPromotion=10, hitsSincePromotion=300 over
    // 10 days → auto-demote fires". The detector reads daysToPromotion off
    // the pattern's firstSeen→promotedAt span; we synthesize that and confirm
    // the qualifier returns a non-null reason.
    const pattern = makePattern({
      firstSeen: "2026-04-01", // 30 days before promotion
      promotedAt: "2026-05-01",
      hitsAtPromotion: 10,
      hitCount: 310,
      lastSeen: "2026-05-11",
    });
    const ev = evaluatePromotedPatternEffectiveness(pattern, new Date("2026-05-11T00:00:00Z"));
    assert.ok(ev, "pattern must surface");
    // Pre: 10/30 ≈ 0.33/day. Post: 300/10 = 30/day. Ratio ≈ 90 → rate-ratio fires.
    const reason = qualifiesForRuleAction(ev!);
    assert.equal(reason, "rate-ratio");
  });
});

// ---------------------------------------------------------------------------
// applyDemotionToPattern + isAutoDemoteEnabled + isEffectivenessCooldownExpired
// ---------------------------------------------------------------------------

describe("applyDemotionToPattern (#365)", () => {
  test("clears promotion metadata and stamps demoted fields", () => {
    const p = makePattern({
      hitCount: 476,
      promoted: true,
      promotedAt: "2026-04-27",
      hitsAtPromotion: 0,
    });
    applyDemotionToPattern(p, "2026-05-13T12:34:56.000Z");
    assert.equal(p.promoted, false);
    assert.equal(p.promotedAt, undefined, "cleared so the next sweep doesn't re-evaluate");
    assert.equal(p.hitsAtPromotion, undefined);
    assert.equal(p.demoted, true);
    assert.equal(p.demotedAt, "2026-05-13");
    assert.equal(p.demotedReason, "ineffective");
    // hitCount is preserved — pattern stays in the store but loses cardinal-rule status.
    assert.equal(p.hitCount, 476);
  });
});

describe("isAutoDemoteEnabled — HYDRA_RULE_AUTO_DEMOTE env knob (#365)", () => {
  test("default (unset) → enabled", () => {
    assert.equal(isAutoDemoteEnabled({}), true);
  });
  test("'true' → enabled", () => {
    assert.equal(isAutoDemoteEnabled({ HYDRA_RULE_AUTO_DEMOTE: "true" }), true);
  });
  test("'false' → disabled", () => {
    assert.equal(isAutoDemoteEnabled({ HYDRA_RULE_AUTO_DEMOTE: "false" }), false);
  });
  test("' FALSE ' (whitespace, case) → disabled", () => {
    assert.equal(isAutoDemoteEnabled({ HYDRA_RULE_AUTO_DEMOTE: " FALSE " }), false);
  });
  test("'0' → disabled (numeric-style flag)", () => {
    assert.equal(isAutoDemoteEnabled({ HYDRA_RULE_AUTO_DEMOTE: "0" }), false);
  });
  test("anything else (e.g. 'yes') → enabled (fail-safe to default)", () => {
    assert.equal(isAutoDemoteEnabled({ HYDRA_RULE_AUTO_DEMOTE: "yes" }), true);
  });
});

describe("isEffectivenessCooldownExpired (#365)", () => {
  test("undefined → expired (never checked)", () => {
    assert.equal(isEffectivenessCooldownExpired(undefined, new Date()), true);
  });
  test("malformed ISO string → expired (fail open, don't deadlock the check)", () => {
    assert.equal(isEffectivenessCooldownExpired("not-an-iso", new Date()), true);
  });
  test("within cooldown window → not expired", () => {
    const now = new Date("2026-05-13T12:00:00Z");
    const last = new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString(); // 1h ago
    assert.equal(isEffectivenessCooldownExpired(last, now), false);
  });
  test("past cooldown window → expired", () => {
    const now = new Date("2026-05-13T12:00:00Z");
    const last = new Date(
      now.getTime() - (EFFECTIVENESS_CHECK_COOLDOWN_HOURS + 1) * 60 * 60 * 1000,
    ).toISOString();
    assert.equal(isEffectivenessCooldownExpired(last, now), true);
  });
});

// ---------------------------------------------------------------------------
// removePromotedRuleFromFeedback — pure feedback-file rewrite
// ---------------------------------------------------------------------------

describe("removePromotedRuleFromFeedback — strip a single rule block (#365)", () => {
  const SAMPLE = `# Planner Guidance

## Some Other Section

Body content.

## Auto-Promoted Rules

Rules below were auto-promoted from agent memory after proving themselves
across multiple cycles.

### scope-creep (231x since 2026-04-27)
The executor consistently touches files beyond scope.
Last: cycle-2026-05-07-1219
<!-- auto-promoted 2026-04-28, last hit 2026-05-07 -->

### verification-failure (438x since 2026-04-27)
Ensure verification will pass before proposing.
Last: cycle-2026-05-07-1026
<!-- auto-promoted 2026-04-28, last hit 2026-05-07 -->

### broad-scope-success (17x since 2026-04-28)
Broad scope can work when each file is needed.
Last: cycle-2026-05-07-2125
<!-- auto-promoted 2026-04-29, last hit 2026-05-07 -->
`;

  test("removes the requested rule block, leaves the others intact", () => {
    const { newContent, removed } = removePromotedRuleFromFeedback(SAMPLE, "verification-failure");
    assert.equal(removed, true);
    assert.ok(!newContent.includes("verification-failure (438x"));
    assert.ok(newContent.includes("scope-creep (231x"));
    assert.ok(newContent.includes("broad-scope-success (17x"));
    // No triple blank lines left behind.
    assert.ok(!/\n{3,}/.test(newContent));
  });

  test("removes the LAST rule block (edge case: no following ### terminator)", () => {
    const { newContent, removed } = removePromotedRuleFromFeedback(SAMPLE, "broad-scope-success");
    assert.equal(removed, true);
    assert.ok(!newContent.includes("broad-scope-success"));
    // The preceding rule must be preserved.
    assert.ok(newContent.includes("verification-failure (438x"));
  });

  test("unknown category → no change, removed=false", () => {
    const { newContent, removed } = removePromotedRuleFromFeedback(SAMPLE, "no-such-rule");
    assert.equal(removed, false);
    assert.equal(newContent, SAMPLE);
  });

  test("file has no Auto-Promoted Rules section → no change", () => {
    const without = `# Planner Guidance\n\n## Other\nbody\n`;
    const { newContent, removed } = removePromotedRuleFromFeedback(without, "scope-creep");
    assert.equal(removed, false);
    assert.equal(newContent, without);
  });

  test("does not cross into the 'Stale Rules (review needed)' section", () => {
    const withStale =
      SAMPLE +
      `\n## Stale Rules (review needed)\n\n### scope-creep (5x since 2026-01-01)\nold body\n<!-- auto-promoted 2026-01-01, last hit 2026-01-05 -->\n`;
    // Removing scope-creep should only affect the Auto-Promoted block, not the
    // identically-named heading inside Stale Rules.
    const { newContent, removed } = removePromotedRuleFromFeedback(withStale, "scope-creep");
    assert.equal(removed, true);
    // Stale section + its scope-creep block survives.
    assert.ok(newContent.includes("## Stale Rules (review needed)"));
    assert.ok(newContent.includes("### scope-creep (5x since 2026-01-01)"));
    // Auto-promoted scope-creep is gone.
    assert.ok(!newContent.includes("scope-creep (231x"));
  });
});

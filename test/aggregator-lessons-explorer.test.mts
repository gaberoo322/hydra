/**
 * Regression tests for the lessons-explorer aggregator (issue #620, PRD #615).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  getLessonsExplorer,
  liftPromotedLessons,
  skillMatches,
  type RawMemoryPattern,
} from "../src/aggregators/lessons-explorer.ts";

function raw(overrides: Partial<RawMemoryPattern> = {}): RawMemoryPattern {
  return {
    category: "stub-rule",
    severity: "prevent",
    hitCount: 5,
    promoted: true,
    promotedAt: "2026-05-01",
    hitsAtPromotion: 3,
    lastSeen: "2026-05-26T12:00:00Z",
    examples: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("liftPromotedLessons", () => {
  test("drops un-promoted patterns", () => {
    const out = liftPromotedLessons("hydra-dev", [raw({ promoted: false })]);
    assert.deepEqual(out, []);
  });

  test("computes postPromotionHits when hitsAtPromotion known", () => {
    const out = liftPromotedLessons(
      "hydra-dev",
      [raw({ hitCount: 10, hitsAtPromotion: 3 })],
    );
    assert.equal(out[0].postPromotionHits, 7);
  });

  test("postPromotionHits null when hitsAtPromotion missing", () => {
    const out = liftPromotedLessons(
      "hydra-dev",
      [raw({ hitCount: 10, hitsAtPromotion: undefined })],
    );
    assert.equal(out[0].postPromotionHits, null);
  });

  test("postPromotionHits clamped at 0 (never negative)", () => {
    const out = liftPromotedLessons(
      "hydra-dev",
      [raw({ hitCount: 2, hitsAtPromotion: 5 })],
    );
    assert.equal(out[0].postPromotionHits, 0);
  });

  test("flag demoted", () => {
    const out = liftPromotedLessons("hydra-dev", [raw({ demoted: true })]);
    assert.equal(out[0].demoted, true);
  });

  test("returns [] when patterns isn't an array", () => {
    assert.deepEqual(liftPromotedLessons("hydra-dev", null as any), []);
  });
});

describe("skillMatches", () => {
  test("empty filter matches anything", () => {
    assert.equal(skillMatches("hydra-dev", ""), true);
  });
  test("case-insensitive substring match", () => {
    assert.equal(skillMatches("hydra-dev", "DEV"), true);
    assert.equal(skillMatches("hydra-qa", "dev"), false);
  });
});

// ---------------------------------------------------------------------------
// Integration shape
// ---------------------------------------------------------------------------

describe("getLessonsExplorer — happy path", () => {
  test("flattens promoted lessons across skills sorted by hitCount desc", async () => {
    const reader = async () => [
      {
        skill: "hydra-dev",
        patterns: [
          raw({ category: "low-fire", hitCount: 4 }),
          raw({ category: "hot", hitCount: 20 }),
        ],
      },
      {
        skill: "hydra-qa",
        patterns: [raw({ category: "medium", hitCount: 10 })],
      },
    ];
    const result = await getLessonsExplorer({}, { readMemoryPatterns: reader });
    assert.equal(result.lessons.length, 3);
    assert.deepEqual(
      result.lessons.map((l) => l.cue),
      ["hot", "medium", "low-fire"],
    );
    assert.equal(result.promotionThreshold, 3);
  });

  test("filters by skill substring", async () => {
    const reader = async () => [
      { skill: "hydra-dev", patterns: [raw({ category: "x" })] },
      { skill: "hydra-qa", patterns: [raw({ category: "y" })] },
    ];
    const result = await getLessonsExplorer(
      { skill: "dev" },
      { readMemoryPatterns: reader },
    );
    assert.equal(result.lessons.length, 1);
    assert.equal(result.lessons[0].skill, "hydra-dev");
  });

  test("reader failure → empty lessons", async () => {
    const reader = async () => {
      throw new Error("redis dead");
    };
    const result = await getLessonsExplorer({}, { readMemoryPatterns: reader });
    assert.deepEqual(result.lessons, []);
  });
});

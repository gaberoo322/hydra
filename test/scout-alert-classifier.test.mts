/**
 * Regression tests for `src/scout/alert-classifier.ts` — the pure
 * alert-classification policy leaf extracted from `alert-listener.ts`
 * (issue #2785).
 *
 * The whole point of the extraction: this file imports the classifier
 * DIRECTLY, with NO Redis import in scope and NO connection/teardown
 * lifecycle. Every branch of the pure disposition function is exercised
 * against a synthetic `RawAlert + state` object — no mock setup, no DB.
 *
 * The Redis-backed end-to-end coverage of `planAlertDispatches` lives in
 * `test/scout-alert-listener.test.mts` (the coordinator).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  PATTERN_CATEGORY_MAP,
  ALERT_PER_PATTERN_COOLDOWN_HOURS,
  ALERT_PER_CATEGORY_COOLDOWN_HOURS,
  stripPatternPrefix,
  categoriesForPattern,
  isCooledDownHours,
  classifyAlert,
} from "../src/scout/alert-classifier.ts";

const MS_PER_HOUR = 60 * 60 * 1000;

// ===========================================================================
// 1. stripPatternPrefix + categoriesForPattern — pure lookups
// ===========================================================================

describe("stripPatternPrefix", () => {
  test("strips the pattern: prefix", () => {
    assert.equal(stripPatternPrefix("pattern:test_decline"), "test_decline");
  });
  test("returns input unchanged when no prefix", () => {
    assert.equal(stripPatternPrefix("test_decline"), "test_decline");
  });
  test("non-string input returns empty string", () => {
    assert.equal(stripPatternPrefix(undefined as any), "");
    assert.equal(stripPatternPrefix(null as any), "");
  });
});

describe("categoriesForPattern", () => {
  test("every mapped pattern resolves to at least one category", () => {
    for (const p of Object.keys(PATTERN_CATEGORY_MAP)) {
      const cats = categoriesForPattern(p);
      assert.ok(cats.length >= 1, `${p} should map to ≥1 category`);
    }
  });
  test("unmapped pattern returns empty array (not null)", () => {
    const cats = categoriesForPattern("totally-made-up-pattern");
    assert.deepEqual([...cats], []);
  });
  test("infra patterns are deliberately silent", () => {
    assert.deepEqual([...categoriesForPattern("cost-cap")], []);
    assert.deepEqual([...categoriesForPattern("consumer_dead")], []);
    assert.deepEqual([...categoriesForPattern("dlq_alert")], []);
  });
  test("PATTERN_CATEGORY_MAP is frozen (mutation-safe)", () => {
    assert.throws(() => {
      (PATTERN_CATEGORY_MAP as any).new_pattern = ["x"];
    });
  });
  test("cooldown constants are the 24h acute-pain window", () => {
    assert.equal(ALERT_PER_PATTERN_COOLDOWN_HOURS, 24);
    assert.equal(ALERT_PER_CATEGORY_COOLDOWN_HOURS, 24);
  });
});

// ===========================================================================
// 2. isCooledDownHours — pure cooldown predicate
// ===========================================================================

describe("isCooledDownHours", () => {
  const now = new Date("2026-05-19T12:00:00Z");
  test("null / empty last → cooled", () => {
    assert.equal(isCooledDownHours(null, 24, now), true);
    assert.equal(isCooledDownHours("", 24, now), true);
  });
  test("unparseable last → cooled (corrupt-record fallback)", () => {
    assert.equal(isCooledDownHours("not-a-date", 24, now), true);
  });
  test("recent fire within window → not cooled", () => {
    const past = new Date(now.getTime() - 6 * MS_PER_HOUR).toISOString();
    assert.equal(isCooledDownHours(past, 24, now), false);
  });
  test("old fire past window → cooled", () => {
    const past = new Date(now.getTime() - 25 * MS_PER_HOUR).toISOString();
    assert.equal(isCooledDownHours(past, 24, now), true);
  });
});

// ===========================================================================
// 3. classifyAlert — pure disposition (every branch)
// ===========================================================================

describe("classifyAlert", () => {
  const now = new Date("2026-05-19T12:00:00Z");
  const fresh = () => ({
    patternLastFired: {} as Record<string, string | null>,
    categoryLastWalked: {} as Record<string, string | null>,
    alreadyScheduled: new Set<string>(),
    cursorIso: null as string | null,
    now,
  });

  test("happy path: mapped pattern, no cooldown → target", () => {
    const result = classifyAlert(
      {
        id: "alert-1",
        type: "pattern:test_decline",
        timestamp: "2026-05-19T11:00:00Z",
        message: "Tests declining",
      },
      fresh(),
    );
    assert.ok("target" in result, "expected target");
    assert.equal(result.target.pattern, "test_decline");
    assert.equal(result.target.category, "testing-tooling");
    assert.equal(result.target.alertId, "alert-1");
    assert.equal(result.target.reason, "Tests declining");
  });

  test("target reason falls back to synthetic when message empty", () => {
    const result = classifyAlert(
      {
        id: "alert-2",
        type: "pattern:test_decline",
        timestamp: "2026-05-19T11:00:00Z",
      },
      fresh(),
    );
    assert.ok("target" in result);
    assert.equal(result.target.reason, "pattern test_decline");
  });

  test("malformed alert (no id) → skip:malformed", () => {
    const result = classifyAlert(
      { type: "pattern:test_decline", timestamp: "2026-05-19T11:00:00Z" },
      fresh(),
    );
    assert.ok("skip" in result);
    assert.equal(result.skip.reason, "malformed");
  });

  test("dismissed alert → skip:dismissed", () => {
    const result = classifyAlert(
      {
        id: "a",
        type: "pattern:test_decline",
        timestamp: "2026-05-19T11:00:00Z",
        dismissed: true,
      },
      fresh(),
    );
    assert.ok("skip" in result);
    assert.equal(result.skip.reason, "dismissed");
  });

  test("alert older than cursor → skip:before-cursor", () => {
    const state = fresh();
    state.cursorIso = "2026-05-19T11:30:00Z";
    const result = classifyAlert(
      {
        id: "old",
        type: "pattern:test_decline",
        timestamp: "2026-05-19T11:00:00Z",
      },
      state,
    );
    assert.ok("skip" in result);
    assert.equal(result.skip.reason, "before-cursor");
  });

  test("unmapped pattern → skip:unmapped-pattern", () => {
    const result = classifyAlert(
      {
        id: "a",
        type: "pattern:totally_unknown",
        timestamp: "2026-05-19T11:00:00Z",
      },
      fresh(),
    );
    assert.ok("skip" in result);
    assert.equal(result.skip.reason, "unmapped-pattern");
  });

  test("cycle:failed (non-pattern type) → skip:unmapped-pattern", () => {
    const result = classifyAlert(
      {
        id: "a",
        type: "cycle:failed",
        timestamp: "2026-05-19T11:00:00Z",
      },
      fresh(),
    );
    assert.ok("skip" in result);
    assert.equal(result.skip.reason, "unmapped-pattern");
  });

  test("per-pattern cooldown → skip:pattern-cooldown", () => {
    const state = fresh();
    state.patternLastFired = {
      test_decline: new Date(now.getTime() - 6 * MS_PER_HOUR).toISOString(),
    };
    const result = classifyAlert(
      {
        id: "a",
        type: "pattern:test_decline",
        timestamp: "2026-05-19T11:00:00Z",
      },
      state,
    );
    assert.ok("skip" in result);
    assert.equal(result.skip.reason, "pattern-cooldown");
  });

  test("per-category cooldown → skip:category-cooldown", () => {
    const state = fresh();
    state.categoryLastWalked = {
      "testing-tooling": new Date(now.getTime() - 6 * MS_PER_HOUR).toISOString(),
    };
    const result = classifyAlert(
      {
        id: "a",
        type: "pattern:test_decline",
        timestamp: "2026-05-19T11:00:00Z",
      },
      state,
    );
    assert.ok("skip" in result);
    assert.equal(result.skip.reason, "category-cooldown");
  });

  test("category already scheduled in batch → skip:coalesced", () => {
    const state = fresh();
    state.alreadyScheduled = new Set(["testing-tooling"]);
    const result = classifyAlert(
      {
        id: "a",
        type: "pattern:test_decline",
        timestamp: "2026-05-19T11:00:00Z",
      },
      state,
    );
    assert.ok("skip" in result);
    assert.equal(result.skip.reason, "coalesced");
  });

  test("cooldowns elapsed past 24h → eligible", () => {
    const state = fresh();
    state.patternLastFired = {
      test_decline: new Date(now.getTime() - 25 * MS_PER_HOUR).toISOString(),
    };
    state.categoryLastWalked = {
      "testing-tooling": new Date(now.getTime() - 25 * MS_PER_HOUR).toISOString(),
    };
    const result = classifyAlert(
      {
        id: "a",
        type: "pattern:test_decline",
        timestamp: "2026-05-19T11:00:00Z",
      },
      state,
    );
    assert.ok("target" in result);
  });
});

/**
 * Test home for the pure functions of `src/cost/token-math.ts` (issue #4785,
 * epic #4780 — the test-topology split of ADR-0042 Decision 8).
 *
 * The token-math unit suites moved here VERBATIM from
 * `test/usage-tracker.test.mts` (parseUsageLine, modelToFamily, cacheHitRatio,
 * projectResetWindow, parseObservedResetMs, the weightedTokens helper, and
 * parseSessionLimitReset) so the suites live inside token-math.ts's mutation
 * related-test set (#4504 cap of 8, basename rank) instead of the tracker's.
 *
 * The file's founding suite is the `weightedTokens` regression set (issue
 * #3825):
 *
 * Pre-#3825 the fold hardcoded input / output / cacheCreation at weight 1.0 and
 * exposed only `cacheRead`, so every ranking surface ranked consumers by RAW
 * cache-read volume (85% of volume, ~25% of real burn) while the dominant cost
 * driver — cache writes — was invisible. This suite pins the four-category fix:
 *
 *   - each of the four categories contributes at its OWN configured weight
 *     (isolation test per category) — AC5 / ask #1
 *   - the fold is NOT an identity under the default list-price config — AC5
 *   - the documented volume/cost inversion holds: cache-read-dominant volume
 *     shrinks under list-price weights, cache-write grows
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  cacheHitRatio,
  modelToFamily,
  parseObservedResetMs,
  parseSessionLimitReset,
  parseUsageLine,
  projectResetWindow,
  weightedTokens,
} from "../src/cost/token-math.ts";
import type { TokenBreakdown, CategoryWeights } from "../src/cost/token-math.ts";
// The list-price DEFAULTS live in the env-reader leaf (issue #3825); import them
// so the "default config" assertions track the source of truth, not a literal.
import {
  DEFAULT_BURN_WEIGHT_INPUT,
  DEFAULT_BURN_WEIGHT_OUTPUT,
  DEFAULT_BURN_WEIGHT_CACHE_READ,
  DEFAULT_BURN_WEIGHT_CACHE_CREATION,
} from "../src/cost/config.ts";
// Shared Cost-module test fixtures (issue #4784): the suites moved in #4785
// build their inputs through the shared object-form `breakdown` /
// `assistantLine` helpers, exactly as they did inside usage-tracker.test.mts.
import { assistantLine, breakdown } from "./_helpers/cost-fixtures.mts";

// The shared `breakdown` fixture above takes a Partial object; the #3825
// isolation tests below additionally want the compact POSITIONAL form, so it
// lives on under a distinct name (issue #4785).
function positionalBreakdown(
  input = 0,
  output = 0,
  cacheRead = 0,
  cacheCreation = 0,
): TokenBreakdown {
  return { input, output, cacheRead, cacheCreation, total: input + output + cacheRead + cacheCreation };
}

describe("weightedTokens (issue #3825)", () => {
  test("each of the four categories contributes at its own configured weight", () => {
    // A non-trivial weight per category, none equal, so a leak between axes
    // (e.g. cacheCreation silently pinned at 1.0) changes the result.
    const w: CategoryWeights = { input: 3, output: 5, cacheRead: 0.1, cacheCreation: 1.25 };

    // Isolate each category: only ONE axis non-zero → the fold must equal that
    // axis's weight × its token count, proving the weight actually binds.
    assert.equal(weightedTokens(positionalBreakdown(100), w), 300, "input axis"); // 3 * 100
    assert.equal(weightedTokens(positionalBreakdown(0, 100), w), 500, "output axis"); // 5 * 100
    assert.equal(weightedTokens(positionalBreakdown(0, 0, 100), w), 10, "cacheRead axis"); // 0.1 * 100
    assert.equal(weightedTokens(positionalBreakdown(0, 0, 0, 100), w), 125, "cacheCreation axis"); // 1.25 * 100
  });

  test("all-1.0 weights reduce to .total (the identity baseline)", () => {
    const identity: CategoryWeights = { input: 1, output: 1, cacheRead: 1, cacheCreation: 1 };
    const b = positionalBreakdown(100, 200, 300, 400);
    assert.equal(weightedTokens(b, identity), b.total);
  });

  test("is NOT an identity under the DEFAULT list-price config (criterion 5)", () => {
    // The pre-#3825 default config was identity for 3 of 4 axes; the new default
    // list-price config is NOT, which is the whole point.
    const defaults: CategoryWeights = {
      input: DEFAULT_BURN_WEIGHT_INPUT, // 1.0
      output: DEFAULT_BURN_WEIGHT_OUTPUT, // 5.0
      cacheRead: DEFAULT_BURN_WEIGHT_CACHE_READ, // 0.1
      cacheCreation: DEFAULT_BURN_WEIGHT_CACHE_CREATION, // 1.25
    };
    const b = positionalBreakdown(100, 100, 100, 100);
    assert.notEqual(weightedTokens(b, defaults), b.total);
    // 1*100 + 5*100 + 0.1*100 + 1.25*100 = 735
    assert.equal(weightedTokens(b, defaults), 735);
  });

  test("the volume/cost inversion the issue describes: cache-read volume shrinks, cache-write grows", () => {
    // A realistic cache-read-dominant mix: cacheRead is ~70% of VOLUME but the
    // cheapest category; cacheCreation (cache-write) is ~12% of volume but a
    // top cost driver. Ranking by raw tokens puts cacheRead on top; weighting
    // inverts it.
    const defaults: CategoryWeights = {
      input: DEFAULT_BURN_WEIGHT_INPUT,
      output: DEFAULT_BURN_WEIGHT_OUTPUT,
      cacheRead: DEFAULT_BURN_WEIGHT_CACHE_READ,
      cacheCreation: DEFAULT_BURN_WEIGHT_CACHE_CREATION,
    };
    const b = positionalBreakdown(10_000, 5_000, 60_000, 10_000); // total 85,000
    // 1*10000 + 5*5000 + 0.1*60000 + 1.25*10000 = 53500
    assert.equal(weightedTokens(b, defaults), 53_500);
    // Raw cache-read share of volume ≈ 70.6%; its share of the WEIGHTED total:
    const cacheReadWeightedShare = (DEFAULT_BURN_WEIGHT_CACHE_READ * 60_000) / 53_500;
    assert.ok(cacheReadWeightedShare < 0.15, "cache-read shrinks from ~70% of volume to ~11% of burn");
    // Cache-write share of volume ≈ 11.8%; of the WEIGHTED total:
    const cacheWriteWeightedShare = (DEFAULT_BURN_WEIGHT_CACHE_CREATION * 10_000) / 53_500;
    assert.ok(cacheWriteWeightedShare > 0.2, "cache-write grows from ~12% of volume to ~23% of burn");
  });
});

// ---------------------------------------------------------------------------
// The unit suites below moved here VERBATIM from test/usage-tracker.test.mts
// (issue #4785): their subjects are the pure functions this file's module
// under test exports. They are top-level describes with their own hooks (the
// pure suites need none), so they never piggyback on another suite's
// lifecycle. Bodies are unchanged — only the nesting level was.
// ---------------------------------------------------------------------------

describe("parseUsageLine", () => {
  test("returns null on malformed JSON", () => {
    assert.equal(parseUsageLine("{not json"), null);
  });

  test("skips non-assistant lines without usage block", () => {
    const line = JSON.stringify({
      type: "user",
      timestamp: "2026-05-25T00:00:00Z",
      message: { role: "user" },
    });
    assert.equal(parseUsageLine(line), "skip");
  });

  test("skips lines without timestamp", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { usage: { input_tokens: 1 } },
    });
    assert.equal(parseUsageLine(line), "skip");
  });

  test("skips lines with all-zero token counts", () => {
    const line = assistantLine("2026-05-25T00:00:00Z", {});
    assert.equal(parseUsageLine(line), "skip");
  });

  test("parses standard usage block (input + output + cache reads + cache writes)", () => {
    const line = assistantLine("2026-05-25T12:00:00Z", {
      in: 100,
      out: 200,
      cacheRead: 300,
      cacheCreation: 400,
    });
    const result = parseUsageLine(line);
    assert.ok(result !== null && result !== "skip");
    assert.equal(result.tokens.input, 100);
    assert.equal(result.tokens.output, 200);
    assert.equal(result.tokens.cacheRead, 300);
    assert.equal(result.tokens.cacheCreation, 400);
    assert.equal(result.tokens.total, 1000);
    assert.equal(result.tsMs, Date.parse("2026-05-25T12:00:00Z"));
  });

  test("treats missing token fields as zero (not NaN)", () => {
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-05-25T12:00:00Z",
      message: { usage: { output_tokens: 50 } },
    });
    const result = parseUsageLine(line);
    assert.ok(result !== null && result !== "skip");
    assert.equal(result.tokens.input, 0);
    assert.equal(result.tokens.output, 50);
    assert.equal(result.tokens.total, 50);
  });

  test("surfaces the model string when present", () => {
    const line = assistantLine("2026-05-25T12:00:00Z", { in: 10 }, "claude-opus-4-7");
    const result = parseUsageLine(line);
    assert.ok(result !== null && result !== "skip");
    assert.equal(result.model, "claude-opus-4-7");
  });

  test("model defaults to empty string when absent", () => {
    const line = assistantLine("2026-05-25T12:00:00Z", { in: 10 });
    const result = parseUsageLine(line);
    assert.ok(result !== null && result !== "skip");
    assert.equal(result.model, "");
  });
});

describe("modelToFamily", () => {
  test("maps observed opus/sonnet/haiku strings by prefix", () => {
    assert.equal(modelToFamily("claude-opus-4-6"), "opus");
    assert.equal(modelToFamily("claude-opus-4-7"), "opus");
    assert.equal(modelToFamily("claude-sonnet-4-6"), "sonnet");
    assert.equal(modelToFamily("claude-haiku-4-5"), "haiku");
  });

  test("maps claude-fable strings into the opus (frontier) family", () => {
    assert.equal(modelToFamily("claude-fable-5"), "opus");
    assert.equal(modelToFamily("claude-fable-5[1m]"), "opus");
  });

  test("is case-insensitive on the prefix", () => {
    assert.equal(modelToFamily("Claude-Opus-4-7"), "opus");
  });

  test("falls back to unknown for non-claude / synthetic / missing strings", () => {
    assert.equal(modelToFamily("<synthetic>"), "unknown");
    assert.equal(modelToFamily("gpt-5.5"), "unknown");
    assert.equal(modelToFamily(""), "unknown");
    assert.equal(modelToFamily(null), "unknown");
    assert.equal(modelToFamily(undefined), "unknown");
  });
});

describe("cacheHitRatio", () => {
  // Formula: cacheRead / (cacheRead + cacheCreation + input).
  // Output tokens are NEVER in the denominator.

  test("all-cache-read → ratio = 1", () => {
    // Pure cache reads with no creation and no fresh input: every
    // cache-eligible token was a hit.
    const ratio = cacheHitRatio(breakdown({ cacheRead: 1000, output: 500 }));
    assert.equal(ratio, 1);
  });

  test("all-uncached-input → ratio = 0", () => {
    const ratio = cacheHitRatio(breakdown({ input: 1000, output: 500 }));
    assert.equal(ratio, 0);
  });

  test("mixed-realistic case → cacheRead / (cacheRead + cacheCreation + input)", () => {
    // 800 read, 100 created, 100 fresh input, 1000 output (excluded).
    // 800 / (800 + 100 + 100) = 0.8
    const ratio = cacheHitRatio(
      breakdown({ cacheRead: 800, cacheCreation: 100, input: 100, output: 1000 }),
    );
    assert.equal(ratio, 0.8);
  });

  test("zero-total → ratio = 0 (no division by zero)", () => {
    const ratio = cacheHitRatio(breakdown({}));
    assert.equal(ratio, 0);
    assert.ok(Number.isFinite(ratio));
  });

  test("output tokens are NOT in the denominator", () => {
    // Same input/cacheRead, wildly different output: ratio must not move.
    const a = cacheHitRatio(breakdown({ cacheRead: 50, input: 50, output: 0 }));
    const b = cacheHitRatio(breakdown({ cacheRead: 50, input: 50, output: 1_000_000 }));
    assert.equal(a, 0.5);
    assert.equal(b, 0.5);
  });

  test("cacheCreation IS in the denominator (cache-warming cost counted)", () => {
    // 100 read vs 100 created, no input → 100 / 200 = 0.5, not 1.
    const ratio = cacheHitRatio(breakdown({ cacheRead: 100, cacheCreation: 100 }));
    assert.equal(ratio, 0.5);
  });

  test("ratio is always within the closed interval [0, 1]", () => {
    const cases: TokenBreakdown[] = [
      breakdown({}),
      breakdown({ cacheRead: 1 }),
      breakdown({ input: 1 }),
      breakdown({ cacheRead: 3, cacheCreation: 7, input: 13, output: 999 }),
    ];
    for (const c of cases) {
      const r = cacheHitRatio(c);
      assert.ok(r >= 0 && r <= 1, `ratio ${r} out of [0,1] for ${JSON.stringify(c)}`);
    }
  });
});

describe("projectResetWindow", () => {
  const D7 = 7 * 86_400_000;

  test("now exactly on the anchor: current=anchor, next=anchor+7d", () => {
    const anchor = Date.parse("2026-06-01T00:00:00Z");
    const w = projectResetWindow(anchor, anchor);
    assert.equal(w.currentMs, anchor);
    assert.equal(w.nextMs, anchor + D7);
  });

  test("now mid-window: snaps back to the most recent boundary", () => {
    const anchor = Date.parse("2026-06-01T00:00:00Z");
    const now = anchor + 3 * 86_400_000; // 3 days in
    const w = projectResetWindow(anchor, now);
    assert.equal(w.currentMs, anchor);
    assert.equal(w.nextMs, anchor + D7);
  });

  test("projects forward across MULTIPLE 7d periods", () => {
    const anchor = Date.parse("2026-06-01T00:00:00Z");
    // ~23 days later → 3 full weeks elapsed (k=3).
    const now = anchor + 23 * 86_400_000;
    const w = projectResetWindow(anchor, now);
    assert.equal(w.currentMs, anchor + 3 * D7);
    assert.equal(w.nextMs, anchor + 4 * D7);
    assert.ok(w.currentMs <= now && now < w.nextMs);
  });

  test("anchor in the FUTURE: k is negative, current is still <= now", () => {
    const anchor = Date.parse("2026-06-15T00:00:00Z");
    const now = Date.parse("2026-06-01T00:00:00Z"); // 14 days before anchor
    const w = projectResetWindow(anchor, now);
    // k = floor(-14d / 7d) = -2 → current = anchor - 14d = 2026-06-01
    assert.equal(w.currentMs, anchor - 2 * D7);
    assert.equal(w.nextMs, anchor - 1 * D7);
    assert.ok(w.currentMs <= now && now < w.nextMs);
  });
});

describe("parseObservedResetMs", () => {
  test("returns null on malformed JSON", () => {
    assert.equal(parseObservedResetMs("{nope"), null);
  });

  test("returns null when no reset field present", () => {
    assert.equal(
      parseObservedResetMs(JSON.stringify({ timestamp: "2026-06-01T00:00:00Z", message: {} })),
      null,
    );
  });

  test("reads message.usage.resets_at (ISO)", () => {
    const line = JSON.stringify({
      message: { usage: { resets_at: "2026-06-02T00:00:00Z" } },
    });
    assert.equal(parseObservedResetMs(line), Date.parse("2026-06-02T00:00:00Z"));
  });

  test("reads message.rate_limit.resets_at (ISO)", () => {
    const line = JSON.stringify({
      message: { rate_limit: { resets_at: "2026-06-03T12:00:00Z" } },
    });
    assert.equal(parseObservedResetMs(line), Date.parse("2026-06-03T12:00:00Z"));
  });

  test("reads top-level usageLimitResetTime", () => {
    const line = JSON.stringify({ usageLimitResetTime: "2026-06-04T06:00:00Z" });
    assert.equal(parseObservedResetMs(line), Date.parse("2026-06-04T06:00:00Z"));
  });

  test("coerces numeric epoch-SECONDS to ms", () => {
    const secs = Math.floor(Date.parse("2026-06-05T00:00:00Z") / 1000);
    const line = JSON.stringify({ resetsAt: secs });
    assert.equal(parseObservedResetMs(line), secs * 1000);
  });

  test("coerces numeric epoch-MS as-is", () => {
    const ms = Date.parse("2026-06-06T00:00:00Z");
    const line = JSON.stringify({ reset_at: ms });
    assert.equal(parseObservedResetMs(line), ms);
  });
});

describe("weightedTokens helper", () => {
  test("at all-1.0 category weights reduces exactly to .total", () => {
    const b = breakdown({ input: 100, output: 200, cacheRead: 5000, cacheCreation: 50 });
    assert.equal(
      weightedTokens(b, { input: 1, output: 1, cacheRead: 1, cacheCreation: 1 }),
      b.total,
    );
  });

  test("weights each of the four categories at its configured multiplier (issue #3825)", () => {
    const b = breakdown({ input: 100, output: 200, cacheRead: 1000, cacheCreation: 50 });
    // 1*100 + 5*200 + 1.25*50 + 0.1*1000 = 100 + 1000 + 62.5 + 100 = 1262.5
    assert.equal(
      weightedTokens(b, { input: 1, output: 5, cacheRead: 0.1, cacheCreation: 1.25 }),
      1262.5,
    );
  });

  test("a 0 cacheRead weight drops cacheRead entirely", () => {
    const b = breakdown({ input: 100, output: 200, cacheRead: 9999, cacheCreation: 50 });
    // 1*100 + 1*200 + 1*50 + 0*9999 = 350
    assert.equal(
      weightedTokens(b, { input: 1, output: 1, cacheRead: 0, cacheCreation: 1 }),
      350,
    );
  });
});

describe("parseSessionLimitReset (issue #1089)", () => {
  // 2026-06-06 12:00:00 PDT == 19:00:00Z (PDT is UTC-7 in June).
  const nowMs = Date.parse("2026-06-06T19:00:00.000Z");

  test("parses the real CLI/journal line and resolves to a future instant", () => {
    const line =
      "Jun 06 14:41:18 gabenuc env[1522365]: You've hit your session limit · resets 4:40pm (America/Los_Angeles)";
    const ms = parseSessionLimitReset(line, nowMs);
    assert.ok(ms !== null);
    // 4:40pm PDT on 2026-06-06 == 23:40:00Z, which is after nowMs (19:00Z).
    assert.equal(new Date(ms!).toISOString(), "2026-06-06T23:40:00.000Z");
    assert.ok(ms! > nowMs);
  });

  test("a wall-clock time already passed today resolves to tomorrow", () => {
    // 9:00am PDT on 2026-06-06 == 16:00Z, BEFORE nowMs (19:00Z) → next day.
    const line = "You've hit your session limit · resets 9:00am (America/Los_Angeles)";
    const ms = parseSessionLimitReset(line, nowMs);
    assert.ok(ms !== null);
    assert.equal(new Date(ms!).toISOString(), "2026-06-07T16:00:00.000Z");
  });

  test("tolerates AM/PM casing and a missing-minutes form", () => {
    const ms = parseSessionLimitReset(
      "hit your session limit · resets 5PM (America/Los_Angeles)",
      nowMs,
    );
    assert.ok(ms !== null);
    assert.equal(new Date(ms!).toISOString(), "2026-06-07T00:00:00.000Z"); // 5pm PDT
  });

  test("12am/12pm boundary handling", () => {
    const noon = parseSessionLimitReset(
      "hit your session limit · resets 12:00pm (America/Los_Angeles)",
      nowMs,
    );
    assert.equal(new Date(noon!).toISOString(), "2026-06-07T19:00:00.000Z"); // next-day noon PDT
    const midnight = parseSessionLimitReset(
      "hit your session limit · resets 12:00am (America/Los_Angeles)",
      nowMs,
    );
    assert.equal(new Date(midnight!).toISOString(), "2026-06-07T07:00:00.000Z"); // midnight PDT
  });

  test("a UTC timezone resolves with no offset", () => {
    const ms = parseSessionLimitReset(
      "hit your session limit · resets 11:30pm (UTC)",
      nowMs,
    );
    assert.equal(new Date(ms!).toISOString(), "2026-06-06T23:30:00.000Z");
  });

  test("non-session-limit / generic lines return null", () => {
    assert.equal(parseSessionLimitReset("ordinary log line", nowMs), null);
    assert.equal(parseSessionLimitReset("rate_limit resets soon", nowMs), null);
    assert.equal(parseSessionLimitReset("", nowMs), null);
  });

  test("an unknown timezone returns null (no throw)", () => {
    assert.equal(
      parseSessionLimitReset(
        "hit your session limit · resets 4:40pm (Not/AZone)",
        nowMs,
      ),
      null,
    );
  });

  test("an out-of-range hour returns null", () => {
    assert.equal(
      parseSessionLimitReset(
        "hit your session limit · resets 13:40pm (America/Los_Angeles)",
        nowMs,
      ),
      null,
    );
  });
});

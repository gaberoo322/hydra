import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  rollupCrossRunTrend,
  emptyCrossRunTrend,
  RANKING_SOUND_THRESHOLD,
  UNATTRIBUTABLE_CLASS_KEY,
  type CrossRunTrend,
} from "../src/aggregators/cross-run-trend.ts";
import type { DispatchOutcomeRecord } from "../src/redis/dispatch-outcomes.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WIN = { windowStartMs: 1_000, windowEndMs: 9_000 };

/** Build a record with sensible dark-tolerant defaults; override per-case. */
function rec(over: Partial<DispatchOutcomeRecord>): DispatchOutcomeRecord {
  return {
    cycleId: "c1",
    runIdPrefix: "abc12345",
    turn: 1,
    className: "dev_orch",
    skill: "hydra-dev",
    outcome: "merged",
    tokens: 100,
    durationMs: 60_000,
    escalationAttempt: null,
    escalatedModel: null,
    recordedAt: 5_000,
    anchorReference: null,
    ...over,
  };
}

function rowByClass(t: CrossRunTrend, className: string) {
  return t.byClass.find((r) => r.className === className);
}

// ---------------------------------------------------------------------------
// rollupCrossRunTrend
// ---------------------------------------------------------------------------

describe("rollupCrossRunTrend — three-way bucketing", () => {
  test("completed and succeeded bucket as merged (via bucketCycleStatus, no second status set)", () => {
    const t = rollupCrossRunTrend(
      [
        rec({ cycleId: "a", outcome: "merged" }),
        rec({ cycleId: "b", outcome: "completed" }),
        rec({ cycleId: "c", outcome: "succeeded" }),
      ],
      WIN,
    );
    const dev = rowByClass(t, "dev_orch");
    assert.ok(dev);
    assert.equal(dev!.outcomes.merged, 3);
    assert.equal(dev!.outcomes.failed, 0);
    assert.equal(dev!.outcomes.unaccounted, 0);
    assert.equal(dev!.dispatches, 3);
  });

  test("failed-family statuses bucket as failed", () => {
    const t = rollupCrossRunTrend(
      [
        rec({ cycleId: "a", outcome: "failed" }),
        rec({ cycleId: "b", outcome: "abandoned" }),
        rec({ cycleId: "c", outcome: "timed-out" }),
        rec({ cycleId: "d", outcome: "TIMEOUT" /* case-insensitive */ }),
      ],
      WIN,
    );
    const dev = rowByClass(t, "dev_orch");
    assert.ok(dev);
    assert.equal(dev!.outcomes.failed, 4);
    assert.equal(dev!.outcomes.merged, 0);
    assert.equal(dev!.outcomes.unaccounted, 0);
  });

  test("null / unknown / in-flight outcomes bucket as unaccounted (three-way preserved)", () => {
    const t = rollupCrossRunTrend(
      [
        rec({ cycleId: "a", outcome: "merged" }),
        rec({ cycleId: "b", outcome: "failed" }),
        rec({ cycleId: "c", outcome: "" }),
        rec({ cycleId: "d", outcome: "in-flight" }),
        rec({ cycleId: "e", outcome: "mystery-status" }),
      ],
      WIN,
    );
    const dev = rowByClass(t, "dev_orch");
    assert.ok(dev);
    assert.equal(dev!.outcomes.merged, 1);
    assert.equal(dev!.outcomes.failed, 1);
    assert.equal(dev!.outcomes.unaccounted, 3);
  });
});

describe("rollupCrossRunTrend — identity invariant", () => {
  test("dispatches == merged + failed + unaccounted for EVERY byClass row (mixed fixture)", () => {
    const t = rollupCrossRunTrend(
      [
        rec({ cycleId: "a", className: "dev_orch", outcome: "merged", tokens: 100 }),
        rec({ cycleId: "b", className: "dev_orch", outcome: "completed", tokens: 50 }),
        rec({ cycleId: "c", className: "dev_orch", outcome: "failed", tokens: 200 }),
        rec({ cycleId: "d", className: "dev_orch", outcome: "weird", tokens: null }),
        rec({ cycleId: "e", className: "qa_orch", outcome: "abandoned", tokens: 75 }),
        rec({ cycleId: "f", className: "qa_orch", outcome: "merged", tokens: 30 }),
        rec({ cycleId: "g", className: null, outcome: "merged", tokens: 500 }),
        rec({ cycleId: "h", className: null, outcome: "unknown", tokens: null }),
      ],
      WIN,
    );
    for (const row of t.byClass) {
      assert.equal(
        row.dispatches,
        row.outcomes.merged + row.outcomes.failed + row.outcomes.unaccounted,
        `identity failed for ${row.className}`,
      );
    }
    // sanity: three class rows including unattributable
    assert.deepEqual(
      t.byClass.map((r) => r.className).sort(),
      ["dev_orch", "qa_orch", UNATTRIBUTABLE_CLASS_KEY],
    );
  });
});

describe("rollupCrossRunTrend — unattributable first-class row", () => {
  test("null-className records collapse into a first-class 'unattributable' row, never dropped", () => {
    const t = rollupCrossRunTrend(
      [
        rec({ cycleId: "a", className: "dev_orch", outcome: "merged", tokens: 10 }),
        rec({ cycleId: "b", className: null, skill: null, outcome: "merged", tokens: 999 }),
        rec({ cycleId: "c", className: null, skill: null, outcome: "failed", tokens: 1 }),
      ],
      WIN,
    );
    const unattr = rowByClass(t, UNATTRIBUTABLE_CLASS_KEY);
    assert.ok(unattr, "unattributable row must exist");
    assert.equal(unattr!.skill, null);
    assert.equal(unattr!.dispatches, 2);
    assert.equal(unattr!.outcomes.merged, 1);
    assert.equal(unattr!.outcomes.failed, 1);
    assert.equal(unattr!.tokens, 1000);
  });

  test("no null-className records → no unattributable row", () => {
    const t = rollupCrossRunTrend(
      [rec({ cycleId: "a", className: "dev_orch" })],
      WIN,
    );
    assert.equal(rowByClass(t, UNATTRIBUTABLE_CLASS_KEY), undefined);
  });
});

describe("rollupCrossRunTrend — tokensPerMerged", () => {
  test("counts completed as merged (per MERGED_STATUSES) and averages over the merged count", () => {
    // two merged (100 + 200 tokens) + one completed (300) → 3 merged, 600 tokens → 200 each
    const t = rollupCrossRunTrend(
      [
        rec({ cycleId: "a", outcome: "merged", tokens: 100 }),
        rec({ cycleId: "b", outcome: "merged", tokens: 200 }),
        rec({ cycleId: "c", outcome: "completed", tokens: 300 }),
        rec({ cycleId: "d", outcome: "failed", tokens: 9999 }),
      ],
      WIN,
    );
    const dev = rowByClass(t, "dev_orch");
    assert.ok(dev);
    assert.equal(dev!.outcomes.merged, 3);
    assert.equal(dev!.tokensPerMerged, 200); // 600 / 3, rounded
  });

  test("0 when the class has no merged dispatches", () => {
    const t = rollupCrossRunTrend(
      [rec({ cycleId: "a", outcome: "failed", tokens: 500 })],
      WIN,
    );
    const dev = rowByClass(t, "dev_orch");
    assert.ok(dev);
    assert.equal(dev!.tokensPerMerged, 0);
  });
});

describe("rollupCrossRunTrend — coverage (both attribution planes)", () => {
  test("records-read vs index-members (run attribution) AND class-attributed records + token share", () => {
    const t = rollupCrossRunTrend(
      [
        // run-attributed + class-attributed
        rec({ cycleId: "a", runIdPrefix: "abc12345", className: "dev_orch", tokens: 100 }),
        // run-attributed + class-attributed
        rec({ cycleId: "b", runIdPrefix: "def67890", className: "qa_orch", tokens: 200 }),
        // NOT run-attributed (null prefix) but class-attributed
        rec({ cycleId: "c", runIdPrefix: null, className: "dev_orch", tokens: 50 }),
        // neither (bare-uuid family): null prefix + null class
        rec({ cycleId: "d", runIdPrefix: null, className: null, tokens: 650 }),
      ],
      WIN,
    );
    const c = t.coverage;
    assert.equal(c.recordsRead, 4);
    assert.equal(c.indexMembers, 2); // only a & b have a runIdPrefix
    assert.equal(c.attributionRate, 0.5); // 2/4
    assert.equal(c.classAttributedRecords, 3); // a, b, c have a className
    assert.equal(c.totalTokens, 1000);
    assert.equal(c.classAttributedTokens, 350); // 100+200+50 — d (null class) excluded
    assert.equal(c.classAttributedTokenShare, 0.35); // 350/1000
  });

  test("rankingSound is false below the threshold, true at/above it", () => {
    // 40% class-attributed token share → not sound
    const low = rollupCrossRunTrend(
      [
        rec({ cycleId: "a", className: "dev_orch", tokens: 40 }),
        rec({ cycleId: "b", className: null, tokens: 60 }),
      ],
      WIN,
    );
    assert.equal(low.coverage.classAttributedTokenShare, 0.4);
    assert.equal(low.coverage.rankingSound, false);

    // exactly 50% → sound (>= threshold)
    const at = rollupCrossRunTrend(
      [
        rec({ cycleId: "a", className: "dev_orch", tokens: 50 }),
        rec({ cycleId: "b", className: null, tokens: 50 }),
      ],
      WIN,
    );
    assert.equal(at.coverage.classAttributedTokenShare, 0.5);
    assert.equal(at.coverage.rankingSound, true);

    // 90% → sound
    const high = rollupCrossRunTrend(
      [
        rec({ cycleId: "a", className: "dev_orch", tokens: 90 }),
        rec({ cycleId: "b", className: null, tokens: 10 }),
      ],
      WIN,
    );
    assert.equal(high.coverage.rankingSound, true);

    // the exported threshold is the documented 0.5
    assert.equal(RANKING_SOUND_THRESHOLD, 0.5);
  });
});

describe("rollupCrossRunTrend — byRun", () => {
  test("groups by runIdPrefix; excludes null-prefix records (no run identity)", () => {
    const t = rollupCrossRunTrend(
      [
        rec({ cycleId: "a", runIdPrefix: "abc12345", outcome: "merged", tokens: 100 }),
        rec({ cycleId: "b", runIdPrefix: "abc12345", outcome: "failed", tokens: 200 }),
        rec({ cycleId: "c", runIdPrefix: "def67890", outcome: "merged", tokens: 50 }),
        // null prefix — excluded from byRun entirely
        rec({ cycleId: "d", runIdPrefix: null, outcome: "merged", tokens: 9999 }),
      ],
      WIN,
    );
    assert.deepEqual(
      t.byRun.map((r) => r.runIdPrefix).sort(),
      ["abc12345", "def67890"],
    );
    const abc = t.byRun.find((r) => r.runIdPrefix === "abc12345")!;
    assert.equal(abc.dispatches, 2);
    assert.equal(abc.tokens, 300);
    // merged 1 / (merged 1 + failed 1) = 0.5, terminal-only
    assert.equal(abc.mergedRate, 0.5);
  });

  test("mergedRate excludes unaccounted from the denominator (terminal-only)", () => {
    const t = rollupCrossRunTrend(
      [
        rec({ cycleId: "a", runIdPrefix: "abc12345", outcome: "merged" }),
        rec({ cycleId: "b", runIdPrefix: "abc12345", outcome: "in-flight" }),
        rec({ cycleId: "c", runIdPrefix: "abc12345", outcome: "weird" }),
      ],
      WIN,
    );
    const abc = t.byRun.find((r) => r.runIdPrefix === "abc12345")!;
    // 3 dispatches, but only 1 terminal (merged); 2 unaccounted excluded from rate
    assert.equal(abc.dispatches, 3);
    assert.equal(abc.mergedRate, 1); // 1 / (1 + 0)
  });

  test("mergedRate is 0 when the run has no terminal dispatches", () => {
    const t = rollupCrossRunTrend(
      [rec({ cycleId: "a", runIdPrefix: "abc12345", outcome: "in-flight" })],
      WIN,
    );
    assert.equal(t.byRun[0].mergedRate, 0);
  });
});

describe("rollupCrossRunTrend — window + determinism", () => {
  test("window bounds carried through verbatim", () => {
    const t = rollupCrossRunTrend([rec({ cycleId: "a" })], WIN);
    assert.equal(t.windowStartMs, WIN.windowStartMs);
    assert.equal(t.windowEndMs, WIN.windowEndMs);
  });

  test("byClass sorted by descending tokens, then className asc", () => {
    const t = rollupCrossRunTrend(
      [
        rec({ cycleId: "a", className: "dev_orch", tokens: 10 }),
        rec({ cycleId: "b", className: "qa_orch", tokens: 500 }),
        rec({ cycleId: "c", className: "arch_orch", tokens: 500 }),
      ],
      WIN,
    );
    // 500-tied pair sorts arch_orch before qa_orch; then 10-token dev_orch
    assert.deepEqual(
      t.byClass.map((r) => r.className),
      ["arch_orch", "qa_orch", "dev_orch"],
    );
  });

  test("rates are never NaN on an empty fold", () => {
    const t = rollupCrossRunTrend([], WIN);
    assert.equal(t.coverage.attributionRate, 0);
    assert.equal(t.coverage.classAttributedTokenShare, 0);
    assert.equal(t.coverage.rankingSound, false);
    assert.deepEqual(t.byClass, []);
    assert.deepEqual(t.byRun, []);
  });
});

describe("rollupCrossRunTrend — dark-tolerance", () => {
  test("null tokens contribute 0 to every token sum, never NaN", () => {
    const t = rollupCrossRunTrend(
      [
        rec({ cycleId: "a", className: "dev_orch", tokens: null, outcome: "merged" }),
        rec({ cycleId: "b", className: "dev_orch", tokens: 200, outcome: "merged" }),
      ],
      WIN,
    );
    const dev = rowByClass(t, "dev_orch");
    assert.ok(dev);
    assert.equal(dev!.tokens, 200);
    assert.equal(dev!.tokensPerMerged, 100); // 200 / 2 merged
    assert.equal(t.coverage.totalTokens, 200);
    assert.equal(t.coverage.classAttributedTokens, 200);
  });

  test("malformed slots in the array are skipped, not folded", () => {
    const t = rollupCrossRunTrend(
      [
        null as unknown as DispatchOutcomeRecord,
        rec({ cycleId: "a", className: "dev_orch" }),
      ],
      WIN,
    );
    assert.equal(t.coverage.recordsRead, 1); // the null slot skipped
  });
});

describe("emptyCrossRunTrend", () => {
  test("valid zero shape, NOT ranking-sound, carries the window", () => {
    const e = emptyCrossRunTrend(WIN);
    assert.equal(e.windowStartMs, WIN.windowStartMs);
    assert.equal(e.windowEndMs, WIN.windowEndMs);
    assert.deepEqual(e.byClass, []);
    assert.deepEqual(e.byRun, []);
    assert.equal(e.coverage.recordsRead, 0);
    assert.equal(e.coverage.rankingSound, false);
  });
});

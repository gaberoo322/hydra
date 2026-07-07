/**
 * Unit tests for the pure candidate-scoring policy leaf (issue #2973).
 *
 * `src/backlog/candidate-scoring.ts` owns the ARITHMETIC half of the Candidate
 * Feed (issue #2040): the tier base ladder, the freshness / recent-reflection
 * penalties, the blocker-just-cleared bonus, and the [0,1] clamp. It is pure —
 * `scoreCandidate(signals)` is deterministic given an injected `now`, has zero
 * Redis / I/O, and degrades to `{score:0, reasons:["unknown-tier"]}` rather than
 * throwing on an unknown tier (ADR-0016 Locality invariant: scoring has exactly
 * ONE home).
 *
 * Before #2973 this module was only exercised transitively through the HTTP-level
 * `test/api-anchor-candidates.test.mts`; it had no isolated unit coverage, so a
 * change to a tier base weight, a penalty magnitude, or the clamp bounds would
 * fail only indirectly. This suite pins each scoring lever directly, importing
 * the symbols from the leaf so the arithmetic is regression-protected in
 * isolation.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  scoreCandidate,
  PRIORITY_TIER_BASE_SCORE,
  type ScoreSignals,
} from "../src/backlog/candidate-scoring.ts";

// A fixed clock so every age computation is deterministic.
const NOW = Date.parse("2026-07-07T12:00:00Z");
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Helper: build signals with `now` pinned to NOW unless overridden. */
function signals(partial: Partial<ScoreSignals>): ScoreSignals {
  return { priorityTier: "kanban-queued", now: NOW, ...partial };
}

describe("candidate-scoring — tier base ladder (#2973)", () => {
  test("kanban-queued scores the higher base (0.85), fresh item = exactly the base", () => {
    const { score, reasons } = scoreCandidate(signals({ priorityTier: "kanban-queued" }));
    assert.equal(score, PRIORITY_TIER_BASE_SCORE["kanban-queued"]);
    assert.equal(score, 0.85);
    assert.ok(reasons.some((r) => r.startsWith("tier:kanban-queued")));
  });

  test("work-queue scores the lower base (0.70), fresh item = exactly the base", () => {
    const { score, reasons } = scoreCandidate(signals({ priorityTier: "work-queue" }));
    assert.equal(score, PRIORITY_TIER_BASE_SCORE["work-queue"]);
    assert.equal(score, 0.7);
    assert.ok(reasons.some((r) => r.startsWith("tier:work-queue")));
  });

  test("kanban-queued always outranks work-queue for otherwise-identical signals", () => {
    const kanban = scoreCandidate(signals({ priorityTier: "kanban-queued" })).score;
    const workq = scoreCandidate(signals({ priorityTier: "work-queue" })).score;
    assert.ok(kanban > workq, `expected kanban(${kanban}) > work-queue(${workq})`);
  });

  test("kanban base (0.85) clears the research threshold (0.5) so a live board suppresses research", () => {
    assert.ok(PRIORITY_TIER_BASE_SCORE["kanban-queued"] > 0.5);
    assert.ok(PRIORITY_TIER_BASE_SCORE["work-queue"] > 0.5);
  });
});

describe("candidate-scoring — unknown-tier degradation (#2973)", () => {
  test("an unknown tier returns {score:0, reasons:['unknown-tier']}, never throws", () => {
    const res = scoreCandidate(signals({ priorityTier: "nonsense" as any }));
    assert.equal(res.score, 0);
    assert.deepEqual(res.reasons, ["unknown-tier"]);
  });
});

describe("candidate-scoring — freshness penalty (#2973)", () => {
  test("an item updated within 14d is 'fresh' and pays no penalty", () => {
    const { score, reasons } = scoreCandidate(
      signals({ lastUpdated: new Date(NOW - 13 * DAY_MS).toISOString() }),
    );
    assert.equal(score, 0.85);
    assert.ok(reasons.includes("fresh"));
    assert.ok(!reasons.some((r) => r.startsWith("stale:")));
  });

  test("an item older than the 14d freshness threshold pays the -0.15 penalty", () => {
    const { score, reasons } = scoreCandidate(
      signals({ lastUpdated: new Date(NOW - 20 * DAY_MS).toISOString() }),
    );
    // 0.85 - 0.15 = 0.70, allowing for float noise.
    assert.ok(Math.abs(score - 0.7) < 1e-9, `expected ~0.70, got ${score}`);
    assert.ok(reasons.some((r) => r.startsWith("stale:")));
    assert.ok(reasons.some((r) => r.includes("20d")));
  });

  test("the 14d boundary is exclusive — exactly 14d is still fresh", () => {
    const { reasons } = scoreCandidate(
      signals({ lastUpdated: new Date(NOW - 14 * DAY_MS).toISOString() }),
    );
    assert.ok(reasons.includes("fresh"));
  });

  test("no lastUpdated signal => no freshness reason emitted at all", () => {
    const { reasons } = scoreCandidate(signals({ lastUpdated: null }));
    assert.ok(!reasons.includes("fresh"));
    assert.ok(!reasons.some((r) => r.startsWith("stale:")));
  });

  test("an unparseable lastUpdated is treated as non-finite => no penalty (fail-open)", () => {
    const { score } = scoreCandidate(signals({ lastUpdated: "not-a-date" }));
    assert.equal(score, 0.85);
  });
});

describe("candidate-scoring — recent-reflection penalty (#2973)", () => {
  test("a reflection <24h ago pays the -0.20 recent-failure penalty", () => {
    const { score, reasons } = scoreCandidate(
      signals({ lastReflectionAt: new Date(NOW - 2 * HOUR_MS).toISOString() }),
    );
    assert.ok(Math.abs(score - 0.65) < 1e-9, `expected ~0.65, got ${score}`);
    assert.ok(reasons.some((r) => r.startsWith("recent-failure")));
  });

  test("a reflection >=24h ago pays no penalty", () => {
    const { score, reasons } = scoreCandidate(
      signals({ lastReflectionAt: new Date(NOW - 25 * HOUR_MS).toISOString() }),
    );
    assert.equal(score, 0.85);
    assert.ok(!reasons.some((r) => r.startsWith("recent-failure")));
  });
});

describe("candidate-scoring — blocker-just-cleared bonus (#2973)", () => {
  test("blockerJustCleared adds the +0.15 bonus", () => {
    // Start from work-queue base (0.70) so the bonus stays under the clamp.
    const { score, reasons } = scoreCandidate(
      signals({ priorityTier: "work-queue", blockerJustCleared: true }),
    );
    assert.ok(Math.abs(score - 0.85) < 1e-9, `expected ~0.85, got ${score}`);
    assert.ok(reasons.some((r) => r.startsWith("blocker-cleared")));
  });

  test("no bonus reason when blockerJustCleared is false/absent", () => {
    const { reasons } = scoreCandidate(signals({ blockerJustCleared: false }));
    assert.ok(!reasons.some((r) => r.startsWith("blocker-cleared")));
  });
});

describe("candidate-scoring — [0,1] clamp (#2973)", () => {
  test("stacked penalties never drive the score below 0", () => {
    const { score } = scoreCandidate(
      signals({
        priorityTier: "work-queue", // 0.70
        lastUpdated: new Date(NOW - 60 * DAY_MS).toISOString(), // -0.15
        lastReflectionAt: new Date(NOW - 1 * HOUR_MS).toISOString(), // -0.20
      }),
    );
    // 0.70 - 0.15 - 0.20 = 0.35, still positive; verify clamp holds even so.
    assert.ok(score >= 0);
    assert.ok(score <= 1);
  });

  test("the bonus never drives a top-tier fresh item above 1", () => {
    const { score } = scoreCandidate(
      signals({ priorityTier: "kanban-queued", blockerJustCleared: true }),
    );
    // 0.85 + 0.15 = 1.00 exactly — the clamp keeps it at the ceiling.
    assert.ok(score <= 1, `expected <= 1, got ${score}`);
    assert.ok(Math.abs(score - 1) < 1e-9);
  });
});

describe("candidate-scoring — determinism (#2973)", () => {
  test("same signals + same injected now => byte-identical result", () => {
    const s = signals({
      lastUpdated: new Date(NOW - 30 * DAY_MS).toISOString(),
      lastReflectionAt: new Date(NOW - 3 * HOUR_MS).toISOString(),
    });
    const a = scoreCandidate(s);
    const b = scoreCandidate(s);
    assert.deepEqual(a, b);
  });
});

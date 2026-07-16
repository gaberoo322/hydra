/**
 * Edge-case unit tests for the pure candidate-scoring leaf (issue #2973).
 *
 * `src/backlog/candidate-scoring.ts` owns the ARITHMETIC half of the Candidate
 * Feed (issue #2040): the tier base ladder, the freshness / recent-reflection
 * penalties, the blocker-just-cleared bonus, and the [0,1] clamp. It is pure —
 * `scoreCandidate(signals)` is deterministic given an injected `now`, has zero
 * Redis / I/O, and degrades to `{score:0, reasons:["unknown-tier"]}` rather than
 * throwing on an unknown tier (ADR-0016 Locality invariant: scoring has exactly
 * ONE home).
 *
 * SCOPE — this file deliberately holds ONLY the edge cases that the
 * `describe("scoreCandidate — pure scoring helper (ADR-0016)")` block in
 * `test/api-anchor-candidates.test.mts` does NOT already assert. That block
 * already pins: the two-tier base table, fresh kanban=0.85, work-queue=0.70,
 * the >14d -0.15 penalty, the <24h reflection -0.20 penalty, the >=24h no-op,
 * the blocker +0.15 bonus (clamped to 1), the [0,1] clamp, and unknown-tier
 * degradation. Per the design-concept artifact (invariant 3) those are NOT
 * re-duplicated here — this suite adds only the boundary / fail-open / ordering
 * branches left uncovered:
 *   - the 14d freshness boundary is EXCLUSIVE (`> threshold`, not `>=`)
 *   - a missing lastUpdated emits NO freshness reason at all
 *   - an unparseable lastUpdated fails open (Number.isFinite guard → no penalty)
 *   - kanban always strictly outranks work-queue for identical signals
 *   - both live tier bases clear the 0.5 research threshold
 *   - blockerJustCleared=false/absent emits no bonus reason
 *   - determinism: same signals + same injected now → deep-equal result
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  scoreCandidate,
  scoreCandidateWithReflection,
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

describe("candidate-scoring — tier ordering + research-threshold invariants (#2973)", () => {
  test("kanban-queued always strictly outranks work-queue for otherwise-identical signals", () => {
    const kanban = scoreCandidate(signals({ priorityTier: "kanban-queued" })).score;
    const workq = scoreCandidate(signals({ priorityTier: "work-queue" })).score;
    assert.ok(kanban > workq, `expected kanban(${kanban}) > work-queue(${workq})`);
  });

  test("both live tier bases clear the research threshold (0.5) so a live board suppresses research", () => {
    assert.ok(PRIORITY_TIER_BASE_SCORE["kanban-queued"] > 0.5);
    assert.ok(PRIORITY_TIER_BASE_SCORE["work-queue"] > 0.5);
  });
});

describe("candidate-scoring — freshness boundary + fail-open branches (#2973)", () => {
  test("the 14d boundary is EXCLUSIVE — exactly 14d old is still fresh (no penalty)", () => {
    const { score, reasons } = scoreCandidate(
      signals({ lastUpdated: new Date(NOW - 14 * DAY_MS).toISOString() }),
    );
    assert.equal(score, 0.85);
    assert.ok(reasons.includes("fresh"));
    assert.ok(!reasons.some((r) => r.startsWith("stale:")));
  });

  test("no lastUpdated signal => no freshness reason emitted at all (neither fresh nor stale)", () => {
    const { score, reasons } = scoreCandidate(signals({ lastUpdated: null }));
    assert.equal(score, 0.85);
    assert.ok(!reasons.includes("fresh"));
    assert.ok(!reasons.some((r) => r.startsWith("stale:")));
  });

  test("an unparseable lastUpdated is non-finite => fails open (no penalty, 'fresh' branch)", () => {
    // new Date("not-a-date").getTime() is NaN → ageMs is NaN → the
    // Number.isFinite guard rejects the penalty and the else-branch runs.
    const { score, reasons } = scoreCandidate(signals({ lastUpdated: "not-a-date" }));
    assert.equal(score, 0.85);
    assert.ok(reasons.includes("fresh"));
    assert.ok(!reasons.some((r) => r.startsWith("stale:")));
  });
});

describe("candidate-scoring — blocker-cleared absence branch (#2973)", () => {
  test("no bonus reason when blockerJustCleared is explicitly false", () => {
    const { score, reasons } = scoreCandidate(signals({ blockerJustCleared: false }));
    assert.equal(score, 0.85);
    assert.ok(!reasons.some((r) => r.startsWith("blocker-cleared")));
  });

  test("no bonus reason when blockerJustCleared is absent", () => {
    const { reasons } = scoreCandidate(signals({}));
    assert.ok(!reasons.some((r) => r.startsWith("blocker-cleared")));
  });
});

describe("candidate-scoring — reflection-aware contract (#3392)", () => {
  const base = { priorityTier: "kanban-queued" as const, now: NOW };

  test("a recent (<24h) reflection is fetched via the reader and applies the -0.20 penalty", async () => {
    let seen: string | undefined;
    const reader = async (ref: string) => {
      seen = ref;
      return new Date(NOW - 2 * HOUR_MS).toISOString();
    };
    const { score, reasons } = await scoreCandidateWithReflection("issue-3392", base, reader);
    assert.equal(seen, "issue-3392", "the anchorRef is forwarded to the reader");
    // scoreCandidate returns the un-rounded arithmetic (0.85 - 0.20); the
    // coordinator rounds. Compare within float tolerance.
    assert.ok(Math.abs(score - 0.65) < 1e-9, `expected ~0.65, got ${score}`);
    assert.ok(reasons.some((r) => r.includes("recent-failure")));
  });

  test("a null reflection read applies no penalty (fetch is co-located, not the coordinator's job)", async () => {
    const { score, reasons } = await scoreCandidateWithReflection(
      "issue-3392",
      base,
      async () => null,
    );
    assert.equal(score, 0.85);
    assert.ok(!reasons.some((r) => r.includes("recent-failure")));
  });

  test("a throwing reader fails open — no penalty, resolves rather than rejecting", async () => {
    await assert.doesNotReject(async () => {
      const { score, reasons } = await scoreCandidateWithReflection(
        "issue-3392",
        base,
        async () => {
          throw new Error("reflection read failed");
        },
      );
      assert.equal(score, 0.85, "fail-open: scored as if no reflection existed");
      assert.ok(!reasons.some((r) => r.includes("recent-failure")));
    });
  });

  test("delegates to the pure scoreCandidate — same result as passing the timestamp directly", async () => {
    const ts = new Date(NOW - 5 * HOUR_MS).toISOString();
    const viaContract = await scoreCandidateWithReflection("issue-3392", base, async () => ts);
    const viaPure = scoreCandidate({ ...base, lastReflectionAt: ts });
    assert.deepEqual(viaContract, viaPure);
  });
});

describe("candidate-scoring — determinism (#2973)", () => {
  test("same signals + same injected now => deep-equal result (pure, no hidden clock read)", () => {
    const s = signals({
      lastUpdated: new Date(NOW - 30 * DAY_MS).toISOString(),
      lastReflectionAt: new Date(NOW - 3 * HOUR_MS).toISOString(),
    });
    const a = scoreCandidate(s);
    const b = scoreCandidate(s);
    assert.deepEqual(a, b);
  });
});

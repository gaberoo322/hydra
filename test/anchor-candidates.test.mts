/**
 * Feed-composition eligibility-guard coverage for the Candidate Feed (issue #3172).
 *
 * The deep module `src/anchor-candidates.ts` (`getCandidateFeed`) owns
 * enumeration + scoring + the four stateful eligibility guards behind one
 * interface (ADR-0016), and its injectable `deps` are the test surface. These
 * tests drive the feed end-to-end with stubbed deps (no Redis fixture) exactly
 * as `test/api-anchor-candidates.test.mts` does.
 *
 * SCOPE — this file deliberately holds ONLY the feed-level guard branches that
 * `test/api-anchor-candidates.test.mts` does NOT already assert. That file
 * already pins the happy-path of every guard: in-flight-PR fresh-suppress + its
 * excludeInFlight/stale/non-PR escape hatches, merged-by-cycle suppress + its
 * escape hatch + reader-fail-open, the inline-buildability and PR-deliverability
 * gates, terminal-marker suppression, the design-concept annotation
 * (present/absent/reader-throws), the operator-priority tiebreak, and the
 * research_recommended threshold. Per the CLAUDE.md "flip-then-add" ordering,
 * this suite adds only the guard BRANCHES left uncovered end-to-end:
 *
 *   In-flight-PR guard (isInFlightPR via the feed) — fail-open branches:
 *     - a `pr-<n>` claim with NO claimedAt is not suppressed
 *     - a `pr-<n>` claim with an unparseable claimedAt is not suppressed
 *     - the 30-min freshness boundary is EXCLUSIVE (exactly 30m ago resurfaces)
 *
 *   Blocker-just-cleared guard (isBlockerJustCleared via the feed) — negatives:
 *     - a still-"blocked" lane earns NO bonus even with a recent movedAt
 *     - a stale (>24h) unblock earns NO bonus
 *     - the 24h boundary is EXCLUSIVE (exactly 24h ago earns no bonus)
 *     - a missing blockedReason earns no bonus (never-blocked item)
 *
 *   Research-recommended guard (the RESEARCH_THRESHOLD=0.5 predicate):
 *     - an empty board flips research_recommended=true (top.length===0 arm)
 *     - a candidate sitting exactly AT 0.5 does NOT recommend research (strict <)
 *
 *   Feed composition / defaulting branches:
 *     - a throwing `loadLastReflectionAt` degrades that field, never drops the
 *       candidate (the reflection-reader sibling of the tested design-concept
 *       fail-open)
 *     - `limit` above MAX_LIMIT (50) is clamped
 *     - an invalid `limit` (0 / negative / non-finite) falls back to the default
 *     - `now` defaults to Date.now() when opts.now is omitted (a fresh item is
 *       still fresh under the real clock)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  getCandidateFeed,
  type CandidateFeedDeps,
} from "../src/anchor-candidates.ts";
import type { CandidateDesignConcept } from "../src/backlog/candidate-design-concept.ts";

const ABSENT_DC: CandidateDesignConcept = {
  present: false,
  isFresh: false,
  status: null,
  gateOk: false,
};

/**
 * Build a deps bundle with no candidates by default; override any field per
 * test. Mirrors the makeDeps helper in test/api-anchor-candidates.test.mts.
 */
function makeDeps(over: Partial<CandidateFeedDeps> = {}): CandidateFeedDeps {
  return {
    loadBacklog: async () => ({ inProgress: [], queued: [], backlog: [] }),
    getWorkQueueItems: async () => [],
    loadLastReflectionAt: async () => null,
    loadDesignConcept: async () => ABSENT_DC,
    loadMergedAnchorRefs: async () => new Set<string>(),
    ...over,
  };
}

const NOW = Date.UTC(2026, 6, 11, 12, 0, 0);
const MIN_MS = 60 * 1000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;
const isoAgo = (ms: number) => new Date(NOW - ms).toISOString();

// ---------------------------------------------------------------------------
// In-flight-PR guard — fail-open + freshness-boundary branches through the feed.
// The happy-path (fresh pr-<n> suppresses; stale/escape-hatch/non-pr surface)
// is already pinned in api-anchor-candidates.test.mts; these are the branches
// where the guard must NOT suppress because its inputs are incomplete.
// ---------------------------------------------------------------------------

describe("getCandidateFeed — in-flight-PR guard fail-open branches (#3172)", () => {
  test("a pr-<n> claim with NO claimedAt is not suppressed (fail-open)", async () => {
    const deps = makeDeps({
      loadBacklog: async () => ({
        inProgress: [{ id: 1, title: "PR claim, no timestamp", claimedBy: "pr-42", claimedAt: null, movedAt: isoAgo(0) }],
        queued: [],
        backlog: [],
      }),
    });
    const feed = await getCandidateFeed({ now: NOW }, deps);
    assert.ok(feed.candidates.map((c) => c.title).includes("PR claim, no timestamp"));
    assert.equal(feed.in_flight_suppressed, 0);
  });

  test("a pr-<n> claim with an unparseable claimedAt is not suppressed (fail-open)", async () => {
    const deps = makeDeps({
      loadBacklog: async () => ({
        inProgress: [{ id: 1, title: "Garbled claimedAt", claimedBy: "pr-7", claimedAt: "not-a-date", movedAt: isoAgo(0) }],
        queued: [],
        backlog: [],
      }),
    });
    const feed = await getCandidateFeed({ now: NOW }, deps);
    assert.ok(feed.candidates.map((c) => c.title).includes("Garbled claimedAt"));
    assert.equal(feed.in_flight_suppressed, 0);
  });

  test("the 30-min in-flight freshness boundary is EXCLUSIVE — exactly 30m ago resurfaces", async () => {
    // now - claimedAt === IN_FLIGHT_PR_FRESHNESS_MS → the `< window` test is
    // false → NOT suppressed. One millisecond younger WOULD be suppressed.
    const deps = makeDeps({
      loadBacklog: async () => ({
        inProgress: [
          { id: 1, title: "Exactly 30m PR", claimedBy: "pr-1", claimedAt: isoAgo(30 * MIN_MS), movedAt: isoAgo(0) },
          { id: 2, title: "29m59s PR", claimedBy: "pr-2", claimedAt: isoAgo(30 * MIN_MS - 1000), movedAt: isoAgo(0) },
        ],
        queued: [],
        backlog: [],
      }),
    });
    const feed = await getCandidateFeed({ now: NOW }, deps);
    const titles = feed.candidates.map((c) => c.title);
    assert.ok(titles.includes("Exactly 30m PR"), "exactly-30m claim is stale enough to resurface");
    assert.ok(!titles.includes("29m59s PR"), "a still-fresh claim is suppressed");
    assert.equal(feed.in_flight_suppressed, 1);
  });
});

// ---------------------------------------------------------------------------
// Blocker-just-cleared guard — the NEGATIVE branches through the feed. The
// positive case (bonus applied, score→1.0) is pinned in
// api-anchor-candidates.test.mts; these confirm the guard withholds the bonus
// on each disqualifying input, so a not-actually-unblocked item is not upscored.
// ---------------------------------------------------------------------------

describe("getCandidateFeed — blocker-just-cleared guard negatives (#3172)", () => {
  test("a still-'blocked' lane earns NO bonus even with a recent movedAt", async () => {
    const deps = makeDeps({
      loadBacklog: async () => ({
        inProgress: [],
        queued: [{
          id: 1,
          title: "Still blocked",
          lane: "blocked",
          movedAt: isoAgo(HOUR_MS),
          meta: { blockedReason: "Blocked by #99" },
        }],
        backlog: [],
      }),
    });
    const feed = await getCandidateFeed({ now: NOW }, deps);
    assert.equal(feed.candidates[0].score, 0.85, "no blocker-cleared bonus while still blocked");
    assert.ok(!feed.candidates[0].reasons.some((r) => r.includes("blocker-cleared")));
  });

  test("a stale (>24h) unblock earns NO bonus", async () => {
    const deps = makeDeps({
      loadBacklog: async () => ({
        inProgress: [],
        queued: [{
          id: 1,
          title: "Unblocked long ago",
          lane: "queued",
          movedAt: isoAgo(25 * HOUR_MS),
          meta: { blockedReason: "Blocked by #99 (merged)" },
        }],
        backlog: [],
      }),
    });
    const feed = await getCandidateFeed({ now: NOW }, deps);
    // >14d? No (25h). Fresh, no bonus → base 0.85.
    assert.equal(feed.candidates[0].score, 0.85);
    assert.ok(!feed.candidates[0].reasons.some((r) => r.includes("blocker-cleared")));
  });

  test("the 24h recent-unblock boundary is EXCLUSIVE — exactly 24h ago earns no bonus", async () => {
    const deps = makeDeps({
      loadBacklog: async () => ({
        inProgress: [],
        queued: [
          { id: 1, title: "Exactly 24h unblock", lane: "queued", movedAt: isoAgo(24 * HOUR_MS), meta: { blockedReason: "b" } },
          { id: 2, title: "23h59m unblock", lane: "queued", movedAt: isoAgo(24 * HOUR_MS - 1000), meta: { blockedReason: "b" } },
        ],
        backlog: [],
      }),
    });
    const feed = await getCandidateFeed({ now: NOW }, deps);
    const byTitle = new Map(feed.candidates.map((c) => [c.title, c]));
    assert.equal(byTitle.get("Exactly 24h unblock")!.score, 0.85, "exactly-24h earns no bonus (< is exclusive)");
    assert.equal(byTitle.get("23h59m unblock")!.score, 1.0, "still-inside-window earns the +0.15 bonus");
    assert.ok(byTitle.get("23h59m unblock")!.reasons.some((r) => r.includes("blocker-cleared")));
  });

  test("a never-blocked item (no blockedReason) earns no bonus", async () => {
    const deps = makeDeps({
      loadBacklog: async () => ({
        inProgress: [],
        queued: [{ id: 1, title: "Never blocked", lane: "queued", movedAt: isoAgo(HOUR_MS) }],
        backlog: [],
      }),
    });
    const feed = await getCandidateFeed({ now: NOW }, deps);
    assert.equal(feed.candidates[0].score, 0.85);
    assert.ok(!feed.candidates[0].reasons.some((r) => r.includes("blocker-cleared")));
  });
});

// ---------------------------------------------------------------------------
// Research-recommended guard — the RESEARCH_THRESHOLD=0.5 predicate. The two
// obvious arms (weak top score → true; strong kanban → false) are already
// pinned; these pin the two BOUNDARY arms.
// ---------------------------------------------------------------------------

describe("getCandidateFeed — research_recommended boundary arms (#3172)", () => {
  test("an empty board flips research_recommended=true via the top.length===0 arm", async () => {
    const feed = await getCandidateFeed({ now: NOW }, makeDeps());
    assert.equal(feed.candidates.length, 0);
    assert.equal(feed.research_recommended, true);
  });

  test("a candidate scoring exactly 0.5 does NOT recommend research (strict < threshold)", async () => {
    // work-queue base 0.70 - freshness 0.15 = 0.55; then a -0.20 reflection would
    // undershoot. Compose exactly 0.5: kanban 0.85 - stale 0.15 - reflection 0.20 = 0.50.
    const deps = makeDeps({
      loadBacklog: async () => ({
        inProgress: [],
        queued: [{ id: 1, title: "Exactly half", movedAt: isoAgo(30 * DAY_MS) }],
        backlog: [],
      }),
      loadLastReflectionAt: async () => isoAgo(HOUR_MS),
    });
    const feed = await getCandidateFeed({ now: NOW }, deps);
    assert.equal(feed.candidates[0].score, 0.5, "score composes to exactly the threshold");
    assert.equal(feed.research_recommended, false, "0.5 is not below 0.5 — no research recommended");
  });
});

// ---------------------------------------------------------------------------
// Feed composition + defaulting branches.
// ---------------------------------------------------------------------------

describe("getCandidateFeed — reflection-reader fail-open (#3172)", () => {
  test("a throwing loadLastReflectionAt degrades the field, never drops the candidate", async () => {
    // Sibling of the tested design-concept fail-open: an injected reflection
    // reader that throws must be caught inside the feed so the candidate stays,
    // scored as if no reflection existed (no -0.20 penalty).
    const deps = makeDeps({
      loadBacklog: async () => ({ inProgress: [], queued: [{ id: 1, title: "Survivor", movedAt: isoAgo(0) }], backlog: [] }),
      loadLastReflectionAt: async () => { throw new Error("reflection read failed"); },
    });
    await assert.doesNotReject(async () => {
      const feed = await getCandidateFeed({ now: NOW }, deps);
      assert.equal(feed.candidates.length, 1);
      assert.equal(feed.candidates[0].title, "Survivor");
      assert.equal(feed.candidates[0].score, 0.85, "no reflection penalty applied when the reader throws");
    });
  });
});

describe("getCandidateFeed — limit clamping (#3172)", () => {
  test("a limit above MAX_LIMIT (50) is clamped to 50", async () => {
    const deps = makeDeps({
      loadBacklog: async () => ({
        inProgress: [],
        queued: Array.from({ length: 60 }, (_, i) => ({ id: i, title: `Task ${i}`, movedAt: isoAgo(0) })),
        backlog: [],
      }),
    });
    const feed = await getCandidateFeed({ now: NOW, limit: 999 }, deps);
    assert.equal(feed.candidates.length, 50, "returned slice is capped at MAX_LIMIT");
    assert.equal(feed.total_evaluated, 60, "total_evaluated still counts every candidate");
  });

  test("an invalid limit (0) falls back to the default (10)", async () => {
    const deps = makeDeps({
      loadBacklog: async () => ({
        inProgress: [],
        queued: Array.from({ length: 15 }, (_, i) => ({ id: i, title: `Task ${i}`, movedAt: isoAgo(0) })),
        backlog: [],
      }),
    });
    const feed = await getCandidateFeed({ now: NOW, limit: 0 }, deps);
    assert.equal(feed.candidates.length, 10, "limit<=0 is rejected → DEFAULT_LIMIT");
    assert.equal(feed.total_evaluated, 15);
  });

  test("a negative limit falls back to the default (10)", async () => {
    const deps = makeDeps({
      loadBacklog: async () => ({
        inProgress: [],
        queued: Array.from({ length: 15 }, (_, i) => ({ id: i, title: `Task ${i}`, movedAt: isoAgo(0) })),
        backlog: [],
      }),
    });
    const feed = await getCandidateFeed({ now: NOW, limit: -5 }, deps);
    assert.equal(feed.candidates.length, 10);
  });
});

describe("getCandidateFeed — now defaulting (#3172)", () => {
  test("omitting opts.now uses the real clock; a just-moved item is still fresh", async () => {
    // No `now` override — the feed reads Date.now(). A movedAt of "just now"
    // (real time) must score as fresh kanban base (no >14d freshness penalty).
    const deps = makeDeps({
      loadBacklog: async () => ({
        inProgress: [],
        queued: [{ id: 1, title: "Just moved", movedAt: new Date().toISOString() }],
        backlog: [],
      }),
    });
    const feed = await getCandidateFeed({}, deps);
    assert.equal(feed.candidates.length, 1);
    assert.equal(feed.candidates[0].score, 0.85, "fresh under the real clock → full kanban base");
    assert.ok(feed.candidates[0].reasons.includes("fresh"));
  });
});

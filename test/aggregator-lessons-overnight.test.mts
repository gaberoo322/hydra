/**
 * Regression tests for the lessons-overnight aggregator (issue #617).
 *
 * The pure helper `filterNearPromotion` is tested directly. The meta-friction
 * `gh` read moved to the `friction-source.ts` seam (issue #864) — its parse /
 * createdAt-refilter / newest-first behaviour is covered by
 * `aggregator-friction-source.test.mts`; here it's exercised end-to-end through
 * `getOvernightLessons` with an exec stub. No Redis required.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  getOvernightLessons,
  filterNearPromotion,
} from "../src/aggregators/lessons-overnight.ts";
import { PROMOTION_THRESHOLD } from "../src/pattern-memory/constants.ts";
import type { IssueRow } from "../src/github/issues.ts";

const NOW = new Date("2026-05-26T12:00:00.000Z");

/**
 * Build a `listIssuesBySearchOrEmpty` stub returning the given meta-friction
 * rows (after issue #915 the meta-friction read goes through the seam, not a
 * raw `gh` exec).
 */
function metaReader(rows: Array<Partial<IssueRow> & { number: number }>) {
  const full: IssueRow[] = rows.map((r) => ({
    number: r.number,
    title: r.title ?? `Issue #${r.number}`,
    url: r.url ?? `https://github.com/gaberoo322/hydra/issues/${r.number}`,
    createdAt: r.createdAt ?? "",
    labels: r.labels ?? [],
    body: r.body ?? "",
    state: r.state ?? "OPEN",
  }));
  return async () => full;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("filterNearPromotion — pure helper", () => {
  test("returns [] when patterns is not an array", () => {
    // @ts-expect-error: intentionally passing wrong type to pin defensiveness.
    assert.deepEqual(filterNearPromotion("hydra-dev", null, 1), []);
  });

  test("keeps un-promoted patterns within candidateWindow hits of threshold", () => {
    const patterns = [
      // candidateWindow=1, threshold=3 → keep hitCount in [2, 3)
      { category: "cue-a", hitCount: 2, lastSeen: "2026-05-26T01:00:00Z" },
      { category: "cue-b", hitCount: 1, lastSeen: "2026-05-26T01:00:00Z" }, // too low
      { category: "cue-c", hitCount: PROMOTION_THRESHOLD, lastSeen: "2026-05-26T01:00:00Z" }, // already at threshold
      { category: "cue-d", hitCount: 2, lastSeen: "2026-05-26T01:00:00Z", promoted: true }, // already promoted
    ];
    const out = filterNearPromotion("hydra-dev", patterns, 1);
    assert.equal(out.length, 1);
    assert.equal(out[0].cue, "cue-a");
    assert.equal(out[0].hitsToPromotion, 1);
    assert.equal(out[0].skill, "hydra-dev");
  });

  test("a wider candidateWindow pulls in lower hit-counts", () => {
    const patterns = [
      { category: "cue-x", hitCount: 1, lastSeen: "2026-05-26T01:00:00Z" },
      { category: "cue-y", hitCount: 2, lastSeen: "2026-05-26T01:00:00Z" },
    ];
    const out = filterNearPromotion("hydra-qa", patterns, 2);
    assert.equal(out.length, 2);
    const cues = out.map((c) => c.cue).sort();
    assert.deepEqual(cues, ["cue-x", "cue-y"]);
  });
});

describe("meta-friction read (via seam) — windowing through getOvernightLessons", () => {
  test("keeps issues created inside the window, drops pre-window, sorts newest-first", async () => {
    const lessons = await getOvernightLessons(24, {
      now: NOW,
      listIssuesBySearchOrEmpty: metaReader([
        { number: 1, title: "older meta", url: "u1", createdAt: "2026-05-25T13:00:00Z" },
        { number: 2, title: "newer meta", url: "u2", createdAt: "2026-05-26T11:00:00Z" },
        { number: 3, title: "before window", url: "u3", createdAt: "2026-05-24T00:00:00Z" },
      ]),
      readFrictionPatterns: async () => [],
    });
    // WINDOW_START = NOW - 24h = 2026-05-25T12:00:00Z; #3 is before it.
    assert.deepEqual(lessons.metaFrictionOpened.map((i) => i.number), [2, 1]);
  });

  test("seam reader degrades to [] → empty bucket (never throws)", async () => {
    const lessons = await getOvernightLessons(24, {
      now: NOW,
      listIssuesBySearchOrEmpty: async () => [],
      readFrictionPatterns: async () => [],
    });
    assert.deepEqual(lessons.metaFrictionOpened, []);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("getOvernightLessons — happy path", () => {
  test("merges friction-pattern candidates with meta-friction issues", async () => {
    const readFrictionPatterns = async () => [
      {
        skill: "hydra-dev",
        patterns: [
          { category: "cue-warm", hitCount: PROMOTION_THRESHOLD - 1, lastSeen: "2026-05-26T11:00:00Z" },
        ],
      },
    ];
    const lessons = await getOvernightLessons(24, {
      now: NOW,
      listIssuesBySearchOrEmpty: metaReader([
        { number: 99, title: "meta-friction: x", url: "u99", createdAt: "2026-05-26T10:00:00Z" },
      ]),
      readFrictionPatterns,
    });
    assert.equal(lessons.promotionCandidates.length, 1);
    assert.equal(lessons.promotionCandidates[0].cue, "cue-warm");
    assert.equal(lessons.promotionCandidates[0].hitsToPromotion, 1);
    assert.equal(lessons.metaFrictionOpened.length, 1);
    assert.equal(lessons.metaFrictionOpened[0].number, 99);
    assert.equal(lessons.windowHours, 24);
    assert.equal(lessons.promotionThreshold, PROMOTION_THRESHOLD);
  });
});

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

describe("getOvernightLessons — empty state", () => {
  test("no patterns, no meta-issues → empty buckets but threshold echoed", async () => {
    const lessons = await getOvernightLessons(24, {
      now: NOW,
      listIssuesBySearchOrEmpty: async () => [],
      readFrictionPatterns: async () => [],
    });
    assert.deepEqual(lessons.promotionCandidates, []);
    assert.deepEqual(lessons.metaFrictionOpened, []);
    assert.equal(lessons.promotionThreshold, PROMOTION_THRESHOLD);
  });
});

// ---------------------------------------------------------------------------
// Boundary: sub-source failure isolation
// ---------------------------------------------------------------------------

describe("getOvernightLessons — sub-source failure isolation", () => {
  test("friction-pattern reader throws → meta-issues still ship", async () => {
    const lessons = await getOvernightLessons(24, {
      now: NOW,
      listIssuesBySearchOrEmpty: metaReader([
        { number: 1, title: "meta", url: "u1", createdAt: "2026-05-26T10:00:00Z" },
      ]),
      readFrictionPatterns: async () => {
        throw new Error("redis down");
      },
    });
    assert.deepEqual(lessons.promotionCandidates, []);
    assert.equal(lessons.metaFrictionOpened.length, 1);
  });

  test("meta-friction reader degrades to [] → friction candidates still ship", async () => {
    const lessons = await getOvernightLessons(24, {
      now: NOW,
      listIssuesBySearchOrEmpty: async () => [],
      readFrictionPatterns: async () => [
        {
          skill: "hydra-dev",
          patterns: [
            { category: "cue-warm", hitCount: PROMOTION_THRESHOLD - 1, lastSeen: "2026-05-26T11:00:00Z" },
          ],
        },
      ],
    });
    assert.equal(lessons.promotionCandidates.length, 1);
    assert.deepEqual(lessons.metaFrictionOpened, []);
  });
});

/**
 * Regression tests for the lessons-overnight aggregator (issue #617).
 *
 * Pure helpers (`filterNearPromotion`, `parseMetaFrictionIssues`) are
 * tested directly. Integration shape uses an exec stub and a friction-
 * patterns reader stub so no Redis is required.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  getOvernightLessons,
  filterNearPromotion,
  parseMetaFrictionIssues,
} from "../src/aggregators/lessons-overnight.ts";
import { PROMOTION_THRESHOLD } from "../src/pattern-memory/agent-memory.ts";

const NOW = new Date("2026-05-26T12:00:00.000Z");
const WINDOW_START = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);

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

describe("parseMetaFrictionIssues — pure helper", () => {
  test("returns [] on empty / non-array", () => {
    assert.deepEqual(parseMetaFrictionIssues("", WINDOW_START), []);
    assert.deepEqual(parseMetaFrictionIssues("{}", WINDOW_START), []);
  });

  test("keeps issues created inside the window, sorts newest-first", () => {
    const stdout = JSON.stringify([
      { number: 1, title: "older meta", url: "u1", createdAt: "2026-05-25T13:00:00Z" },
      { number: 2, title: "newer meta", url: "u2", createdAt: "2026-05-26T11:00:00Z" },
      { number: 3, title: "before window", url: "u3", createdAt: "2026-05-24T00:00:00Z" },
    ]);
    const out = parseMetaFrictionIssues(stdout, WINDOW_START);
    assert.deepEqual(out.map((i) => i.number), [2, 1]);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("getOvernightLessons — happy path", () => {
  test("merges friction-pattern candidates with meta-friction issues", async () => {
    const exec = async () => ({
      stdout: JSON.stringify([
        { number: 99, title: "meta-friction: x", url: "u99", createdAt: "2026-05-26T10:00:00Z" },
      ]),
      stderr: "",
    });
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
      execFileAsync: exec,
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
    const exec = async () => ({ stdout: JSON.stringify([]), stderr: "" });
    const lessons = await getOvernightLessons(24, {
      now: NOW,
      execFileAsync: exec,
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
    const exec = async () => ({
      stdout: JSON.stringify([
        { number: 1, title: "meta", url: "u1", createdAt: "2026-05-26T10:00:00Z" },
      ]),
      stderr: "",
    });
    const lessons = await getOvernightLessons(24, {
      now: NOW,
      execFileAsync: exec,
      readFrictionPatterns: async () => {
        throw new Error("redis down");
      },
    });
    assert.deepEqual(lessons.promotionCandidates, []);
    assert.equal(lessons.metaFrictionOpened.length, 1);
  });

  test("gh throws → friction candidates still ship", async () => {
    const exec = async () => {
      throw new Error("gh broken");
    };
    const lessons = await getOvernightLessons(24, {
      now: NOW,
      execFileAsync: exec,
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

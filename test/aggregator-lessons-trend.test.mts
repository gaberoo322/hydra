/**
 * Regression tests for the lessons-trend aggregator (issue #619).
 *
 * Pure helpers (`collectPromoted`, `promotionsByDay`, `pickTopFriction`) are
 * tested directly. The meta-friction count is now derived from the
 * `friction-source.ts` seam reader's `.length` (issue #864) — its parse /
 * createdAt-refilter is covered by `aggregator-friction-source.test.mts` and
 * exercised end-to-end here through `getLessonsTrend` with an exec stub.
 * Integration uses a stub friction-pattern reader + exec stub so no Redis is
 * required.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  getLessonsTrend,
  collectPromoted,
  promotionsByDay,
  pickTopFriction,
} from "../src/aggregators/lessons-trend.ts";
import { PROMOTION_THRESHOLD } from "../src/pattern-memory/agent-memory.ts";
import type { FrictionPattern } from "../src/aggregators/lessons-overnight.ts";

const NOW = new Date("2026-05-26T12:00:00.000Z");
const WINDOW_START = new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000);

// ---------------------------------------------------------------------------
// Pure helpers — collectPromoted
// ---------------------------------------------------------------------------

describe("collectPromoted — pure helper", () => {
  test("returns [] for non-array input", () => {
    // @ts-expect-error: intentional bad input
    assert.deepEqual(collectPromoted(null, WINDOW_START, NOW), []);
  });

  test("keeps explicitly promoted patterns inside the window", () => {
    const patterns: FrictionPattern[] = [
      {
        category: "cue-a",
        hitCount: 5,
        promoted: true,
        lastSeen: "2026-05-26T01:00:00Z",
      },
    ];
    const out = collectPromoted(
      [{ skill: "hydra-dev", patterns }],
      WINDOW_START,
      NOW,
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].cue, "cue-a");
    assert.equal(out[0].skill, "hydra-dev");
  });

  test("falls back to hitCount >= threshold when 'promoted' missing", () => {
    const patterns: FrictionPattern[] = [
      {
        category: "cue-b",
        hitCount: PROMOTION_THRESHOLD,
        lastSeen: "2026-05-26T01:00:00Z",
      },
    ];
    const out = collectPromoted(
      [{ skill: "hydra-qa", patterns }],
      WINDOW_START,
      NOW,
    );
    assert.equal(out.length, 1);
  });

  test("drops patterns outside the window", () => {
    const patterns: FrictionPattern[] = [
      {
        category: "cue-old",
        hitCount: 5,
        promoted: true,
        lastSeen: "2026-04-01T00:00:00Z", // way before window
      },
    ];
    const out = collectPromoted(
      [{ skill: "hydra-dev", patterns }],
      WINDOW_START,
      NOW,
    );
    assert.deepEqual(out, []);
  });

  test("drops un-promoted patterns below threshold", () => {
    const patterns: FrictionPattern[] = [
      {
        category: "cue-low",
        hitCount: 1,
        lastSeen: "2026-05-26T01:00:00Z",
      },
    ];
    const out = collectPromoted(
      [{ skill: "hydra-dev", patterns }],
      WINDOW_START,
      NOW,
    );
    assert.deepEqual(out, []);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers — promotionsByDay
// ---------------------------------------------------------------------------

describe("promotionsByDay — pure helper", () => {
  test("[] for empty input", () => {
    assert.deepEqual(promotionsByDay([]), []);
  });

  test("buckets by UTC day", () => {
    const out = promotionsByDay([
      {
        skill: "x",
        cue: "a",
        hitCount: 3,
        lastSeen: "2026-05-25T05:00:00Z",
        lastSeenMs: Date.parse("2026-05-25T05:00:00Z"),
      },
      {
        skill: "x",
        cue: "b",
        hitCount: 3,
        lastSeen: "2026-05-25T22:00:00Z",
        lastSeenMs: Date.parse("2026-05-25T22:00:00Z"),
      },
      {
        skill: "x",
        cue: "c",
        hitCount: 3,
        lastSeen: "2026-05-26T01:00:00Z",
        lastSeenMs: Date.parse("2026-05-26T01:00:00Z"),
      },
    ]);
    assert.equal(out.length, 2);
    assert.equal(out[0].v, 2);
    assert.equal(out[1].v, 1);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers — pickTopFriction
// ---------------------------------------------------------------------------

describe("pickTopFriction — pure helper", () => {
  test("returns top-N by hitCount desc", () => {
    const out = pickTopFriction(
      [
        {
          skill: "x",
          cue: "a",
          hitCount: 3,
          lastSeen: "2026-05-26T01:00:00Z",
          lastSeenMs: 0,
        },
        {
          skill: "x",
          cue: "b",
          hitCount: 10,
          lastSeen: "2026-05-26T01:00:00Z",
          lastSeenMs: 0,
        },
        {
          skill: "x",
          cue: "c",
          hitCount: 7,
          lastSeen: "2026-05-26T01:00:00Z",
          lastSeenMs: 0,
        },
      ],
      2,
    );
    assert.deepEqual(
      out.map((i) => i.cue),
      ["b", "c"],
    );
  });

  test("limit of 0 returns []", () => {
    assert.deepEqual(
      pickTopFriction(
        [
          {
            skill: "x",
            cue: "a",
            hitCount: 1,
            lastSeen: "2026-05-26T01:00:00Z",
            lastSeenMs: 0,
          },
        ],
        0,
      ),
      [],
    );
  });

  test("tie on hitCount → more-recent wins", () => {
    const out = pickTopFriction(
      [
        {
          skill: "x",
          cue: "older",
          hitCount: 3,
          lastSeen: "2026-05-25T00:00:00Z",
          lastSeenMs: Date.parse("2026-05-25T00:00:00Z"),
        },
        {
          skill: "x",
          cue: "newer",
          hitCount: 3,
          lastSeen: "2026-05-26T00:00:00Z",
          lastSeenMs: Date.parse("2026-05-26T00:00:00Z"),
        },
      ],
      1,
    );
    assert.equal(out[0].cue, "newer");
  });
});

// ---------------------------------------------------------------------------
// meta-friction count (derived from the seam reader's .length, issue #864)
// ---------------------------------------------------------------------------

describe("metaFrictionOpened — derived from seam reader length", () => {
  test("counts only items inside the window via getLessonsTrend", async () => {
    // windowStart = NOW - 7d = 2026-05-19T12:00:00Z.
    const exec = async () => ({
      stdout: JSON.stringify([
        { number: 1, title: "in", url: "u1", createdAt: "2026-05-26T01:00:00Z" }, // inside
        { number: 2, title: "before", url: "u2", createdAt: "2026-05-19T11:00:00Z" }, // just BEFORE start → outside
        { number: 3, title: "in", url: "u3", createdAt: "2026-05-20T00:00:00Z" }, // inside
      ]),
      stderr: "",
    });
    const response = await getLessonsTrend(7, {
      now: NOW,
      execFileAsync: exec,
      readFrictionPatterns: async () => [],
    });
    assert.equal(response.metaFrictionOpened, 2);
  });

  test("non-array gh payload → count 0 (never throws)", async () => {
    const response = await getLessonsTrend(7, {
      now: NOW,
      execFileAsync: async () => ({ stdout: "{}", stderr: "" }),
      readFrictionPatterns: async () => [],
    });
    assert.equal(response.metaFrictionOpened, 0);
  });
});

// ---------------------------------------------------------------------------
// Integration shape
// ---------------------------------------------------------------------------

describe("getLessonsTrend — happy path", () => {
  test("merges promotion + top friction + meta-friction count", async () => {
    const exec = async () => ({
      stdout: JSON.stringify([
        { number: 7, createdAt: "2026-05-26T01:00:00Z" },
      ]),
      stderr: "",
    });
    const readFrictionPatterns = async () => [
      {
        skill: "hydra-dev",
        patterns: [
          {
            category: "cue-promoted",
            hitCount: PROMOTION_THRESHOLD,
            promoted: true,
            lastSeen: "2026-05-26T01:00:00Z",
          },
        ],
      },
    ];
    const response = await getLessonsTrend(7, {
      now: NOW,
      execFileAsync: exec,
      readFrictionPatterns,
    });
    assert.equal(response.windowDays, 7);
    assert.equal(response.metaFrictionOpened, 1);
    assert.equal(response.topFriction.length, 1);
    assert.equal(response.topFriction[0].cue, "cue-promoted");
    assert.equal(response.promotionThreshold, PROMOTION_THRESHOLD);
  });
});

describe("getLessonsTrend — empty state", () => {
  test("no patterns and no meta-friction → zero counts", async () => {
    const response = await getLessonsTrend(7, {
      now: NOW,
      execFileAsync: async () => ({ stdout: JSON.stringify([]), stderr: "" }),
      readFrictionPatterns: async () => [],
    });
    assert.deepEqual(response.promotionRate, []);
    assert.deepEqual(response.topFriction, []);
    assert.equal(response.metaFrictionOpened, 0);
  });
});

describe("getLessonsTrend — failure isolation", () => {
  test("friction reader throws → meta count still ships", async () => {
    const response = await getLessonsTrend(7, {
      now: NOW,
      execFileAsync: async () => ({
        stdout: JSON.stringify([{ number: 1, createdAt: "2026-05-26T01:00:00Z" }]),
        stderr: "",
      }),
      readFrictionPatterns: async () => {
        throw new Error("redis down");
      },
    });
    assert.deepEqual(response.topFriction, []);
    assert.equal(response.metaFrictionOpened, 1);
  });

  test("gh exec throws → friction signals still ship", async () => {
    const response = await getLessonsTrend(7, {
      now: NOW,
      execFileAsync: async () => {
        throw new Error("gh broken");
      },
      readFrictionPatterns: async () => [
        {
          skill: "hydra-dev",
          patterns: [
            {
              category: "cue-promoted",
              hitCount: PROMOTION_THRESHOLD,
              promoted: true,
              lastSeen: "2026-05-26T01:00:00Z",
            },
          ],
        },
      ],
    });
    assert.equal(response.topFriction.length, 1);
    assert.equal(response.metaFrictionOpened, 0);
  });
});

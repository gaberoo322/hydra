/**
 * Regression tests for the friction-patterns aggregator (issue #620, PRD #615).
 *
 * Pure helpers (`liftFrictionPatterns`, `normalizeLastEscalation`) tested
 * directly. The meta-friction `gh` read moved to the `friction-source.ts` seam
 * (issue #864); its parse / createdAt-refilter / newest-first behaviour is
 * covered by `aggregator-friction-source.test.mts` and exercised end-to-end
 * here through `getFrictionPatterns` with a `gh issue list` exec stub.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  getFrictionPatterns,
  liftFrictionPatterns,
  normalizeLastEscalation,
  type RawFrictionPattern,
} from "../src/aggregators/friction-patterns.ts";
import { PROMOTION_THRESHOLD } from "../src/pattern-memory/agent-memory.ts";

const NOW = new Date("2026-05-26T12:00:00.000Z");

function rawPattern(overrides: Partial<RawFrictionPattern> = {}): RawFrictionPattern {
  return {
    category: "stub-cue",
    severity: "prevent",
    hitCount: 1,
    promoted: false,
    lastSeen: "2026-05-26T10:00:00Z",
    firstSeen: "2026-05-20T00:00:00Z",
    examples: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("liftFrictionPatterns — pure helper", () => {
  test("nearThreshold true when un-promoted and one hit shy", () => {
    const rows = liftFrictionPatterns(
      "hydra-dev",
      [rawPattern({ category: "x", hitCount: PROMOTION_THRESHOLD - 1 })],
      1,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].nearThreshold, true);
    assert.equal(rows[0].hitsToPromotion, 1);
  });

  test("nearThreshold false once promoted, even with hits below threshold", () => {
    const rows = liftFrictionPatterns(
      "hydra-dev",
      [rawPattern({ category: "x", hitCount: PROMOTION_THRESHOLD - 1, promoted: true })],
      1,
    );
    assert.equal(rows[0].nearThreshold, false);
    assert.equal(rows[0].promoted, true);
  });

  test("nearThreshold false at or above threshold (no longer a candidate)", () => {
    const rows = liftFrictionPatterns(
      "hydra-dev",
      [rawPattern({ category: "x", hitCount: PROMOTION_THRESHOLD })],
      1,
    );
    assert.equal(rows[0].nearThreshold, false);
    assert.equal(rows[0].hitsToPromotion, 0);
  });

  test("drops rows with non-finite hitCount", () => {
    const rows = liftFrictionPatterns(
      "hydra-dev",
      [rawPattern({ hitCount: NaN as unknown as number })],
      1,
    );
    assert.deepEqual(rows, []);
  });

  test("sorts newest-lastSeen first", () => {
    const rows = liftFrictionPatterns(
      "hydra-dev",
      [
        rawPattern({ category: "old", hitCount: 1, lastSeen: "2026-05-20T00:00:00Z" }),
        rawPattern({ category: "fresh", hitCount: 1, lastSeen: "2026-05-26T11:00:00Z" }),
      ],
      1,
    );
    assert.deepEqual(rows.map((r) => r.cue), ["fresh", "old"]);
  });

  test("clamps examples to 3 and drops non-string entries", () => {
    const rows = liftFrictionPatterns(
      "hydra-dev",
      [
        rawPattern({
          category: "ex",
          hitCount: 1,
          examples: ["a", "b", "c", "d", null as any, 42 as any],
        }),
      ],
      1,
    );
    assert.deepEqual(rows[0].examples, ["a", "b", "c"]);
  });

  test("returns [] when patterns isn't an array", () => {
    assert.deepEqual(liftFrictionPatterns("hydra-dev", null as any, 1), []);
  });

  // Issue #843 — Escalation Outcome surfaced per row.
  test("surfaces lastEscalation when present (error outage shows on the row)", () => {
    const rows = liftFrictionPatterns(
      "hydra-dev",
      [rawPattern({
        category: "x",
        hitCount: PROMOTION_THRESHOLD,
        lastEscalation: { status: "error", error: "gh auth expired", at: "2026-05-26T11:00:00.000Z" },
      })],
      1,
    );
    assert.deepEqual(rows[0].lastEscalation, {
      status: "error",
      error: "gh auth expired",
      at: "2026-05-26T11:00:00.000Z",
    });
  });

  test("lastEscalation is null when absent (pre-#843 record)", () => {
    const rows = liftFrictionPatterns("hydra-dev", [rawPattern({ category: "x", hitCount: 1 })], 1);
    assert.equal(rows[0].lastEscalation, null);
  });
});

describe("normalizeLastEscalation — pure helper (issue #843)", () => {
  test("null/absent/malformed → null", () => {
    assert.equal(normalizeLastEscalation(undefined), null);
    assert.equal(normalizeLastEscalation(null as any), null);
    assert.equal(normalizeLastEscalation({} as any), null);
    assert.equal(normalizeLastEscalation({ status: "bogus" } as any), null);
  });

  test("created outcome keeps issueNumber, drops error", () => {
    assert.deepEqual(
      normalizeLastEscalation({ status: "created", issueNumber: 7, at: "2026-05-26T11:00:00.000Z" }),
      { status: "created", issueNumber: 7, at: "2026-05-26T11:00:00.000Z" },
    );
  });

  test("error outcome keeps error string", () => {
    assert.deepEqual(
      normalizeLastEscalation({ status: "error", error: "boom", at: "2026-05-26T11:00:00.000Z" }),
      { status: "error", error: "boom", at: "2026-05-26T11:00:00.000Z" },
    );
  });

  test("skipped outcome has neither issueNumber nor error", () => {
    assert.deepEqual(
      normalizeLastEscalation({ status: "skipped", at: "2026-05-26T11:00:00.000Z" }),
      { status: "skipped", at: "2026-05-26T11:00:00.000Z" },
    );
  });
});

describe("meta-friction read (via seam) — windowing through getFrictionPatterns", () => {
  test("filters by createdAt against the 7d window and sorts newest-first", async () => {
    // Default windowHours = 168 (7d); windowStart = NOW - 7d = 2026-05-19T12:00Z.
    const exec = async () => ({
      stdout: JSON.stringify([
        { number: 1, title: "older", url: "u1", createdAt: "2026-05-20T01:00:00Z" },
        { number: 2, title: "newer", url: "u2", createdAt: "2026-05-25T20:00:00Z" },
        { number: 3, title: "before window", url: "u3", createdAt: "2026-05-18T00:00:00Z" },
      ]),
      stderr: "",
    });
    const snapshot = await getFrictionPatterns({
      now: NOW,
      readFrictionPatterns: async () => [],
      execFileAsync: exec,
    });
    assert.deepEqual(
      snapshot.recentMetaFrictionIssues.map((i) => i.number),
      [2, 1],
    );
  });

  test("non-array gh payload degrades to empty (never throws)", async () => {
    const snapshot = await getFrictionPatterns({
      now: NOW,
      readFrictionPatterns: async () => [],
      execFileAsync: async () => ({ stdout: "{}", stderr: "" }),
    });
    assert.deepEqual(snapshot.recentMetaFrictionIssues, []);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("getFrictionPatterns — happy path", () => {
  test("returns groups + candidates + meta-friction issues", async () => {
    const reader = async () => [
      {
        skill: "hydra-dev",
        patterns: [
          rawPattern({ category: "stale-master-ref", hitCount: PROMOTION_THRESHOLD - 1, lastSeen: "2026-05-26T10:00:00Z" }),
          rawPattern({ category: "first-time", hitCount: 1, lastSeen: "2026-05-25T00:00:00Z" }),
        ],
      },
      {
        skill: "hydra-qa",
        patterns: [
          rawPattern({ category: "ac-deferred", hitCount: 5, promoted: true, lastSeen: "2026-05-26T11:00:00Z" }),
        ],
      },
    ];
    const exec = async () => ({
      stdout: JSON.stringify([
        { number: 555, title: "meta", url: "u", createdAt: "2026-05-25T00:00:00Z" },
      ]),
      stderr: "",
    });
    const snapshot = await getFrictionPatterns({
      now: NOW,
      readFrictionPatterns: reader,
      execFileAsync: exec,
    });

    assert.equal(snapshot.bySkill.length, 2);
    assert.equal(snapshot.thresholdCandidates.length, 1);
    assert.equal(snapshot.thresholdCandidates[0].cue, "stale-master-ref");
    assert.equal(snapshot.recentMetaFrictionIssues.length, 1);
    assert.equal(snapshot.promotionThreshold, PROMOTION_THRESHOLD);
    assert.ok(snapshot.bySkill[0].patterns.length > 0);
  });
});

// ---------------------------------------------------------------------------
// Sub-source failure isolation
// ---------------------------------------------------------------------------

describe("getFrictionPatterns — sub-source failure isolation", () => {
  test("gh failure → groups still ship; meta-friction empty", async () => {
    const reader = async () => [
      { skill: "hydra-dev", patterns: [rawPattern({ hitCount: 1 })] },
    ];
    const exec = async () => {
      throw new Error("gh broken");
    };
    const snapshot = await getFrictionPatterns({
      now: NOW,
      readFrictionPatterns: reader,
      execFileAsync: exec,
    });
    assert.equal(snapshot.bySkill.length, 1);
    assert.deepEqual(snapshot.recentMetaFrictionIssues, []);
  });

  test("Redis reader failure → groups empty but meta-friction ships", async () => {
    const reader = async () => {
      throw new Error("redis broken");
    };
    const exec = async () => ({
      stdout: JSON.stringify([
        { number: 1, title: "ok", url: "u", createdAt: "2026-05-25T00:00:00Z" },
      ]),
      stderr: "",
    });
    const snapshot = await getFrictionPatterns({
      now: NOW,
      readFrictionPatterns: reader,
      execFileAsync: exec,
    });
    assert.deepEqual(snapshot.bySkill, []);
    assert.equal(snapshot.recentMetaFrictionIssues.length, 1);
  });
});

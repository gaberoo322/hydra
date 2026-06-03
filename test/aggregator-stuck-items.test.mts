/**
 * Regression tests for the stuck-items aggregator (issue #617, PRD #615).
 *
 * After issue #915 the aggregator reads GitHub through the **GitHub Issue/PR
 * Read seam** (`src/github/issues.ts`) instead of a local argv + parser. Tests
 * stub the seam readers (`listIssuesByLabelOrEmpty` / `listOpenPrsOrEmpty`)
 * rather than crafting raw `gh` JSON strings — the canonical-row parse now lives
 * in (and is tested by) the seam's own suite (`github-issues.test.mts`). The
 * pure classifiers here (`classifyByAge`, `selectPrsWithFailedCi`) are tested
 * directly against the seam's `IssueRow`/`PrRow` shapes.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  getStuckItems,
  classifyByAge,
  selectPrsWithFailedCi,
  DEFAULT_THRESHOLDS,
} from "../src/aggregators/stuck-items.ts";
import type { IssueRow, PrRow } from "../src/github/issues.ts";

const NOW = new Date("2026-05-26T12:00:00.000Z");

function issueRow(over: Partial<IssueRow> & { number: number }): IssueRow {
  return {
    number: over.number,
    title: over.title ?? `Issue #${over.number}`,
    url: over.url ?? `https://github.com/gaberoo322/hydra/issues/${over.number}`,
    createdAt: over.createdAt ?? "",
    labels: over.labels ?? [],
    body: over.body ?? "",
    state: over.state ?? "OPEN",
  };
}

function prRow(over: Partial<PrRow> & { number: number }): PrRow {
  return {
    number: over.number,
    title: over.title ?? `PR #${over.number}`,
    url: over.url ?? `https://github.com/gaberoo322/hydra/pull/${over.number}`,
    updatedAt: over.updatedAt ?? "",
    statusCheckRollup: over.statusCheckRollup ?? [],
  };
}

/**
 * Build a `listIssuesByLabelOrEmpty` stub from a label→rows map. Unknown labels
 * resolve to `[]`, mirroring the seam's degrade-to-empty contract.
 */
function makeLabelReader(byLabel: Record<string, IssueRow[]>) {
  return async (label: string) => byLabel[label] ?? [];
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("classifyByAge — pure helper", () => {
  test("keeps issues older than the threshold; drops younger", () => {
    const issues = [
      issueRow({ number: 1, title: "old", url: "u1", createdAt: "2026-05-20T00:00:00Z" }), // 6d
      issueRow({ number: 2, title: "young", url: "u2", createdAt: "2026-05-26T11:00:00Z" }), // 1h
    ];
    const out = classifyByAge(issues, NOW, 2);
    assert.equal(out.length, 1);
    assert.equal(out[0].number, 1);
    assert.equal(out[0].ageDays, 6);
  });

  test("boundary: exactly at threshold counts as stuck", () => {
    // 2-day age from NOW = 2026-05-24T12:00 UTC.
    const issues = [
      issueRow({ number: 1, title: "edge", url: "u1", createdAt: "2026-05-24T12:00:00Z" }),
    ];
    const out = classifyByAge(issues, NOW, 2);
    assert.equal(out.length, 1);
    assert.equal(out[0].ageDays, 2);
  });

  test("sorts oldest-first", () => {
    const issues = [
      issueRow({ number: 2, title: "less old", url: "u2", createdAt: "2026-05-23T00:00:00Z" }),
      issueRow({ number: 1, title: "oldest", url: "u1", createdAt: "2026-05-20T00:00:00Z" }),
    ];
    const out = classifyByAge(issues, NOW, 1);
    assert.deepEqual(out.map((i) => i.number), [1, 2]);
  });

  test("skips issues with unparseable / empty createdAt", () => {
    const issues = [
      issueRow({ number: 1, title: "junk", url: "u1", createdAt: "not-a-date" }),
      issueRow({ number: 2, title: "no-date", url: "u2", createdAt: "" }),
    ];
    const out = classifyByAge(issues, NOW, 1);
    assert.deepEqual(out, []);
  });
});

describe("selectPrsWithFailedCi — pure helper", () => {
  test("returns [] on empty input", () => {
    assert.deepEqual(selectPrsWithFailedCi([]), []);
  });

  test("keeps PRs with at least one FAILURE check; reports the failing names", () => {
    const rows = [
      prRow({
        number: 1,
        title: "good",
        url: "u1",
        updatedAt: "2026-05-26T00:00:00Z",
        statusCheckRollup: [{ conclusion: "SUCCESS", name: "test" }],
      }),
      prRow({
        number: 2,
        title: "broken",
        url: "u2",
        updatedAt: "2026-05-26T01:00:00Z",
        statusCheckRollup: [
          { conclusion: "SUCCESS", name: "typecheck" },
          { conclusion: "FAILURE", name: "test" },
          { conclusion: "TIMED_OUT", name: "build" },
        ],
      }),
    ];
    const out = selectPrsWithFailedCi(rows);
    assert.equal(out.length, 1);
    assert.equal(out[0].number, 2);
    assert.deepEqual(out[0].failedChecks, ["test", "build"]);
  });

  test("PENDING/SUCCESS-only rollups are filtered out", () => {
    const rows = [
      prRow({
        number: 3,
        title: "still running",
        url: "u3",
        updatedAt: "2026-05-26T02:00:00Z",
        statusCheckRollup: [{ conclusion: "PENDING", name: "ci" }],
      }),
    ];
    assert.deepEqual(selectPrsWithFailedCi(rows), []);
  });

  test("falls back to context then 'check' for a nameless failing entry", () => {
    const rows = [
      prRow({
        number: 4,
        statusCheckRollup: [
          { conclusion: "FAILURE", context: "legacy-status" },
          { conclusion: "FAILURE" },
        ],
      }),
    ];
    const out = selectPrsWithFailedCi(rows);
    assert.deepEqual(out[0].failedChecks, ["legacy-status", "check"]);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("getStuckItems — happy path", () => {
  test("returns three buckets + thresholds + generatedAt", async () => {
    const result = await getStuckItems({
      now: NOW,
      listIssuesByLabelOrEmpty: makeLabelReader({
        blocked: [
          issueRow({
            number: 1,
            title: "blocked old",
            url: "u1",
            createdAt: "2026-05-22T00:00:00Z", // 4.5d old → stuck (≥2d)
            labels: ["blocked"],
          }),
        ],
        "needs-info": [
          issueRow({
            number: 2,
            title: "needs-info waiting",
            url: "u2",
            createdAt: "2026-05-24T00:00:00Z", // 2.5d old → stuck (≥1d)
            labels: ["needs-info"],
          }),
        ],
      }),
      listOpenPrsOrEmpty: async () => [
        prRow({
          number: 555,
          title: "ci broken",
          url: "p555",
          updatedAt: "2026-05-26T00:00:00Z",
          statusCheckRollup: [{ conclusion: "FAILURE", name: "test" }],
        }),
      ],
    });
    assert.equal(result.blockedOver2d.length, 1);
    assert.equal(result.needsInfoWaiting.length, 1);
    assert.equal(result.prsWithFailedCi.length, 1);
    assert.deepEqual(result.thresholds, DEFAULT_THRESHOLDS);
    assert.equal(typeof result.generatedAt, "string");
  });
});

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

describe("getStuckItems — empty state", () => {
  test("no labeled issues, no failing PRs → empty buckets", async () => {
    const result = await getStuckItems({
      now: NOW,
      listIssuesByLabelOrEmpty: async () => [],
      listOpenPrsOrEmpty: async () => [],
    });
    assert.deepEqual(result.blockedOver2d, []);
    assert.deepEqual(result.needsInfoWaiting, []);
    assert.deepEqual(result.prsWithFailedCi, []);
  });
});

// ---------------------------------------------------------------------------
// Boundary: custom thresholds + sub-source failure isolation
// ---------------------------------------------------------------------------

describe("getStuckItems — custom thresholds", () => {
  test("overriding blockedDays reclassifies the bucket", async () => {
    const reader = {
      now: NOW,
      listIssuesByLabelOrEmpty: makeLabelReader({
        blocked: [
          issueRow({
            number: 1,
            title: "young blocked",
            url: "u1",
            createdAt: "2026-05-26T00:00:00Z", // 12h old
            labels: ["blocked"],
          }),
        ],
      }),
      listOpenPrsOrEmpty: async () => [],
    };

    // With default 2-day threshold, this item is NOT stuck.
    const defaultResult = await getStuckItems(reader);
    assert.equal(defaultResult.blockedOver2d.length, 0);

    // With a 0-day threshold (everything counts), it IS stuck.
    const aggressiveResult = await getStuckItems({
      ...reader,
      thresholds: { blockedDays: 0 },
    });
    assert.equal(aggressiveResult.blockedOver2d.length, 1);
  });
});

describe("getStuckItems — sub-source failure isolation", () => {
  test("PR reader rejecting → issue buckets still ship", async () => {
    const result = await getStuckItems({
      now: NOW,
      listIssuesByLabelOrEmpty: makeLabelReader({
        blocked: [
          issueRow({
            number: 1,
            title: "blocked",
            url: "u1",
            createdAt: "2026-05-20T00:00:00Z",
            labels: ["blocked"],
          }),
        ],
      }),
      // The seam's *OrEmpty readers degrade to [] internally; this models a
      // harder failure (the reader itself rejecting) to prove allSettled
      // isolation in the aggregator.
      listOpenPrsOrEmpty: async () => {
        throw new Error("gh pr broken");
      },
    });
    assert.equal(result.blockedOver2d.length, 1);
    assert.deepEqual(result.prsWithFailedCi, []);
  });
});

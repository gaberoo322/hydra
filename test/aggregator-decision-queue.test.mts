/**
 * Regression tests for the decision-queue aggregator (issue #617, PRD #615).
 *
 * After issue #915 the aggregator reads GitHub through the **GitHub Issue/PR
 * Read seam** (`src/github/issues.ts`). Tests stub the seam readers
 * (`listIssuesBySearchOrEmpty` for the dated-digest search,
 * `listIssuesByLabelOrEmpty` for the ready-for-human / needs-info lists) and
 * feed the pure helpers the seam's canonical `IssueRow` shape — the raw-JSON
 * parse now lives in the seam's own suite (`github-issues.test.mts`). The pure
 * merge/extract/format helpers are tested directly.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  getDecisionQueue,
  mergeDecisionItems,
} from "../src/aggregators/decision-queue.ts";
// The digest-body parsing primitives moved to their own seam (issue #2130);
// the test surface for them follows — the seam IS the thing being tested.
import {
  extractIssueRefs,
  digestRefsFromRows,
  labeledItemsFromRows,
  datedTitle,
} from "../src/aggregators/digest-issue.ts";
import type { IssueRow } from "../src/github/issues.ts";

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

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("datedTitle — pure helper", () => {
  test("formats YYYY-MM-DD in UTC", () => {
    assert.equal(datedTitle(NOW), "Operator decision queue 2026-05-26");
  });

  test("zero-pads month and day", () => {
    assert.equal(
      datedTitle(new Date("2026-01-03T00:00:00.000Z")),
      "Operator decision queue 2026-01-03",
    );
  });
});

describe("extractIssueRefs — pure helper", () => {
  test("returns [] on empty input", () => {
    assert.deepEqual(extractIssueRefs(""), []);
  });

  test("extracts #N references", () => {
    assert.deepEqual(extractIssueRefs("Review #1, #22, and #333"), [1, 22, 333]);
  });

  test("dedupes repeated references", () => {
    assert.deepEqual(extractIssueRefs("#5 then #5 again, then #6"), [5, 6]);
  });

  test("ignores references inside backtick code spans", () => {
    // A literal `#42` in code should not pollute the queue.
    assert.deepEqual(extractIssueRefs("Real ref #10. Code ref: `#42`."), [10]);
  });

  test("ignores tokens like abc#1 (only word-boundary #N)", () => {
    assert.deepEqual(extractIssueRefs("URL frag/abc#7. Real #8"), [8]);
  });
});

describe("labeledItemsFromRows — pure helper", () => {
  test("maps seam rows to raw decision inputs", () => {
    const items = labeledItemsFromRows([
      issueRow({
        number: 101,
        title: "Pick a tier",
        url: "https://x/101",
        createdAt: "2026-05-26T01:00:00.000Z",
        labels: ["ready-for-human", "tier:2"],
      }),
    ]);
    assert.equal(items.length, 1);
    assert.equal(items[0].number, 101);
    assert.deepEqual(items[0].labels, ["ready-for-human", "tier:2"]);
  });

  test("re-homes an empty createdAt to the epoch sentinel", () => {
    const items = labeledItemsFromRows([issueRow({ number: 5, createdAt: "" })]);
    assert.equal(items[0].createdAt, new Date(0).toISOString());
  });
});

describe("digestRefsFromRows — pure helper", () => {
  test("returns [] when title doesn't match", () => {
    const rows = [issueRow({ number: 1, title: "Some other digest", body: "Sees #100" })];
    assert.deepEqual(digestRefsFromRows(rows, "Operator decision queue 2026-05-26"), []);
  });

  test("extracts referenced issues from the matching digest body", () => {
    const rows = [
      issueRow({
        number: 999,
        title: "Operator decision queue 2026-05-26",
        body: "Action items: #100, #101. Also #102.",
        createdAt: "2026-05-26T06:00:00.000Z",
        labels: ["operator-queue"],
      }),
    ];
    const items = digestRefsFromRows(rows, "Operator decision queue 2026-05-26");
    assert.equal(items.length, 3);
    assert.deepEqual(items.map((i) => i.number), [100, 101, 102]);
    assert.equal(items[0].createdAt, "2026-05-26T06:00:00.000Z");
  });

  test("returns [] when the digest exists but body has no refs", () => {
    const rows = [
      issueRow({
        number: 999,
        title: "Operator decision queue 2026-05-26",
        body: "No action items today!",
        createdAt: "2026-05-26T06:00:00.000Z",
      }),
    ];
    assert.deepEqual(digestRefsFromRows(rows, "Operator decision queue 2026-05-26"), []);
  });
});

describe("mergeDecisionItems — pure helper", () => {
  test("preserves first source as primary; tracks all sources", () => {
    const merged = mergeDecisionItems({
      "operator-decision-queue": [
        { number: 10, title: "A", url: "ua", createdAt: "2026-05-26T01:00:00Z", labels: ["x"] },
      ],
      "ready-for-human": [
        { number: 10, title: "A-dup", url: "ua", createdAt: "2026-05-26T01:00:00Z", labels: ["y"] },
      ],
    });
    assert.equal(merged.length, 1);
    assert.equal(merged[0].source, "operator-decision-queue");
    assert.deepEqual(merged[0].sources, ["operator-decision-queue", "ready-for-human"]);
    // Labels from both sources are unioned.
    assert.deepEqual(merged[0].labels, ["x", "y"]);
  });

  test("sorts oldest-first", () => {
    const merged = mergeDecisionItems({
      "ready-for-human": [
        { number: 2, title: "young", url: "u2", createdAt: "2026-05-26T11:00:00Z", labels: [] },
        { number: 1, title: "old", url: "u1", createdAt: "2026-05-26T01:00:00Z", labels: [] },
      ],
    });
    assert.deepEqual(merged.map((i) => i.number), [1, 2]);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("getDecisionQueue — happy path", () => {
  test("merges digest refs, ready-for-human, and needs-info into one age-sorted list", async () => {
    const items = await getDecisionQueue({
      now: NOW,
      listIssuesBySearchOrEmpty: async (search) => {
        // Only "today"'s digest exists; yesterday's resolves empty.
        if (search.includes("Operator decision queue 2026-05-26")) {
          return [
            issueRow({
              number: 999,
              title: "Operator decision queue 2026-05-26",
              body: "Action items: #100",
              createdAt: "2026-05-26T06:00:00.000Z",
            }),
          ];
        }
        return [];
      },
      listIssuesByLabelOrEmpty: async (label) => {
        if (label === "ready-for-human") {
          return [
            issueRow({
              number: 200,
              title: "Decide tier",
              url: "https://x/200",
              createdAt: "2026-05-26T08:00:00.000Z",
              labels: ["ready-for-human"],
            }),
          ];
        }
        if (label === "needs-info") {
          return [
            issueRow({
              number: 50,
              title: "Old waiting",
              url: "https://x/50",
              createdAt: "2026-05-20T00:00:00.000Z",
              labels: ["needs-info"],
            }),
          ];
        }
        return [];
      },
    });
    // Oldest first: #50 (May 20), then #999-referenced #100 (May 26 06:00), then #200 (May 26 08:00).
    assert.deepEqual(
      items.map((i) => i.number),
      [50, 100, 200],
    );
    assert.equal(items[0].source, "needs-info");
    assert.equal(items[1].source, "operator-decision-queue");
    assert.equal(items[2].source, "ready-for-human");
  });
});

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

describe("getDecisionQueue — empty state", () => {
  test("returns [] when no source has items", async () => {
    const items = await getDecisionQueue({
      now: NOW,
      listIssuesBySearchOrEmpty: async () => [],
      listIssuesByLabelOrEmpty: async () => [],
    });
    assert.deepEqual(items, []);
  });
});

// ---------------------------------------------------------------------------
// Boundary: one source fails, the rest still ship
// ---------------------------------------------------------------------------

describe("getDecisionQueue — sub-source failure isolation", () => {
  test("digest reader rejecting → labeled lists still produce the queue", async () => {
    const items = await getDecisionQueue({
      now: NOW,
      // The *OrEmpty readers normally degrade to []; this models a harder
      // failure (the reader rejecting) to prove allSettled isolation.
      listIssuesBySearchOrEmpty: async () => {
        throw new Error("gh blew up");
      },
      listIssuesByLabelOrEmpty: async (label) =>
        label === "ready-for-human"
          ? [
              issueRow({
                number: 7,
                title: "still here",
                url: "u7",
                createdAt: "2026-05-26T01:00:00.000Z",
              }),
            ]
          : [],
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].number, 7);
  });
});

/**
 * Regression tests for the decision-queue aggregator (issue #617, PRD #615).
 *
 * After issue #915 the aggregator reads GitHub through the **GitHub Issue/PR
 * Read seam** (`src/github/issues.ts`). Tests stub the seam reader
 * (`listIssuesByLabelOrEmpty` for the ready-for-human / needs-info lists) and
 * feed the pure helpers the seam's canonical `IssueRow` shape — the raw-JSON
 * parse now lives in the seam's own suite (`github-issues.test.mts`). The pure
 * merge/extract/format helpers are tested directly.
 *
 * A third source — the dated `Operator decision queue YYYY-MM-DD` digest
 * issue — was retired by ADR-0034 §8.1 / #4621: `hydra-grill` now posts its
 * gate-fail handoff directly on the anchor issue instead of a dated queue
 * issue, so `datedTitle` / `digestRefsFromRows` / `addDays` no longer exist.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  getDecisionQueue,
  mergeDecisionItems,
} from "../src/aggregators/decision-queue.ts";
// The by-source merge skeleton and issue-ref extraction moved to their own
// seam (issue #2130); the test surface for them follows — the seam IS the
// thing being tested.
import {
  extractIssueRefs,
  labeledItemsFromRows,
  mergeBySource,
  type RawDigestInput,
  type MergedBySource,
} from "../src/aggregators/digest-issue.ts";
import type { IssueRow } from "../src/github/issues.ts";

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

describe("mergeDecisionItems — pure helper", () => {
  test("preserves first source as primary; tracks all sources", () => {
    const merged = mergeDecisionItems({
      "ready-for-human": [
        { number: 10, title: "A", url: "ua", createdAt: "2026-05-26T01:00:00Z", labels: ["x"] },
      ],
      "needs-info": [
        { number: 10, title: "A-dup", url: "ua", createdAt: "2026-05-26T01:00:00Z", labels: ["y"] },
      ],
    });
    assert.equal(merged.length, 1);
    assert.equal(merged[0].source, "ready-for-human");
    assert.deepEqual(merged[0].sources, ["ready-for-human", "needs-info"]);
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
// mergeBySource — the shared multi-source dedup skeleton (issue #2639)
// ---------------------------------------------------------------------------

describe("mergeBySource — seam dedup skeleton", () => {
  function raw(over: Partial<RawDigestInput> & { number: number }): RawDigestInput {
    return {
      number: over.number,
      title: over.title ?? `#${over.number}`,
      url: over.url ?? `u${over.number}`,
      createdAt: over.createdAt ?? "",
      labels: over.labels ?? [],
    };
  }

  const ORDER = ["a", "b", "c"] as const;
  type S = (typeof ORDER)[number];

  test("first-write-wins by ORDER priority, not input-record order", () => {
    // "b" is listed first in the input record but "a" precedes it in ORDER;
    // the primary source must be "a" (order-priority, per invariant 4).
    const merged = mergeBySource<S>(
      { b: [raw({ number: 10 })], a: [raw({ number: 10 })] },
      ORDER,
    );
    assert.equal(merged.length, 1);
    assert.equal(merged[0].source, "a");
    assert.deepEqual(merged[0].sources, ["a", "b"]);
  });

  test("sources[] accumulates every source, deduped, in ORDER order", () => {
    const merged = mergeBySource<S>(
      {
        a: [raw({ number: 1 })],
        b: [raw({ number: 1 })],
        c: [raw({ number: 1 })],
      },
      ORDER,
    );
    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0].sources, ["a", "b", "c"]);
  });

  test("preserves first-seen (ORDER-driven) emission order across numbers", () => {
    const merged = mergeBySource<S>(
      { c: [raw({ number: 99 })], a: [raw({ number: 5 })] },
      ORDER,
    );
    // "a" iterates before "c" in ORDER, so #5 emits before #99.
    assert.deepEqual(merged.map((m) => m.row.number), [5, 99]);
  });

  test("onDuplicate folds caller state onto the kept row", () => {
    const merged = mergeBySource<S>(
      { a: [raw({ number: 7, labels: ["x"] })], b: [raw({ number: 7, labels: ["y", "x"] })] },
      ORDER,
      (existing, incoming) => {
        for (const l of incoming.labels) {
          if (!existing.row.labels.includes(l)) existing.row.labels.push(l);
        }
      },
    );
    assert.deepEqual(merged[0].row.labels, ["x", "y"]);
  });

  test("omitting onDuplicate is a clean no-op on duplicates", () => {
    const merged = mergeBySource<S>(
      { a: [raw({ number: 3, labels: ["x"] })], b: [raw({ number: 3, labels: ["z"] })] },
      ORDER,
    );
    // No fold: the kept row keeps only its own labels.
    assert.deepEqual(merged[0].row.labels, ["x"]);
    assert.deepEqual(merged[0].sources, ["a", "b"]);
  });

  test("clones labels — never mutates the caller's input array", () => {
    const input = raw({ number: 4, labels: ["orig"] });
    const merged = mergeBySource<S>({ a: [input], b: [raw({ number: 4, labels: ["extra"] })] }, ORDER, (e, i) => {
      for (const l of i.labels) if (!e.row.labels.includes(l)) e.row.labels.push(l);
    });
    assert.deepEqual(merged[0].row.labels, ["orig", "extra"]);
    // The caller's original input array is untouched.
    assert.deepEqual(input.labels, ["orig"]);
  });

  test("empty / missing sources yield an empty result", () => {
    const merged: MergedBySource<S>[] = mergeBySource<S>({}, ORDER);
    assert.deepEqual(merged, []);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("getDecisionQueue — happy path", () => {
  test("merges ready-for-human and needs-info into one age-sorted list", async () => {
    const { items } = await getDecisionQueue({
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
    // Oldest first: #50 (May 20), then #200 (May 26 08:00).
    assert.deepEqual(
      items.map((i) => i.number),
      [50, 200],
    );
    assert.equal(items[0].source, "needs-info");
    assert.equal(items[1].source, "ready-for-human");
  });
});

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

describe("getDecisionQueue — empty state", () => {
  test("returns [] when no source has items", async () => {
    const { items } = await getDecisionQueue({
      listIssuesByLabelOrEmpty: async () => [],
    });
    assert.deepEqual(items, []);
  });
});

// ---------------------------------------------------------------------------
// Boundary: one source fails, the rest still ship
// ---------------------------------------------------------------------------

describe("getDecisionQueue — sub-source failure isolation", () => {
  test("ready-for-human reader rejecting → needs-info still produces the queue", async () => {
    const { items, sourcesOk } = await getDecisionQueue({
      // The *OrEmpty reader normally degrades to []; this models a harder
      // failure (the reader rejecting) to prove allSettled isolation.
      listIssuesByLabelOrEmpty: async (label) => {
        if (label === "ready-for-human") throw new Error("gh blew up");
        return label === "needs-info"
          ? [
              issueRow({
                number: 7,
                title: "still here",
                url: "u7",
                createdAt: "2026-05-26T01:00:00.000Z",
              }),
            ]
          : [];
      },
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].number, 7);
    assert.equal(sourcesOk, false, "a rejected sub-fetch flips sourcesOk false");
  });
});

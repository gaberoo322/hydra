/**
 * Regression tests for the /hydra-review pickup-set aggregator (issue #745).
 *
 * The pickup set unifies three buckets — operator-decision-queue +
 * ready-for-human + stale-blocked — which is intentionally NOT the same as the
 * dashboard-v2 `getDecisionQueue()` (whose third bucket is `needs-info`). The
 * phone-notify hook reads THIS aggregator so it mirrors what the operator sees
 * in `/hydra-review`.
 *
 * After issue #915 the aggregator reads GitHub through the **GitHub Issue/PR
 * Read seam** (`src/github/issues.ts`). Tests stub the seam readers
 * (`listIssuesBySearchOrEmpty` / `listIssuesByLabelOrEmpty`, and the
 * discriminated `listIssuesBySearch` for the open-blocker lookup) and feed the
 * pure helpers the canonical `IssueRow` shape — the raw-JSON parse now lives in
 * the seam's own suite (`github-issues.test.mts`).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  getReviewPickupSet,
  mergePickupItems,
  blockedIssuesFromRows,
  classifyStaleBlocked,
  openNumbersFromRows,
} from "../src/review-pickup.ts";
import type { IssueRow } from "../src/github/issues.ts";

const NOW = new Date("2026-05-29T12:00:00.000Z");

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
// mergePickupItems — pure helper
// ---------------------------------------------------------------------------

describe("mergePickupItems — pure helper", () => {
  test("dedupes by number; digest wins as primary source", () => {
    const merged = mergePickupItems({
      "operator-decision-queue": [{ number: 10, title: "A", url: "ua" }],
      "ready-for-human": [{ number: 10, title: "A-dup", url: "ua" }],
      "stale-blocked": [{ number: 10, title: "A-dup2", url: "ua" }],
    });
    assert.equal(merged.length, 1);
    assert.equal(merged[0].source, "operator-decision-queue");
    assert.deepEqual(merged[0].sources, [
      "operator-decision-queue",
      "ready-for-human",
      "stale-blocked",
    ]);
  });

  test("sorts by ascending issue number", () => {
    const merged = mergePickupItems({
      "ready-for-human": [
        { number: 30, title: "c", url: "u30" },
        { number: 10, title: "a", url: "u10" },
      ],
      "stale-blocked": [{ number: 20, title: "b", url: "u20" }],
    });
    assert.deepEqual(merged.map((i) => i.number), [10, 20, 30]);
  });

  test("empty input yields empty list", () => {
    assert.deepEqual(mergePickupItems({}), []);
  });
});

// ---------------------------------------------------------------------------
// blockedIssuesFromRows — pure helper
// ---------------------------------------------------------------------------

describe("blockedIssuesFromRows — pure helper", () => {
  test("returns [] on empty input", () => {
    assert.deepEqual(blockedIssuesFromRows([]), []);
  });

  test("extracts blocker refs from body, dropping self-references", () => {
    const parsed = blockedIssuesFromRows([
      issueRow({ number: 5, title: "T", url: "u5", body: "blocked by #5 and #9" }),
    ]);
    assert.equal(parsed.length, 1);
    // #5 is a self-reference and is filtered out; #9 remains.
    assert.deepEqual(parsed[0].blockerRefs, [9]);
  });

  test("no refs in body yields empty blockerRefs", () => {
    const parsed = blockedIssuesFromRows([
      issueRow({ number: 7, title: "Standalone", url: "u7", body: "Waiting on operator decision." }),
    ]);
    assert.deepEqual(parsed[0].blockerRefs, []);
  });
});

// ---------------------------------------------------------------------------
// classifyStaleBlocked — pure helper
// ---------------------------------------------------------------------------

describe("classifyStaleBlocked — pure helper", () => {
  const blocked = [
    { number: 1, title: "no refs", url: "u1", blockerRefs: [] },
    { number: 2, title: "open blocker", url: "u2", blockerRefs: [100] },
    { number: 3, title: "closed blocker", url: "u3", blockerRefs: [200] },
    { number: 4, title: "mixed", url: "u4", blockerRefs: [200, 100] },
  ];

  test("no blocker refs => stale-blocked", () => {
    const stale = classifyStaleBlocked(blocked, new Set([100]));
    assert.ok(stale.some((s) => s.number === 1));
  });

  test("open blocker present => NOT stale", () => {
    const stale = classifyStaleBlocked(blocked, new Set([100]));
    assert.ok(!stale.some((s) => s.number === 2));
    // #4 has an open blocker (#100) among its refs, so not stale.
    assert.ok(!stale.some((s) => s.number === 4));
  });

  test("only closed blockers => stale-blocked", () => {
    const stale = classifyStaleBlocked(blocked, new Set([100]));
    // #3's only ref (#200) is not in the open set, so it's stale.
    assert.ok(stale.some((s) => s.number === 3));
  });
});

// ---------------------------------------------------------------------------
// openNumbersFromRows — pure helper
// ---------------------------------------------------------------------------

describe("openNumbersFromRows — pure helper", () => {
  test("intersects reported open numbers with requested", () => {
    const open = openNumbersFromRows(
      [issueRow({ number: 100 }), issueRow({ number: 999 })],
      [100, 200],
    );
    // 100 is open and requested; 999 is open but not requested (ignored).
    assert.deepEqual([...open], [100]);
  });

  test("empty rows yields empty set", () => {
    assert.equal(openNumbersFromRows([], [1]).size, 0);
  });
});

// ---------------------------------------------------------------------------
// getReviewPickupSet — integration shape (seam-reader stubs)
// ---------------------------------------------------------------------------

describe("getReviewPickupSet — integration", () => {
  test("merges all three buckets; only stale-blocked issues survive", async () => {
    const items = await getReviewPickupSet({
      now: NOW,
      listIssuesBySearchOrEmpty: async (search) => {
        // Digest issue for today carries one ref (#100); yesterday — none.
        if (search.includes("Operator decision queue 2026-05-29")) {
          return [
            issueRow({
              number: 900,
              title: "Operator decision queue 2026-05-29",
              body: "Decide: #100",
              url: "https://x/900",
              createdAt: "2026-05-29T06:00:00Z",
            }),
          ];
        }
        return [];
      },
      listIssuesByLabelOrEmpty: async (label) => {
        if (label === "ready-for-human") {
          return [
            issueRow({ number: 200, title: "Decide tier", url: "https://x/200", createdAt: "2026-05-29T08:00:00Z" }),
          ];
        }
        if (label === "blocked") {
          // #300 has an open blocker (#100); #400 only a closed one (#500).
          return [
            issueRow({ number: 300, title: "still blocked", url: "https://x/300", body: "blocked by #100" }),
            issueRow({ number: 400, title: "stale blocked", url: "https://x/400", body: "depends on #500" }),
          ];
        }
        return [];
      },
      // open-blocker lookup over {100, 500}: only #100 is open.
      listIssuesBySearch: async () => ({ ok: true, rows: [issueRow({ number: 100 })] }),
    });
    const numbers = items.map((i) => i.number);
    // #100 (digest ref), #200 (ready-for-human), #400 (stale-blocked).
    // #300 is NOT here — its blocker #100 is still open.
    assert.deepEqual(numbers, [100, 200, 400]);
    assert.equal(items.find((i) => i.number === 400)?.source, "stale-blocked");
  });

  test("a failed open-blocker lookup conservatively treats all blockers as open", async () => {
    const items = await getReviewPickupSet({
      now: NOW,
      listIssuesBySearchOrEmpty: async () => [],
      listIssuesByLabelOrEmpty: async (label) =>
        label === "blocked"
          ? [issueRow({ number: 400, title: "blocked", url: "https://x/400", body: "depends on #500" })]
          : [],
      // Discriminated reader reports a failure → #500 treated as still-open →
      // #400 is NOT surfaced as stale (no false notification).
      listIssuesBySearch: async () => ({ ok: false, code: "gh-failed" }),
    });
    assert.deepEqual(items, []);
  });

  test("never throws — a failed sub-source contributes []", async () => {
    const items = await getReviewPickupSet({
      now: NOW,
      listIssuesBySearchOrEmpty: async () => {
        throw new Error("digest reader exploded");
      },
      listIssuesByLabelOrEmpty: async (label) =>
        label === "ready-for-human"
          ? [issueRow({ number: 200, title: "rfh", url: "https://x/200", createdAt: "2026-05-29T08:00:00Z" })]
          : [],
      listIssuesBySearch: async () => ({ ok: true, rows: [] }),
    });
    // The surviving ready-for-human source still ships.
    assert.deepEqual(items.map((i) => i.number), [200]);
  });

  test("empty board yields empty pickup set", async () => {
    const items = await getReviewPickupSet({
      now: NOW,
      listIssuesBySearchOrEmpty: async () => [],
      listIssuesByLabelOrEmpty: async () => [],
      listIssuesBySearch: async () => ({ ok: true, rows: [] }),
    });
    assert.deepEqual(items, []);
  });
});

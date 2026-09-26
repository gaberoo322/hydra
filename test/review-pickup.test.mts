/**
 * Regression tests for the /hydra-review pickup-set aggregator (issue #745).
 *
 * The pickup set unifies two buckets — ready-for-human + stale-blocked —
 * which is intentionally NOT the same as the dashboard-v2 `getDecisionQueue()`
 * (whose second bucket is `needs-info`). A third bucket — the dated
 * `Operator decision queue YYYY-MM-DD` digest issue — was retired by
 * ADR-0034 §8.1 / #4621: `hydra-grill` now posts its gate-fail handoff
 * directly on the anchor issue (a `## hydra-grill handoff` comment plus the
 * `ready-for-human` label) instead of a dated queue issue.
 * `hitl-grill` was a fourth bucket from #4026 until the lane moved to its own
 * skill (`/hydra-hitl-grill`): parked ideas are NOT operator-attention items,
 * so `/hydra-review` — and the phone-notify hook that mirrors it — ignore them. The
 * phone-notify hook reads THIS aggregator so it mirrors what the operator sees
 * in `/hydra-review`.
 *
 * After issue #915 the aggregator reads GitHub through the **GitHub Issue/PR
 * Read seam** (`src/github/issues.ts`). Tests stub the seam readers
 * (`listIssuesByLabelOrEmpty`, and the discriminated `listIssuesBySearch` for
 * the open-blocker lookup) and feed the pure helpers the canonical `IssueRow`
 * shape — the raw-JSON parse now lives in the seam's own suite
 * (`github-issues.test.mts`).
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
  test("dedupes by number; ready-for-human wins as primary source", () => {
    const merged = mergePickupItems({
      "ready-for-human": [{ number: 10, title: "A-dup", url: "ua" }],
      "stale-blocked": [{ number: 10, title: "A-dup2", url: "ua" }],
    });
    assert.equal(merged.length, 1);
    assert.equal(merged[0].source, "ready-for-human");
    assert.deepEqual(merged[0].sources, [
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

  test("hitl-grill is not a pickup source — the type and the order exclude it", () => {
    // Regression for the /hydra-hitl-grill split: a caller that still passes a
    // hitl-grill bucket contributes nothing, because mergePickupItems iterates
    // only the three review sources.
    const merged = mergePickupItems({
      "stale-blocked": [{ number: 10, title: "A", url: "ua" }],
      ...({ "hitl-grill": [{ number: 11, title: "parked", url: "up" }] } as object),
    });
    assert.deepEqual(merged.map((i) => i.number), [10]);
    assert.deepEqual(merged[0].sources, ["stale-blocked"]);
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
  test("merges both buckets; only stale-blocked issues survive", async () => {
    const items = await getReviewPickupSet({
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
    // #200 (ready-for-human), #400 (stale-blocked).
    // #300 is NOT here — its blocker #100 is still open.
    assert.deepEqual(numbers, [200, 400]);
    assert.equal(items.find((i) => i.number === 400)?.source, "stale-blocked");
  });

  test("a failed open-blocker lookup conservatively treats all blockers as open", async () => {
    const items = await getReviewPickupSet({
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
      listIssuesByLabelOrEmpty: async (label) => {
        if (label === "ready-for-human") throw new Error("ready-for-human reader exploded");
        if (label === "blocked") {
          return [issueRow({ number: 400, title: "stale blocked", url: "https://x/400", body: "depends on #500" })];
        }
        return [];
      },
      // #500 not in the open set → #400 stale-blocked survives.
      listIssuesBySearch: async () => ({ ok: true, rows: [] }),
    });
    // The surviving stale-blocked source still ships.
    assert.deepEqual(items.map((i) => i.number), [400]);
  });

  test("empty board yields empty pickup set", async () => {
    const items = await getReviewPickupSet({
      listIssuesByLabelOrEmpty: async () => [],
      listIssuesBySearch: async () => ({ ok: true, rows: [] }),
    });
    assert.deepEqual(items, []);
  });

  test("hitl-grill issues never enter the pickup set, and the lane is never even read", async () => {
    const labelsRead: string[] = [];
    const items = await getReviewPickupSet({
      listIssuesByLabelOrEmpty: async (label) => {
        labelsRead.push(label);
        return label === "hitl-grill"
          ? [issueRow({ number: 700, title: "Parked idea", url: "https://x/700" })]
          : [];
      },
      listIssuesBySearch: async () => ({ ok: true, rows: [] }),
    });
    assert.deepEqual(items, []);
    assert.ok(
      !labelsRead.includes("hitl-grill"),
      "/hydra-review must not spend a gh call on the park lane — /hydra-hitl-grill owns it",
    );
  });

  test("an issue in both hitl-grill and ready-for-human surfaces once, under ready-for-human only", async () => {
    const items = await getReviewPickupSet({
      listIssuesByLabelOrEmpty: async (label) => {
        if (label === "ready-for-human" || label === "hitl-grill") {
          return [issueRow({ number: 200, title: "Both", url: "https://x/200" })];
        }
        return [];
      },
      listIssuesBySearch: async () => ({ ok: true, rows: [] }),
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].source, "ready-for-human");
    assert.deepEqual(items[0].sources, ["ready-for-human"]);
  });
});

/**
 * Unit tests for the shared inter-issue blocker seam (issue #3059,
 * `src/github/blockers.ts`).
 *
 *   1. `extractStrictBlockerRefs` — the STRICT `blocked by #N` / `depends on #N`
 *      parser. Pins that a bare `#N` mention is NOT a blocker (a false positive
 *      would silently starve dispatch), that code-span refs are ignored, and
 *      that both anchored conventions are recognised + deduped.
 *   2. `fetchOpenBlockerNumbers` — the batched open/closed resolver, with its
 *      load-bearing FAIL-SAFE (a lookup failure treats every referenced blocker
 *      as still-open).
 *
 * No live `gh` — the resolver's reader is injected.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  extractStrictBlockerRefs,
  fetchOpenBlockerNumbers,
  openNumbersFromRows,
} from "../src/github/blockers.ts";
import type { IssueRow, IssueReadResult } from "../src/github/issues.ts";

function issueRow(partial: Partial<IssueRow> & { number: number }): IssueRow {
  return {
    number: partial.number,
    title: partial.title ?? `Issue #${partial.number}`,
    url: partial.url ?? `https://github.com/x/y/issues/${partial.number}`,
    createdAt: partial.createdAt ?? "",
    labels: partial.labels ?? [],
    body: partial.body ?? "",
    state: partial.state ?? "OPEN",
    updatedAt: partial.updatedAt ?? "",
  };
}

// ---------------------------------------------------------------------------
// extractStrictBlockerRefs — strict parser
// ---------------------------------------------------------------------------

describe("extractStrictBlockerRefs — strict blocker parse (issue #3059)", () => {
  test("matches `blocked by #N` and `depends on #N`, deduped, in order", () => {
    const refs = extractStrictBlockerRefs(
      "Blocked by #10.\nAlso depends on #20 and blocked by #10 again.",
    );
    assert.deepEqual(refs, [10, 20]);
  });

  test("matches hyphenated and colon variants (`blocked-by:`, `depends-on`)", () => {
    assert.deepEqual(extractStrictBlockerRefs("blocked-by: #5"), [5]);
    assert.deepEqual(extractStrictBlockerRefs("depends-on #6"), [6]);
    assert.deepEqual(extractStrictBlockerRefs("blocks #7"), [7]);
  });

  test("a BARE `#N` mention is NOT a strict blocker (false-positive guard)", () => {
    // The whole point of strict parsing: an incidental "see also #99" or
    // "part of #42" must never gate dispatch.
    assert.deepEqual(extractStrictBlockerRefs("See also #99, part of #42."), []);
  });

  test("a `#N` inside a code span is ignored (code-span-safe)", () => {
    assert.deepEqual(
      extractStrictBlockerRefs("Blocked by `#10` in a snippet."),
      [],
    );
    // But a real ref outside the span still counts.
    assert.deepEqual(
      extractStrictBlockerRefs("`code #10` but blocked by #11"),
      [11],
    );
  });

  test("empty / absent body → []", () => {
    assert.deepEqual(extractStrictBlockerRefs(""), []);
    assert.deepEqual(extractStrictBlockerRefs(undefined), []);
    assert.deepEqual(extractStrictBlockerRefs(null), []);
  });
});

// ---------------------------------------------------------------------------
// fetchOpenBlockerNumbers — batched resolver + fail-safe
// ---------------------------------------------------------------------------

describe("fetchOpenBlockerNumbers — resolver + fail-safe (issue #3059)", () => {
  test("empty input → empty set, no gh call", async () => {
    let called = false;
    const open = await fetchOpenBlockerNumbers([], {
      listIssuesBySearch: async () => {
        called = true;
        return { ok: true, rows: [] };
      },
    });
    assert.equal(open.size, 0);
    assert.equal(called, false);
  });

  test("returns only the requested numbers reported OPEN by the search", async () => {
    const open = await fetchOpenBlockerNumbers([10, 20, 30], {
      // 10 open, 20 open; 30 closed (absent from open-state rows). Row 999 is
      // an unrelated match that must be intersected away.
      listIssuesBySearch: async () => ({
        ok: true,
        rows: [issueRow({ number: 10 }), issueRow({ number: 20 }), issueRow({ number: 999 })],
      }),
    });
    assert.deepEqual([...open].sort((a, b) => a - b), [10, 20]);
  });

  test("FAIL-SAFE: a lookup failure treats ALL referenced blockers as open", async () => {
    const open = await fetchOpenBlockerNumbers([10, 20], {
      listIssuesBySearch: async () =>
        ({ ok: false, code: "gh-failed" } as IssueReadResult<IssueRow>),
    });
    assert.deepEqual([...open].sort((a, b) => a - b), [10, 20]);
  });
});

// ---------------------------------------------------------------------------
// openNumbersFromRows — pure helper (hoisted from review-pickup)
// ---------------------------------------------------------------------------

describe("openNumbersFromRows — pure helper (issue #3059)", () => {
  test("intersects rows against the requested set", () => {
    const open = openNumbersFromRows(
      [issueRow({ number: 1 }), issueRow({ number: 2 }), issueRow({ number: 999 })],
      [1, 2, 3],
    );
    assert.deepEqual([...open].sort((a, b) => a - b), [1, 2]);
  });

  test("no rows → empty set", () => {
    assert.equal(openNumbersFromRows([], [1, 2]).size, 0);
  });
});

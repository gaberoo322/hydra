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
 *   3. `extractParentEpicRefs` / `extractGatingBlockerRefs` — the parent-epic
 *      exemption (issue #4823): a strict blocker the SAME body also declares as
 *      its parent/epic (`Child of #N` / `Parent: #N` / `Part of #N`) no longer
 *      gates — membership is not ordering, and a parent epic is open BECAUSE its
 *      children are.
 *
 * No live `gh` — the resolver's reader is injected.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  extractStrictBlockerRefs,
  extractParentEpicRefs,
  extractGatingBlockerRefs,
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
// extractParentEpicRefs + extractGatingBlockerRefs — parent-epic exemption
// (issue #4823)
// ---------------------------------------------------------------------------

describe("extractParentEpicRefs — parent/epic declaration parse (issue #4823)", () => {
  test("matches the three declared conventions, deduped", () => {
    // `Child of #N` — the convention the 2026-10-02 Target-starvation
    // remediation itself authored on the live board.
    assert.deepEqual(extractParentEpicRefs("Child of #194 (M5 Paper Clock)."), [194]);
    assert.deepEqual(extractParentEpicRefs("child issue of #194"), [194]);
    assert.deepEqual(extractParentEpicRefs("Child-of #194"), [194]);
    // `Parent: #N` family.
    assert.deepEqual(extractParentEpicRefs("Parent: #194"), [194]);
    assert.deepEqual(extractParentEpicRefs("parent epic: #194"), [194]);
    assert.deepEqual(extractParentEpicRefs("parent issue: #194"), [194]);
    // `Part of #N`.
    assert.deepEqual(extractParentEpicRefs("Part of #194."), [194]);
    assert.deepEqual(extractParentEpicRefs("part-of #194"), [194]);
    // Dedup across patterns; like the strict extractor, results order by
    // PATTERN then first appearance within a pattern (pattern 1 = `child of`
    // runs before pattern 3 = `part of`), not document order.
    assert.deepEqual(extractParentEpicRefs("Part of #9. Child of #8, part of #9."), [8, 9]);
  });

  test("a bare `#N` mention, or `parent OF #N`, is NOT a parent ref", () => {
    // "the parent of #194" describes #194's parent — the opposite direction —
    // and must not read as declaring #194 as THIS issue's parent.
    assert.deepEqual(extractParentEpicRefs("The parent of #194 is #100."), []);
    assert.deepEqual(extractParentEpicRefs("See also #99."), []);
  });

  test("a `#N` inside a code span is ignored (code-span-safe, same guard)", () => {
    assert.deepEqual(extractParentEpicRefs("Child of `#194` in a snippet."), []);
    assert.deepEqual(extractParentEpicRefs("`child of #194` but parent: #200"), [200]);
  });

  test("case-insensitive; empty / absent body → []", () => {
    assert.deepEqual(extractParentEpicRefs("CHILD OF #194"), [194]);
    assert.deepEqual(extractParentEpicRefs(""), []);
    assert.deepEqual(extractParentEpicRefs(undefined), []);
    assert.deepEqual(extractParentEpicRefs(null), []);
  });
});

describe("extractGatingBlockerRefs — strict refs minus declared parents (issue #4823)", () => {
  test("the incident shape: `Blocked by #194` + `Child of #194` gates on NOTHING", () => {
    const body =
      "Child of #194 (M5 Paper Clock), split out of its first slice.\n\nBlocked by #194.";
    assert.deepEqual(extractStrictBlockerRefs(body), [194]);
    assert.deepEqual(extractParentEpicRefs(body), [194]);
    assert.deepEqual(extractGatingBlockerRefs(body, 200), []);
  });

  test("a NON-parent strict blocker still gates (sibling slice, unrelated dep)", () => {
    const body = "Child of #194.\n\nBlocked by #195 (sibling slice) and depends on #196.";
    assert.deepEqual(extractGatingBlockerRefs(body, 200), [195, 196]);
  });

  test("the pre-remediation shape (bare `Blocked by`, no marker) still gates", () => {
    // The 49add2ba board shape BEFORE the hand remediation reworded bodies:
    // no parent marker, so #194 remains a gating blocker — visible via
    // ready_blocker_excluded, not silently dropped.
    assert.deepEqual(extractGatingBlockerRefs("Blocked by #194.", 200), [194]);
  });

  test("self-references are excluded (an issue can't block itself)", () => {
    assert.deepEqual(extractGatingBlockerRefs("blocked by #300", 300), []);
    // Self-ref is dropped even when it is also a declared parent.
    assert.deepEqual(extractGatingBlockerRefs("Child of #300, blocked by #300.", 300), []);
  });

  test("the exemption is body-scoped: a parent ref on ANOTHER issue's body doesn't travel", () => {
    // Only the SAME body's parent declaration defuses its own strict ref.
    assert.deepEqual(extractGatingBlockerRefs("Blocked by #194.", 200), [194]);
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

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
 *   3. `extractDeclaredEpicRefs` + the Epic subtraction inside
 *      `extractStrictBlockerRefs` (issue #4823): a strict blocker the SAME body
 *      also declares as its Epic (`## Parent` heading / `Parent: #N` /
 *      `Child of #N`) is subtracted — membership is not ordering, and an Epic
 *      is open BECAUSE its children are.
 *
 * No live `gh` — the resolver's reader is injected.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  extractStrictBlockerRefs,
  extractDeclaredEpicRefs,
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
// extractDeclaredEpicRefs + Epic subtraction in extractStrictBlockerRefs
// (issue #4823)
// ---------------------------------------------------------------------------

describe("extractDeclaredEpicRefs — declared-Epic marker parse (issue #4823)", () => {
  test("matches exactly the three declared forms", () => {
    // (c) `Child of #N` — the Target child-issue shape.
    assert.deepEqual(extractDeclaredEpicRefs("**Child of #194 (M5 Paper Clock).**"), [194]);
    // (b) inline `Parent: #N` / `Parent epic: #N`.
    assert.deepEqual(extractDeclaredEpicRefs("Parent: #194"), [194]);
    assert.deepEqual(extractDeclaredEpicRefs("parent epic: #194"), [194]);
    // (a) `## Parent` heading + (optional blank lines, optional bullet) + #N.
    assert.deepEqual(extractDeclaredEpicRefs("## Parent\n\n#42\n\n## What"), [42]);
    assert.deepEqual(extractDeclaredEpicRefs("### Parent epic\n- #42"), [42]);
    assert.deepEqual(extractDeclaredEpicRefs("# Parent\n* #7"), [7]);
    // CRLF line endings (GitHub web-UI edits) still match form (a).
    assert.deepEqual(extractDeclaredEpicRefs("## Parent\r\n\r\n#42\r\n\r\n## What"), [42]);
    assert.deepEqual(extractDeclaredEpicRefs("### Parent epic\r\n- #42"), [42]);
    // Inline form is line-anchored: prose mid-sentence is not a marker.
    assert.deepEqual(extractDeclaredEpicRefs("Text\n- parent: #9"), [9]);
    assert.deepEqual(extractDeclaredEpicRefs("the grandparent: #9 is unrelated"), []);
    assert.deepEqual(extractDeclaredEpicRefs("not a parent: #9 inline prose"), []);
  });

  test("anything else is NOT an Epic declaration", () => {
    assert.deepEqual(extractDeclaredEpicRefs("Part of #194."), []);
    assert.deepEqual(extractDeclaredEpicRefs("See #194, follow-up of #195."), []);
    assert.deepEqual(extractDeclaredEpicRefs("The parent of #194 is #100."), []);
    // A heading that is not a Parent heading, then a bare ref.
    assert.deepEqual(extractDeclaredEpicRefs("## Context\n\n#42"), []);
  });

  test("code-span-safe, case-insensitive, empty-safe", () => {
    assert.deepEqual(extractDeclaredEpicRefs("Child of `#194` in a snippet."), []);
    assert.deepEqual(extractDeclaredEpicRefs("CHILD OF #194"), [194]);
    assert.deepEqual(extractDeclaredEpicRefs(""), []);
    assert.deepEqual(extractDeclaredEpicRefs(undefined), []);
    assert.deepEqual(extractDeclaredEpicRefs(null), []);
  });
});

describe("extractStrictBlockerRefs — declared-Epic subtraction (issue #4823)", () => {
  test("the incident shape: `Blocked by #194` + `Child of #194` yields no strict ref", () => {
    const body =
      "**Child of #194 (M5 Paper Clock), split out of its first slice.** Blocked by #194.";
    assert.deepEqual(extractStrictBlockerRefs(body), []);
  });

  test("a non-Epic strict ref in the same body still blocks (#204 shape)", () => {
    assert.deepEqual(
      extractStrictBlockerRefs("Child of #194. Blocked by #194 and depends on #126."),
      [126],
    );
  });

  test("the pre-remediation shape (bare `Blocked by`, no marker) still blocks", () => {
    assert.deepEqual(extractStrictBlockerRefs("Blocked by #194."), [194]);
  });

  test("hydra-prd child body: Epic via `## Parent` is subtracted, sibling blocker kept", () => {
    const body = "## Parent\n\n#42\n\n## Blocked by\n- Blocked by #43\n- Blocked by #42";
    assert.deepEqual(extractStrictBlockerRefs(body), [43]);
  });

  test("the subtraction is body-scoped and `part of` does NOT subtract", () => {
    assert.deepEqual(extractStrictBlockerRefs("Part of #194. Blocked by #194."), [194]);
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

// ---------------------------------------------------------------------------
// Blocker clearance verdict (issue #4806)
// ---------------------------------------------------------------------------

import {
  extractClearanceBlockerRefs,
  findClearedBlockedIssues,
  type BlockerRefState,
} from "../src/github/blockers.ts";

describe("extractClearanceBlockerRefs (#4806)", () => {
  test("includes every #N on a strict-match line, excludes Parent/see-also lines and self", () => {
    const body = [
      "## Parent",
      "#4619",
      "Blocked by #100 and #101, also #7",
      "See also #200",
    ].join("\n");
    assert.deepEqual(extractClearanceBlockerRefs(body, 7), [100, 101]);
  });

  test("ignores code spans and empty bodies", () => {
    assert.deepEqual(extractClearanceBlockerRefs("Blocked by `#5` only"), []);
    assert.deepEqual(extractClearanceBlockerRefs(null), []);
  });
});

describe("findClearedBlockedIssues (#4806)", () => {
  const bodies: Record<number, string | null> = {
    1: "Blocked by #10 and #11\n\n## Files in scope\n- src/a.ts",
    2: "Blocked by #10\n\n## Files in scope\n- src/a.ts",
    3: "No blockers here, see #10\n\n## Files in scope\n- src/a.ts",
    4: "Blocked by #10",
    5: null,
  };
  const mk = (
    over: {
      open?: (n: number[]) => Promise<Set<number>>;
      states?: Record<number, BlockerRefState>;
    } = {},
  ) => ({
    readBody: async (n: number) => bodies[n] ?? null,
    fetchOpen: over.open ?? (async () => new Set<number>()),
    resolveRef: async (n: number): Promise<BlockerRefState> =>
      over.states?.[n] ?? "closed",
    hasScope: (b: string) => /Files in scope/.test(b),
  });

  test("promotes only issues with all blockers cleared, a ref, and scope", async () => {
    const res = await findClearedBlockedIssues([1, 2, 3, 4, 5], mk());
    assert.deepEqual(res, [
      { issue: 1, cleared: [10, 11] },
      { issue: 2, cleared: [10] },
    ]);
  });

  test("an open or unresolvable ref holds the issue; merged PR clears", async () => {
    const res = await findClearedBlockedIssues(
      [1, 2],
      mk({ states: { 10: "merged", 11: "unknown" } }),
    );
    assert.deepEqual(res, [{ issue: 2, cleared: [10] }]);
  });

  test("failed batched open lookup (everything reported open) promotes nothing", async () => {
    const res = await findClearedBlockedIssues(
      [1, 2],
      mk({ open: async (ns) => new Set(ns) }),
    );
    assert.deepEqual(res, []);
  });

  test("cross-repo owner/repo#N blocker ref holds the issue", async () => {
    bodies[6] = "Blocked by other/repo#10\n\n## Files in scope\n- src/a.ts";
    const res = await findClearedBlockedIssues([6], mk());
    assert.deepEqual(res, []);
  });

  test("a throwing dependency is caught and promotes nothing", async () => {
    const res = await findClearedBlockedIssues([1], {
      ...mk(),
      resolveRef: async () => {
        throw new Error("boom");
      },
    });
    assert.deepEqual(res, []);
  });
});

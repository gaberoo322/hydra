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
 *   3. The declared-Epic marker parse (module-private) + the Epic subtraction inside
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

describe("declared-Epic marker parse, observed via extractStrictBlockerRefs subtraction (issue #4823/#4880)", () => {
  // A marker declares #N as the Epic, so the SAME body's `Blocked by #N` is
  // subtracted ([]). A non-marker leaves it a real blocker ([N]).
  const accepted: Array<[string, string, number]> = [
    ["(c) bold Child of with trailing text", "**Child of #194 (M5 Paper Clock).**\nBlocked by #194", 194],
    ["(c) uppercase", "CHILD OF #194\nBlocked by #194", 194],
    ["(c) bullet", "- Child of #9\nBlocked by #9", 9],
    ["(c) underscore emphasis", "__Child of #3__\nBlocked by #3", 3],
    ["(c) sentence-start after period", "Child of #194. Blocked by #194", 194],
    ["(c) mid-line producer shape", "**Follow-up of #202 (x).** Child of #194 (M5).\nBlocked by #194", 194],
    ["(b) Parent:", "Parent: #194\nBlocked by #194", 194],
    ["(b) parent epic:", "parent epic: #194\nBlocked by #194", 194],
    ["(b) bullet parent:", "Text\n- parent: #9\nBlocked by #9", 9],
    ["(a) heading", "## Parent\n\n#42\n\n## What\nBlocked by #42", 42],
    ["(a) heading + bullet", "### Parent epic\n- #42\nBlocked by #42", 42],
    ["(a) h1 + star bullet", "# Parent\n* #7\nBlocked by #7", 7],
    ["(a) CRLF", "## Parent\r\n\r\n#42\r\n\r\n## What\r\nBlocked by #42", 42],
    ["(a) CRLF bullet", "### Parent epic\r\n- #42\r\nBlocked by #42", 42],
  ];
  for (const [name, body, n] of accepted) {
    test(`accepted marker ${name} subtracts #${n}`, () => {
      assert.deepEqual(extractStrictBlockerRefs(body), []);
    });
  }

  const rejected: Array<[string, string, number]> = [
    ["part of", "Part of #194.\nBlocked by #194", 194],
    ["see / follow-up of", "See #194, follow-up of #194.\nBlocked by #194", 194],
    ["parent of", "The parent of #194 is #100.\nBlocked by #194", 194],
    ["non-Parent heading", "## Context\n\n#42\nBlocked by #42", 42],
    ["code-span", "Child of `#194` in a snippet.\nBlocked by #194", 194],
    ["grandparent:", "the grandparent: #9 is unrelated\nBlocked by #9", 9],
    ["not a parent:", "not a parent: #9 inline prose\nBlocked by #9", 9],
    ["negated child of (#4880)", "Not a child of #194; blocked by #194.", 194],
    ["mid-sentence child of", "This is a child of #5.\nBlocked by #5", 5],
    ["grandchild of", "the grandchild of #4\nBlocked by #4", 4],
  ];
  for (const [name, body, n] of rejected) {
    test(`rejected marker ${name} leaves #${n} a blocker`, () => {
      assert.deepEqual(extractStrictBlockerRefs(body), [n]);
    });
  }

  test("prose-negation regression: a negated child-of never drops a real blocker (#4880)", () => {
    assert.deepEqual(extractStrictBlockerRefs("Not a child of #194; blocked by #194."), [194]);
  });

  test("form (c) is sentence-anchored: negation and mid-sentence prose are not markers (#4880)", () => {
    for (const body of [
      "Not a child of #194; blocked by #194.",
      "This is a child of #5; blocked by #5.",
      "the grandchild of #4; blocked by #4.",
    ]) {
      const n = Number(/#(\d+)/.exec(body)![1]);
      assert.deepEqual(extractStrictBlockerRefs(body), [n], body);
    }
  });

  test("empty / absent body is empty-safe", () => {
    assert.deepEqual(extractStrictBlockerRefs(""), []);
    assert.deepEqual(extractStrictBlockerRefs(undefined), []);
    assert.deepEqual(extractStrictBlockerRefs(null), []);
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

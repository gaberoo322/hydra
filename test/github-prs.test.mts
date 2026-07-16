/**
 * Regression tests for the PR-list Read surface (`src/github/prs.ts`),
 * extracted from the GitHub Issue/PR Read seam by architecture-scan issue #3370.
 *
 * These import DIRECTLY from `../src/github/prs.ts` (the leverage the extraction
 * exists to unlock — the PR-list parser can be exercised without pulling in the
 * issue-list machinery). The identical assertions imported from
 * `../src/github/issues.ts` still pass via that module's re-export
 * (`test/github-issues.test.mts`), which pins the zero-diff back-compat surface.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  PR_LIST_JSON_FIELDS,
  parsePrRows,
  listOpenPrs,
  listOpenPrsOrEmpty,
  type PrRow,
} from "../src/github/prs.ts";

// The extraction must not reshape the surface: prs.ts symbols are re-exported
// from issues.ts at their prior import paths (zero-diff for existing consumers).
import {
  PR_LIST_JSON_FIELDS as PR_LIST_JSON_FIELDS_via_issues,
  parsePrRows as parsePrRows_via_issues,
  listOpenPrs as listOpenPrs_via_issues,
  listOpenPrsOrEmpty as listOpenPrsOrEmpty_via_issues,
} from "../src/github/issues.ts";

describe("github/prs.ts — parsePrRows (direct import)", () => {
  test("normalizes the status-check rollup and synthesizes a pull URL", () => {
    const rows = parsePrRows(
      [
        {
          number: 5,
          title: "PR",
          updatedAt: "2026-06-01T00:00:00Z",
          statusCheckRollup: [
            { conclusion: "FAILURE", name: "ci" },
            "garbage",
            { context: "legacy-status" },
          ],
        },
      ],
      "acme/widgets",
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].url, "https://github.com/acme/widgets/pull/5");
    assert.equal(rows[0].statusCheckRollup.length, 2);
    assert.equal(rows[0].statusCheckRollup[0].conclusion, "FAILURE");
    assert.equal(rows[0].statusCheckRollup[1].context, "legacy-status");
  });

  test("extracts state/headRefName/createdAt for the lifecycle-bridge view", () => {
    const rows = parsePrRows(
      [
        {
          number: 9,
          title: "P",
          state: "merged",
          headRefName: "agent-deadbeef",
          createdAt: "2026-06-20T10:00:00Z",
        },
      ],
      "acme/widgets",
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, "MERGED");
    assert.equal(rows[0].headRefName, "agent-deadbeef");
    assert.equal(rows[0].createdAt, "2026-06-20T10:00:00Z");
  });

  test("missing lifecycle fields default to '' (never throws)", () => {
    const rows: PrRow[] = parsePrRows(
      [{ number: 9, title: "P", statusCheckRollup: [] }],
      "acme/widgets",
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, "");
    assert.equal(rows[0].headRefName, "");
    assert.equal(rows[0].createdAt, "");
  });

  test("drops rows without a positive integer number (never throws)", () => {
    const rows = parsePrRows(
      [{ title: "no-number" }, { number: 0 }, { number: -3 }, { number: 7 }],
      "acme/widgets",
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].number, 7);
  });

  test("non-array payload folds to []", () => {
    assert.deepEqual(parsePrRows(null, "acme/widgets"), []);
    assert.deepEqual(parsePrRows({ number: 1 }, "acme/widgets"), []);
  });
});

describe("github/prs.ts — field-set + zero-diff re-export parity (#3370)", () => {
  test("PR_LIST_JSON_FIELDS is the canonical PR field set", () => {
    assert.equal(
      PR_LIST_JSON_FIELDS,
      "number,state,title,url,headRefName,createdAt,updatedAt,statusCheckRollup",
    );
  });

  test("issues.ts re-exports the same symbols (byte-identical bindings)", () => {
    // The re-export must resolve to the SAME runtime bindings — this is what
    // keeps pr-lifecycle-bridge/snapshot/stuck-items zero-diff after the move.
    assert.equal(PR_LIST_JSON_FIELDS_via_issues, PR_LIST_JSON_FIELDS);
    assert.equal(parsePrRows_via_issues, parsePrRows);
    assert.equal(listOpenPrs_via_issues, listOpenPrs);
    assert.equal(listOpenPrsOrEmpty_via_issues, listOpenPrsOrEmpty);
  });
});

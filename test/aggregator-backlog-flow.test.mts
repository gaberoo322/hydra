/**
 * Regression tests for the backlog-flow aggregator (issue #620, PRD #615).
 *
 * After issue #915 the aggregator reads GitHub through the **GitHub Issue/PR
 * Read seam** (`src/github/issues.ts`). Tests stub the seam readers
 * (`listIssuesBySearchOrEmpty` for the created/closed windows,
 * `listIssuesByLabelOrEmpty` for the blocked snapshot) with the seam's
 * canonical `IssueRow` shape — only `labels` are read for class bucketing, so
 * the raw-JSON parse now lives in the seam's own suite (`github-issues.test.mts`).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  getBacklogFlow,
  classFromLabels,
  bucketByClass,
  clampWindowDays,
  iso8601DateOnly,
} from "../src/aggregators/backlog-flow.ts";
import type { IssueRow } from "../src/github/issues.ts";

const NOW = new Date("2026-05-26T12:00:00.000Z");

function row(number: number, labels: string[]): IssueRow {
  return {
    number,
    title: `Issue #${number}`,
    url: `https://github.com/gaberoo322/hydra/issues/${number}`,
    createdAt: "",
    labels,
    body: "",
    state: "OPEN",
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("classFromLabels", () => {
  test("returns the known class label", () => {
    assert.equal(classFromLabels(["dev_orch", "ready-for-agent"]), "dev_orch");
  });
  test("returns 'unclassified' when no known label is present", () => {
    assert.equal(classFromLabels(["bug", "needs-info"]), "unclassified");
  });
  test("returns 'unclassified' on empty labels", () => {
    assert.equal(classFromLabels([]), "unclassified");
  });
  test("first matching label wins", () => {
    assert.equal(classFromLabels(["qa", "dev_orch"]), "qa");
  });
});

describe("bucketByClass", () => {
  test("tallies into one row per class", () => {
    const added = [row(1, ["dev_orch"]), row(2, ["dev_orch"]), row(3, ["qa"])];
    const closed = [row(4, ["dev_orch"])];
    const blocked = [row(5, ["dev_target"])];
    const rows = bucketByClass(added, closed, blocked);
    const dev_orch = rows.find((r) => r.class === "dev_orch");
    assert.deepEqual(dev_orch, { class: "dev_orch", added: 2, closed: 1, blocked: 0 });
    const qa = rows.find((r) => r.class === "qa");
    assert.deepEqual(qa, { class: "qa", added: 1, closed: 0, blocked: 0 });
    const dev_target = rows.find((r) => r.class === "dev_target");
    assert.deepEqual(dev_target, { class: "dev_target", added: 0, closed: 0, blocked: 1 });
  });

  test("unclassified bucket collects unlabelled issues", () => {
    const rows = bucketByClass([row(1, []), row(2, ["bug"])], [], []);
    const unc = rows.find((r) => r.class === "unclassified");
    assert.equal(unc?.added, 2);
  });

  test("rows sorted by total descending", () => {
    const added = [row(1, ["qa"]), row(2, ["dev_orch"]), row(3, ["dev_orch"]), row(4, ["dev_orch"])];
    const rows = bucketByClass(added, [], []);
    assert.equal(rows[0].class, "dev_orch");
  });
});

describe("clampWindowDays", () => {
  test("default for non-finite", () => {
    assert.equal(clampWindowDays(NaN), 7);
  });
  test("clamps to 1 below", () => {
    assert.equal(clampWindowDays(0), 1);
  });
  test("clamps to 30 above", () => {
    assert.equal(clampWindowDays(365), 30);
  });
});

describe("iso8601DateOnly", () => {
  test("strips the time portion", () => {
    assert.equal(iso8601DateOnly(new Date("2026-05-26T12:34:56.000Z")), "2026-05-26");
  });
});

// ---------------------------------------------------------------------------
// Integration shape
// ---------------------------------------------------------------------------

describe("getBacklogFlow — happy path", () => {
  test("invokes the three sub-sources and bundles per-class totals", async () => {
    const result = await getBacklogFlow(7, {
      now: NOW,
      listIssuesBySearchOrEmpty: async (search) => {
        if (search.startsWith("created:>=")) {
          return [row(1, ["dev_orch"]), row(2, ["qa"])];
        }
        if (search.startsWith("closed:>=")) {
          return [row(3, ["dev_orch"])];
        }
        return [];
      },
      listIssuesByLabelOrEmpty: async (label) =>
        label === "blocked" ? [row(4, ["dev_target", "blocked"])] : [],
    });
    assert.equal(result.windowDays, 7);
    assert.equal(result.totals.added, 2);
    assert.equal(result.totals.closed, 1);
    assert.equal(result.totals.blocked, 1);
    const dev_orch = result.byClass.find((r) => r.class === "dev_orch");
    assert.equal(dev_orch?.added, 1);
    assert.equal(dev_orch?.closed, 1);
  });
});

describe("getBacklogFlow — sub-source failure isolation", () => {
  test("when one source rejects, other columns still ship", async () => {
    const result = await getBacklogFlow(7, {
      now: NOW,
      // The *OrEmpty readers normally degrade to []; this models a harder
      // failure (the reader rejecting) to prove allSettled isolation.
      listIssuesBySearchOrEmpty: async (search) => {
        if (search.startsWith("created:>=")) throw new Error("added broken");
        if (search.startsWith("closed:>=")) return [row(1, ["qa"])];
        return [];
      },
      listIssuesByLabelOrEmpty: async () => [],
    });
    assert.equal(result.totals.added, 0);
    assert.equal(result.totals.closed, 1);
  });
});

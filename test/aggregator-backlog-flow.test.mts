/**
 * Regression tests for the backlog-flow aggregator (issue #620, PRD #615).
 *
 * After issue #915 the aggregator reads GitHub through the **GitHub Issue/PR
 * Read seam** (`src/github/issues.ts`). Tests stub the seam readers
 * (`listIssuesBySearchOrEmpty` for the created/closed windows,
 * `listIssuesByLabelOrEmpty` for the blocked snapshot) with the seam's
 * canonical `IssueRow` shape — only `labels` are read for bucketing, so
 * the raw-JSON parse now lives in the seam's own suite (`github-issues.test.mts`).
 *
 * After issue #1672 bucketing classifies by the live **provenance label**
 * vocabulary served from the Dispatch-Class Taxonomy Module
 * (`tool-scout` / `architecture-scan` / `cleanup-scan` + residual `sentry`);
 * issues with no provenance label fall to the `unclassified` residual bucket.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  getBacklogFlow,
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

describe("bucketByClass — provenance vocabulary (#1672)", () => {
  test("tallies into one row per provenance label", () => {
    const added = [row(1, ["cleanup-scan"]), row(2, ["cleanup-scan"]), row(3, ["tool-scout"])];
    const closed = [row(4, ["cleanup-scan"])];
    const blocked = [row(5, ["architecture-scan"])];
    const rows = bucketByClass(added, closed, blocked);
    const cleanup = rows.find((r) => r.class === "cleanup-scan");
    assert.deepEqual(cleanup, { class: "cleanup-scan", added: 2, closed: 1, blocked: 0 });
    const scout = rows.find((r) => r.class === "tool-scout");
    assert.deepEqual(scout, { class: "tool-scout", added: 1, closed: 0, blocked: 0 });
    const arch = rows.find((r) => r.class === "architecture-scan");
    assert.deepEqual(arch, { class: "architecture-scan", added: 0, closed: 0, blocked: 1 });
  });

  test("issue carrying cleanup-scan classifies as cleanup-scan even among triage labels", () => {
    const rows = bucketByClass([row(1, ["ready-for-agent", "cleanup-scan", "enhancement"])], [], []);
    assert.equal(rows[0].class, "cleanup-scan");
    assert.equal(rows[0].added, 1);
  });

  test("residual provenance label sentry classifies as sentry", () => {
    const rows = bucketByClass([row(1, ["sentry", "bug"])], [], []);
    assert.equal(rows[0].class, "sentry");
  });

  test("unclassified residual bucket collects issues with no provenance label — none dropped", () => {
    const rows = bucketByClass([row(1, []), row(2, ["bug", "dev_orch"])], [], []);
    const unc = rows.find((r) => r.class === "unclassified");
    assert.equal(unc?.added, 2);
    const total = rows.reduce((n, r) => n + r.added + r.closed + r.blocked, 0);
    assert.equal(total, 2);
  });

  test("rows sorted by total descending", () => {
    const added = [row(1, ["tool-scout"]), row(2, ["cleanup-scan"]), row(3, ["cleanup-scan"]), row(4, ["cleanup-scan"])];
    const rows = bucketByClass(added, [], []);
    assert.equal(rows[0].class, "cleanup-scan");
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
          return [row(1, ["cleanup-scan"]), row(2, ["tool-scout"])];
        }
        if (search.startsWith("closed:>=")) {
          return [row(3, ["cleanup-scan"])];
        }
        return [];
      },
      listIssuesByLabelOrEmpty: async (label) =>
        label === "blocked" ? [row(4, ["architecture-scan", "blocked"])] : [],
    });
    assert.equal(result.windowDays, 7);
    assert.equal(result.totals.added, 2);
    assert.equal(result.totals.closed, 1);
    assert.equal(result.totals.blocked, 1);
    const cleanup = result.byClass.find((r) => r.class === "cleanup-scan");
    assert.equal(cleanup?.added, 1);
    assert.equal(cleanup?.closed, 1);
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
        if (search.startsWith("closed:>=")) return [row(1, ["tool-scout"])];
        return [];
      },
      listIssuesByLabelOrEmpty: async () => [],
    });
    assert.equal(result.totals.added, 0);
    assert.equal(result.totals.closed, 1);
  });
});

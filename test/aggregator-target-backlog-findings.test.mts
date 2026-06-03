/**
 * Regression tests for the target-backlog-findings aggregator (issue #617).
 *
 * After issue #915 the aggregator reads GitHub through the **GitHub Issue/PR
 * Read seam** (`src/github/issues.ts`). Tests stub the seam reader
 * (`listIssuesBySearchOrEmpty`) and feed `filterUnroutedFindings` the seam's
 * canonical `IssueRow` shape — the raw-JSON parse now lives in the seam's own
 * suite (`github-issues.test.mts`). `excerptOf` stays a pure-string helper.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  getNewTargetFindings,
  filterUnroutedFindings,
  excerptOf,
} from "../src/aggregators/target-backlog-findings.ts";
import type { IssueRow } from "../src/github/issues.ts";

const NOW = new Date("2026-05-26T12:00:00.000Z");
const WINDOW_START = new Date(NOW.getTime() - 24 * 60 * 60 * 1000); // 24h

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

describe("excerptOf — pure helper", () => {
  test("returns '' on empty input", () => {
    assert.equal(excerptOf(""), "");
  });

  test("returns the first non-empty paragraph", () => {
    const body = "\n\nFirst para.\n\nSecond para.\n";
    assert.equal(excerptOf(body), "First para.");
  });

  test("truncates paragraphs longer than 240 chars with an ellipsis", () => {
    const body = "x".repeat(300);
    const out = excerptOf(body);
    assert.equal(out.length, 240);
    assert.ok(out.endsWith("..."));
  });
});

describe("filterUnroutedFindings — pure helper", () => {
  test("returns [] on empty input", () => {
    assert.deepEqual(filterUnroutedFindings([], WINDOW_START), []);
  });

  test("keeps OPEN, not-in-progress, in-window items", () => {
    const rows = [
      issueRow({
        number: 1,
        title: "fresh finding",
        url: "u1",
        createdAt: "2026-05-26T06:00:00Z",
        labels: ["target-backlog"],
        body: "Found a latency regression in handlePick.",
        state: "OPEN",
      }),
      issueRow({
        number: 2,
        title: "already in progress",
        url: "u2",
        createdAt: "2026-05-26T07:00:00Z",
        labels: ["target-backlog", "in-progress"],
        state: "OPEN",
      }),
      issueRow({
        number: 3,
        title: "closed",
        url: "u3",
        createdAt: "2026-05-26T08:00:00Z",
        labels: ["target-backlog"],
        state: "CLOSED",
      }),
      issueRow({
        number: 4,
        title: "stale outside window",
        url: "u4",
        createdAt: "2026-05-20T00:00:00Z",
        labels: ["target-backlog"],
        state: "OPEN",
      }),
    ];
    const out = filterUnroutedFindings(rows, WINDOW_START);
    assert.equal(out.length, 1);
    assert.equal(out[0].number, 1);
    assert.ok(out[0].excerpt.startsWith("Found a latency regression"));
  });

  test("sorts newest-first", () => {
    const rows = [
      issueRow({ number: 1, title: "older", url: "u1", createdAt: "2026-05-26T06:00:00Z", labels: ["target-backlog"] }),
      issueRow({ number: 2, title: "newer", url: "u2", createdAt: "2026-05-26T10:00:00Z", labels: ["target-backlog"] }),
    ];
    const out = filterUnroutedFindings(rows, WINDOW_START);
    assert.deepEqual(out.map((i) => i.number), [2, 1]);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("getNewTargetFindings — happy path", () => {
  test("returns one finding when the seam reader produces one matching row", async () => {
    const findings = await getNewTargetFindings(24, {
      now: NOW,
      listIssuesBySearchOrEmpty: async () => [
        issueRow({
          number: 42,
          title: "Latency spike in /handlePick",
          url: "https://x/42",
          createdAt: "2026-05-26T06:00:00Z",
          labels: ["target-backlog"],
          body: "p99 spiked at 06:14 UTC.",
          state: "OPEN",
        }),
      ],
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].number, 42);
  });

  test("forwards the label/state/search to the seam reader", async () => {
    let captured: { search?: string; label?: string; state?: string } = {};
    await getNewTargetFindings(24, {
      now: NOW,
      listIssuesBySearchOrEmpty: async (search, _prefix, opts) => {
        captured = { search, label: opts?.label, state: opts?.state };
        return [];
      },
    });
    assert.equal(captured.search, "created:>=2026-05-25");
    assert.equal(captured.label, "target-backlog");
    assert.equal(captured.state, "all");
  });
});

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

describe("getNewTargetFindings — empty state", () => {
  test("no matches → []", async () => {
    const findings = await getNewTargetFindings(24, {
      now: NOW,
      listIssuesBySearchOrEmpty: async () => [],
    });
    assert.deepEqual(findings, []);
  });

  test("seam reader degrades to [] → [] (never throws)", async () => {
    // The *OrEmpty reader swallows gh failures into []; the aggregator just
    // filters an empty list.
    const findings = await getNewTargetFindings(24, {
      now: NOW,
      listIssuesBySearchOrEmpty: async () => [],
    });
    assert.deepEqual(findings, []);
  });
});

// ---------------------------------------------------------------------------
// Boundary: window edge — item exactly at windowStart counts as inside
// ---------------------------------------------------------------------------

describe("getNewTargetFindings — window boundary", () => {
  test("item at windowStart is INSIDE; one second earlier is OUTSIDE", async () => {
    const insideISO = WINDOW_START.toISOString();
    const outsideISO = new Date(WINDOW_START.getTime() - 1000).toISOString();
    const findings = await getNewTargetFindings(24, {
      now: NOW,
      listIssuesBySearchOrEmpty: async () => [
        issueRow({ number: 1, title: "inside", url: "u1", createdAt: insideISO, labels: ["target-backlog"], state: "OPEN" }),
        issueRow({ number: 2, title: "outside", url: "u2", createdAt: outsideISO, labels: ["target-backlog"], state: "OPEN" }),
      ],
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].number, 1);
  });
});

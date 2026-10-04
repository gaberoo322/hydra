/**
 * Issues-waiting aggregator (issue #4625, ADR-0034 §8.1 ranks 2-3).
 *
 * Golden-fixture tests for the pure classifier plus the injected-reader
 * entrypoint — no live `gh`.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyWaiting,
  getIssuesWaiting,
} from "../src/aggregators/issues-waiting.ts";
import type { IssueReadResult, IssueRow } from "../src/github/issues.ts";

const NOW = new Date("2026-10-03T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

function row(number: number, over: Partial<IssueRow> = {}): IssueRow {
  return {
    number,
    title: `issue ${number}`,
    url: `https://github.com/o/r/issues/${number}`,
    createdAt: ago(10),
    labels: [],
    body: "",
    state: "OPEN",
    ...over,
  };
}

function byLabel(m: Record<string, IssueRow[]>): Map<string, IssueRow[]> {
  return new Map(Object.entries(m));
}

describe("classifyWaiting — one line per issue, by precedence", () => {
  test("an issue on several label lists is admitted to exactly one line (reframe > ready-for-human > stale-blocked > blocked-live > needs-info)", () => {
    const r = row(1);
    const all = byLabel({
      reframe: [r],
      "ready-for-human": [r],
      blocked: [r],
      "needs-info": [r],
    });
    const out = classifyWaiting(all, new Set(), NOW);
    assert.equal(out.length, 1);
    assert.equal(out[0].line, "reframe");

    const noReframe = byLabel({ "ready-for-human": [r], blocked: [r], "needs-info": [r] });
    assert.equal(classifyWaiting(noReframe, new Set(), NOW)[0].line, "ready-for-human");

    const blockedInfo = byLabel({ blocked: [r], "needs-info": [r] });
    assert.equal(classifyWaiting(blockedInfo, new Set(), NOW)[0].line, "stale-blocked");
    // Live blocker below the age line falls through to needs-info.
    const young = row(2, { createdAt: ago(1.5), body: "Blocked by #99" });
    const fall = byLabel({ blocked: [young], "needs-info": [young] });
    const res = classifyWaiting(fall, new Set([99]), NOW);
    assert.equal(res.length, 1);
    assert.equal(res[0].line, "needs-info");
  });
});

describe("classifyWaiting — blocker liveness uses the strict predicate", () => {
  test("a bare `Part of #N` mention is not a blocker, so the issue is stale-blocked", () => {
    const r = row(3, { body: "Part of #4619\n\nsee #55" });
    const out = classifyWaiting(byLabel({ blocked: [r] }), new Set([4619, 55]), NOW);
    assert.equal(out[0].line, "stale-blocked");
  });

  test("blocked with an OPEN strict blocker and age >= blockedDays is blocked-live", () => {
    const r = row(4, { createdAt: ago(3), body: "Blocked by #77" });
    const out = classifyWaiting(byLabel({ blocked: [r] }), new Set([77]), NOW);
    assert.equal(out[0].line, "blocked-live");
    assert.deepEqual(out[0].blockerNumbers, [77]);
  });

  test("blocked with an OPEN strict blocker below blockedDays is not admitted", () => {
    const r = row(5, { createdAt: ago(1), body: "Blocked by #77" });
    assert.deepEqual(classifyWaiting(byLabel({ blocked: [r] }), new Set([77]), NOW), []);
  });

  test("blocked with only CLOSED blockers is stale-blocked at any age", () => {
    const r = row(6, { createdAt: ago(0.1), body: "Blocked by #77" });
    const out = classifyWaiting(byLabel({ blocked: [r] }), new Set(), NOW);
    assert.equal(out[0].line, "stale-blocked");
  });

  test("blocked with no blocker reference is stale-blocked", () => {
    const out = classifyWaiting(byLabel({ blocked: [row(7)] }), new Set(), NOW);
    assert.equal(out[0].line, "stale-blocked");
  });
});

describe("classifyWaiting — needs-info and presence lines", () => {
  test("needs-info admits at >= needsInfoDays only", () => {
    const old = row(8, { createdAt: ago(1) });
    const young = row(9, { createdAt: ago(0.5) });
    const out = classifyWaiting(byLabel({ "needs-info": [old, young] }), new Set(), NOW);
    assert.deepEqual(out.map((i) => i.number), [8]);
  });

  test("ready-for-human admits on presence regardless of age", () => {
    const out = classifyWaiting(
      byLabel({ "ready-for-human": [row(10, { createdAt: ago(0.01) })] }),
      new Set(),
      NOW,
    );
    assert.equal(out[0].line, "ready-for-human");
  });
});

describe("getIssuesWaiting — source evidence", () => {
  const ok = (rows: IssueRow[]): IssueReadResult<IssueRow> => ({ ok: true, rows });

  test("blocker-lookup failure names itself and treats every referenced blocker as OPEN (fewer stale rows)", async () => {
    const blocked = row(11, { createdAt: ago(5), body: "Blocked by #77" });
    const result = await getIssuesWaiting({
      now: NOW,
      githubRepo: "o/r",
      listIssuesByLabel: async (label) => ok(label === "blocked" ? [blocked] : []),
      listIssuesBySearch: async () => ({ ok: false, code: "gh-failed" }) as IssueReadResult<IssueRow>,
    });
    assert.deepEqual(result.sourceErrors, ["blocker-lookup"]);
    assert.equal(result.sourcesOk, false);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].line, "blocked-live", "not a false stale-blocked row");
  });

  test("a failed label read names the label and flips sourcesOk", async () => {
    const result = await getIssuesWaiting({
      now: NOW,
      githubRepo: "o/r",
      listIssuesByLabel: async (label) =>
        label === "needs-info"
          ? ({ ok: false, code: "gh-failed" }) as IssueReadResult<IssueRow>
          : ok([]),
      listIssuesBySearch: async () => ok([]),
    });
    assert.deepEqual(result.sourceErrors, ["needs-info"]);
    assert.equal(result.sourcesOk, false);
  });

  test("includeReframe false never reads the reframe label; true reads it", async () => {
    const seen: string[] = [];
    const reader = async (label: string) => {
      seen.push(label);
      return ok([]);
    };
    await getIssuesWaiting({ now: NOW, listIssuesByLabel: reader, listIssuesBySearch: async () => ok([]) });
    assert.ok(!seen.includes("reframe"));
    seen.length = 0;
    await getIssuesWaiting({
      now: NOW,
      includeReframe: true,
      listIssuesByLabel: reader,
      listIssuesBySearch: async () => ok([]),
    });
    assert.ok(seen.includes("reframe"));
  });

  test("scanned counts raw rows from fulfilled label reads; zero issues still proves the lookup ran", async () => {
    const result = await getIssuesWaiting({
      now: NOW,
      listIssuesByLabel: async (label) =>
        ok(label === "needs-info" ? [row(12, { createdAt: ago(0.2) })] : []),
      listIssuesBySearch: async () => ok([]),
    });
    assert.equal(result.scanned, 1);
    assert.equal(result.sourcesOk, true);
    assert.deepEqual(result.items, []);
  });
});

describe("parseArchived (github/repo.ts pure parser)", () => {
  test("true / false / malformed / failed-read payloads", async () => {
    const { parseArchived } = await import("../src/github/repo.ts");
    assert.equal(parseArchived({ archived: true }), true);
    assert.equal(parseArchived({ archived: false }), false);
    assert.equal(parseArchived({ archived: "yes" }), null);
    assert.equal(parseArchived({}), null);
    assert.equal(parseArchived(null), null);
  });
});

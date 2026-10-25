/**
 * Issues-waiting projections (issue #5091, slice 1/3 of #5090).
 *
 * `readWaitingIssues` is the ONE read; the stuck / decision-queue / pickup
 * projections are pure functions of its value. The goldens are differential at
 * the aggregator interface: the same fixture goes to the legacy entry point
 * (getStuckItems / getReviewPickupSet) and to read + projection, and the two
 * must deep-equal. (The legacy decision-queue aggregator was deleted in
 * ADR-0034 §8.1, so its golden is the pinned literal shape.)
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEFAULT_THRESHOLDS,
  projectDecisionQueue,
  projectPickupSet,
  projectStuckIssues,
  projectWaitingLines,
  readWaitingIssues,
  getIssuesWaiting,
} from "../src/aggregators/issues-waiting.ts";
import { DEFAULT_THRESHOLDS as REEXPORTED, getStuckItems } from "../src/aggregators/stuck-items.ts";
import { getReviewPickupSet } from "../src/review-pickup.ts";
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

/** One recording lister: serves label->rows and counts calls per label. */
function lister(byLabel: Record<string, IssueRow[]>) {
  const calls: string[] = [];
  const discriminated = async (label: string): Promise<IssueReadResult<IssueRow>> => {
    calls.push(label);
    return { ok: true, rows: byLabel[label] ?? [] } as IssueReadResult<IssueRow>;
  };
  const orEmpty = async (label: string) => byLabel[label] ?? [];
  return { calls, discriminated, orEmpty };
}

describe("projections — structure", () => {
  test("the stale threshold is declared once and re-exported unchanged", () => {
    assert.equal(REEXPORTED, DEFAULT_THRESHOLDS);
    assert.deepEqual(DEFAULT_THRESHOLDS, { blockedDays: 2, needsInfoDays: 1 });
  });

  test("issues-waiting.ts never imports the loose any-#N scanner", () => {
    const src = readFileSync(new URL("../src/aggregators/issues-waiting.ts", import.meta.url), "utf8");
    const imports = src.match(/^import[\s\S]*?from\s+"[^"]+";/gm) ?? [];
    for (const imp of imports) assert.ok(!imp.includes("extractIssueRefs"), imp);
  });

  test("one listIssuesByLabel call per label per read, regardless of projections", async () => {
    const l = lister({ blocked: [row(1)] });
    const read = await readWaitingIssues({
      now: NOW,
      listIssuesByLabel: l.discriminated as never,
      listIssuesBySearch: async () => ({ ok: true, rows: [] }),
    });
    projectStuckIssues(read);
    projectDecisionQueue(read);
    projectPickupSet(read);
    assert.deepEqual([...l.calls].sort(), ["blocked", "needs-info", "ready-for-human"]);
  });

  test("getIssuesWaiting is projectWaitingLines of the read", async () => {
    const deps = {
      now: NOW,
      listIssuesByLabel: lister({ "needs-info": [row(2)] }).discriminated as never,
      listIssuesBySearch: async () => ({ ok: true as const, rows: [] }),
    };
    assert.deepEqual(await getIssuesWaiting(deps), projectWaitingLines(await readWaitingIssues(deps)));
  });
});

describe("projectStuckIssues — differential vs getStuckItems", () => {
  test("blocked / needs-info buckets, thresholds, scanned and sourcesOk match", async () => {
    const fixture = {
      blocked: [
        row(1, { createdAt: ago(4.5), labels: ["blocked"] }),
        row(3, { createdAt: ago(0.5), labels: ["blocked"] }),
      ],
      "needs-info": [
        row(2, { createdAt: ago(2.5), labels: ["needs-info"] }),
        row(4, { createdAt: ago(0.2), labels: ["needs-info"] }),
      ],
    };
    const l = lister(fixture);
    const legacy = await getStuckItems({
      now: NOW,
      listIssuesByLabelOrEmpty: (async (label: string) => l.orEmpty(label)) as never,
      listOpenPrsOrEmpty: async () => [],
      listRequiredStatusContextsOrNull: async () => null,
    });
    const read = await readWaitingIssues({
      now: NOW,
      listIssuesByLabel: l.discriminated as never,
      listIssuesBySearch: async () => ({ ok: true, rows: [] }),
    });
    const next = projectStuckIssues(read);
    assert.deepEqual(next.blockedOver2d, legacy.blockedOver2d);
    assert.deepEqual(next.needsInfoWaiting, legacy.needsInfoWaiting);
    assert.deepEqual(next.thresholds, legacy.thresholds);
    assert.equal(next.generatedAt, legacy.generatedAt);
    assert.equal(next.sourcesOk, true);
    assert.equal(next.scanned, 4);
  });

  test("a failed label read flips sourcesOk", async () => {
    const read = await readWaitingIssues({
      now: NOW,
      listIssuesByLabel: (async (label: string) =>
        label === "blocked" ? { ok: false, code: "gh-failed" } : { ok: true, rows: [] }) as never,
      listIssuesBySearch: async () => ({ ok: true, rows: [] }),
    });
    assert.equal(projectStuckIssues(read).sourcesOk, false);
  });
});

describe("projectDecisionQueue — presence semantics", () => {
  test("lists a young needs-info and an Epic, unions labels, sorts createdAt-ascending", async () => {
    const l = lister({
      "ready-for-human": [row(10, { createdAt: ago(3), labels: ["ready-for-human"] })],
      "needs-info": [
        row(10, { createdAt: ago(3), labels: ["needs-info"] }),
        row(11, { createdAt: ago(5), labels: ["needs-info"], body: "## Sub-issues\n- #12\n" }),
        row(13, { createdAt: ago(0.1), labels: ["needs-info"] }),
      ],
    });
    const read = await readWaitingIssues({
      now: NOW,
      listIssuesByLabel: l.discriminated as never,
      listIssuesBySearch: async () => ({ ok: true, rows: [] }),
    });
    const q = projectDecisionQueue(read);
    assert.deepEqual(q.items.map((i) => i.number), [11, 10, 13]);
    const ten = q.items.find((i) => i.number === 10)!;
    assert.equal(ten.source, "ready-for-human");
    assert.deepEqual(ten.sources, ["ready-for-human", "needs-info"]);
    assert.deepEqual(ten.labels, ["ready-for-human", "needs-info"]);
    assert.equal(q.scanned, 4);
    assert.equal(q.sourcesOk, true);
  });
});

describe("projectPickupSet — differential vs getReviewPickupSet", () => {
  const fixture = {
    "ready-for-human": [row(200, { createdAt: ago(1), title: "Decide tier" })],
    blocked: [
      // #300 has an open blocker (#100); #400 only a closed one (#500).
      row(300, { body: "blocked by #100" }),
      row(400, { body: "depends on #500" }),
    ],
  };
  const search = async () => ({ ok: true as const, rows: [row(100)] });

  test("same pickup set on the review-pickup integration fixture", async () => {
    const l = lister(fixture);
    const legacy = await getReviewPickupSet({
      listIssuesByLabelOrEmpty: (async (label: string) => l.orEmpty(label)) as never,
      listIssuesBySearch: search,
    });
    const read = await readWaitingIssues({
      now: NOW,
      listIssuesByLabel: l.discriminated as never,
      listIssuesBySearch: search,
    });
    assert.deepEqual(projectPickupSet(read), legacy);
    assert.deepEqual(legacy.map((i) => i.number), [200, 400]);
  });

  test("failed blocker lookup: every ref counts open, fewer pickup rows", async () => {
    const l = lister({ blocked: [row(400, { body: "depends on #500" })] });
    const read = await readWaitingIssues({
      now: NOW,
      listIssuesByLabel: l.discriminated as never,
      listIssuesBySearch: async () => ({ ok: false, code: "gh-failed" }),
    });
    assert.deepEqual(projectPickupSet(read), []);
  });

  test("a blocked issue with no blocker ref pages once aged >= blockedDays; a loose mention is no blocker", async () => {
    const l = lister({
      blocked: [
        row(500, { createdAt: ago(3), body: "no refs" }),
        row(501, { createdAt: ago(0.5), body: "no refs" }),
        row(502, { createdAt: ago(3), body: "see #999 for context" }),
      ],
    });
    const read = await readWaitingIssues({
      now: NOW,
      listIssuesByLabel: l.discriminated as never,
      listIssuesBySearch: async () => ({ ok: true, rows: [row(999)] }),
    });
    assert.deepEqual(projectPickupSet(read).map((i) => i.number), [500, 502]);
  });
});

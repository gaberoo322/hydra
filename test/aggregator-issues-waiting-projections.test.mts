/**
 * Issues-waiting projections (issue #5091, slice 1/3 of #5090).
 *
 * `readWaitingIssues` is the ONE read; the stuck / pickup projections are pure
 * functions of its value. Issue #5093 deleted the decision-queue projection and
 * the legacy-differential arm: stuck expectations are pinned as explicit
 * issue-number lists over the CLASSIFIED set.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEFAULT_THRESHOLDS,
  projectPickupSet,
  projectStuckIssues,
  projectWaitingLines,
  readWaitingIssues,
  getIssuesWaiting,
} from "../src/aggregators/issues-waiting.ts";
import { DEFAULT_THRESHOLDS as REEXPORTED } from "../src/aggregators/stuck-items.ts";
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
  return { calls, discriminated };
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

describe("projectStuckIssues — classified expectations", () => {
  const search = async () => ({ ok: true as const, rows: [row(100)] });

  test("blocked / needs-info buckets, thresholds, scanned and sourcesOk on the happy path", async () => {
    const l = lister({
      blocked: [
        row(1, { createdAt: ago(4.5), labels: ["blocked"] }),
        row(3, { createdAt: ago(0.5), labels: ["blocked"] }),
      ],
      "needs-info": [
        row(2, { createdAt: ago(2.5), labels: ["needs-info"] }),
        row(4, { createdAt: ago(0.2), labels: ["needs-info"] }),
      ],
    });
    const next = projectStuckIssues(
      await readWaitingIssues({
        now: NOW,
        listIssuesByLabel: l.discriminated as never,
        listIssuesBySearch: async () => ({ ok: true, rows: [] }),
      }),
    );
    assert.deepEqual(next.blockedOver2d.map((i) => i.number), [1]);
    assert.deepEqual(next.needsInfoWaiting.map((i) => i.number), [2]);
    assert.deepEqual(next.thresholds, DEFAULT_THRESHOLDS);
    assert.equal(next.generatedAt, NOW.toISOString());
    assert.equal(next.sourcesOk, true);
    assert.equal(next.scanned, 4);
  });

  test("Epic excluded; open-blocker and both-label rows stay stuck; scanned counts raw rows", async () => {
    const l = lister({
      blocked: [
        row(1, { createdAt: ago(5), labels: ["blocked"], body: "## Sub-issues\n- #2\n" }),
        row(3, { createdAt: ago(5), labels: ["blocked"], body: "blocked by #100" }),
        row(4, { createdAt: ago(5), labels: ["blocked", "needs-info"] }),
      ],
      "needs-info": [row(4, { createdAt: ago(5), labels: ["blocked", "needs-info"] })],
    });
    const next = projectStuckIssues(
      await readWaitingIssues({
        now: NOW,
        listIssuesByLabel: l.discriminated as never,
        listIssuesBySearch: search,
      }),
    );
    assert.deepEqual(next.blockedOver2d.map((i) => i.number), [3, 4]);
    assert.deepEqual(next.needsInfoWaiting.map((i) => i.number), [4]);
    assert.equal(next.scanned, 4);
    assert.equal(next.sourcesOk, true);
  });

  test("a failed needs-info label read flips sourcesOk; scanned excludes it", async () => {
    const read = await readWaitingIssues({
      now: NOW,
      listIssuesByLabel: (async (label: string) =>
        label === "needs-info"
          ? { ok: false, code: "gh-failed" }
          : { ok: true, rows: label === "blocked" ? [row(1, { createdAt: ago(5), labels: ["blocked"] })] : [] }) as never,
      listIssuesBySearch: async () => ({ ok: true, rows: [] }),
    });
    const next = projectStuckIssues(read);
    assert.equal(next.sourcesOk, false);
    assert.equal(next.scanned, 1);
  });

  test("a failed ready-for-human read does NOT flip the stuck projection's sourcesOk", async () => {
    const read = await readWaitingIssues({
      now: NOW,
      listIssuesByLabel: (async (label: string) =>
        label === "ready-for-human" ? { ok: false, code: "gh-failed" } : { ok: true, rows: [] }) as never,
      listIssuesBySearch: async () => ({ ok: true, rows: [] }),
    });
    assert.equal(projectStuckIssues(read).sourcesOk, true);
  });
});

describe("readWaitingIssues — concurrent reads single-flight (#5093 INV-7)", () => {
  test("two concurrent reads sharing one reader issue one listIssuesByLabel per label", async () => {
    const l = lister({ blocked: [row(1)] });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = (async (label: string) => {
      await gate;
      return l.discriminated(label);
    }) as never;
    const deps = {
      now: NOW,
      listIssuesByLabel: slow,
      listIssuesBySearch: async () => ({ ok: true as const, rows: [] }),
    };
    const a = readWaitingIssues(deps);
    const b = readWaitingIssues(deps);
    release();
    await Promise.all([a, b]);
    assert.deepEqual([...l.calls].sort(), ["blocked", "needs-info", "ready-for-human"]);
  });

  test("a read that starts after the previous settled issues its own calls (no TTL memo)", async () => {
    const l = lister({});
    const deps = {
      now: NOW,
      listIssuesByLabel: l.discriminated as never,
      listIssuesBySearch: async () => ({ ok: true as const, rows: [] }),
    };
    await readWaitingIssues(deps);
    await readWaitingIssues(deps);
    assert.equal(l.calls.length, 6);
  });

  test("distinct thresholds or repos never coalesce", async () => {
    const l = lister({});
    const base = {
      now: NOW,
      listIssuesByLabel: l.discriminated as never,
      listIssuesBySearch: async () => ({ ok: true as const, rows: [] }),
    };
    await Promise.all([
      readWaitingIssues(base),
      readWaitingIssues({ ...base, thresholds: { blockedDays: 0 } }),
      readWaitingIssues({ ...base, githubRepo: "o/other" }),
    ]);
    assert.equal(l.calls.length, 9);
  });
});

describe("projectPickupSet — golden + composition identity with getReviewPickupSet", () => {
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
    const deps = {
      now: NOW,
      listIssuesByLabel: l.discriminated as never,
      listIssuesBySearch: search,
    };
    const items = await getReviewPickupSet(deps);
    assert.deepEqual(items, [
      {
        number: 200,
        title: "Decide tier",
        url: "https://github.com/o/r/issues/200",
        source: "ready-for-human",
        sources: ["ready-for-human"],
      },
      {
        number: 400,
        title: "issue 400",
        url: "https://github.com/o/r/issues/400",
        source: "stale-blocked",
        sources: ["stale-blocked"],
      },
    ]);
    assert.deepEqual(items, projectPickupSet(await readWaitingIssues(deps)));
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

  test("dual-label ready-for-human + blocked: one item, sources [ready-for-human] (deliberate divergence from legacy)", async () => {
    const dual = row(600, { createdAt: ago(3), body: "no refs", title: "dual" });
    const l = lister({ "ready-for-human": [dual], blocked: [dual] });
    const read = await readWaitingIssues({
      now: NOW,
      listIssuesByLabel: l.discriminated as never,
      listIssuesBySearch: search,
    });
    const items = projectPickupSet(read);
    assert.equal(items.length, 1);
    assert.equal(items[0].number, 600);
    assert.deepEqual(items[0].sources, ["ready-for-human"]);
  });
});

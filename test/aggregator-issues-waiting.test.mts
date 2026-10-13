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
    const r = row(1, { body: "Blocked by #5" });
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
  test("a bare `Part of #N` mention is not a blocker, so the issue has no blocker ref and is blocked-live at >= blockedDays", () => {
    const r = row(3, { body: "Part of #4619\n\nsee #55" });
    const out = classifyWaiting(byLabel({ blocked: [r] }), new Set([4619, 55]), NOW);
    assert.equal(out[0].line, "blocked-live");
    assert.deepEqual(out[0].blockerNumbers, []);
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

  test("blocked with no blocker reference is blocked-live at >= blockedDays, not stale-blocked", () => {
    const out = classifyWaiting(byLabel({ blocked: [row(7)] }), new Set(), NOW);
    assert.equal(out[0].line, "blocked-live");
    const young = row(70, { createdAt: ago(1) });
    assert.deepEqual(classifyWaiting(byLabel({ blocked: [young] }), new Set(), NOW), []);
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

// ---------------------------------------------------------------------------
// Issue #4805 — machine-owned suppression, Epic exclusion, human blockers
// ---------------------------------------------------------------------------

const okRows = (rows: IssueRow[]): IssueReadResult<IssueRow> => ({ ok: true, rows });
const failRead = { ok: false, code: "gh-failed" } as IssueReadResult<IssueRow>;

/** Run getIssuesWaiting over fixed label rows, blocker rows and PR rows. */
async function run(opts: {
  blocked?: IssueRow[];
  needsInfo?: IssueRow[];
  humanRows?: IssueRow[];
  blockers?: IssueRow[] | "fail";
  prs?: { number: number; body: string }[] | "fail";
}) {
  let prReads = 0;
  const result = await getIssuesWaiting({
    now: NOW,
    githubRepo: "o/r",
    listIssuesByLabel: async (label) =>
      okRows(
        label === "blocked"
          ? (opts.blocked ?? [])
          : label === "needs-info"
            ? (opts.needsInfo ?? [])
            : label === "ready-for-human"
              ? (opts.humanRows ?? [])
              : [],
      ),
    listIssuesBySearch: async () =>
      opts.blockers === "fail" ? failRead : okRows(opts.blockers ?? []),
    listOpenPrs: (async () => {
      prReads++;
      if (opts.prs === "fail") return { ok: false, code: "gh-failed" };
      return { ok: true, rows: (opts.prs ?? []).map((p) => ({ ...p, headRefName: "" })) };
    }) as never,
  });
  return { result, prReads: () => prReads };
}

const blocker = (n: number, labels: string[]) => row(n, { labels, createdAt: ago(1) });

describe("getIssuesWaiting — machine-owned suppression (#4805)", () => {
  test("a slice whose only open blocker is ready-for-agent / needs-qa / needs-dev-resume is not admitted", async () => {
    for (const label of ["ready-for-agent", "needs-qa", "needs-dev-resume", "in-progress"]) {
      const slice = row(100, { body: "## Blocked by\n\n- Blocked by #200" });
      const { result, prReads } = await run({ blocked: [slice], blockers: [blocker(200, [label])] });
      assert.deepEqual(result.items, [], label);
      assert.equal(prReads(), 0, "label-settled blockers never trigger the PR read");
    }
  });

  test("an open blocker with no lifecycle label that an open PR closes is machine-owned (lazy PR read)", async () => {
    const slice = row(101, { body: "Blocked by #201" });
    const { result, prReads } = await run({
      blocked: [slice],
      blockers: [blocker(201, [])],
      prs: [{ number: 900, body: "Closes #201" }],
    });
    assert.deepEqual(result.items, []);
    assert.equal(prReads(), 1);
  });

  test("a human label on the blocker takes precedence over a machine label", async () => {
    const slice = row(102, { body: "Blocked by #202" });
    const { result } = await run({
      blocked: [slice],
      blockers: [blocker(202, ["ready-for-agent", "ready-for-human"])],
    });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].line, "blocked-live");
    assert.deepEqual(result.items[0].humanBlockers, [{ number: 202, reason: "ready-for-human" }]);
  });

  test("an unlabelled open blocker with no closing PR is admitted as (no owner label)", async () => {
    const slice = row(103, { body: "Blocked by #203" });
    const { result } = await run({ blocked: [slice], blockers: [blocker(203, [])], prs: [] });
    assert.equal(result.items[0].line, "blocked-live");
    assert.deepEqual(result.items[0].humanBlockers, [{ number: 203, reason: "no owner label" }]);
  });

  test("a mix of machine-owned and human-waiting open blockers is admitted, naming only the human one", async () => {
    const slice = row(104, { body: "Blocked by #204 and #205" });
    const { result } = await run({
      blocked: [slice],
      blockers: [blocker(204, ["needs-qa"]), blocker(205, ["hitl-grill"])],
    });
    assert.deepEqual(result.items[0].humanBlockers, [{ number: 205, reason: "hitl-grill" }]);
  });

  test("all blockers closed => stale-blocked; hasFilesInScope reflects the body", async () => {
    const withScope = row(105, { body: "Blocked by #206\n\n## Files in scope\n\n- src/a.ts\n" });
    const noScope = row(106, { body: "Blocked by #206" });
    const { result } = await run({ blocked: [withScope, noScope], blockers: [] });
    const by = Object.fromEntries(result.items.map((i) => [i.number, i]));
    assert.equal(by[105].line, "stale-blocked");
    assert.equal(by[105].hasFilesInScope, true);
    assert.equal(by[106].line, "stale-blocked");
    assert.equal(by[106].hasFilesInScope, false);
  });
});

describe("getIssuesWaiting — Epic exclusion (#4805)", () => {
  test("an Epic with a `## Sub-issues` section is never admitted via blocked or needs-info", async () => {
    const epic = row(300, { createdAt: ago(10), body: "## Sub-issues\n\n- #301\n- #302\n" });
    const { result } = await run({ blocked: [epic], needsInfo: [epic] });
    assert.deepEqual(result.items, []);
  });

  test("an issue declared as the parent by another row in hand is an Epic (blocked and needs-info)", async () => {
    const parentBlocked = row(310, { body: "umbrella" });
    const parentInfo = row(311, { body: "umbrella" });
    const child = row(312, { body: "## Parent\n\n#310\n" });
    const child2 = row(313, { body: "Parent: #311", createdAt: ago(0.1) });
    const { result } = await run({
      blocked: [parentBlocked, child],
      needsInfo: [parentInfo, child2],
      blockers: [],
    });
    assert.ok(!result.items.some((i) => i.number === 310 || i.number === 311));
  });

  test("an Epic labelled ready-for-human is still admitted", async () => {
    const epic = row(320, { body: "## Sub-issues\n- #1\n", labels: ["ready-for-human"] });
    const { result } = await run({ humanRows: [epic], blocked: [epic] });
    assert.equal(result.items[0].line, "ready-for-human");
  });

  test("a `## Sub-issues` heading with no #N beneath it does not make an Epic", async () => {
    const r = row(330, { body: "## Sub-issues\n\nnone yet\n" });
    const { result } = await run({ blocked: [r] });
    assert.equal(result.items[0].line, "blocked-live");
  });
});

describe("getIssuesWaiting — lookup failures never hide rows (#4805)", () => {
  test("blocker lookup failure admits the row as blocked-live with sourcesOk:false and no PR read", async () => {
    const slice = row(400, { body: "Blocked by #500" });
    const { result, prReads } = await run({ blocked: [slice], blockers: "fail" });
    assert.equal(result.sourcesOk, false);
    assert.deepEqual(result.sourceErrors, ["blocker-lookup"]);
    assert.equal(result.items[0].line, "blocked-live");
    assert.equal(result.items[0].blockerLookupFailed, true);
    assert.deepEqual(result.items[0].humanBlockers, []);
    assert.equal(prReads(), 0);
  });

  test("open-PR lookup failure admits rows only a PR would suppress and names open-pr-lookup", async () => {
    const slice = row(401, { body: "Blocked by #501" });
    const { result } = await run({ blocked: [slice], blockers: [blocker(501, [])], prs: "fail" });
    assert.deepEqual(result.sourceErrors, ["open-pr-lookup"]);
    assert.equal(result.sourcesOk, false);
    assert.equal(result.items[0].line, "blocked-live");
  });
});

describe("getIssuesWaiting — 2026-09-30 snapshot fixture (#4805)", () => {
  test("17 machine-owned slices + 6 closed-blocker slices + 3 blocked Epics + 1 needs-info Epic + human-blocked rows => only stale-blocked and human-blocked survive", async () => {
    const blocked: IssueRow[] = [];
    const blockers: IssueRow[] = [];
    const machine = ["ready-for-agent", "needs-qa", "needs-dev-resume"];
    for (let i = 0; i < 17; i++) {
      blocked.push(row(1000 + i, { body: `## Blocked by\n\n- Blocked by #${2000 + i}\n\n## Parent\n\n#4619` }));
      blockers.push(blocker(2000 + i, [machine[i % 3]]));
    }
    for (let i = 0; i < 6; i++) {
      blocked.push(row(1100 + i, { body: `Blocked by #${3000 + i}\n\n## Files in scope\n\n- src/x.ts` }));
    }
    for (const n of [4619, 4681, 4716]) {
      blocked.push(row(n, { body: "## Sub-issues\n\n- #1000\n" }));
    }
    const infoEpic = row(4586, { body: "## Sub-issues\n\n- #1100\n" });
    blocked.push(row(1200, { body: "Blocked by #4624" }), row(1201, { body: "Blocked by #4625" }));
    blockers.push(blocker(4624, ["ready-for-human"]), blocker(4625, []));

    const { result } = await run({ blocked, needsInfo: [infoEpic], blockers, prs: [] });
    const lines = result.items.map((i) => [i.number, i.line]).sort((a, b) => Number(a[0]) - Number(b[0]));
    assert.deepEqual(lines, [
      [1100, "stale-blocked"],
      [1101, "stale-blocked"],
      [1102, "stale-blocked"],
      [1103, "stale-blocked"],
      [1104, "stale-blocked"],
      [1105, "stale-blocked"],
      [1200, "blocked-live"],
      [1201, "blocked-live"],
    ]);
    assert.equal(result.sourcesOk, true);
  });
});

describe("parseArchived (github/repo.ts pure parser)", () => {
  test("true / false / malformed / empty / null payloads parse to boolean-or-null", async () => {
    const { parseArchived } = await import("../src/github/repo.ts");
    assert.equal(parseArchived({ archived: true }), true);
    assert.equal(parseArchived({ archived: false }), false);
    assert.equal(parseArchived({ archived: "yes" }), null);
    assert.equal(parseArchived({}), null);
    assert.equal(parseArchived(null), null);
  });
});

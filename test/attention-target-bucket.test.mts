/**
 * Attention feed rank 3 — Target items (issue #4625, ADR-0034 §8.1).
 *
 * Every source is an injected stub — no live gh, Redis or scheduler.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { getAttentionFeed, type AttentionFeedDeps } from "../src/attention.ts";
import { DEFAULT_THRESHOLDS } from "../src/aggregators/stuck-items.ts";
import type {
  IssuesWaitingResult,
  WaitingIssue,
} from "../src/aggregators/issues-waiting.ts";
import type { DispatchOutcomeRecord } from "../src/redis/dispatch-outcomes.ts";
import { AttentionFeedResponseSchema } from "../src/schemas/attention.ts";

const NOW = new Date("2026-10-03T12:00:00.000Z");
const TARGET = "acme/the-target";

function waiting(items: WaitingIssue[], over: Partial<IssuesWaitingResult> = {}): IssuesWaitingResult {
  return {
    items,
    scanned: items.length,
    sourcesOk: true,
    sourceErrors: [],
    thresholds: DEFAULT_THRESHOLDS,
    ...over,
  };
}

function issue(number: number, line: WaitingIssue["line"], over: Partial<WaitingIssue> = {}): WaitingIssue {
  return {
    number,
    title: `target issue ${number}`,
    url: `https://github.com/${TARGET}/issues/${number}`,
    createdAt: "2026-09-20T00:00:00.000Z",
    ageDays: 13,
    labels: [],
    line,
    blockerNumbers: [],
    openBlockerNumbers: [],
    ...over,
  };
}

function outcome(over: Partial<DispatchOutcomeRecord>): DispatchOutcomeRecord {
  return {
    cycleId: "worktree-agent-aaaaaaaa-t1-dev_target",
    anchorReference: "issue-5",
    runIdPrefix: "aaaaaaaa",
    turn: 1,
    className: "dev_target",
    skill: "hydra-target-build",
    outcome: "failed",
    tokens: null,
    durationMs: null,
    escalationAttempt: null,
    escalatedModel: null,
    recordedAt: NOW.getTime() - 1000,
    ...over,
  };
}

const quiet = waiting([]);

function deps(over: Partial<AttentionFeedDeps> = {}): AttentionFeedDeps {
  return {
    now: NOW,
    targetGithubRepo: TARGET,
    readTargetRepoArchived: async () => false,
    getIssuesWaiting: async () => quiet,
    getTargetIssuesWaiting: async () => quiet,
    getStalledPrs: async () => ({ items: [], scanned: 0, sourcesOk: true, sourceErrors: [] }),
    getFrictionPatterns: async () => ({
      bySkill: [],
      thresholdCandidates: [],
      recentMetaFrictionIssues: [],
      promotionThreshold: 3,
      candidateWindow: 1,
      windowHours: 168,
      generatedAt: NOW.toISOString(),
      scanned: 0,
      sourcesOk: true,
    }),
    loadDismissedIds: async () => [],
    recordSurfaced: async () => {},
    readPaused: async () => ({ paused: false }),
    readSessionBlockedUntil: async () => null,
    readSchedulerStopReason: async () => null,
    readShaDrift: async () => ({
      deployedSha: "a",
      originMasterSha: "a",
      firstSeenMs: null,
      driftSeconds: null,
      active: false,
    }),
    listDispatchOutcomes: async () => ({ ok: true, records: [] }),
    ...over,
  };
}

const rank3 = (r: Awaited<ReturnType<typeof getAttentionFeed>>) =>
  r.buckets.find((b) => b.bucket === "target-items")!;

describe("rank 3 target-items — wired and parameterised", () => {
  test("rank 3 is wired and the Target read targets the injected repo only", async () => {
    const repos: Array<string | undefined> = [];
    const result = await getAttentionFeed(
      deps({
        getTargetIssuesWaiting: async (d) => {
          repos.push(d?.githubRepo);
          assert.equal(d?.includeReframe, true);
          return waiting([issue(7, "ready-for-human")]);
        },
      }),
    );
    assert.deepEqual(repos, [TARGET]);
    const b = rank3(result);
    assert.equal(b.wired, true);
    assert.equal(b.count, 1);
    assert.equal(b.sourcesOk, true);
    const item = result.items.find((i) => i.bucket === "target-items")!;
    assert.equal(item.key, "target-items:ready-for-human");
    assert.equal(item.id, "target-ready-for-human-issue-7");
    assert.equal(item.action.key, "target-items:ready-for-human");
  });

  test("src/attention.ts and issues-waiting.ts carry no Target repo literal", () => {
    for (const f of ["src/attention.ts", "src/aggregators/issues-waiting.ts"]) {
      const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
      assert.doesNotMatch(src, /claw-street-bets|hydra-betting/, f);
    }
  });

  test("rank-2 and rank-3 ids for the same issue number never collide", async () => {
    const result = await getAttentionFeed(
      deps({
        getIssuesWaiting: async () =>
          waiting([issue(9, "needs-info", { url: "https://github.com/o/r/issues/9" })]),
        getTargetIssuesWaiting: async () => waiting([issue(9, "needs-info")]),
      }),
    );
    const ids = result.items.map((i) => i.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.includes("needs-info-issue-9"));
    assert.ok(ids.includes("target-needs-info-issue-9"));
  });
});

describe("rank 3 target-items — archived Target", () => {
  test("an archived Target renders exactly ONE aggregate row; the issue reader is never called", async () => {
    let issueReads = 0;
    const result = await getAttentionFeed(
      deps({
        readTargetRepoArchived: async () => true,
        getTargetIssuesWaiting: async () => {
          issueReads++;
          return quiet;
        },
      }),
    );
    assert.equal(issueReads, 0);
    const items = result.items.filter((i) => i.bucket === "target-items");
    assert.equal(items.length, 1);
    assert.equal(items[0].key, "target-items:archived");
    assert.equal(items[0].title, `Target ${TARGET} archived — awaiting swap`);
    assert.equal(items[0].id, `target-archived-${TARGET}`);
    const b = rank3(result);
    assert.equal(b.sourcesOk, true);
    assert.equal(b.scanned, 1);
    assert.deepEqual(b.sourceErrors, []);
    const parsed = AttentionFeedResponseSchema.safeParse({ ...result, generatedAt: NOW.toISOString() });
    assert.equal(parsed.success, true, JSON.stringify(parsed.success ? null : parsed.error.issues));
  });

  test("an unset (empty) Target repo also renders the aggregate row", async () => {
    const result = await getAttentionFeed(deps({ targetGithubRepo: "" }));
    const items = result.items.filter((i) => i.bucket === "target-items");
    assert.equal(items.length, 1);
    assert.equal(items[0].key, "target-items:archived");
    assert.equal(rank3(result).sourcesOk, true);
  });

  test("a null (UNKNOWN) archived read still reads issues but names target-repo-metadata", async () => {
    let issueReads = 0;
    const result = await getAttentionFeed(
      deps({
        readTargetRepoArchived: async () => null,
        getTargetIssuesWaiting: async () => {
          issueReads++;
          return waiting([issue(3, "stale-blocked")]);
        },
      }),
    );
    assert.equal(issueReads, 1);
    const b = rank3(result);
    assert.deepEqual(b.sourceErrors, ["target-repo-metadata"]);
    assert.equal(b.sourcesOk, false);
    assert.equal(b.count, 1);
    assert.equal(result.sourcesOk, false);
  });
});

describe("rank 3 target-items — reframe rows carry the attempt count", () => {
  test("observedValue = matching dev_target records in the window; detail names the newest transcript", async () => {
    const result = await getAttentionFeed(
      deps({
        getTargetIssuesWaiting: async () => waiting([issue(5, "reframe")]),
        listDispatchOutcomes: async () => ({
          ok: true,
          records: [
            outcome({ cycleId: "old-cycle", recordedAt: NOW.getTime() - 5000 }),
            outcome({ cycleId: "new-cycle", recordedAt: NOW.getTime() - 100 }),
            outcome({ cycleId: "resume-cycle", recordedAt: NOW.getTime() - 3000 }),
            outcome({ cycleId: "other-issue", anchorReference: "issue-6" }),
            outcome({ cycleId: "other-class", className: "dev_orch" }),
          ],
        }),
      }),
    );
    const item = result.items.find((i) => i.key === "target-items:reframe")!;
    assert.equal(item.observedValue, 3);
    assert.equal(item.threshold, 2);
    assert.match(item.detail ?? "", /\/dispatch\/new-cycle\/transcript/);
  });

  test("no matching record: observedValue 0 (unknown) and detail says so", async () => {
    const result = await getAttentionFeed(
      deps({ getTargetIssuesWaiting: async () => waiting([issue(5, "reframe")]) }),
    );
    const item = result.items.find((i) => i.key === "target-items:reframe")!;
    assert.equal(item.observedValue, 0);
    assert.match(item.detail ?? "", /no dispatch record/);
  });

  test("a dispatch-outcomes read failure keeps the row (observedValue 0) and does NOT flip sourcesOk", async () => {
    const result = await getAttentionFeed(
      deps({
        getTargetIssuesWaiting: async () => waiting([issue(5, "reframe")]),
        listDispatchOutcomes: async () => ({ ok: false, error: "redis down" }),
      }),
    );
    const item = result.items.find((i) => i.key === "target-items:reframe")!;
    assert.equal(item.observedValue, 0);
    assert.match(item.detail ?? "", /attempt count unavailable/);
    assert.equal(rank3(result).sourcesOk, true);
  });
});

describe("rank 2 — new admission lines", () => {
  test("ready-for-human and stale-blocked rows resolve the default registry entry with ids ready-for-human-issue-<n> / blocked-issue-<n> (legacy id kept)", async () => {
    const result = await getAttentionFeed(
      deps({
        getIssuesWaiting: async () =>
          waiting([issue(21, "ready-for-human"), issue(22, "stale-blocked")]),
      }),
    );
    const ids = result.items.filter((i) => i.bucket === "waiting-on-you").map((i) => i.id).sort();
    assert.deepEqual(ids, ["blocked-issue-22", "ready-for-human-issue-21"]);
    for (const i of result.items) assert.equal(i.action.variant, undefined);
  });
});

describe("rank 2 — blocked rows render the live blocker state and keep the legacy id", () => {
  test("blocked-live detail names the open blocker; stale-blocked says none open; both use blocked-issue-<n>", async () => {
    const live = { ...issue(31, "blocked-live"), blockerNumbers: [77, 78], openBlockerNumbers: [77] };
    const stale = { ...issue(32, "stale-blocked"), blockerNumbers: [78], openBlockerNumbers: [] };
    const result = await getAttentionFeed(
      deps({ getIssuesWaiting: async () => waiting([live, stale]) }),
    );
    const byId = new Map(result.items.map((i) => [i.id, i]));
    assert.equal(byId.get("blocked-issue-31")?.detail, "blocked by #77 (open)");
    assert.match(byId.get("blocked-issue-32")?.detail ?? "", /no open blocker/);
  });
});

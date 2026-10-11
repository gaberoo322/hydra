/**
 * Attention feed ranks 4-5 — repetition:hits + parked-over-cap:cap
 * (issue #4626, ADR-0034 §8.1). Every source is an injected stub.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { getAttentionFeed, type AttentionFeedDeps } from "../src/attention.ts";
import { DEFAULT_THRESHOLDS } from "../src/aggregators/stuck-items.ts";
import type { IssuesWaitingResult } from "../src/aggregators/issues-waiting.ts";
import type {
  FrictionPatternsSnapshot,
  FrictionPatternRow,
} from "../src/aggregators/friction-patterns.ts";
import { PROMOTION_THRESHOLD } from "../src/pattern-memory/index.ts";
import { HITL_GRILL_CAP, HITL_GRILL_LABEL } from "../src/schemas/autopilot-board.ts";
import type { IssueReadResult, IssueRow } from "../src/github/issues.ts";

const NOW = new Date("2026-08-14T12:00:00.000Z");

const quiet = async (): Promise<IssuesWaitingResult> => ({
  items: [],
  scanned: 0,
  sourcesOk: true,
  sourceErrors: [],
  thresholds: DEFAULT_THRESHOLDS,
});

function patternRow(over: Partial<FrictionPatternRow> = {}): FrictionPatternRow {
  return {
    skill: "hydra-dev",
    cue: "some-cue",
    severity: "prevent",
    hitCount: PROMOTION_THRESHOLD,
    hitsToPromotion: 0,
    promoted: false,
    lastSeen: "2026-08-01T00:00:00.000Z",
    firstSeen: "2026-07-01T00:00:00.000Z",
    examples: [],
    nearThreshold: false,
    lastEscalation: null,
    ...over,
  };
}

function friction(rows: FrictionPatternRow[]): FrictionPatternsSnapshot {
  return {
    bySkill: rows.length ? [{ skill: "hydra-dev", patterns: rows }] : [],
    thresholdCandidates: [],
    recentMetaFrictionIssues: [],
    promotionThreshold: PROMOTION_THRESHOLD,
    candidateWindow: 1,
    windowHours: 168,
    generatedAt: NOW.toISOString(),
    scanned: rows.length,
    sourcesOk: true,
  };
}

function issue(n: number, createdAt: string, over: Partial<IssueRow> = {}): IssueRow {
  return {
    number: n,
    title: `idea ${n}`,
    url: `https://github.com/gaberoo322/hydra/issues/${n}`,
    createdAt,
    labels: [HITL_GRILL_LABEL, "architecture-scan"],
    body: "",
    state: "OPEN",
    ...over,
  };
}

/** n open rows; issue number i is created i days after 2026-07-01 (so #1 is oldest). */
function lane(n: number): IssueRow[] {
  return Array.from({ length: n }, (_, i) =>
    issue(i + 1, new Date(Date.UTC(2026, 6, 1 + i)).toISOString()),
  );
}

function deps(over: Partial<AttentionFeedDeps> = {}): AttentionFeedDeps {
  return {
    now: NOW,
    targetGithubRepo: "owner/target",
    readTargetRepoArchived: async () => false,
    getIssuesWaiting: quiet,
    getTargetIssuesWaiting: quiet,
    getStalledPrs: async () => ({ items: [], scanned: 0, sourcesOk: true, sourceErrors: [] }),
    getFrictionPatterns: async () => friction([]),
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
    readHitlGrillIssues: async () => ({ ok: true as const, rows: [] }),
    ...over,
  };
}

const withLane =
  (rows: IssueRow[]): AttentionFeedDeps["readHitlGrillIssues"] =>
  async () => ({ ok: true, rows });

describe("rank 5 parked-over-cap:cap", () => {
  test("below cap: wired, sourcesOk, no item, scanned = rows read", async () => {
    const r = await getAttentionFeed(deps({ readHitlGrillIssues: withLane(lane(HITL_GRILL_CAP - 1)) }));
    const b = r.buckets.find((x) => x.bucket === "parked-over-cap")!;
    assert.deepEqual(
      { wired: b.wired, sourcesOk: b.sourcesOk, count: b.count, scanned: b.scanned, sourceErrors: b.sourceErrors },
      { wired: true, sourcesOk: true, count: 0, scanned: HITL_GRILL_CAP - 1, sourceErrors: [] },
    );
    assert.equal(r.items.filter((i) => i.key === "parked-over-cap:cap").length, 0);
  });

  test("exactly at cap: one aggregate item with count, cap, three oldest, resolved action", async () => {
    const r = await getAttentionFeed(deps({ readHitlGrillIssues: withLane(lane(HITL_GRILL_CAP)) }));
    const items = r.items.filter((i) => i.key === "parked-over-cap:cap");
    assert.equal(items.length, 1);
    const it = items[0];
    assert.equal(it.id, "parked-over-cap:cap");
    assert.equal(it.bucket, "parked-over-cap");
    assert.equal(it.rank, 5);
    assert.equal(it.signal, "blocked-on-human");
    assert.equal(it.observedValue, HITL_GRILL_CAP);
    assert.equal(it.threshold, HITL_GRILL_CAP);
    assert.equal(it.thresholdLabel, `parked ≥ ${HITL_GRILL_CAP}`);
    assert.equal(it.title, `Parked ideas over cap: ${HITL_GRILL_CAP} / ${HITL_GRILL_CAP}`);
    assert.equal(it.url, "/work");
    assert.equal(it.detail, "#1 idea 1; #2 idea 2; #3 idea 3");
    // crossedAt = createdAt of the CAP-th oldest row.
    assert.equal(it.crossedAt, lane(HITL_GRILL_CAP)[HITL_GRILL_CAP - 1].createdAt);
    assert.equal(it.action.recommended.kind, "terminal-skill");
    assert.equal((it.action.recommended as { command: string }).command, "/hydra-hitl-grill");
  });

  test("over cap: still exactly one item; three oldest by createdAt, not input order", async () => {
    const rows = lane(HITL_GRILL_CAP + 2).reverse();
    const r = await getAttentionFeed(deps({ readHitlGrillIssues: withLane(rows) }));
    const items = r.items.filter((i) => i.key === "parked-over-cap:cap");
    assert.equal(items.length, 1);
    assert.equal(items[0].observedValue, HITL_GRILL_CAP + 2);
    assert.equal(items[0].detail, "#1 idea 1; #2 idea 2; #3 idea 3");
    // INV-5: crossedAt is the CAP-th oldest row's createdAt (not newest/oldest).
    assert.equal(items[0].crossedAt, lane(HITL_GRILL_CAP + 2)[HITL_GRILL_CAP - 1].createdAt);
  });

  test("unparseable createdAt on the CAP-th oldest row falls back to now", async () => {
    const rows = lane(HITL_GRILL_CAP);
    rows[HITL_GRILL_CAP - 1] = issue(HITL_GRILL_CAP, "not-a-date");
    const r = await getAttentionFeed(deps({ readHitlGrillIssues: withLane(rows) }));
    const it = r.items.find((i) => i.key === "parked-over-cap:cap");
    assert.equal(it?.crossedAt, NOW.toISOString());
  });

  test("CLOSED / unlabelled rows do not count toward the cap", async () => {
    const rows = [
      ...lane(HITL_GRILL_CAP - 1),
      issue(900, "2026-07-01T00:00:00.000Z", { state: "CLOSED" }),
      issue(901, "2026-07-01T00:00:00.000Z", { labels: ["other"] }),
    ];
    const r = await getAttentionFeed(deps({ readHitlGrillIssues: withLane(rows) }));
    assert.equal(r.items.filter((i) => i.key === "parked-over-cap:cap").length, 0);
  });

  test("a rejected lane read renders UNKNOWN naming hitl-grill, never an asserted zero", async () => {
    const r = await getAttentionFeed(
      deps({
        readHitlGrillIssues: async () => {
          throw new Error("gh down");
        },
      }),
    );
    const b = r.buckets.find((x) => x.bucket === "parked-over-cap")!;
    assert.equal(b.sourcesOk, false);
    assert.deepEqual(b.sourceErrors, ["hitl-grill"]);
    assert.equal(r.sourcesOk, false);
  });

  test("INV-6: a lane at cap with no registry entry drops the item and marks the bucket UNKNOWN", async () => {
    const r = await getAttentionFeed(
      deps({ readHitlGrillIssues: withLane(lane(HITL_GRILL_CAP)), registry: [] }),
    );
    assert.equal(r.items.filter((i) => i.key === "parked-over-cap:cap").length, 0);
    const b = r.buckets.find((x) => x.bucket === "parked-over-cap")!;
    assert.equal(b.count, 0);
    assert.equal(b.sourcesOk, false);
    assert.ok(b.sourceErrors.includes("registry:parked-over-cap:cap"));
  });

  test("an {ok:false} lane read renders UNKNOWN naming hitl-grill", async () => {
    const failed = { ok: false, code: "gh-failed" } as unknown as IssueReadResult<IssueRow>;
    const r = await getAttentionFeed(deps({ readHitlGrillIssues: async () => failed }));
    const b = r.buckets.find((x) => x.bucket === "parked-over-cap")!;
    assert.equal(b.sourcesOk, false);
    assert.deepEqual(b.sourceErrors, ["hitl-grill"]);
    assert.equal(r.items.length, 0);
  });
});

describe("rank 4 repetition:hits (pinned, already wired)", () => {
  test("a pattern at the promotion bar admits one item with a resolved action", async () => {
    const r = await getAttentionFeed(
      deps({ getFrictionPatterns: async () => friction([patternRow()]) }),
    );
    const items = r.items.filter((i) => i.key === "repetition:hits");
    assert.equal(items.length, 1);
    assert.equal(items[0].bucket, "repetition");
    assert.equal(items[0].threshold, PROMOTION_THRESHOLD);
    assert.ok(items[0].action.recommended);
  });

  test("a pattern below the bar admits nothing", async () => {
    const r = await getAttentionFeed(
      deps({ getFrictionPatterns: async () => friction([patternRow({ hitCount: PROMOTION_THRESHOLD - 1 })]) }),
    );
    assert.equal(r.items.filter((i) => i.key === "repetition:hits").length, 0);
  });
});

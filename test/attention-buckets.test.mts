/**
 * Attention feed — six-bucket drain order, machine-stopped aggregate, resolved
 * registry actions (issue #4623, ADR-0034 §8.1/§8.2).
 *
 * Pure: every source (stuck-items, friction-patterns, the four rank-0 line
 * reads, the dismissal ledger, the surfaced counter) is an injected stub, so
 * no case touches live Redis, git or the scheduler.
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  getAttentionFeed,
  compareDrainOrder,
  resolveAction,
  type AttentionFeedDeps,
} from "../src/attention.ts";
import {
  DEPLOY_DRIFT_GRACE_SECONDS,
  nextDriftFirstSeen,
  readDeployDrift,
  resetDeployDriftMemo,
  type DeployDriftReading,
} from "../src/health/deployed-sha.ts";
import { DEFAULT_THRESHOLDS, type StuckItems } from "../src/aggregators/stuck-items.ts";
import type { IssuesWaitingResult } from "../src/aggregators/issues-waiting.ts";
import type {
  FrictionPatternsSnapshot,
  FrictionPatternRow,
} from "../src/aggregators/friction-patterns.ts";
import { PROMOTION_THRESHOLD } from "../src/pattern-memory/index.ts";
import type { StalledPrsResult } from "../src/aggregators/stalled-prs.ts";
import { REGISTRY } from "../src/operator-actions/registry.ts";
import {
  BUCKETS,
  OperatorActionEntrySchema,
  type Action,
} from "../src/schemas/operator-actions.ts";
import { AttentionFeedResponseSchema } from "../src/schemas/attention.ts";

const NOW = new Date("2026-08-14T12:00:00.000Z");

// ---------------------------------------------------------------------------
// Stub factories
// ---------------------------------------------------------------------------

function stuckSnapshot(over: Partial<StuckItems> = {}): IssuesWaitingResult {
  // Issue #4625: rank 2 reads issues-waiting; this adapter keeps the legacy
  // blocked/needs-info fixtures expressible as classified waiting rows.
  const s = {
    blockedOver2d: [] as StuckItems["blockedOver2d"],
    needsInfoWaiting: [] as StuckItems["needsInfoWaiting"],
    thresholds: DEFAULT_THRESHOLDS,
    scanned: 0,
    sourcesOk: true,
    ...over,
  };
  return {
    items: [
      ...s.blockedOver2d.map((i) => ({ ...i, line: "blocked-live" as const, blockerNumbers: [], openBlockerNumbers: [] })),
      ...s.needsInfoWaiting.map((i) => ({ ...i, line: "needs-info" as const, blockerNumbers: [], openBlockerNumbers: [] })),
    ],
    scanned: s.scanned,
    sourcesOk: s.sourcesOk,
    sourceErrors: s.sourcesOk ? [] : ["blocked"],
    thresholds: s.thresholds,
  };
}

/** Rank 3 quiet default: the Target repo is live and has nothing waiting. */
const quietTargetWaiting = async (): Promise<IssuesWaitingResult> => ({
  items: [],
  scanned: 0,
  sourcesOk: true,
  sourceErrors: [],
  thresholds: DEFAULT_THRESHOLDS,
});

function stalledSnapshot(over: Partial<StalledPrsResult> = {}): StalledPrsResult {
  return { items: [], scanned: 0, sourcesOk: true, sourceErrors: [], ...over };
}

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

function frictionSnapshot(over: Partial<FrictionPatternsSnapshot> = {}): FrictionPatternsSnapshot {
  return {
    bySkill: [],
    thresholdCandidates: [],
    recentMetaFrictionIssues: [],
    promotionThreshold: PROMOTION_THRESHOLD,
    candidateWindow: 1,
    windowHours: 168,
    generatedAt: NOW.toISOString(),
    scanned: 0,
    sourcesOk: true,
    ...over,
  };
}

function inSync(): DeployDriftReading {
  return { deployedSha: "aaaa", originMasterSha: "aaaa", firstSeenMs: null, driftSeconds: null, active: false };
}

/** A feed dep bag with every source quiet + fulfilled; override per case. */
function deps(over: Partial<AttentionFeedDeps> = {}): AttentionFeedDeps {
  return {
    now: NOW,
    targetGithubRepo: "owner/target",
    readTargetRepoArchived: async () => false,
    getTargetIssuesWaiting: quietTargetWaiting,
    getIssuesWaiting: async () => stuckSnapshot(),
    getStalledPrs: async () => stalledSnapshot(),
    getFrictionPatterns: async () => frictionSnapshot(),
    loadDismissedIds: async () => [],
    recordSurfaced: async () => {},
    readHitlGrillIssues: async () => ({ ok: true as const, rows: [] }),
    readPaused: async () => ({ paused: false }),
    readSessionBlockedUntil: async () => null,
    readSchedulerStopReason: async () => null,
    readShaDrift: async () => inSync(),
    ...over,
  };
}

const down = async (): Promise<never> => {
  throw new Error("source down");
};

function templatesOf(action: Action): string[] {
  if (action.kind === "terminal-skill") return [action.command];
  if (action.kind === "in-dashboard") return [action.route];
  return [];
}

/** A busy fixture spanning ranks 0, 1, 2 and 4 with deliberately inverted ages. */
function busyDeps(over: Partial<AttentionFeedDeps> = {}): AttentionFeedDeps {
  return deps({
    readPaused: async () => ({ paused: true, since: Date.parse("2026-08-14T11:00:00.000Z") }),
    getIssuesWaiting: async () =>
      stuckSnapshot({
        blockedOver2d: [
          // Oldest item in the whole feed — still drains AFTER rank 1.
          { number: 10, title: "old blocked", url: "u10", createdAt: "2026-01-01T00:00:00.000Z", ageDays: 200, labels: [] },
        ],
        needsInfoWaiting: [
          { number: 11, title: "needs info", url: "u11", createdAt: "2026-08-10T00:00:00.000Z", ageDays: 4, labels: [] },
        ],
        scanned: 2,
      }),
    getStalledPrs: async () =>
      stalledSnapshot({
        items: [
          // Newest item — still drains BEFORE every rank-2 item.
          {
            number: 20,
            title: "red pr",
            url: "u20",
            updatedAt: "2026-08-14T11:59:00.000Z",
            line: "failed-required",
            failedChecks: ["test"],
            requiredGreen: 0,
            requiredTotal: 1,
          },
        ],
        scanned: 1,
      }),
    getFrictionPatterns: async () =>
      frictionSnapshot({
        bySkill: [{ skill: "hydra-dev", patterns: [patternRow({ lastSeen: "2025-01-01T00:00:00.000Z" })] }],
        scanned: 1,
      }),
    ...over,
  });
}

// ---------------------------------------------------------------------------
// INV-1 — drain order
// ---------------------------------------------------------------------------

describe("drain order (INV-1)", () => {
  test("items drain rank 0..5 — no cross-bucket age comparison", async () => {
    const result = await getAttentionFeed(busyDeps());
    const ranks = result.items.map((i) => i.rank);
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
    assert.deepEqual(
      result.items.map((i) => i.bucket),
      ["machine-stopped", "prs-not-landing", "waiting-on-you", "waiting-on-you", "repetition"],
    );
    // The 200-day-old blocked issue does NOT jump the minute-old red PR.
    assert.equal(result.items[1].id, "pr-failed-ci-20");
    assert.equal(result.items[2].id, "blocked-issue-10");
  });

  test("within a bucket: crossedAt ascending, then id; unparseable crossedAt last", () => {
    const rows = [
      { rank: 2, crossedAt: "not-a-date", id: "a" },
      { rank: 2, crossedAt: "2026-08-02T00:00:00.000Z", id: "z" },
      { rank: 2, crossedAt: "2026-08-01T00:00:00.000Z", id: "m" },
      { rank: 1, crossedAt: "2026-09-01T00:00:00.000Z", id: "late-but-rank-1" },
    ];
    rows.sort(compareDrainOrder);
    assert.deepEqual(rows.map((r) => r.id), ["late-but-rank-1", "m", "z", "a"]);
  });

  test("equal finite crossedAt ties break on id ascending", () => {
    const at = "2026-08-01T00:00:00.000Z";
    const rows = [
      { rank: 2, crossedAt: at, id: "needs-info-issue-9" },
      { rank: 2, crossedAt: at, id: "blocked-issue-3" },
    ];
    rows.sort(compareDrainOrder);
    assert.deepEqual(rows.map((r) => r.id), ["blocked-issue-3", "needs-info-issue-9"]);
  });
});

// ---------------------------------------------------------------------------
// INV-2 / INV-4 — bucket summaries + unwired buckets
// ---------------------------------------------------------------------------

describe("bucket summaries (INV-2, INV-4)", () => {
  test("exactly six summaries in BUCKETS order; count = visible items per bucket", async () => {
    const result = await getAttentionFeed(busyDeps());
    assert.deepEqual(result.buckets.map((b) => b.bucket), [...BUCKETS]);
    assert.deepEqual(result.buckets.map((b) => b.rank), [0, 1, 2, 3, 4, 5]);
    const byBucket = Object.fromEntries(result.buckets.map((b) => [b.bucket, b.count]));
    assert.equal(byBucket["machine-stopped"], 1);
    assert.equal(byBucket["prs-not-landing"], 1);
    assert.equal(byBucket["waiting-on-you"], 2);
    assert.equal(byBucket.repetition, 1);
    assert.equal(
      result.buckets.reduce((sum, b) => sum + b.count, 0),
      result.items.length,
      "items are not duplicated inside buckets",
    );
  });

  test("parked-over-cap is wired: below cap => wired, sourcesOk, count 0 (never not-wired)", async () => {
    const result = await getAttentionFeed(deps());
    const b = result.buckets.find((x) => x.bucket === "parked-over-cap")!;
    assert.deepEqual(
      { wired: b.wired, sourcesOk: b.sourcesOk, count: b.count, sourceErrors: b.sourceErrors },
      { wired: true, sourcesOk: true, count: 0, sourceErrors: [] },
    );
    assert.equal(result.buckets.every((x) => x.wired), true);
    assert.equal(result.sourcesOk, true);
    assert.equal(result.scanned, result.buckets.reduce((s, b) => s + b.scanned, 0));
  });

  test("the scanned split across ranks 1 and 2 is exact", async () => {
    const result = await getAttentionFeed(busyDeps());
    const by = Object.fromEntries(result.buckets.map((b) => [b.bucket, b.scanned]));
    assert.equal(by["prs-not-landing"], 1);
    assert.equal(by["waiting-on-you"], 2);
    assert.equal(by.repetition, 1);
    assert.equal(by["machine-stopped"], 4);
  });

  test("a failed issues-waiting source names itself on rank 2 only (rank 1 reads stalled-prs, #4624)", async () => {
    const result = await getAttentionFeed(deps({ getIssuesWaiting: down }));
    const by = Object.fromEntries(result.buckets.map((b) => [b.bucket, b]));
    assert.deepEqual(by["prs-not-landing"].sourceErrors, []);
    assert.deepEqual(by["waiting-on-you"].sourceErrors, ["issues-waiting"]);
    assert.equal(by.repetition.sourcesOk, true);
    assert.equal(by["machine-stopped"].sourcesOk, true);
    assert.equal(result.sourcesOk, false);
  });

  test("the full feed validates against the HTTP response schema", async () => {
    const result = await getAttentionFeed(busyDeps());
    const parsed = AttentionFeedResponseSchema.safeParse({ ...result, generatedAt: NOW.toISOString() });
    assert.equal(parsed.success, true, JSON.stringify(parsed.success ? null : parsed.error.issues));
  });
});

// ---------------------------------------------------------------------------
// INV-5 — legacy signal -> line mapping
// ---------------------------------------------------------------------------

describe("legacy signal -> admission line (INV-5)", () => {
  test("ids and signals are unchanged; each item carries its <bucket>:<line> key", async () => {
    const result = await getAttentionFeed(busyDeps({ readPaused: async () => ({ paused: false }) }));
    const got = result.items.map((i) => [i.id, i.signal, i.key, i.rank]);
    assert.deepEqual(got, [
      ["pr-failed-ci-20", "breakage", "prs-not-landing:failed-required", 1],
      ["blocked-issue-10", "blocked-on-human", "waiting-on-you:blocked-live", 2],
      ["needs-info-issue-11", "blocked-on-human", "waiting-on-you:needs-info", 2],
      ["friction-hydra-dev-some-cue", "repetition", "repetition:hits", 4],
    ]);
  });
});

// ---------------------------------------------------------------------------
// INV-6 / INV-3 — machine-stopped aggregate
// ---------------------------------------------------------------------------

describe("machine-stopped aggregate (INV-6, INV-3)", () => {
  const cases: { line: string; over: Partial<AttentionFeedDeps> }[] = [
    { line: "paused", over: { readPaused: async () => ({ paused: true, since: NOW.getTime() - 60_000 }) } },
    { line: "session-blocked", over: { readSessionBlockedUntil: async () => NOW.getTime() + 3_600_000 } },
    { line: "scheduler-deliberate", over: { readSchedulerStopReason: async () => "deliberate" } },
    {
      line: "sha-drift",
      over: {
        readShaDrift: async () => ({
          deployedSha: "aaaaaaaaaa",
          originMasterSha: "bbbbbbbbbb",
          firstSeenMs: NOW.getTime() - 700_000,
          driftSeconds: 700,
          active: true,
        }),
      },
    },
  ];
  for (const { line, over } of cases) {
    test(`line alone: ${line} -> one aggregate row`, async () => {
      const result = await getAttentionFeed(deps(over));
      assert.equal(result.items.length, 1);
      const row = result.items[0];
      assert.equal(row.id, `machine-stopped:${line}`);
      assert.equal(row.rank, 0);
      assert.equal(row.bucket, "machine-stopped");
      assert.equal(row.signal, "blocked-on-human");
      assert.equal(row.url, "/health");
      assert.equal(row.key, `machine-stopped:${line}`);
      assert.equal(row.observedValue, 1);
      assert.equal(row.threshold, 1);
      assert.deepEqual(row.subLines!.map((s) => s.line), [line]);
      assert.equal(result.buckets[0].sourcesOk, true);
    });
  }

  test("several lines -> ONE row; subLines in line order; id sorted; key = most upstream", async () => {
    const result = await getAttentionFeed(
      deps({
        readSchedulerStopReason: async () => "deliberate",
        readSessionBlockedUntil: async () => NOW.getTime() + 60_000,
      }),
    );
    assert.equal(result.items.length, 1);
    const row = result.items[0];
    assert.deepEqual(row.subLines!.map((s) => s.line), ["session-blocked", "scheduler-deliberate"]);
    assert.equal(row.id, "machine-stopped:scheduler-deliberate,session-blocked");
    assert.equal(row.key, "machine-stopped:session-blocked");
    assert.deepEqual(row.action, row.subLines![0].action);
    assert.equal(row.observedValue, 2);
    assert.match(row.thresholdLabel, /session-blocked/);
    assert.match(row.thresholdLabel, /scheduler-deliberate/);
  });

  test("no active line -> no row, and rank 0 asserts its zero", async () => {
    const result = await getAttentionFeed(deps());
    assert.equal(result.items.length, 0);
    assert.deepEqual(result.buckets[0], {
      rank: 0,
      bucket: "machine-stopped",
      wired: true,
      count: 0,
      scanned: 4,
      sourcesOk: true,
      sourceErrors: [],
    });
  });

  test("a scheduler stopReason other than deliberate is not a stop line", async () => {
    const result = await getAttentionFeed(deps({ readSchedulerStopReason: async () => "circuit-breaker" }));
    assert.equal(result.items.length, 0);
  });

  test("drift below the grace window (active:false) is not a stop line", async () => {
    const result = await getAttentionFeed(
      deps({
        readShaDrift: async () => ({
          deployedSha: "a1",
          originMasterSha: "b2",
          firstSeenMs: NOW.getTime() - 10_000,
          driftSeconds: 10,
          active: false,
        }),
      }),
    );
    assert.equal(result.items.length, 0);
    assert.equal(result.buckets[0].sourcesOk, true);
  });

  const failures: { name: string; over: Partial<AttentionFeedDeps>; error: string }[] = [
    { name: "paused", over: { readPaused: down }, error: "paused" },
    { name: "session-block", over: { readSessionBlockedUntil: down }, error: "session-block" },
    { name: "scheduler", over: { readSchedulerStopReason: down }, error: "scheduler" },
    { name: "sha-drift", over: { readShaDrift: down }, error: "sha-drift" },
    {
      name: "deployed-sha null",
      over: { readShaDrift: async () => ({ ...inSync(), deployedSha: null }) },
      error: "deployed-sha",
    },
    {
      name: "origin-master-sha null",
      over: { readShaDrift: async () => ({ ...inSync(), originMasterSha: null }) },
      error: "origin-master-sha",
    },
  ];
  for (const { name, over, error } of failures) {
    test(`a failed ${name} read renders UNKNOWN, never 'not stopped'`, async () => {
      const result = await getAttentionFeed(deps(over));
      assert.equal(result.buckets[0].sourcesOk, false);
      assert.deepEqual(result.buckets[0].sourceErrors, [error]);
      assert.equal(result.sourcesOk, false, "top-level must not assert an all-clear");
    });
  }

  test("a synchronous throw from a rank-0 dep is captured, never escapes", async () => {
    const result = await getAttentionFeed(
      deps({
        readPaused: (() => {
          throw new Error("sync boom");
        }) as unknown as AttentionFeedDeps["readPaused"],
      }),
    );
    assert.deepEqual(result.buckets[0].sourceErrors, ["paused"]);
  });

  test("one failed line does not hide another active line", async () => {
    const result = await getAttentionFeed(
      deps({ readPaused: down, readSchedulerStopReason: async () => "deliberate" }),
    );
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].id, "machine-stopped:scheduler-deliberate");
    assert.equal(result.buckets[0].sourcesOk, false);
  });
});

// ---------------------------------------------------------------------------
// INV-7 / INV-8 — drift memo + watchdog pin
// ---------------------------------------------------------------------------

describe("deploy-drift memo (INV-7)", () => {
  beforeEach(() => resetDeployDriftMemo());

  test("transition table matches the watchdog marker file", () => {
    const table: [number | null, string | null, string | null, number, number | null, string][] = [
      [null, "a", "b", 100, 100, "first differing read sets first-seen"],
      [50, "a", "b", 100, 50, "persists while differing"],
      [50, "a", "c", 100, 50, "persists when origin/master advances again"],
      [50, "a", "a", 100, null, "cleared when equal"],
      [null, "a", "a", 100, null, "stays clear when equal"],
      [50, null, "b", 100, 50, "null deployed SHA neither sets nor clears"],
      [50, "a", null, 100, 50, "null remote SHA neither sets nor clears"],
      [null, null, null, 100, null, "null read on a clear memo stays clear"],
    ];
    for (const [prev, deployed, remote, now, expected, why] of table) {
      assert.equal(nextDriftFirstSeen(prev, deployed, remote, now), expected, why);
    }
  });

  test("readDeployDrift turns active only at >= DEPLOY_DRIFT_GRACE_SECONDS of sustained drift", async () => {
    let nowMs = 1_000_000;
    const probe = {
      now: () => nowMs,
      getDeployedSha: async () => "deployed",
      getRemoteMasterSha: async () => "remote",
    };
    const first = await readDeployDrift(probe);
    assert.equal(first.active, false);
    assert.equal(first.driftSeconds, 0);
    nowMs += (DEPLOY_DRIFT_GRACE_SECONDS - 1) * 1000;
    assert.equal((await readDeployDrift(probe)).active, false);
    nowMs += 1000;
    const sustained = await readDeployDrift(probe);
    assert.equal(sustained.active, true);
    assert.equal(sustained.driftSeconds, DEPLOY_DRIFT_GRACE_SECONDS);
    assert.equal(sustained.firstSeenMs, 1_000_000);
  });

  test("an in-sync read clears the episode", async () => {
    let remote = "remote";
    let nowMs = 0;
    const probe = {
      now: () => nowMs,
      getDeployedSha: async () => "deployed",
      getRemoteMasterSha: async () => remote,
    };
    await readDeployDrift(probe);
    remote = "deployed";
    nowMs = DEPLOY_DRIFT_GRACE_SECONDS * 2000;
    const synced = await readDeployDrift(probe);
    assert.equal(synced.active, false);
    assert.equal(synced.firstSeenMs, null);
    remote = "remote";
    const fresh = await readDeployDrift(probe);
    assert.equal(fresh.active, false, "a new episode restarts the grace window");
  });
});

describe("watchdog drift-grace pin (INV-8)", () => {
  test("scripts/hydra-watchdog.sh defaults AUTODEPLOY_GRACE to DEPLOY_DRIFT_GRACE_SECONDS", () => {
    const script = readFileSync(new URL("../scripts/hydra-watchdog.sh", import.meta.url), "utf8");
    const match = script.match(/HYDRA_WATCHDOG_AUTODEPLOY_GRACE_SECONDS:-(\d+)/);
    assert.ok(match, "watchdog declares a HYDRA_WATCHDOG_AUTODEPLOY_GRACE_SECONDS default");
    assert.equal(Number(match![1]), DEPLOY_DRIFT_GRACE_SECONDS);
  });
});

// ---------------------------------------------------------------------------
// INV-9 / INV-10 — resolved actions
// ---------------------------------------------------------------------------

describe("resolved registry actions (INV-9, INV-10)", () => {
  test("every emitted item (and sub-line) carries a valid, fully-resolved action", async () => {
    const result = await getAttentionFeed(
      busyDeps({
        readSessionBlockedUntil: async () => NOW.getTime() + 60_000,
        readSchedulerStopReason: async () => "deliberate",
        readShaDrift: async () => ({
          deployedSha: "a1",
          originMasterSha: "b2",
          firstSeenMs: 0,
          driftSeconds: 9999,
          active: true,
        }),
      }),
    );
    const actions = result.items.flatMap((i) => [i.action, ...(i.subLines ?? []).map((s) => s.action)]);
    assert.ok(actions.length >= 8);
    for (const entry of actions) {
      assert.equal(OperatorActionEntrySchema.safeParse(entry).success, true);
      for (const action of [entry.recommended, entry.alternatives[0], entry.alternatives[1]]) {
        for (const template of templatesOf(action)) {
          assert.doesNotMatch(template, /\{[a-zA-Z0-9_]+\}/, `leftover placeholder in ${template}`);
        }
      }
    }
  });

  test("{repo} / {number} resolve from the item context", async () => {
    const result = await getAttentionFeed(busyDeps({ githubRepo: "acme/widgets" }));
    const pr = result.items.find((i) => i.id === "pr-failed-ci-20")!;
    const templates = [pr.action.recommended, ...pr.action.alternatives].flatMap(templatesOf);
    assert.ok(templates.some((t) => t.includes("20") && t.includes("acme/widgets")), templates.join(" | "));
  });

  test("lookup falls back to the default entry when the variant has none", () => {
    const resolved = resolveAction("waiting-on-you:needs-info", "grill-handoff", {
      repo: "r/r",
      number: 7,
      kind: "issue",
    });
    const def = REGISTRY.find((e) => e.key === "waiting-on-you:needs-info" && e.variant === undefined)!;
    assert.equal(resolved!.rationale, def.rationale);
    assert.equal(resolved!.variant, undefined);
  });

  test("an unresolvable placeholder yields null", () => {
    assert.equal(resolveAction("waiting-on-you:needs-info", undefined, {}), null);
  });

  test("a registry gap drops the item and marks its bucket UNKNOWN — never an action-less item", async () => {
    const registry = REGISTRY.filter((e) => e.key !== "prs-not-landing:failed-required");
    const result = await getAttentionFeed(busyDeps({ registry }));
    assert.equal(result.items.some((i) => i.id === "pr-failed-ci-20"), false);
    const bucket = result.buckets.find((b) => b.bucket === "prs-not-landing")!;
    assert.equal(bucket.sourcesOk, false);
    assert.deepEqual(bucket.sourceErrors, ["registry:prs-not-landing:failed-required"]);
    assert.equal(result.sourcesOk, false);
  });
});

/**
 * Regression tests for the attention feed (issue #4007, ADR-0034 §4).
 *
 * Pins the contract at every layer the slice touches:
 *
 *   - Schema — the closed signal vocabulary (NO deviation/spend/quota
 *     member), the asserted-emptiness trust fields (scanned + sourcesOk,
 *     mirroring #4006's DecisionQueueResponse), and the strict dismiss body.
 *   - Composer (src/attention.ts) — the three signals map onto the common
 *     item shape with thresholds sourced from the SAME production constants
 *     (DEFAULT_THRESHOLDS / PROMOTION_THRESHOLD — no new lines invented),
 *     dismissals are durable per item id, counters are keyed per signal, and
 *     the composer never throws (Promise.allSettled + settledOr degrade).
 *   - Route (src/api/attention.ts) — forwards the trust evidence, validates
 *     the dismiss body through the Schemas seam (400 schema-validation-failed).
 *   - Redis accessor (src/redis/attention.ts) — record-once semantics, the
 *     30-day dismissal snooze, and the per-threshold calibration counters.
 *
 * Why server-side only: AttentionFeed.jsx is a React component the node:test
 * suite cannot import (no JSX runner, no react in the worktree). The client
 * keys mechanically off the fields these tests pin at the HTTP boundary.
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

import {
  AttentionFeedResponseSchema,
  AttentionFeedItemSchema,
  DismissAttentionRequestSchema,
} from "../src/schemas/attention.ts";
import {
  getAttentionFeed,
  crossedAtFrom,
  repetitionItems,
} from "../src/attention.ts";
import { createAttentionRouter } from "../src/api/attention.ts";
import {
  DEFAULT_THRESHOLDS,
  type StuckItems,
} from "../src/aggregators/stuck-items.ts";
import type { IssuesWaitingResult } from "../src/aggregators/issues-waiting.ts";
import {
  type FrictionPatternsSnapshot,
  type FrictionPatternRow,
} from "../src/aggregators/friction-patterns.ts";
import { PROMOTION_THRESHOLD, escalationThresholdForCue } from "../src/pattern-memory/index.ts";
import {
  dismissAttentionItem,
  loadDismissed,
} from "../src/redis/attention.ts";
import type { AttentionFeedItem } from "../src/schemas/attention.ts";
import { resolveAction } from "../src/attention.ts";
import { ADMISSION_LINE_KEYS, BUCKETS } from "../src/schemas/operator-actions.ts";
import type { StalledPr, StalledPrsResult } from "../src/aggregators/stalled-prs.ts";

const NOW = new Date("2026-08-14T12:00:00.000Z");

// ---------------------------------------------------------------------------
// Stub factories — full snapshot shapes so the composer is exercised against
// the real aggregator return types.
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
      ...s.blockedOver2d.map((i) => ({ ...i, line: "blocked-live" as const, blockerNumbers: [], openBlockerNumbers: [], humanBlockers: [], hasFilesInScope: true })),
      ...s.needsInfoWaiting.map((i) => ({ ...i, line: "needs-info" as const, blockerNumbers: [], openBlockerNumbers: [], humanBlockers: [], hasFilesInScope: true })),
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

function stalledPr(over: Partial<StalledPr> & { number: number }): StalledPr {
  return {
    title: `PR #${over.number}`,
    url: `https://github.com/gaberoo322/hydra/pull/${over.number}`,
    updatedAt: NOW.toISOString(),
    line: "failed-required",
    failedChecks: ["test"],
    requiredGreen: 0,
    requiredTotal: 1,
    ...over,
  };
}

function patternRow(over: Partial<FrictionPatternRow> = {}): FrictionPatternRow {
  return {
    skill: "hydra-dev",
    cue: "some-cue",
    severity: "prevent",
    hitCount: PROMOTION_THRESHOLD,
    hitsToPromotion: 0,
    promoted: false,
    lastSeen: "2026-08-13T00:00:00.000Z",
    firstSeen: "2026-08-01T00:00:00.000Z",
    examples: [],
    nearThreshold: false,
    lastEscalation: null,
    ...over,
  };
}

function frictionSnapshot(
  over: Partial<FrictionPatternsSnapshot> = {},
): FrictionPatternsSnapshot {
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

function feedItem(over: Partial<AttentionFeedItem> = {}): AttentionFeedItem {
  return {
    id: "blocked-issue-1",
    signal: "blocked-on-human",
    title: "item",
    url: "https://github.com/gaberoo322/hydra/issues/1",
    observedValue: 4,
    threshold: DEFAULT_THRESHOLDS.blockedDays,
    thresholdLabel: "blocked ≥ 2d",
    crossedAt: NOW.toISOString(),
    dismissed: false,
    bucket: "waiting-on-you",
    rank: 2,
    key: "waiting-on-you:blocked-live",
    action: resolveAction("waiting-on-you:blocked-live", undefined, {
      repo: "gaberoo322/hydra",
      number: 1,
      kind: "issue",
    })!,
    ...over,
  };
}

/** Six asserted-zero bucket summaries (issue #4623) for schema fixtures. */
function zeroBuckets() {
  return BUCKETS.map((bucket, rank) => ({
    rank,
    bucket,
    wired: true,
    count: 0,
    scanned: 0,
    sourcesOk: true,
    sourceErrors: [] as string[],
  }));
}

/**
 * Issue #4623: a quiet rank-0 (machine-stopped) stub — every line reads
 * fulfilled and not-stopped, so these tests never touch live Redis / git /
 * the scheduler. The four fulfilled reads contribute 4 to `scanned`.
 */
const QUIET_RANK0 = {
  // Issue #4625: rank 3 reads the configured Target — stub it live + quiet.
  targetGithubRepo: "owner/target",
  readTargetRepoArchived: async () => false,
  getTargetIssuesWaiting: quietTargetWaiting,
  // Issue #4624: rank 1 reads PRs through stalled-prs — stub it quiet too.
  getStalledPrs: async (): Promise<StalledPrsResult> => stalledSnapshot(),
  readHitlGrillIssues: async () => ({ ok: true as const, rows: [] }),
  readPaused: async () => ({ paused: false }),
  readSessionBlockedUntil: async () => null,
  readSchedulerStopReason: async () => null,
  readShaDrift: async () => ({
    deployedSha: "abc",
    originMasterSha: "abc",
    firstSeenMs: null,
    driftSeconds: null,
    active: false,
  }),
};
const RANK0_SCANNED = 4;

const NO_DISMISSALS = {
  loadDismissed: async () => new Map<string, Set<string>>(),
};
const NO_COUNTING = {
  reconcileLedgers: async () => {},
};

// ---------------------------------------------------------------------------
// Schema — closed signal vocabulary + trust fields
// ---------------------------------------------------------------------------

describe("AttentionFeedResponseSchema — trust fields", () => {
  test("accepts an ASSERTED zero: items [], scanned 0, sourcesOk true", () => {
    const result = AttentionFeedResponseSchema.safeParse({
      items: [],
      buckets: zeroBuckets(),
      scanned: 0,
      sourcesOk: true,
      generatedAt: NOW.toISOString(),
    });
    assert.equal(result.success, true);
  });

  test("accepts an UNASSERTED empty: sourcesOk false, items []", () => {
    // Both empty cases are valid HTTP — they differ only in the trust
    // evidence, which is exactly what the client status machine reads.
    const result = AttentionFeedResponseSchema.safeParse({
      items: [],
      buckets: zeroBuckets(),
      scanned: 0,
      sourcesOk: false,
      generatedAt: NOW.toISOString(),
    });
    assert.equal(result.success, true);
  });

  test("rejects a response missing sourcesOk (unasserted)", () => {
    const result = AttentionFeedResponseSchema.safeParse({
      items: [],
      buckets: zeroBuckets(),
      scanned: 0,
      generatedAt: NOW.toISOString(),
    });
    assert.equal(result.success, false);
  });

  test("rejects a response missing scanned", () => {
    const result = AttentionFeedResponseSchema.safeParse({
      items: [],
      buckets: zeroBuckets(),
      sourcesOk: true,
      generatedAt: NOW.toISOString(),
    });
    assert.equal(result.success, false);
  });

  test("rejects an unknown extra field (strict mode)", () => {
    const result = AttentionFeedResponseSchema.safeParse({
      items: [],
      buckets: zeroBuckets(),
      scanned: 0,
      sourcesOk: true,
      generatedAt: NOW.toISOString(),
      surprise: true,
    });
    assert.equal(result.success, false);
  });

  test("INV-2: rejects a deviation/spend signal — the enum is closed", () => {
    const result = AttentionFeedItemSchema.safeParse(
      feedItem({ signal: "spend" as never }),
    );
    assert.equal(result.success, false);
  });

  test("INV-2: rejects a quota signal", () => {
    const result = AttentionFeedItemSchema.safeParse(
      feedItem({ signal: "quota" as never }),
    );
    assert.equal(result.success, false);
  });
});

describe("DismissAttentionRequestSchema — typed dismiss body (INV-8)", () => {
  test("accepts a typed reason + admission-line key", () => {
    const result = DismissAttentionRequestSchema.safeParse({
      reason: "not-a-problem",
      key: "waiting-on-you:blocked-live",
    });
    assert.equal(result.success, true);
  });

  test("accepts each of the three typed reasons", () => {
    for (const reason of ["not-a-problem", "handled-elsewhere", "later"] as const) {
      assert.equal(
        DismissAttentionRequestSchema.safeParse({
          reason,
          key: "repetition:hits",
        }).success,
        true,
      );
    }
  });

  test("rejects a free-text reason (the enum is closed)", () => {
    assert.equal(
      DismissAttentionRequestSchema.safeParse({
        reason: "already handled",
        key: "waiting-on-you:blocked-live",
      }).success,
      false,
    );
    assert.equal(
      DismissAttentionRequestSchema.safeParse({ key: "waiting-on-you:blocked-live" }).success,
      false,
    );
  });

  test("rejects a missing key", () => {
    assert.equal(
      DismissAttentionRequestSchema.safeParse({ reason: "later" }).success,
      false,
    );
  });

  test("rejects a key outside BUCKET_LINES", () => {
    assert.equal(
      DismissAttentionRequestSchema.safeParse({
        reason: "later",
        key: "waiting-on-you:spend",
      }).success,
      false,
    );
  });

  test("rejects the legacy signal key (.strict())", () => {
    assert.equal(
      DismissAttentionRequestSchema.safeParse({
        reason: "not-a-problem",
        key: "waiting-on-you:blocked-live",
        signal: "blocked-on-human",
      }).success,
      false,
    );
  });

  test("rejects an unknown extra key (.strict())", () => {
    assert.equal(
      DismissAttentionRequestSchema.safeParse({
        reason: "later",
        key: "waiting-on-you:blocked-live",
        extra: 1,
      }).success,
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Composer — signal wiring, thresholds, dismissal, trust evidence
// ---------------------------------------------------------------------------

describe("getAttentionFeed — signal wiring onto the common item shape", () => {
  test("blocked-on-human: blockedOver2d + needsInfoWaiting with the SAME thresholds", async () => {
    const result = await getAttentionFeed({
      ...QUIET_RANK0,
      getIssuesWaiting: async () =>
        stuckSnapshot({
          blockedOver2d: [
            {
              number: 11,
              title: "blocked thing",
              url: "https://github.com/gaberoo322/hydra/issues/11",
              createdAt: "2026-08-10T00:00:00.000Z",
              ageDays: 4,
              labels: ["blocked"],
            },
          ],
          needsInfoWaiting: [
            {
              number: 12,
              title: "needs info thing",
              url: "https://github.com/gaberoo322/hydra/issues/12",
              createdAt: "2026-08-13T00:00:00.000Z",
              ageDays: 1,
              labels: ["needs-info"],
            },
          ],
          scanned: 2,
        }),
      getFrictionPatterns: async () => frictionSnapshot(),
      ...NO_DISMISSALS,
      ...NO_COUNTING,
    });
    assert.equal(result.items.length, 2);
    const blocked = result.items.find((i) => i.id === "blocked-issue-11")!;
    assert.equal(blocked.signal, "blocked-on-human");
    assert.equal(blocked.observedValue, 4);
    assert.equal(blocked.threshold, DEFAULT_THRESHOLDS.blockedDays);
    assert.equal(blocked.thresholdLabel, `blocked ≥ ${DEFAULT_THRESHOLDS.blockedDays}d`);
    assert.equal(blocked.url, "https://github.com/gaberoo322/hydra/issues/11");

    const info = result.items.find((i) => i.id === "needs-info-issue-12")!;
    assert.equal(info.signal, "blocked-on-human");
    assert.equal(info.threshold, DEFAULT_THRESHOLDS.needsInfoDays);
    assert.equal(info.thresholdLabel, `needs-info ≥ ${DEFAULT_THRESHOLDS.needsInfoDays}d`);
    assert.equal(result.sourcesOk, true);
  });

  test("breakage: failed-required stalled PR with failedChecks.length vs the 1-check line", async () => {
    const result = await getAttentionFeed({
      ...QUIET_RANK0,
      getIssuesWaiting: async () => stuckSnapshot(),
      getStalledPrs: async () =>
        stalledSnapshot({
          items: [
            stalledPr({
              number: 55,
              title: "fix stuff",
              failedChecks: ["test", "build"],
              updatedAt: "2026-08-14T06:00:00.000Z",
            }),
          ],
          scanned: 1,
        }),
      getFrictionPatterns: async () => frictionSnapshot(),
      ...NO_DISMISSALS,
      ...NO_COUNTING,
    });
    assert.equal(result.items.length, 1);
    const pr = result.items[0];
    assert.equal(pr.signal, "breakage");
    assert.equal(pr.observedValue, 2);
    assert.equal(pr.threshold, 1);
    assert.equal(pr.thresholdLabel, "≥ 1 failed required check");
    assert.equal(pr.url, "https://github.com/gaberoo322/hydra/pull/55");
  });

  test("repetition: hitCount vs PROMOTION_THRESHOLD — below the line is NOT surfaced", async () => {
    const result = await getAttentionFeed({
      ...QUIET_RANK0,
      getIssuesWaiting: async () => stuckSnapshot(),
      getFrictionPatterns: async () =>
        frictionSnapshot({
          bySkill: [
            {
              skill: "hydra-dev",
              patterns: [
                patternRow({ cue: "under-line", hitCount: PROMOTION_THRESHOLD - 1 }),
                patternRow({ cue: "over-line", hitCount: PROMOTION_THRESHOLD + 2 }),
                patternRow({ cue: "exactly-line", hitCount: PROMOTION_THRESHOLD }),
              ],
            },
          ],
        }),
      ...NO_DISMISSALS,
      ...NO_COUNTING,
    });
    assert.deepEqual(
      result.items.map((i) => i.title).sort(),
      ["hydra-dev: exactly-line", "hydra-dev: over-line"],
    );
    for (const item of result.items) {
      assert.equal(item.signal, "repetition");
      assert.equal(item.threshold, PROMOTION_THRESHOLD);
      assert.equal(item.thresholdLabel, `hits ≥ ${PROMOTION_THRESHOLD}`);
    }
    assert.equal(result.items.find((i) => i.title.includes("over-line"))!.observedValue, PROMOTION_THRESHOLD + 2);
  });

  // Issue #4569: the flat PROMOTION_THRESHOLD ignored cue-policy.ts, so the
  // by-design inline-mode cue (never-escalate, #1789) sat in the feed forever.
  test("#4569 repetition: a never-escalate cue is NOT surfaced at any finite hit count", () => {
    const items = repetitionItems(
      frictionSnapshot({
        bySkill: [
          {
            skill: "hydra-target-build",
            patterns: [patternRow({ cue: "no-agent-spawn-tool-run-inline", hitCount: 549 })],
          },
        ],
      }),
    );
    assert.deepEqual(items, []);
  });

  test("#4569 repetition: a raised-threshold cue surfaces only at ITS bar, and echoes that bar", () => {
    const bar = escalationThresholdForCue("acceptance-criterion-deferred", PROMOTION_THRESHOLD);
    assert.ok(bar > PROMOTION_THRESHOLD, "fixture cue must carry a raised production threshold");
    const items = repetitionItems(
      frictionSnapshot({
        bySkill: [
          {
            skill: "hydra-dev",
            patterns: [patternRow({ cue: "acceptance-criterion-deferred", hitCount: bar - 1 })],
          },
          {
            skill: "hydra-qa",
            patterns: [patternRow({ cue: "acceptance-criterion-deferred", hitCount: bar })],
          },
        ],
      }),
    );
    assert.deepEqual(items.map((i) => i.title), ["hydra-qa: acceptance-criterion-deferred"]);
    assert.equal(items[0].threshold, bar);
    assert.equal(items[0].thresholdLabel, `hits ≥ ${bar}`);
  });

  test("repetition deep-links to the escalation issue when one fired", async () => {
    const snapshot = frictionSnapshot({
      bySkill: [
        {
          skill: "hydra-dev",
          patterns: [
            patternRow({
              lastEscalation: { status: "created", issueNumber: 4012, at: NOW.toISOString() },
            }),
            patternRow({ cue: "no-escalation" }),
          ],
        },
      ],
    });
    const rows = repetitionItems(snapshot);
    assert.equal(
      rows.find((r) => r.title.includes("some-cue"))!.url,
      "https://github.com/gaberoo322/hydra/issues/4012",
    );
    assert.equal(rows.find((r) => r.title.includes("no-escalation"))!.url, "/explore/friction");
  });

  test("sorts oldest crossing first", async () => {
    const result = await getAttentionFeed({
      ...QUIET_RANK0,
      getIssuesWaiting: async () =>
        stuckSnapshot({
          blockedOver2d: [
            {
              number: 1,
              title: "crossed later",
              url: "u1",
              createdAt: "2026-08-10T00:00:00.000Z", // + 2d → crossed 08-12
              ageDays: 4,
              labels: [],
            },
            {
              number: 2,
              title: "crossed earlier",
              url: "u2",
              createdAt: "2026-08-06T00:00:00.000Z", // + 2d → crossed 08-08
              ageDays: 8,
              labels: [],
            },
          ],
          scanned: 2,
        }),
      getFrictionPatterns: async () => frictionSnapshot(),
      ...NO_DISMISSALS,
      ...NO_COUNTING,
    });
    assert.deepEqual(result.items.map((i) => i.id), [
      "blocked-issue-2",
      "blocked-issue-1",
    ]);
  });
});

describe("getAttentionFeed — asserted-emptiness evidence (ADR-0034 §5.2)", () => {
  test("ASSERTED ZERO: both sources fulfilled and empty → items [], scanned 0, sourcesOk true", async () => {
    const result = await getAttentionFeed({
      ...QUIET_RANK0,
      getIssuesWaiting: async () => stuckSnapshot(),
      getFrictionPatterns: async () => frictionSnapshot(),
      ...NO_DISMISSALS,
      ...NO_COUNTING,
    });
    assert.deepEqual(result.items, []);
    assert.equal(result.scanned, RANK0_SCANNED);
    assert.equal(result.sourcesOk, true);
  });

  test("UNASSERTED EMPTY: both sources reject → items [] BUT sourcesOk false", async () => {
    const result = await getAttentionFeed({
      ...QUIET_RANK0,
      getIssuesWaiting: async () => {
        throw new Error("gh down");
      },
      getFrictionPatterns: async () => {
        throw new Error("redis down");
      },
      ...NO_DISMISSALS,
      ...NO_COUNTING,
    });
    assert.deepEqual(result.items, []);
    assert.equal(result.sourcesOk, false);
  });

  test("PARTIAL FAILURE: one source rejects → sourcesOk false even with items present", async () => {
    const result = await getAttentionFeed({
      ...QUIET_RANK0,
      getIssuesWaiting: async () =>
        stuckSnapshot({
          blockedOver2d: [
            { number: 7, title: "still here", url: "u7", createdAt: "2026-08-10T00:00:00.000Z", ageDays: 4, labels: [] },
          ],
          scanned: 1,
        }),
      getFrictionPatterns: async () => {
        throw new Error("scan failed");
      },
      ...NO_DISMISSALS,
      ...NO_COUNTING,
    });
    assert.equal(result.items.length, 1);
    assert.equal(result.sourcesOk, false);
  });

  test("scanned is the sum of the underlying snapshots' scanned counts", async () => {
    const result = await getAttentionFeed({
      ...QUIET_RANK0,
      getIssuesWaiting: async () => stuckSnapshot({ scanned: 5 }),
      getFrictionPatterns: async () => frictionSnapshot({ scanned: 7 }),
      ...NO_DISMISSALS,
      ...NO_COUNTING,
    });
    assert.equal(result.scanned, 12 + RANK0_SCANNED);
  });
});

describe("getAttentionFeed — INV-2: no deviation/spend/quota anywhere in the shape", () => {
  test("response carries no cost-shaped keys at any level", async () => {
    const result = await getAttentionFeed({
      ...QUIET_RANK0,
      getIssuesWaiting: async () =>
        stuckSnapshot({
          blockedOver2d: [
            { number: 1, title: "t", url: "u", createdAt: "2026-08-10T00:00:00.000Z", ageDays: 4, labels: [] },
          ],
          scanned: 1,
        }),
      getStalledPrs: async () =>
        stalledSnapshot({ items: [stalledPr({ number: 2, title: "t2", url: "u2", failedChecks: ["ci"] })], scanned: 1 }),
      getFrictionPatterns: async () =>
        frictionSnapshot({
          bySkill: [{ skill: "s", patterns: [patternRow()] }],
        }),
      ...NO_DISMISSALS,
      ...NO_COUNTING,
    });
    const costKey = /cost|spend|quota|usd|usage|duration/i;
    for (const key of Object.keys(result)) {
      assert.match(key, /^$|^(items|buckets|scanned|sourcesOk)$/);
      assert.equal(costKey.test(key), false, `top-level key leaked: ${key}`);
    }
    assert.equal(result.items.length, 3);
    for (const item of result.items) {
      for (const key of Object.keys(item)) {
        assert.equal(costKey.test(key), false, `item key leaked: ${key}`);
      }
      assert.equal(costKey.test(item.signal), false);
    }
  });

  test("src/attention.ts imports no cost or usage-tracker module (import discipline)", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/attention.ts", import.meta.url), "utf8"),
    );
    // Scan IMPORT lines only — the module's own doc comment names the
    // exclusion ("never src/cost/* or usage-tracker output"), which is the
    // guard being documented, not a violation.
    const importLines = src.split("\n").filter((l) => /\bfrom\s+"/.test(l));
    assert.equal(
      importLines.some((l) => /cost\/|usage-tracker/.test(l)),
      false,
    );
  });
});

describe("getAttentionFeed — dismissal + calibration wiring", () => {
  test("a dismissed item id is filtered out of the feed (durable per episode)", async () => {
    const result = await getAttentionFeed({
      ...QUIET_RANK0,
      getIssuesWaiting: async () =>
        stuckSnapshot({
          blockedOver2d: [
            { number: 1, title: "dismissed me", url: "u1", createdAt: "2026-08-10T00:00:00.000Z", ageDays: 4, labels: [] },
            { number: 2, title: "still visible", url: "u2", createdAt: "2026-08-11T00:00:00.000Z", ageDays: 3, labels: [] },
          ],
          scanned: 2,
        }),
      getFrictionPatterns: async () => frictionSnapshot(),
      loadDismissed: async () =>
        new Map([["waiting-on-you:blocked-live", new Set(["blocked-issue-1"])]]),
      ...NO_COUNTING,
    });
    assert.deepEqual(result.items.map((i) => i.id), ["blocked-issue-2"]);
  });

  test("dismissal filtering is keyed by admission line — a dismissal on another line never hides this item", async () => {
    const result = await getAttentionFeed({
      ...QUIET_RANK0,
      getIssuesWaiting: async () =>
        stuckSnapshot({
          blockedOver2d: [
            { number: 1, title: "blocked", url: "u1", createdAt: "2026-08-10T00:00:00.000Z", ageDays: 4, labels: [] },
          ],
          scanned: 1,
        }),
      getFrictionPatterns: async () => frictionSnapshot(),
      loadDismissed: async () =>
        new Map([["target-items:blocked-live", new Set(["blocked-issue-1"])]]),
      ...NO_COUNTING,
    });
    assert.equal(result.items.length, 1);
  });

  test("a failed dismissal-ledger read degrades fail-open (items still ship)", async () => {
    const result = await getAttentionFeed({
      ...QUIET_RANK0,
      getIssuesWaiting: async () =>
        stuckSnapshot({
          blockedOver2d: [
            { number: 1, title: "visible", url: "u1", createdAt: "2026-08-10T00:00:00.000Z", ageDays: 4, labels: [] },
          ],
          scanned: 1,
        }),
      getFrictionPatterns: async () => frictionSnapshot(),
      loadDismissed: async () => {
        throw new Error("redis blip");
      },
      ...NO_COUNTING,
    });
    assert.equal(result.items.length, 1);
  });

  test("reconcile receives the ADMITTED items (pre-dismissal-filter), keyed by line, with bucket health", async () => {
    const calls: Array<ReadonlyMap<string, { admitted: ReadonlySet<string>; healthy: boolean }>> = [];
    const result = await getAttentionFeed({
      ...QUIET_RANK0,
      getIssuesWaiting: async () =>
        stuckSnapshot({
          blockedOver2d: [
            { number: 1, title: "dismissed", url: "u1", createdAt: "2026-08-10T00:00:00.000Z", ageDays: 4, labels: [] },
            { number: 2, title: "kept", url: "u2", createdAt: "2026-08-11T00:00:00.000Z", ageDays: 3, labels: [] },
          ],
          scanned: 2,
        }),
      getFrictionPatterns: async () => frictionSnapshot(),
      loadDismissed: async () =>
        new Map([["waiting-on-you:blocked-live", new Set(["blocked-issue-1"])]]),
      reconcileLedgers: async (admittedByLine) => {
        calls.push(admittedByLine);
      },
    });
    assert.equal(result.items.length, 1);
    assert.equal(calls.length, 1);
    const line = calls[0].get("waiting-on-you:blocked-live")!;
    // The DISMISSED item is still admitted — still crossing, just hidden
    // (ADR-0034 §8.4: admitted is the pre-filter set).
    assert.deepEqual([...line.admitted].sort(), ["blocked-issue-1", "blocked-issue-2"]);
    assert.equal(line.healthy, true);
    // Every registry line is present — an empty admitted set still prunes.
    assert.equal(calls[0].size, ADMISSION_LINE_KEYS.length);
  });

  test("a line whose bucket reported source errors is handed healthy:false (no prune)", async () => {
    const calls: Array<ReadonlyMap<string, { admitted: ReadonlySet<string>; healthy: boolean }>> = [];
    await getAttentionFeed({
      ...QUIET_RANK0,
      getIssuesWaiting: async () =>
        stuckSnapshot({
          blockedOver2d: [
            { number: 1, title: "blocked", url: "u1", createdAt: "2026-08-10T00:00:00.000Z", ageDays: 4, labels: [] },
          ],
          scanned: 1,
          sourcesOk: false,
        }),
      getFrictionPatterns: async () => frictionSnapshot(),
      ...NO_DISMISSALS,
      reconcileLedgers: async (admittedByLine) => {
        calls.push(admittedByLine);
      },
    });
    assert.equal(calls[0].get("waiting-on-you:blocked-live")!.healthy, false);
    // A healthy bucket's lines stay prunable.
    assert.equal(calls[0].get("machine-stopped:paused")!.healthy, true);
  });

  test("reconcile runs BEFORE the dismissed-ledger read (a pruned dismissal cannot hide a new episode)", async () => {
    const order: string[] = [];
    await getAttentionFeed({
      ...QUIET_RANK0,
      getIssuesWaiting: async () => stuckSnapshot(),
      getFrictionPatterns: async () => frictionSnapshot(),
      loadDismissed: async () => {
        order.push("read");
        return new Map();
      },
      reconcileLedgers: async () => {
        order.push("reconcile");
      },
    });
    assert.deepEqual(order, ["reconcile", "read"]);
  });

  test("a reconcile failure never fails the feed read", async () => {
    const result = await getAttentionFeed({
      ...QUIET_RANK0,
      getIssuesWaiting: async () => stuckSnapshot(),
      getFrictionPatterns: async () => frictionSnapshot(),
      ...NO_DISMISSALS,
      reconcileLedgers: async () => {
        throw new Error("counter write failed");
      },
    });
    assert.deepEqual(result.items, []);
    assert.equal(result.sourcesOk, true);
  });
});

describe("crossedAtFrom — pure helper", () => {
  test("creation plus the threshold in days", () => {
    assert.equal(
      crossedAtFrom("2026-08-10T00:00:00.000Z", 2),
      "2026-08-12T00:00:00.000Z",
    );
  });

  test("an unparseable createdAt degrades to the raw string", () => {
    assert.equal(crossedAtFrom("not-a-date", 2), "not-a-date");
  });
});

// ---------------------------------------------------------------------------
// Route — trust evidence forwarded, dismiss body validated (INV-7)
// ---------------------------------------------------------------------------

function mockReq(over: any = {}): any {
  return {
    method: "GET",
    url: "/attention/feed",
    headers: {},
    query: {},
    params: {},
    body: {},
    ...over,
  };
}

function mockRes(): any {
  const res: any = {
    _status: 200,
    _body: null,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(body: any) {
      res._body = body;
      return res;
    },
    send(body: any) {
      res._body = body;
      return res;
    },
    setHeader() {
      return res;
    },
    end() {
      return res;
    },
  };
  return res;
}

function findHandler(router: any, method: string, path: string): Function | null {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === path) {
      if (layer.route.methods[method.toLowerCase()]) {
        const stack = layer.route.stack;
        return stack[stack.length - 1].handle;
      }
    }
  }
  return null;
}

function testRouter() {
  return createAttentionRouter({
    ...QUIET_RANK0,
    getIssuesWaiting: async () =>
      stuckSnapshot({
        blockedOver2d: [
          { number: 1, title: "blocked thing", url: "u1", createdAt: "2026-08-10T00:00:00.000Z", ageDays: 4, labels: [] },
        ],
        scanned: 1,
      }),
    getFrictionPatterns: async () => frictionSnapshot(),
    loadDismissed: async () => new Map(),
    reconcileLedgers: async () => {},
    dismissItem: async () => true,
    readCounts: async () => [
      {
        key: "machine-stopped:paused",
        surfaced: 6,
        resolved: 1,
        notAProblem: 0,
        handledElsewhere: 0,
        later: 1,
        verdict: "calibrated",
        because: "0 not-a-problem / 6 surfaced = 0 < 0.5 over 30d",
      },
      {
        key: "repetition:hits",
        surfaced: 0,
        resolved: 0,
        notAProblem: 0,
        handledElsewhere: 0,
        later: 0,
        verdict: "insufficient-data",
        because: "0 surfaced < 5 minimum over 30d",
      },
    ],
  });
}

describe("GET /attention/feed — route", () => {
  test("forwards items + scanned + sourcesOk + generatedAt", async () => {
    const router = testRouter();
    const handler = findHandler(router, "GET", "/attention/feed")!;
    assert.ok(handler, "feed handler registered");
    const res = mockRes();
    await handler(mockReq(), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.items.length, 1);
    assert.equal(res._body.scanned, 1 + RANK0_SCANNED);
    assert.equal(res._body.sourcesOk, true);
    assert.ok(typeof res._body.generatedAt === "string");
    // The full body validates against the HTTP contract schema.
    assert.equal(AttentionFeedResponseSchema.safeParse(res._body).success, true);
  });

  test("an unasserted empty body (sourcesOk false) still validates — UNKNOWN at the client", async () => {
    const router = createAttentionRouter({
    ...QUIET_RANK0,
      getIssuesWaiting: async () => {
        throw new Error("down");
      },
      getFrictionPatterns: async () => {
        throw new Error("down");
      },
      loadDismissed: async () => new Map(),
      reconcileLedgers: async () => {},
    });
    const handler = findHandler(router, "GET", "/attention/feed")!;
    const res = mockRes();
    await handler(mockReq(), res);
    assert.equal(res._status, 200);
    assert.deepEqual(res._body.items, []);
    assert.equal(res._body.sourcesOk, false);
  });
});

describe("POST /attention/:id/dismiss — route", () => {
  test("a valid body returns ok + recorded", async () => {
    const router = testRouter();
    const handler = findHandler(router, "POST", "/attention/:id/dismiss")!;
    const res = mockRes();
    await handler(
      mockReq({
        method: "POST",
        params: { id: "blocked-issue-1" },
        body: { reason: "not-a-problem", key: "waiting-on-you:blocked-live" },
      }),
      res,
    );
    assert.equal(res._status, 200);
    assert.equal(res._body.ok, true);
    assert.equal(res._body.recorded, true);
  });

  test("a free-text reason returns 400 (the enum is closed)", async () => {
    const router = testRouter();
    const handler = findHandler(router, "POST", "/attention/:id/dismiss")!;
    const res = mockRes();
    await handler(
      mockReq({
        method: "POST",
        params: { id: "x" },
        body: { reason: "already handled", key: "waiting-on-you:blocked-live" },
      }),
      res,
    );
    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
  });

  test("a signal-shaped body returns 400 (.strict() — the body carries key + typed reason)", async () => {
    const router = testRouter();
    const handler = findHandler(router, "POST", "/attention/:id/dismiss")!;
    const res = mockRes();
    await handler(
      mockReq({
        method: "POST",
        params: { id: "x" },
        body: { reason: "not-a-problem", key: "waiting-on-you:blocked-live", signal: "blocked-on-human" },
      }),
      res,
    );
    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
  });

  test("a malformed body returns 400 schema-validation-failed (INV-8)", async () => {
    const router = testRouter();
    const handler = findHandler(router, "POST", "/attention/:id/dismiss")!;
    const res = mockRes();
    await handler(
      mockReq({ method: "POST", params: { id: "x" }, body: { signal: "breakage" } }), // no reason
      res,
    );
    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
    assert.ok(Array.isArray(res._body.issues));
  });

  test("an unknown extra key returns 400 (.strict())", async () => {
    const router = testRouter();
    const handler = findHandler(router, "POST", "/attention/:id/dismiss")!;
    const res = mockRes();
    await handler(
      mockReq({
        method: "POST",
        params: { id: "x" },
        body: { reason: "later", key: "waiting-on-you:blocked-live", extra: 1 },
      }),
      res,
    );
    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
  });

  test("a key outside BUCKET_LINES returns 400 (admission-line vocabulary is closed)", async () => {
    const router = testRouter();
    const handler = findHandler(router, "POST", "/attention/:id/dismiss")!;
    const res = mockRes();
    await handler(
      mockReq({
        method: "POST",
        params: { id: "x" },
        body: { reason: "later", key: "machine-stopped:spend" },
      }),
      res,
    );
    assert.equal(res._status, 400);
  });

  test("a dismiss-write failure returns a logged 500, not a fake ok", async () => {
    const router = createAttentionRouter({
    ...QUIET_RANK0,
      getIssuesWaiting: async () => stuckSnapshot(),
      getFrictionPatterns: async () => frictionSnapshot(),
      loadDismissed: async () => new Map(),
      reconcileLedgers: async () => {},
      dismissItem: async () => {
        throw new Error("redis down");
      },
    });
    const handler = findHandler(router, "POST", "/attention/:id/dismiss")!;
    const res = mockRes();
    await handler(
      mockReq({
        method: "POST",
        params: { id: "x" },
        body: { reason: "not-a-problem", key: "waiting-on-you:blocked-live" },
      }),
      res,
    );
    assert.equal(res._status, 500);
    assert.equal(res._body.ok, undefined);
  });
});

describe("GET /attention/counts — route", () => {
  test("returns the per-line calibration read with windowDays 30", async () => {
    const router = testRouter();
    const handler = findHandler(router, "GET", "/attention/counts")!;
    const res = mockRes();
    await handler(mockReq({ url: "/attention/counts" }), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.windowDays, 30);
    assert.equal(res._body.lines.length, 2);
    assert.deepEqual(res._body.lines[0], {
      key: "machine-stopped:paused",
      surfaced: 6,
      resolved: 1,
      notAProblem: 0,
      handledElsewhere: 0,
      later: 1,
      verdict: "calibrated",
      because: "0 not-a-problem / 6 surfaced = 0 < 0.5 over 30d",
    });
    assert.ok(typeof res._body.generatedAt === "string");
  });
});

// ---------------------------------------------------------------------------
// Redis accessor — typed dismiss, snooze, per-line ledgers
// (real Redis; the per-run DB isolation from scripts/test/redis-db-launch.mjs
// keeps this keyspace private to the run)
// ---------------------------------------------------------------------------

let testRedis: any = null;
function getTestRedis(): any {
  if (!testRedis) {
    testRedis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
  }
  return testRedis;
}

describe("redis/attention — typed dismiss + dismissal ledger", () => {
  before(async () => {
    getTestRedis();
  });

  after(() => {
    if (testRedis) testRedis.disconnect();
  });

  beforeEach(async () => {
    // Fresh attention keyspace per case — these tests mutate shared state.
    const r = getTestRedis();
    const keys = await r.keys("hydra:attention:*");
    if (keys.length > 0) await r.del(...keys);
  });

  const dayKey = () =>
    `hydra:attention:calib:${new Date().toISOString().slice(0, 10)}`;

  test("dismiss is durable per episode and counted once per line + typed reason (INV-8)", async () => {
    await getTestRedis().hset("hydra:attention:surfaced:waiting-on-you:blocked-live", "blocked-issue-9", "2026-01-01T00:00:00.000Z");
    const first = await dismissAttentionItem(
      "blocked-issue-9",
      "waiting-on-you:blocked-live",
      "not-a-problem",
    );
    assert.equal(first, true);
    // A repeat dismissal (double-click) is a no-op for the counter AND the
    // audit stream.
    const second = await dismissAttentionItem(
      "blocked-issue-9",
      "waiting-on-you:blocked-live",
      "not-a-problem",
    );
    assert.equal(second, false);

    const dismissed = await loadDismissed();
    assert.ok(dismissed.get("waiting-on-you:blocked-live")!.has("blocked-issue-9"));

    const counters = await getTestRedis().hgetall(dayKey());
    assert.equal(counters["waiting-on-you:blocked-live:not-a-problem"], "1");

    const entries = await getTestRedis().xrange("hydra:attention:dismissals", "-", "+");
    assert.equal(entries.length, 1);
    const flat: string[] = entries[0][1];
    const fields: Record<string, string> = {};
    for (let i = 0; i < flat.length; i += 2) fields[flat[i]] = flat[i + 1];
    assert.equal(fields.id, "blocked-issue-9");
    assert.equal(fields.key, "waiting-on-you:blocked-live");
    assert.equal(fields.reason, "not-a-problem");
    assert.ok(fields.at);
  });

  test("typed reasons land in separate daily-counter fields (INV-8/INV-9)", async () => {
    for (const n of [1, 2, 3]) {
      await getTestRedis().hset("hydra:attention:surfaced:waiting-on-you:blocked-live", `blocked-issue-${n}`, "2026-01-01T00:00:00.000Z");
    }
    await dismissAttentionItem("blocked-issue-1", "waiting-on-you:blocked-live", "not-a-problem");
    await dismissAttentionItem("blocked-issue-2", "waiting-on-you:blocked-live", "handled-elsewhere");
    await dismissAttentionItem("blocked-issue-3", "waiting-on-you:blocked-live", "later");
    const counters = await getTestRedis().hgetall(dayKey());
    assert.equal(counters["waiting-on-you:blocked-live:not-a-problem"], "1");
    assert.equal(counters["waiting-on-you:blocked-live:handled-elsewhere"], "1");
    assert.equal(counters["waiting-on-you:blocked-live:later"], "1");
    // No surfaced write comes from a dismiss.
    assert.equal(counters["waiting-on-you:blocked-live:surfaced"], undefined);
  });

  test("a dismissal older than the 30-day snooze no longer suppresses and is kept as the episode tombstone", async () => {
    // Seed a stale ledger entry directly — the snooze boundary is read-side.
    await getTestRedis().hset(
      "hydra:attention:dismissed:prs-not-landing:failed-required",
      "pr-failed-ci-42",
      "2026-01-01T00:00:00.000Z",
    );
    const active = await loadDismissed();
    assert.deepEqual([...(active.get("prs-not-landing:failed-required") ?? new Set<string>())], []);
    // NOT pruned: the field is the tombstone that stops a re-dismissal of the
    // same continuous episode from recounting not-a-problem.
    const remaining = await getTestRedis().hlen(
      "hydra:attention:dismissed:prs-not-landing:failed-required",
    );
    assert.equal(remaining, 1);
  });

  test("dismiss of an id not in the line's surfaced hash is a no-op (cannot falsify a line)", async () => {
    const recorded = await dismissAttentionItem("forged-id", "waiting-on-you:blocked-live", "not-a-problem");
    assert.equal(recorded, false);
    assert.equal(await getTestRedis().hget(dayKey(), "waiting-on-you:blocked-live:not-a-problem"), null);
    assert.equal(await getTestRedis().hlen("hydra:attention:dismissed:waiting-on-you:blocked-live"), 0);
    assert.equal(await getTestRedis().xlen("hydra:attention:dismissals"), 0);
  });

  test("re-dismissal after snooze expiry re-snoozes the same episode without recounting not-a-problem", async () => {
    const key = "waiting-on-you:blocked-live";
    const r = getTestRedis();
    await r.hset(`hydra:attention:surfaced:${key}`, "issue-5", "2026-01-01T00:00:00.000Z");
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    assert.equal(await dismissAttentionItem("issue-5", key, "not-a-problem", t0), true);
    const later = new Date(t0.getTime() + 31 * 24 * 60 * 60 * 1000);
    // Snooze lapsed: not suppressing, but the tombstone survives loadDismissed.
    assert.equal((await loadDismissed(later)).get(key)!.has("issue-5"), false);
    // Re-dismiss: not counted again, but the snooze is refreshed.
    assert.equal(await dismissAttentionItem("issue-5", key, "not-a-problem", later), false);
    const dayKeyT0 = "hydra:attention:calib:2026-01-01";
    assert.equal(await r.hget(dayKeyT0, `${key}:not-a-problem`), "1");
    const laterDay = `hydra:attention:calib:${later.toISOString().slice(0, 10)}`;
    assert.equal(await r.hget(laterDay, `${key}:not-a-problem`), null);
    assert.equal((await loadDismissed(later)).get(key)!.has("issue-5"), true);
  });

  test("loadDismissed covers every registry line (an empty ledger reads as 19 empty sets)", async () => {
    const dismissed = await loadDismissed();
    assert.equal(dismissed.size, ADMISSION_LINE_KEYS.length);
    for (const ids of dismissed.values()) assert.equal(ids.size, 0);
  });
});

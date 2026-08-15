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
import {
  type FrictionPatternsSnapshot,
  type FrictionPatternRow,
} from "../src/aggregators/friction-patterns.ts";
import { PROMOTION_THRESHOLD } from "../src/pattern-memory/index.ts";
import {
  dismissAttentionItem,
  loadDismissedIds,
  recordSurfacedItems,
  readAttentionCounts,
} from "../src/redis/attention.ts";
import type { AttentionFeedItem } from "../src/schemas/attention.ts";

const NOW = new Date("2026-08-14T12:00:00.000Z");

// ---------------------------------------------------------------------------
// Stub factories — full snapshot shapes so the composer is exercised against
// the real aggregator return types.
// ---------------------------------------------------------------------------

function stuckSnapshot(over: Partial<StuckItems> = {}): StuckItems {
  return {
    blockedOver2d: [],
    needsInfoWaiting: [],
    prsWithFailedCi: [],
    thresholds: DEFAULT_THRESHOLDS,
    generatedAt: NOW.toISOString(),
    scanned: 0,
    sourcesOk: true,
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
    ...over,
  };
}

const NO_DISMISSALS = {
  loadDismissedIds: async () => [] as string[],
};
const NO_COUNTING = {
  recordSurfaced: async () => {},
};

// ---------------------------------------------------------------------------
// Schema — closed signal vocabulary + trust fields
// ---------------------------------------------------------------------------

describe("AttentionFeedResponseSchema — trust fields", () => {
  test("accepts an ASSERTED zero: items [], scanned 0, sourcesOk true", () => {
    const result = AttentionFeedResponseSchema.safeParse({
      items: [],
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
      scanned: 0,
      sourcesOk: false,
      generatedAt: NOW.toISOString(),
    });
    assert.equal(result.success, true);
  });

  test("rejects a response missing sourcesOk (unasserted)", () => {
    const result = AttentionFeedResponseSchema.safeParse({
      items: [],
      scanned: 0,
      generatedAt: NOW.toISOString(),
    });
    assert.equal(result.success, false);
  });

  test("rejects a response missing scanned", () => {
    const result = AttentionFeedResponseSchema.safeParse({
      items: [],
      sourcesOk: true,
      generatedAt: NOW.toISOString(),
    });
    assert.equal(result.success, false);
  });

  test("rejects an unknown extra field (strict mode)", () => {
    const result = AttentionFeedResponseSchema.safeParse({
      items: [],
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

describe("DismissAttentionRequestSchema — strict dismiss body (INV-7)", () => {
  test("accepts a reason + signal", () => {
    const result = DismissAttentionRequestSchema.safeParse({
      reason: "already handled",
      signal: "breakage",
    });
    assert.equal(result.success, true);
  });

  test("rejects an empty / whitespace-only reason", () => {
    assert.equal(
      DismissAttentionRequestSchema.safeParse({ reason: "   ", signal: "breakage" }).success,
      false,
    );
    assert.equal(
      DismissAttentionRequestSchema.safeParse({ signal: "breakage" }).success,
      false,
    );
  });

  test("rejects a missing signal", () => {
    assert.equal(
      DismissAttentionRequestSchema.safeParse({ reason: "x" }).success,
      false,
    );
  });

  test("rejects an unknown extra key (.strict())", () => {
    assert.equal(
      DismissAttentionRequestSchema.safeParse({
        reason: "x",
        signal: "breakage",
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
      getStuckItems: async () =>
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

  test("breakage: prsWithFailedCi with failedChecks.length vs the 1-check line", async () => {
    const result = await getAttentionFeed({
      getStuckItems: async () =>
        stuckSnapshot({
          prsWithFailedCi: [
            {
              number: 55,
              title: "fix stuff",
              url: "https://github.com/gaberoo322/hydra/pull/55",
              failedChecks: ["test", "build"],
              updatedAt: "2026-08-14T06:00:00.000Z",
            },
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
    assert.equal(pr.thresholdLabel, "≥ 1 failed check");
    assert.equal(pr.url, "https://github.com/gaberoo322/hydra/pull/55");
  });

  test("repetition: hitCount vs PROMOTION_THRESHOLD — below the line is NOT surfaced", async () => {
    const result = await getAttentionFeed({
      getStuckItems: async () => stuckSnapshot(),
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
      getStuckItems: async () =>
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
      getStuckItems: async () => stuckSnapshot(),
      getFrictionPatterns: async () => frictionSnapshot(),
      ...NO_DISMISSALS,
      ...NO_COUNTING,
    });
    assert.deepEqual(result.items, []);
    assert.equal(result.scanned, 0);
    assert.equal(result.sourcesOk, true);
  });

  test("UNASSERTED EMPTY: both sources reject → items [] BUT sourcesOk false", async () => {
    const result = await getAttentionFeed({
      getStuckItems: async () => {
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
      getStuckItems: async () =>
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
      getStuckItems: async () => stuckSnapshot({ scanned: 5 }),
      getFrictionPatterns: async () => frictionSnapshot({ scanned: 7 }),
      ...NO_DISMISSALS,
      ...NO_COUNTING,
    });
    assert.equal(result.scanned, 12);
  });
});

describe("getAttentionFeed — INV-2: no deviation/spend/quota anywhere in the shape", () => {
  test("response carries no cost-shaped keys at any level", async () => {
    const result = await getAttentionFeed({
      getStuckItems: async () =>
        stuckSnapshot({
          blockedOver2d: [
            { number: 1, title: "t", url: "u", createdAt: "2026-08-10T00:00:00.000Z", ageDays: 4, labels: [] },
          ],
          prsWithFailedCi: [
            { number: 2, title: "t2", url: "u2", failedChecks: ["ci"], updatedAt: NOW.toISOString() },
          ],
          scanned: 2,
        }),
      getFrictionPatterns: async () =>
        frictionSnapshot({
          bySkill: [{ skill: "s", patterns: [patternRow()] }],
        }),
      ...NO_DISMISSALS,
      ...NO_COUNTING,
    });
    const costKey = /cost|spend|quota|usd|usage|duration/i;
    for (const key of Object.keys(result)) {
      assert.match(key, /^$|^(items|scanned|sourcesOk)$/);
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
  test("a dismissed item id is filtered out of the feed (durable per id)", async () => {
    const result = await getAttentionFeed({
      getStuckItems: async () =>
        stuckSnapshot({
          blockedOver2d: [
            { number: 1, title: "dismissed me", url: "u1", createdAt: "2026-08-10T00:00:00.000Z", ageDays: 4, labels: [] },
            { number: 2, title: "still visible", url: "u2", createdAt: "2026-08-11T00:00:00.000Z", ageDays: 3, labels: [] },
          ],
          scanned: 2,
        }),
      getFrictionPatterns: async () => frictionSnapshot(),
      loadDismissedIds: async (signal) =>
        signal === "blocked-on-human" ? ["blocked-issue-1"] : [],
      ...NO_COUNTING,
    });
    assert.deepEqual(result.items.map((i) => i.id), ["blocked-issue-2"]);
  });

  test("dismissal filtering is keyed by signal — a breakage dismissal never hides a blocked item", async () => {
    const result = await getAttentionFeed({
      getStuckItems: async () =>
        stuckSnapshot({
          blockedOver2d: [
            { number: 1, title: "blocked", url: "u1", createdAt: "2026-08-10T00:00:00.000Z", ageDays: 4, labels: [] },
          ],
          scanned: 1,
        }),
      getFrictionPatterns: async () => frictionSnapshot(),
      loadDismissedIds: async (signal) =>
        signal === "breakage" ? ["blocked-issue-1"] : [],
      ...NO_COUNTING,
    });
    assert.equal(result.items.length, 1);
  });

  test("a failed dismissal-ledger read degrades fail-open (items still ship)", async () => {
    const result = await getAttentionFeed({
      getStuckItems: async () =>
        stuckSnapshot({
          blockedOver2d: [
            { number: 1, title: "visible", url: "u1", createdAt: "2026-08-10T00:00:00.000Z", ageDays: 4, labels: [] },
          ],
          scanned: 1,
        }),
      getFrictionPatterns: async () => frictionSnapshot(),
      loadDismissedIds: async () => {
        throw new Error("redis blip");
      },
      ...NO_COUNTING,
    });
    assert.equal(result.items.length, 1);
  });

  test("surfaced counters receive the VISIBLE items (post-dismissal-filter)", async () => {
    const surfaced: AttentionFeedItem[][] = [];
    const result = await getAttentionFeed({
      getStuckItems: async () =>
        stuckSnapshot({
          blockedOver2d: [
            { number: 1, title: "dismissed", url: "u1", createdAt: "2026-08-10T00:00:00.000Z", ageDays: 4, labels: [] },
            { number: 2, title: "kept", url: "u2", createdAt: "2026-08-11T00:00:00.000Z", ageDays: 3, labels: [] },
          ],
          scanned: 2,
        }),
      getFrictionPatterns: async () => frictionSnapshot(),
      loadDismissedIds: async (signal) =>
        signal === "blocked-on-human" ? ["blocked-issue-1"] : [],
      recordSurfaced: async (items) => {
        surfaced.push([...items]);
      },
    });
    assert.equal(result.items.length, 1);
    assert.equal(surfaced.length, 1);
    assert.deepEqual(surfaced[0].map((i) => i.id), ["blocked-issue-2"]);
  });

  test("a surfaced-counter failure never fails the feed read", async () => {
    const result = await getAttentionFeed({
      getStuckItems: async () => stuckSnapshot(),
      getFrictionPatterns: async () => frictionSnapshot(),
      ...NO_DISMISSALS,
      recordSurfaced: async () => {
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
    getStuckItems: async () =>
      stuckSnapshot({
        blockedOver2d: [
          { number: 1, title: "blocked thing", url: "u1", createdAt: "2026-08-10T00:00:00.000Z", ageDays: 4, labels: [] },
        ],
        scanned: 1,
      }),
    getFrictionPatterns: async () => frictionSnapshot(),
    loadDismissedIds: async () => [],
    recordSurfaced: async () => {},
    dismissItem: async () => true,
    readCounts: async () => [
      { signal: "blocked-on-human", surfaced: 3, dismissed: 1 },
      { signal: "breakage", surfaced: 0, dismissed: 0 },
      { signal: "repetition", surfaced: 2, dismissed: 2 },
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
    assert.equal(res._body.scanned, 1);
    assert.equal(res._body.sourcesOk, true);
    assert.ok(typeof res._body.generatedAt === "string");
    // The full body validates against the HTTP contract schema.
    assert.equal(AttentionFeedResponseSchema.safeParse(res._body).success, true);
  });

  test("an unasserted empty body (sourcesOk false) still validates — UNKNOWN at the client", async () => {
    const router = createAttentionRouter({
      getStuckItems: async () => {
        throw new Error("down");
      },
      getFrictionPatterns: async () => {
        throw new Error("down");
      },
      loadDismissedIds: async () => [],
      recordSurfaced: async () => {},
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
      mockReq({ method: "POST", params: { id: "blocked-issue-1" }, body: { reason: "handled", signal: "blocked-on-human" } }),
      res,
    );
    assert.equal(res._status, 200);
    assert.equal(res._body.ok, true);
    assert.equal(res._body.recorded, true);
  });

  test("a malformed body returns 400 schema-validation-failed (INV-7)", async () => {
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
      mockReq({ method: "POST", params: { id: "x" }, body: { reason: "r", signal: "breakage", extra: 1 } }),
      res,
    );
    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
  });

  test("a deviation-shaped signal value returns 400 (closed enum)", async () => {
    const router = testRouter();
    const handler = findHandler(router, "POST", "/attention/:id/dismiss")!;
    const res = mockRes();
    await handler(
      mockReq({ method: "POST", params: { id: "x" }, body: { reason: "r", signal: "spend" } }),
      res,
    );
    assert.equal(res._status, 400);
  });

  test("a dismiss-write failure returns a logged 500, not a fake ok", async () => {
    const router = createAttentionRouter({
      getStuckItems: async () => stuckSnapshot(),
      getFrictionPatterns: async () => frictionSnapshot(),
      loadDismissedIds: async () => [],
      recordSurfaced: async () => {},
      dismissItem: async () => {
        throw new Error("redis down");
      },
    });
    const handler = findHandler(router, "POST", "/attention/:id/dismiss")!;
    const res = mockRes();
    await handler(
      mockReq({ method: "POST", params: { id: "x" }, body: { reason: "r", signal: "breakage" } }),
      res,
    );
    assert.equal(res._status, 500);
    assert.equal(res._body.ok, undefined);
  });
});

describe("GET /attention/counts — route", () => {
  test("returns per-threshold surfaced/dismissed rows", async () => {
    const router = testRouter();
    const handler = findHandler(router, "GET", "/attention/counts")!;
    const res = mockRes();
    await handler(mockReq({ url: "/attention/counts" }), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.counts.length, 3);
    assert.deepEqual(res._body.counts[0], {
      signal: "blocked-on-human",
      surfaced: 3,
      dismissed: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// Redis accessor — record-once, snooze, per-threshold counters
// (real Redis; the per-run DB isolation from scripts/test/redis-db-launch.mjs
// keeps this keyspace private to the run)
// ---------------------------------------------------------------------------

const SIGNAL_KEYS = ["blocked-on-human", "breakage", "repetition"];

let testRedis: any = null;
function getTestRedis(): any {
  if (!testRedis) {
    testRedis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
  }
  return testRedis;
}

describe("redis/attention — dismissal ledger + calibration counters", () => {
  before(async () => {
    getTestRedis();
  });

  after(() => {
    if (testRedis) testRedis.disconnect();
  });

  beforeEach(async () => {
    // Fresh attention keyspace per case — these tests mutate shared state.
    const r = getTestRedis();
    for (const signal of SIGNAL_KEYS) {
      await r.del(
        `hydra:attention:dismissed:${signal}`,
        `hydra:attention:surfaced:${signal}`,
        `hydra:attention:counts:${signal}:surfaced`,
        `hydra:attention:counts:${signal}:dismissed`,
      );
    }
  });

  test("dismiss is durable per id and counted once per threshold (INV-5)", async () => {
    const first = await dismissAttentionItem("blocked-issue-9", "blocked-on-human");
    assert.equal(first, true);
    // A repeat dismissal (double-click) is a no-op for the counter.
    const second = await dismissAttentionItem("blocked-issue-9", "blocked-on-human");
    assert.equal(second, false);

    const dismissed = await loadDismissedIds("blocked-on-human");
    assert.deepEqual(dismissed, ["blocked-issue-9"]);

    const counts = await readAttentionCounts();
    const blocked = counts.find((c) => c.signal === "blocked-on-human")!;
    assert.equal(blocked.dismissed, 1);
    assert.equal(blocked.surfaced, 0);
    // Fresh install reads as honest zeros on the untouched lines.
    assert.deepEqual(
      counts.find((c) => c.signal === "repetition")!,
      { signal: "repetition", surfaced: 0, dismissed: 0 },
    );
  });

  test("a dismissal older than the 30-day snooze no longer suppresses and is pruned", async () => {
    // Seed a stale ledger entry directly — the snooze boundary is read-side.
    await getTestRedis().hset(
      "hydra:attention:dismissed:breakage",
      "pr-failed-ci-42",
      "2026-01-01T00:00:00.000Z",
    );
    const active = await loadDismissedIds("breakage");
    assert.deepEqual(active, []);
    // Lazily pruned: the dead field is gone, not just ignored.
    const remaining = await getTestRedis().hlen("hydra:attention:dismissed:breakage");
    assert.equal(remaining, 0);
  });

  test("surfaced counters count an item id ONCE regardless of poll cadence", async () => {
    const items = [
      feedItem({ id: "blocked-issue-1" }),
      feedItem({ id: "blocked-issue-2" }),
    ];
    await recordSurfacedItems(items);
    await recordSurfacedItems(items); // the 30s poll re-read
    await recordSurfacedItems(items); // and again

    const counts = await readAttentionCounts();
    assert.equal(counts.find((c) => c.signal === "blocked-on-human")!.surfaced, 2);
  });

  test("surfaced counters are keyed by signal, not by item (calibration survives)", async () => {
    await recordSurfacedItems([
      feedItem({ id: "blocked-issue-1" }),
      feedItem({ id: "pr-failed-ci-5", signal: "breakage", threshold: 1, thresholdLabel: "≥ 1 failed check" }),
    ]);
    const counts = await readAttentionCounts();
    assert.equal(counts.find((c) => c.signal === "blocked-on-human")!.surfaced, 1);
    assert.equal(counts.find((c) => c.signal === "breakage")!.surfaced, 1);
  });
});

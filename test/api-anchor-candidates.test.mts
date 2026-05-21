/**
 * Regression tests for the anchor-candidates API (issue #424).
 *
 * Covers:
 *   - Empty board → research_recommended=true
 *   - Mixed candidates sorted by score desc
 *   - Stale candidate downscored (>14d old)
 *   - Reflections present → recent-failure downscore
 *   - Blocker-just-cleared → upscore
 *
 * Also covers the pure scoreCandidate() helper directly so we can pin the
 * formula without a Redis fixture.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/1";
process.env.REDIS_URL = REDIS_URL;

let redis: any;
let createAnchorRouter: any;
let backlogAdmin: any;
let scoreCandidate: any;

async function cleanKeys() {
  const keys = await redis.keys("hydra:*");
  if (keys.length > 0) await redis.del(...keys);
}

function mockReq(query: any = {}): any {
  return { method: "GET", url: "/anchor/candidates", headers: {}, query, params: {}, body: {} };
}

function mockRes(): any {
  const res: any = {
    _status: 200,
    _body: null,
    status(code: number) { res._status = code; return res; },
    json(body: any) { res._body = body; return res; },
    send(body: any) { res._body = body; return res; },
    setHeader() { return res; },
    end() { return res; },
  };
  return res;
}

function findHandler(router: any, method: string, path: string): Function | null {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === path) {
      const handlers = layer.route.methods;
      if (handlers[method.toLowerCase()]) {
        const stack = layer.route.stack;
        return stack[stack.length - 1].handle;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pure scorer tests — no Redis needed
// ---------------------------------------------------------------------------

describe("scoreCandidate — pure scoring helper (#424)", () => {
  beforeEach(async () => {
    if (!scoreCandidate) {
      const mod = await import("../src/anchor-selection.ts");
      scoreCandidate = mod.scoreCandidate;
    }
  });

  test("fresh kanban candidate with no abandonments scores at base", () => {
    const result = scoreCandidate({}, {
      priorityTier: "kanban-queued",
      lastUpdated: new Date().toISOString(),
      abandonments: 0,
      now: Date.now(),
    });
    assert.equal(result.score, 0.85);
    assert.ok(result.reasons.some((r: string) => r.includes("tier:kanban-queued")));
    assert.ok(result.reasons.includes("first-attempt"));
  });

  test("stale candidate (>14d) loses 0.15 freshness penalty", () => {
    const now = Date.now();
    const fifteenDaysAgo = new Date(now - 15 * 24 * 60 * 60 * 1000).toISOString();
    const result = scoreCandidate({}, {
      priorityTier: "kanban-queued",
      lastUpdated: fifteenDaysAgo,
      abandonments: 0,
      now,
    });
    assert.equal(Math.round(result.score * 100) / 100, 0.70);
    assert.ok(result.reasons.some((r: string) => r.startsWith("stale:")));
  });

  test("abandoned >=2 times loses 0.25", () => {
    const result = scoreCandidate({}, {
      priorityTier: "kanban-queued",
      lastUpdated: new Date().toISOString(),
      abandonments: 2,
      now: Date.now(),
    });
    assert.equal(Math.round(result.score * 100) / 100, 0.60);
    assert.ok(result.reasons.some((r: string) => r.includes("abandoned:2x")));
  });

  test("abandoned >=3 times loses 0.45 (circuit-breaker territory)", () => {
    const result = scoreCandidate({}, {
      priorityTier: "kanban-queued",
      lastUpdated: new Date().toISOString(),
      abandonments: 3,
      now: Date.now(),
    });
    assert.equal(Math.round(result.score * 100) / 100, 0.40);
  });

  test("recent reflection (<24h) downscores by 0.20", () => {
    const now = Date.now();
    const result = scoreCandidate({}, {
      priorityTier: "kanban-queued",
      lastUpdated: new Date(now).toISOString(),
      abandonments: 0,
      lastReflectionAt: new Date(now - 6 * 60 * 60 * 1000).toISOString(),
      now,
    });
    assert.equal(Math.round(result.score * 100) / 100, 0.65);
    assert.ok(result.reasons.some((r: string) => r.includes("recent-failure")));
  });

  test("old reflection (>24h) does NOT downscore", () => {
    const now = Date.now();
    const result = scoreCandidate({}, {
      priorityTier: "kanban-queued",
      lastUpdated: new Date(now).toISOString(),
      abandonments: 0,
      lastReflectionAt: new Date(now - 48 * 60 * 60 * 1000).toISOString(),
      now,
    });
    assert.equal(result.score, 0.85);
  });

  test("blocker-just-cleared upscores by 0.15", () => {
    const result = scoreCandidate({}, {
      priorityTier: "kanban-queued",
      lastUpdated: new Date().toISOString(),
      abandonments: 0,
      blockerJustCleared: true,
      now: Date.now(),
    });
    assert.equal(result.score, 1.00); // 0.85 + 0.15
    assert.ok(result.reasons.some((r: string) => r.includes("blocker-cleared")));
  });

  test("score clamped to [0, 1]", () => {
    // priorities-doc (0.25) - stale (0.15) - 3x abandoned (0.45) - reflection (0.20) = -0.55 → 0
    const now = Date.now();
    const result = scoreCandidate({}, {
      priorityTier: "priorities-doc",
      lastUpdated: new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(),
      abandonments: 3,
      lastReflectionAt: new Date(now - 1 * 60 * 60 * 1000).toISOString(),
      now,
    });
    assert.equal(result.score, 0);

    // explicit-operator (1.0) + blocker-cleared (0.15) = 1.15 → clamped to 1
    const high = scoreCandidate({}, {
      priorityTier: "explicit-operator",
      lastUpdated: new Date().toISOString(),
      abandonments: 0,
      blockerJustCleared: true,
      now,
    });
    assert.equal(high.score, 1);
  });

  test("priorities-doc base score (0.25) flips research_recommended", () => {
    // Pure helper doesn't know about the 0.5 threshold, but its base score
    // for priorities-doc must be < 0.5 so the endpoint correctly flips.
    const result = scoreCandidate({}, {
      priorityTier: "priorities-doc",
      lastUpdated: new Date().toISOString(),
      abandonments: 0,
      now: Date.now(),
    });
    assert.ok(result.score < 0.5, "priorities-doc base score must be below research threshold");
  });

  test("unknown tier returns 0 score and 'unknown-tier' reason (graceful degradation)", () => {
    const result = scoreCandidate({}, {
      priorityTier: "nonexistent-tier" as any,
      lastUpdated: new Date().toISOString(),
      abandonments: 0,
      now: Date.now(),
    });
    assert.equal(result.score, 0);
    assert.ok(result.reasons.includes("unknown-tier"));
  });
});

// ---------------------------------------------------------------------------
// API integration tests — requires Redis
// ---------------------------------------------------------------------------

describe("GET /anchor/candidates — endpoint integration (#424)", () => {
  beforeEach(async () => {
    if (!redis) {
      redis = new Redis(REDIS_URL);
    }
    await cleanKeys();
    if (!createAnchorRouter) {
      const mod = await import("../src/api/anchor.ts");
      createAnchorRouter = mod.createAnchorRouter;
    }
    if (!backlogAdmin) {
      const mod = await import("../src/backlog.ts");
      backlogAdmin = mod._admin;
    }
  });

  after(async () => {
    if (redis) {
      await cleanKeys();
      redis.disconnect();
    }
    const { closeRedisConnections } = await import("../src/redis-adapter.ts");
    closeRedisConnections();
  });

  test("empty board → research_recommended=true and no candidates", async () => {
    const router = createAnchorRouter();
    const handler = findHandler(router, "GET", "/anchor/candidates");
    assert.ok(handler);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    assert.ok(res._body, "response should have body");
    assert.equal(res._body.research_recommended, true);
    assert.deepEqual(res._body.candidates, []);
    assert.equal(res._body.total_evaluated, 0);
  });

  test("mixed candidates returned sorted by score desc", async () => {
    // Add three backlog items so they enumerate as kanban-queued candidates.
    await backlogAdmin.addToBacklog({ title: "Alpha task", lane: "queued", priority: 1 });
    await backlogAdmin.addToBacklog({ title: "Beta task", lane: "backlog", priority: 0 });
    await backlogAdmin.addToBacklog({ title: "Gamma task", lane: "backlog", priority: 0 });

    const router = createAnchorRouter();
    const handler = findHandler(router, "GET", "/anchor/candidates");

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    assert.equal(res._body.candidates.length, 3);
    // All three at kanban-queued tier with no penalties = same base score.
    // The sort is stable on the secondary tiebreak (last_updated desc) so
    // the most recently added item comes first. Either way, scores must be
    // non-ascending.
    for (let i = 1; i < res._body.candidates.length; i++) {
      assert.ok(
        res._body.candidates[i - 1].score >= res._body.candidates[i].score,
        `candidates must be sorted by score desc: ${res._body.candidates[i - 1].score} >= ${res._body.candidates[i].score}`,
      );
    }
    // Best candidate is well above research threshold.
    assert.ok(res._body.candidates[0].score >= 0.5);
    assert.equal(res._body.research_recommended, false);
  });

  test("stale candidate (>14d old) is downscored", async () => {
    // Insert a backlog item, then rewrite its movedAt to be 30 days old.
    const added = await backlogAdmin.addToBacklog({ title: "Old stale task", lane: "backlog" });
    const rawKey = `hydra:backlog:items`;
    const raw = await redis.hget(rawKey, String(added.id));
    assert.ok(raw, "backlog item should be saved");
    const item = JSON.parse(raw);
    item.movedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await redis.hset(rawKey, String(added.id), JSON.stringify(item));

    const router = createAnchorRouter();
    const handler = findHandler(router, "GET", "/anchor/candidates");
    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    const stale = res._body.candidates.find((c: any) => c.title === "Old stale task");
    assert.ok(stale, "stale candidate should appear in output");
    // kanban-queued (0.85) - freshness (0.15) = 0.70
    assert.equal(Math.round(stale.score * 100) / 100, 0.70);
    assert.ok(stale.reasons.some((r: string) => r.startsWith("stale:")));
  });

  test("recent reflection downscores the matching candidate", async () => {
    await backlogAdmin.addToBacklog({ title: "Has failure history", lane: "backlog" });

    // Inject a reflection for this anchor reference via the same adapter
    // the endpoint reads.
    const { recordAnchorReflection } = await import("../src/reflections/reflections.ts");
    await recordAnchorReflection({
      anchorRef: "Has failure history",
      cycleId: "cycle-test",
      taskTitle: "Has failure history",
      outcome: "failed",
      reason: "verification-failure",
      whatWasAttempted: "tried X",
      whyItFailed: "Y broke",
      whatShouldChange: "try Z",
    });

    const router = createAnchorRouter();
    const handler = findHandler(router, "GET", "/anchor/candidates");
    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    const c = res._body.candidates.find((x: any) => x.title === "Has failure history");
    assert.ok(c, "candidate should appear");
    // kanban-queued (0.85) - recent-failure (0.20) = 0.65
    assert.equal(Math.round(c.score * 100) / 100, 0.65);
    assert.ok(c.reasons.some((r: string) => r.includes("recent-failure")));
  });

  test("blocker-just-cleared candidate is upscored", async () => {
    // Seed a backlog item that was recently blocked then moved back.
    const added = await backlogAdmin.addToBacklog({ title: "Unblocked dep", lane: "backlog" });
    const rawKey = `hydra:backlog:items`;
    const raw = await redis.hget(rawKey, String(added.id));
    const item = JSON.parse(raw);
    // Simulate: was blocked, dep merged, item now back in backlog with
    // blockedReason still recorded and a fresh movedAt.
    item.meta = { ...item.meta, blockedReason: "Blocked by #99 (now merged)" };
    item.movedAt = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(); // 1h ago
    await redis.hset(rawKey, String(added.id), JSON.stringify(item));

    const router = createAnchorRouter();
    const handler = findHandler(router, "GET", "/anchor/candidates");
    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    const c = res._body.candidates.find((x: any) => x.title === "Unblocked dep");
    assert.ok(c, "unblocked candidate should appear");
    // kanban-queued (0.85) + blocker-cleared (0.15) = 1.00
    assert.equal(c.score, 1.00);
    assert.ok(c.reasons.some((r: string) => r.includes("blocker-cleared")));
  });

  test("limit query param caps result count and respects max", async () => {
    for (let i = 0; i < 5; i++) {
      await backlogAdmin.addToBacklog({ title: `Task ${i}`, lane: "backlog" });
    }
    const router = createAnchorRouter();
    const handler = findHandler(router, "GET", "/anchor/candidates");

    const req = mockReq({ limit: "2" });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res._body.candidates.length, 2);
    assert.equal(res._body.total_evaluated, 5);
  });

  test("priorities-doc only would flip research_recommended=true", async () => {
    // No backlog items, no specs, no work queue → no candidates at all
    // (we don't synthesize a priorities-doc candidate inside the endpoint
    // — the empty-board case already flips research_recommended).
    const router = createAnchorRouter();
    const handler = findHandler(router, "GET", "/anchor/candidates");
    const req = mockReq();
    const res = mockRes();
    await handler(req, res);
    assert.equal(res._body.research_recommended, true);
  });
});

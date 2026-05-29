/**
 * test/recommendations-api.test.mts — covers the three recommendation
 * endpoints landed on /api/now/* in issue #674 (slice F of #667).
 *
 *   GET  /now/recommendations
 *   POST /now/recommendations/:id/dismiss
 *   POST /now/recommendations/mute-class
 *
 * Same pattern as test/api-now-endpoints.test.mts — find the route on the
 * router, mock req/res, inject in-memory deps. No live Express, no Redis.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  createNowPageRouter,
  filterActiveRecommendations,
  resolveRunId,
  type RecommendationsReaderDeps,
  type CurrentRunIdReader,
} from "../src/api/now-page.ts";

// ---------------------------------------------------------------------------
// Test helpers — mirrors api-now-endpoints.test.mts
// ---------------------------------------------------------------------------

function mockReq(
  query: Record<string, unknown> = {},
  body: Record<string, unknown> = {},
  params: Record<string, string> = {},
): any {
  return { method: "GET", url: "/x", headers: {}, query, params, body };
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

// ---------------------------------------------------------------------------
// In-memory rec storage facade
// ---------------------------------------------------------------------------

interface RecRow {
  id: string;
  severity: "info" | "warn" | "critical";
  message: string;
  evidence_id: string;
  run_id: string;
  created_at: string;
}

function makeRecsFake(initial: {
  recs?: Record<string, RecRow[]>;
  dismissed?: Record<string, string[]>;
  muted?: Record<string, string[]>;
} = {}): { redis: RecommendationsReaderDeps; state: any } {
  const state = {
    recs: new Map<string, Map<string, string>>(),
    dismissed: new Map<string, Set<string>>(),
    muted: new Map<string, Set<string>>(),
  };
  for (const [runId, rows] of Object.entries(initial.recs ?? {})) {
    const h = new Map<string, string>();
    for (const r of rows) h.set(r.id, JSON.stringify(r));
    state.recs.set(runId, h);
  }
  for (const [runId, ids] of Object.entries(initial.dismissed ?? {})) {
    state.dismissed.set(runId, new Set(ids));
  }
  for (const [runId, sevs] of Object.entries(initial.muted ?? {})) {
    state.muted.set(runId, new Set(sevs));
  }

  const redis: RecommendationsReaderDeps = {
    async getAllRecommendations(runId) {
      const h = state.recs.get(runId);
      if (!h) return {};
      return Object.fromEntries(h);
    },
    async getDismissedSet(runId) {
      return Array.from(state.dismissed.get(runId) ?? []);
    },
    async getMutedClassesSet(runId) {
      return Array.from(state.muted.get(runId) ?? []);
    },
    async dismissRecommendation(runId, recId) {
      const s = state.dismissed.get(runId) ?? new Set<string>();
      s.add(recId);
      state.dismissed.set(runId, s);
    },
    async muteSeverityClass(runId, severity) {
      const s = state.muted.get(runId) ?? new Set<string>();
      s.add(severity);
      state.muted.set(runId, s);
    },
  };

  return { redis, state };
}

function rec(overrides: Partial<RecRow> = {}): RecRow {
  return {
    id: "run-A:1:0",
    severity: "info",
    message: "test rec",
    evidence_id: "turn:1",
    run_id: "run-A",
    created_at: "2026-05-28T00:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("filterActiveRecommendations", () => {
  test("returns parsed recs newest-first by created_at", () => {
    const rawHash = {
      a: JSON.stringify(rec({ id: "a", created_at: "2026-05-28T00:00:00Z" })),
      b: JSON.stringify(rec({ id: "b", created_at: "2026-05-28T00:00:10Z" })),
      c: JSON.stringify(rec({ id: "c", created_at: "2026-05-28T00:00:05Z" })),
    };
    const out = filterActiveRecommendations({ rawHash, dismissed: [], muted: [] });
    assert.deepEqual(
      out.map((r) => r.id),
      ["b", "c", "a"],
    );
  });

  test("drops dismissed ids", () => {
    const rawHash = {
      a: JSON.stringify(rec({ id: "a" })),
      b: JSON.stringify(rec({ id: "b" })),
    };
    const out = filterActiveRecommendations({
      rawHash,
      dismissed: ["a"],
      muted: [],
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].id, "b");
  });

  test("drops recs whose severity is in the muted set", () => {
    const rawHash = {
      a: JSON.stringify(rec({ id: "a", severity: "info" })),
      b: JSON.stringify(rec({ id: "b", severity: "warn" })),
      c: JSON.stringify(rec({ id: "c", severity: "critical" })),
    };
    const out = filterActiveRecommendations({
      rawHash,
      dismissed: [],
      muted: ["warn"],
    });
    assert.deepEqual(
      out.map((r) => r.id).sort(),
      ["a", "c"],
    );
  });

  test("skips unparseable rows without throwing", () => {
    const rawHash = {
      a: "not json{",
      b: JSON.stringify(rec({ id: "b" })),
    };
    const out = filterActiveRecommendations({ rawHash, dismissed: [], muted: [] });
    assert.equal(out.length, 1);
    assert.equal(out[0].id, "b");
  });
});

describe("resolveRunId", () => {
  test("'current' delegates to the reader", async () => {
    const reader: CurrentRunIdReader = async () => "run-LIVE";
    assert.equal(await resolveRunId("current", reader), "run-LIVE");
  });

  test("any other string returns verbatim", async () => {
    const reader: CurrentRunIdReader = async () => "should-not-be-used";
    assert.equal(await resolveRunId("run-EXPLICIT", reader), "run-EXPLICIT");
  });

  test("'current' returns null when no run exists", async () => {
    const reader: CurrentRunIdReader = async () => null;
    assert.equal(await resolveRunId("current", reader), null);
  });
});

// ---------------------------------------------------------------------------
// GET /now/recommendations
// ---------------------------------------------------------------------------

describe("GET /now/recommendations", () => {
  test("returns active recs newest-first", async () => {
    const { redis } = makeRecsFake({
      recs: {
        "run-A": [
          rec({ id: "a", created_at: "2026-05-28T00:00:00Z" }),
          rec({ id: "b", created_at: "2026-05-28T00:00:10Z" }),
        ],
      },
    });
    const router = createNowPageRouter({
      recsRedis: redis,
      readCurrentRunId: async () => "run-A",
      now: () => new Date("2026-05-28T00:00:30Z"),
    });
    const handler = findHandler(router, "GET", "/now/recommendations");
    assert.ok(handler);
    const res = mockRes();
    await handler!(mockReq(), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.run_id, "run-A");
    assert.equal(res._body.items.length, 2);
    assert.equal(res._body.items[0].id, "b");
  });

  test("returns empty list and null run_id when no current run", async () => {
    const { redis } = makeRecsFake();
    const router = createNowPageRouter({
      recsRedis: redis,
      readCurrentRunId: async () => null,
    });
    const handler = findHandler(router, "GET", "/now/recommendations");
    const res = mockRes();
    await handler!(mockReq(), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.run_id, null);
    assert.deepEqual(res._body.items, []);
  });

  test("filters out dismissed and muted-class recs", async () => {
    const { redis } = makeRecsFake({
      recs: {
        "run-A": [
          rec({ id: "a", severity: "info" }),
          rec({ id: "b", severity: "warn" }),
          rec({ id: "c", severity: "critical" }),
        ],
      },
      dismissed: { "run-A": ["c"] },
      muted: { "run-A": ["info"] },
    });
    const router = createNowPageRouter({
      recsRedis: redis,
      readCurrentRunId: async () => "run-A",
    });
    const handler = findHandler(router, "GET", "/now/recommendations");
    const res = mockRes();
    await handler!(mockReq(), res);
    assert.equal(res._body.items.length, 1);
    assert.equal(res._body.items[0].id, "b");
  });

  test("rejects an empty run_id with schema-validation-failed", async () => {
    const { redis } = makeRecsFake();
    const router = createNowPageRouter({ recsRedis: redis });
    const handler = findHandler(router, "GET", "/now/recommendations");
    const res = mockRes();
    await handler!(mockReq({ run_id: "  " }), res);
    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
  });
});

// ---------------------------------------------------------------------------
// POST /now/recommendations/:id/dismiss
// ---------------------------------------------------------------------------

describe("POST /now/recommendations/:id/dismiss", () => {
  test("adds the id to the dismissed set and echoes back the canonical run_id", async () => {
    const { redis, state } = makeRecsFake({
      recs: { "run-A": [rec({ id: "a" })] },
    });
    const router = createNowPageRouter({
      recsRedis: redis,
      readCurrentRunId: async () => "run-A",
    });
    const handler = findHandler(router, "POST", "/now/recommendations/:id/dismiss");
    assert.ok(handler);
    const res = mockRes();
    await handler!(mockReq({}, {}, { id: "a" }), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.dismissed, true);
    assert.equal(res._body.rec_id, "a");
    assert.equal(res._body.run_id, "run-A");
    assert.ok(state.dismissed.get("run-A")?.has("a"));
  });

  test("404s when no current run and run_id is 'current'", async () => {
    const { redis } = makeRecsFake();
    const router = createNowPageRouter({
      recsRedis: redis,
      readCurrentRunId: async () => null,
    });
    const handler = findHandler(router, "POST", "/now/recommendations/:id/dismiss");
    const res = mockRes();
    await handler!(mockReq({}, {}, { id: "a" }), res);
    assert.equal(res._status, 404);
  });

  test("400s on an empty :id path param", async () => {
    const { redis } = makeRecsFake();
    const router = createNowPageRouter({ recsRedis: redis });
    const handler = findHandler(router, "POST", "/now/recommendations/:id/dismiss");
    const res = mockRes();
    await handler!(mockReq({}, {}, { id: "  " }), res);
    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
  });
});

// ---------------------------------------------------------------------------
// POST /now/recommendations/mute-class
// ---------------------------------------------------------------------------

describe("POST /now/recommendations/mute-class", () => {
  test("adds the severity to the muted set", async () => {
    const { redis, state } = makeRecsFake();
    const router = createNowPageRouter({
      recsRedis: redis,
      readCurrentRunId: async () => "run-A",
    });
    const handler = findHandler(router, "POST", "/now/recommendations/mute-class");
    assert.ok(handler);
    const res = mockRes();
    await handler!(mockReq({}, { severity: "warn" }), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.muted, true);
    assert.equal(res._body.severity, "warn");
    assert.ok(state.muted.get("run-A")?.has("warn"));
  });

  test("rejects an unknown severity value", async () => {
    const { redis } = makeRecsFake();
    const router = createNowPageRouter({
      recsRedis: redis,
      readCurrentRunId: async () => "run-A",
    });
    const handler = findHandler(router, "POST", "/now/recommendations/mute-class");
    const res = mockRes();
    await handler!(mockReq({}, { severity: "panic" }), res);
    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
  });

  test("accepts an explicit run_id without consulting the reader", async () => {
    const { redis, state } = makeRecsFake();
    let readerCalled = false;
    const router = createNowPageRouter({
      recsRedis: redis,
      readCurrentRunId: async () => {
        readerCalled = true;
        return "should-not-resolve";
      },
    });
    const handler = findHandler(router, "POST", "/now/recommendations/mute-class");
    const res = mockRes();
    await handler!(mockReq({}, { run_id: "run-X", severity: "critical" }), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.run_id, "run-X");
    assert.equal(readerCalled, false);
    assert.ok(state.muted.get("run-X")?.has("critical"));
  });
});

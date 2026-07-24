/**
 * test/now-recommendations.test.mts — covers the pure now-recommendations
 * aggregator leaf (`src/aggregators/now-recommendations.ts`, issue #3570).
 *
 * These assert on the aggregator's TYPED result shapes (which recs survive a
 * mute/dismiss filter, what a dismissal / mute returns, how a missing current
 * run degrades) with injected in-memory deps — no HTTP layer, no Redis. The
 * companion `test/recommendations-api.test.mts` still exercises the thin route
 * adapters that call these entrypoints.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  getActiveRecommendations,
  dismissRecommendationForRun,
  muteSeverityClassForRun,
  filterActiveRecommendations,
  resolveRunId,
  type NowRecommendationsDeps,
  type RecommendationsReaderDeps,
  type CurrentRunIdReader,
} from "../src/aggregators/now-recommendations.ts";

// ---------------------------------------------------------------------------
// In-memory rec storage facade (mirrors recommendations-api.test.mts)
// ---------------------------------------------------------------------------

interface RecRow {
  id: string;
  severity: "info" | "warn" | "critical";
  message: string;
  evidence_id: string;
  run_id: string;
  created_at: string;
}

function makeRecsFake(
  initial: {
    recs?: Record<string, RecRow[]>;
    dismissed?: Record<string, string[]>;
    muted?: Record<string, string[]>;
  } = {},
): { redis: RecommendationsReaderDeps; state: any } {
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

function makeDeps(
  redis: RecommendationsReaderDeps,
  readCurrentRunId: CurrentRunIdReader,
  nowIso = "2026-05-28T00:00:30.000Z",
): NowRecommendationsDeps {
  return {
    recsRedis: redis,
    readCurrentRunId,
    now: () => new Date(nowIso),
    ttlSeconds: 3600,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers (re-homed to the aggregator leaf)
// ---------------------------------------------------------------------------

describe("aggregator: filterActiveRecommendations", () => {
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

describe("aggregator: resolveRunId", () => {
  test("'current' delegates to the reader; explicit is verbatim", async () => {
    const reader: CurrentRunIdReader = async () => "run-LIVE";
    assert.equal(await resolveRunId("current", reader), "run-LIVE");
    assert.equal(await resolveRunId("run-X", reader), "run-X");
  });
});

// ---------------------------------------------------------------------------
// getActiveRecommendations
// ---------------------------------------------------------------------------

describe("aggregator: getActiveRecommendations", () => {
  test("returns active recs newest-first with a resolved run_id and clock stamp", async () => {
    const { redis } = makeRecsFake({
      recs: {
        "run-A": [
          rec({ id: "a", created_at: "2026-05-28T00:00:00Z" }),
          rec({ id: "b", created_at: "2026-05-28T00:00:10Z" }),
        ],
      },
    });
    const result = await getActiveRecommendations(
      "current",
      makeDeps(redis, async () => "run-A"),
    );
    assert.equal(result.run_id, "run-A");
    assert.equal(result.items.length, 2);
    assert.equal(result.items[0].id, "b");
    assert.equal(result.generatedAt, "2026-05-28T00:00:30.000Z");
  });

  test("degrades to an empty list with run_id null when no current run", async () => {
    const { redis } = makeRecsFake();
    const result = await getActiveRecommendations(
      "current",
      makeDeps(redis, async () => null),
    );
    assert.equal(result.run_id, null);
    assert.deepEqual(result.items, []);
  });

  test("applies the dismissal + muting policy", async () => {
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
    const result = await getActiveRecommendations(
      "current",
      makeDeps(redis, async () => "run-A"),
    );
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].id, "b");
  });
});

// ---------------------------------------------------------------------------
// dismissRecommendationForRun
// ---------------------------------------------------------------------------

describe("aggregator: dismissRecommendationForRun", () => {
  test("records the dismissal and returns the canonical run_id", async () => {
    const { redis, state } = makeRecsFake({
      recs: { "run-A": [rec({ id: "a" })] },
    });
    const result = await dismissRecommendationForRun(
      "current",
      "a",
      makeDeps(redis, async () => "run-A"),
    );
    assert.equal(result.kind, "ok");
    if (result.kind === "ok") {
      assert.equal(result.run_id, "run-A");
      assert.equal(result.rec_id, "a");
      assert.equal(result.dismissed, true);
    }
    assert.ok(state.dismissed.get("run-A")?.has("a"));
  });

  test("returns run_missing when 'current' resolves to no run", async () => {
    const { redis } = makeRecsFake();
    const result = await dismissRecommendationForRun(
      "current",
      "a",
      makeDeps(redis, async () => null),
    );
    assert.equal(result.kind, "run_missing");
  });
});

// ---------------------------------------------------------------------------
// muteSeverityClassForRun
// ---------------------------------------------------------------------------

describe("aggregator: muteSeverityClassForRun", () => {
  test("records the mute against the resolved run", async () => {
    const { redis, state } = makeRecsFake();
    const result = await muteSeverityClassForRun(
      "current",
      "warn",
      makeDeps(redis, async () => "run-A"),
    );
    assert.equal(result.kind, "ok");
    if (result.kind === "ok") {
      assert.equal(result.run_id, "run-A");
      assert.equal(result.severity, "warn");
      assert.equal(result.muted, true);
    }
    assert.ok(state.muted.get("run-A")?.has("warn"));
  });

  test("honours an explicit run_id without consulting the reader", async () => {
    const { redis, state } = makeRecsFake();
    let readerCalled = false;
    const result = await muteSeverityClassForRun(
      "run-X",
      "critical",
      makeDeps(redis, async () => {
        readerCalled = true;
        return "should-not-resolve";
      }),
    );
    assert.equal(result.kind, "ok");
    if (result.kind === "ok") assert.equal(result.run_id, "run-X");
    assert.equal(readerCalled, false);
    assert.ok(state.muted.get("run-X")?.has("critical"));
  });

  test("returns run_missing when 'current' resolves to no run", async () => {
    const { redis } = makeRecsFake();
    const result = await muteSeverityClassForRun(
      "current",
      "warn",
      makeDeps(redis, async () => null),
    );
    assert.equal(result.kind, "run_missing");
  });
});

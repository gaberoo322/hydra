/**
 * test/retro-artifacts.test.mts — the persisted retro-artifact seam (issue
 * #921, retro-4 of epic #917).
 *
 * Split out of the former `test/retro-artifact.test.mts` (issue #1914) when the
 * combined `src/redis/retro.ts` was split into a slice-A module
 * (`retro-seen.ts`) and this slice-B module (`retro-artifacts.ts`). This file
 * imports from exactly one source module.
 *
 * Covers:
 *   - `src/redis/retro-artifacts.ts` accessors against an in-memory fake
 *     connection (the DI facade shape used across the Redis seam) — persist→read
 *     round-trip, newest-first index ordering, limit clamping, TTL stamping, and
 *     the never-throw contract when the connection rejects.
 *   - `src/schemas/retro.ts` — the artifact schema and the recent-retros query
 *     schema (coercion, defaults, bounds).
 *
 * No live Redis, no live Express — the accessors take an injected connection
 * and the schemas are pure.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  persistRetroArtifact,
  getRetroArtifact,
  listRecentRetroArtifacts,
  retroArtifactKey,
  retroArtifactsIndexKey,
  RETRO_ARTIFACT_TTL_SECONDS,
  type RetroArtifact,
  type RetroRedisLike,
} from "../src/redis/retro-artifacts.ts";
import {
  RetroArtifactSchema,
  RecentRetrosQuerySchema,
} from "../src/schemas/retro.ts";

// ---------------------------------------------------------------------------
// In-memory fake connection — records ops so tests can assert TTL + ordering.
// ---------------------------------------------------------------------------

interface FakeState {
  strings: Map<string, string>;
  /** key -> Map<member, score> for the index ZSET. */
  zsets: Map<string, Map<string, number>>;
  /** key -> last EX seconds applied (via set EX or expire). */
  ttls: Map<string, number>;
}

function makeFakeRedis(): { redis: RetroRedisLike; state: FakeState } {
  const state: FakeState = {
    strings: new Map(),
    zsets: new Map(),
    ttls: new Map(),
  };
  const redis: RetroRedisLike = {
    async set(key, value, _mode, seconds) {
      state.strings.set(key, value);
      state.ttls.set(key, seconds);
      return "OK";
    },
    async get(key) {
      return state.strings.has(key) ? (state.strings.get(key) as string) : null;
    },
    async zadd(key, score, member) {
      let z = state.zsets.get(key);
      if (!z) {
        z = new Map();
        state.zsets.set(key, z);
      }
      z.set(member, score);
      return 1;
    },
    async zrevrange(key, start, stop) {
      const z = state.zsets.get(key);
      if (!z) return [];
      const sorted = [...z.entries()]
        .sort((a, b) => b[1] - a[1]) // descending score == newest first
        .map(([member]) => member);
      // ioredis ZREVRANGE is inclusive of stop.
      return sorted.slice(start, stop + 1);
    },
    async expire(key, seconds) {
      state.ttls.set(key, seconds);
      return 1;
    },
  };
  return { redis, state };
}

function makeArtifact(overrides: Partial<RetroArtifact> = {}): RetroArtifact {
  return {
    run_id: "run-abc",
    generatedAt: "2026-06-03T00:00:00.000Z",
    findings: [
      { cue: "qa-fail-loop", summary: "QA looped twice", recurrence: 3, disposition: "pr" },
    ],
    emitted: [{ kind: "issue", number: 921, title: "retro-4" }],
    summary: "1 merged, 1 failed",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Redis seam — accessors
// ---------------------------------------------------------------------------

describe("redis/retro-artifacts — persist + read", () => {
  test("persist→get round-trips the artifact and stamps the 14d TTL", async () => {
    const { redis, state } = makeFakeRedis();
    const artifact = makeArtifact();

    const result = await persistRetroArtifact(artifact, redis);
    assert.deepEqual(result, { ok: true });

    // Artifact stored under the per-run key with the 14d TTL.
    const key = retroArtifactKey("run-abc");
    assert.ok(state.strings.has(key));
    assert.equal(state.ttls.get(key), RETRO_ARTIFACT_TTL_SECONDS);
    assert.equal(RETRO_ARTIFACT_TTL_SECONDS, 14 * 24 * 60 * 60);

    // Index entry stamped + TTL'd too.
    assert.equal(state.ttls.get(retroArtifactsIndexKey()), RETRO_ARTIFACT_TTL_SECONDS);

    const read = await getRetroArtifact("run-abc", redis);
    assert.deepEqual(read, artifact);
  });

  test("getRetroArtifact returns null for an absent run", async () => {
    const { redis } = makeFakeRedis();
    assert.equal(await getRetroArtifact("nope", redis), null);
  });

  test("getRetroArtifact returns null (never throws) on a corrupt value", async () => {
    const { redis, state } = makeFakeRedis();
    state.strings.set(retroArtifactKey("run-corrupt"), "{not json");
    assert.equal(await getRetroArtifact("run-corrupt", redis), null);
  });

  test("a malformed generatedAt falls back to a finite index score", async () => {
    const { redis, state } = makeFakeRedis();
    const artifact = makeArtifact({ run_id: "run-bad-date", generatedAt: "not-a-date" });
    const result = await persistRetroArtifact(artifact, redis);
    assert.deepEqual(result, { ok: true });
    const z = state.zsets.get(retroArtifactsIndexKey());
    const score = z?.get("run-bad-date");
    assert.equal(typeof score, "number");
    assert.ok(Number.isFinite(score as number));
  });
});

describe("redis/retro-artifacts — listRecentRetroArtifacts", () => {
  test("returns artifacts newest-first by generatedAt", async () => {
    const { redis } = makeFakeRedis();
    await persistRetroArtifact(
      makeArtifact({ run_id: "old", generatedAt: "2026-06-01T00:00:00.000Z" }),
      redis,
    );
    await persistRetroArtifact(
      makeArtifact({ run_id: "new", generatedAt: "2026-06-03T00:00:00.000Z" }),
      redis,
    );
    await persistRetroArtifact(
      makeArtifact({ run_id: "mid", generatedAt: "2026-06-02T00:00:00.000Z" }),
      redis,
    );

    const list = await listRecentRetroArtifacts(10, redis);
    assert.deepEqual(
      list.map((a) => a.run_id),
      ["new", "mid", "old"],
    );
  });

  test("honours the limit", async () => {
    const { redis } = makeFakeRedis();
    for (let i = 0; i < 5; i++) {
      await persistRetroArtifact(
        makeArtifact({
          run_id: `run-${i}`,
          generatedAt: `2026-06-0${i + 1}T00:00:00.000Z`,
        }),
        redis,
      );
    }
    const list = await listRecentRetroArtifacts(2, redis);
    assert.equal(list.length, 2);
    assert.deepEqual(list.map((a) => a.run_id), ["run-4", "run-3"]);
  });

  test("returns [] for a non-positive limit", async () => {
    const { redis } = makeFakeRedis();
    await persistRetroArtifact(makeArtifact(), redis);
    assert.deepEqual(await listRecentRetroArtifacts(0, redis), []);
    assert.deepEqual(await listRecentRetroArtifacts(-1, redis), []);
  });

  test("skips an index entry whose artifact has expired", async () => {
    const { redis, state } = makeFakeRedis();
    await persistRetroArtifact(makeArtifact({ run_id: "live" }), redis);
    // Simulate a dangling index member whose artifact string has expired.
    state.zsets.get(retroArtifactsIndexKey())!.set("ghost", 999_999_999_999);
    const list = await listRecentRetroArtifacts(10, redis);
    assert.deepEqual(list.map((a) => a.run_id), ["live"]);
  });
});

describe("redis/retro-artifacts — never-throw contract", () => {
  function rejectingRedis(): RetroRedisLike {
    const boom = async () => {
      throw new Error("redis down");
    };
    return {
      set: boom as any,
      get: boom as any,
      zadd: boom as any,
      zrevrange: boom as any,
      expire: boom as any,
    };
  }

  test("persistRetroArtifact returns a result object, never throws", async () => {
    const result = await persistRetroArtifact(makeArtifact(), rejectingRedis());
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "redis-error");
      assert.match(result.detail, /redis down/);
    }
  });

  test("getRetroArtifact returns null, never throws", async () => {
    assert.equal(await getRetroArtifact("x", rejectingRedis()), null);
  });

  test("listRecentRetroArtifacts returns [], never throws", async () => {
    assert.deepEqual(await listRecentRetroArtifacts(5, rejectingRedis()), []);
  });
});

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

describe("schemas/retro — RetroArtifactSchema", () => {
  test("accepts a well-formed artifact", () => {
    const parsed = RetroArtifactSchema.safeParse(makeArtifact());
    assert.equal(parsed.success, true);
  });

  test("rejects an empty run_id", () => {
    const parsed = RetroArtifactSchema.safeParse(makeArtifact({ run_id: "" }));
    assert.equal(parsed.success, false);
  });

  test("rejects an unknown emitted kind", () => {
    const parsed = RetroArtifactSchema.safeParse(
      makeArtifact({ emitted: [{ kind: "wat" as any, number: 1 }] }),
    );
    assert.equal(parsed.success, false);
  });

  test("rejects a negative recurrence", () => {
    const parsed = RetroArtifactSchema.safeParse(
      makeArtifact({
        findings: [{ cue: "c", summary: "s", recurrence: -1, disposition: "issue" }],
      }),
    );
    assert.equal(parsed.success, false);
  });
});

describe("schemas/retro — RecentRetrosQuerySchema", () => {
  test("defaults limit to 20 when absent", () => {
    const parsed = RecentRetrosQuerySchema.safeParse({});
    assert.equal(parsed.success, true);
    if (parsed.success) assert.equal(parsed.data.limit, 20);
  });

  test("coerces a string limit", () => {
    const parsed = RecentRetrosQuerySchema.safeParse({ limit: "5" });
    assert.equal(parsed.success, true);
    if (parsed.success) assert.equal(parsed.data.limit, 5);
  });

  test("rejects limit below 1 and above 100", () => {
    assert.equal(RecentRetrosQuerySchema.safeParse({ limit: "0" }).success, false);
    assert.equal(RecentRetrosQuerySchema.safeParse({ limit: "101" }).success, false);
  });

  test("rejects unknown keys (strict)", () => {
    assert.equal(
      RecentRetrosQuerySchema.safeParse({ limit: "5", extra: "x" }).success,
      false,
    );
  });
});

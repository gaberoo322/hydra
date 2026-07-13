/**
 * Regression tests for the per-dispatch outcome-record Redis seam
 * (`src/redis/dispatch-outcomes.ts`, issue #2942).
 *
 * Coverage maps to the issue's acceptance criteria:
 *   AC2 — Bounded growth: 14d TTL on both the per-record hash and the index
 *         ZSET, plus a write-time index cap (ZREMRANGEBYRANK keeps the newest
 *         N members).
 *   AC3 — A typed accessor under src/redis/ returns records for a run
 *         (`getDispatchOutcomesForRun`) and across a rolling window
 *         (`listDispatchOutcomes`).
 *   Dark tolerance — null attribution fields round-trip as null (omitted hash
 *         fields), and an index member whose hash expired is skipped, never
 *         fabricated.
 *   Upgrade — `upgradeDispatchOutcome` is an additive in-place HSET (the
 *         issue-2860 completed→merged path) that never re-initialises the
 *         record, and re-applies the TTL only when the key has none (the
 *         #2926 leak-backstop pattern).
 *
 * Uses Redis DB 1 — never touches production (DB 0). Own top-level describe
 * with its own before/after lifecycle (per the CLAUDE.md shared-Redis
 * teardown rule).
 */

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/1";
process.env.REDIS_URL = REDIS_URL;

import {
  putDispatchOutcome,
  upgradeDispatchOutcome,
  getDispatchOutcomesForRun,
  listDispatchOutcomes,
  dispatchOutcomeKey,
  dispatchOutcomesIndexKey,
  DISPATCH_OUTCOME_TTL_SECONDS,
  type DispatchOutcomeRecord,
} from "../src/redis/dispatch-outcomes.ts";

function record(over: Partial<DispatchOutcomeRecord> = {}): DispatchOutcomeRecord {
  return {
    cycleId: "worktree-agent-277e4476-t4-dev_orch",
    runIdPrefix: "277e4476",
    turn: 4,
    className: "dev_orch",
    skill: "hydra-dev",
    outcome: "completed",
    tokens: 120_000,
    durationMs: 90_000,
    escalationAttempt: null,
    escalatedModel: null,
    recordedAt: 1_750_000_000_000,
    ...over,
  };
}

describe("dispatch-outcomes Redis seam (issue #2942)", () => {
  let redis: any;

  before(() => {
    redis = new Redis(REDIS_URL);
  });

  beforeEach(async () => {
    const keys = await redis.keys("hydra:autopilot:dispatch-outcome*");
    if (keys.length > 0) await redis.del(...keys);
  });

  after(async () => {
    const keys = await redis.keys("hydra:autopilot:dispatch-outcome*");
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  });

  test("put writes the hash + index member with 14d TTLs on both (AC2)", async () => {
    const rec = record();
    const res = await putDispatchOutcome(rec);
    assert.equal(res.ok, true);

    const hash = await redis.hgetall(dispatchOutcomeKey(rec.cycleId));
    assert.equal(hash.cycleId, rec.cycleId);
    assert.equal(hash.runIdPrefix, "277e4476");
    assert.equal(hash.turn, "4");
    assert.equal(hash.class, "dev_orch");
    assert.equal(hash.skill, "hydra-dev");
    assert.equal(hash.outcome, "completed");
    assert.equal(hash.tokens, "120000");
    assert.equal(hash.durationMs, "90000");

    const score = await redis.zscore(dispatchOutcomesIndexKey(), rec.cycleId);
    assert.equal(Number(score), rec.recordedAt);

    const hashTtl = await redis.ttl(dispatchOutcomeKey(rec.cycleId));
    const indexTtl = await redis.ttl(dispatchOutcomesIndexKey());
    assert.ok(hashTtl > 0 && hashTtl <= DISPATCH_OUTCOME_TTL_SECONDS, `hash ttl=${hashTtl}`);
    assert.ok(indexTtl > 0 && indexTtl <= DISPATCH_OUTCOME_TTL_SECONDS, `index ttl=${indexTtl}`);
  });

  test("null attribution fields are omitted from the hash and round-trip as null (dark tolerance)", async () => {
    const rec = record({
      cycleId: "8f1c2d3e-aaaa-bbbb-cccc-000000000000", // bare-UUID qa relay id
      runIdPrefix: null,
      turn: null,
      className: null,
      skill: null,
      tokens: null,
      durationMs: null,
    });
    assert.equal((await putDispatchOutcome(rec)).ok, true);

    const hash = await redis.hgetall(dispatchOutcomeKey(rec.cycleId));
    assert.equal("runIdPrefix" in hash, false);
    assert.equal("tokens" in hash, false);
    // Issue #3284: a non-escalation dispatch omits both escalation fields.
    assert.equal("escalationAttempt" in hash, false);
    assert.equal("escalatedModel" in hash, false);

    const listed = await listDispatchOutcomes({ sinceMs: 0 });
    assert.equal(listed.ok, true);
    if (listed.ok !== true) return;
    assert.equal(listed.records.length, 1);
    const got = listed.records[0];
    assert.equal(got.cycleId, rec.cycleId);
    assert.equal(got.runIdPrefix, null);
    assert.equal(got.turn, null);
    assert.equal(got.className, null);
    assert.equal(got.skill, null);
    assert.equal(got.tokens, null);
    assert.equal(got.durationMs, null);
    assert.equal(got.outcome, "completed");
    assert.equal(got.escalationAttempt, null);
    assert.equal(got.escalatedModel, null);
  });

  test("escalation provenance round-trips (issue #3284, invariant 7 marker)", async () => {
    const rec = record({
      cycleId: "worktree-agent-277e4476-t2-cleanup_orch",
      className: "cleanup_orch",
      tokens: 55_000,
      outcome: "merged",
      escalationAttempt: 2,
      escalatedModel: "sonnet",
    });
    assert.equal((await putDispatchOutcome(rec)).ok, true);

    const hash = await redis.hgetall(dispatchOutcomeKey(rec.cycleId));
    assert.equal(hash.escalationAttempt, "2");
    assert.equal(hash.escalatedModel, "sonnet");

    const listed = await listDispatchOutcomes({ sinceMs: 0 });
    assert.equal(listed.ok, true);
    if (listed.ok !== true) return;
    const got = listed.records.find((r) => r.cycleId === rec.cycleId);
    assert.ok(got);
    assert.equal(got!.escalationAttempt, 2);
    assert.equal(got!.escalatedModel, "sonnet");
  });

  test("write-time index trim keeps only the newest indexMax members (AC2 cap)", async () => {
    for (let i = 1; i <= 5; i++) {
      const res = await putDispatchOutcome(
        record({
          cycleId: `worktree-agent-277e4476-t${i}-dev_orch`,
          turn: i,
          recordedAt: 1_750_000_000_000 + i,
        }),
        3, // injectable cap so the test doesn't need 2000 rows
      );
      assert.equal(res.ok, true);
    }
    const members = await redis.zrange(dispatchOutcomesIndexKey(), 0, -1);
    assert.equal(members.length, 3);
    assert.deepEqual(members.sort(), [
      "worktree-agent-277e4476-t3-dev_orch",
      "worktree-agent-277e4476-t4-dev_orch",
      "worktree-agent-277e4476-t5-dev_orch",
    ]);
  });

  test("upgrade patches outcome/tokens in place without re-initialising the record", async () => {
    const rec = record();
    await putDispatchOutcome(rec);

    const up = await upgradeDispatchOutcome(rec.cycleId, {
      outcome: "merged",
      tokens: 130_000,
    });
    assert.equal(up.ok, true);

    const hash = await redis.hgetall(dispatchOutcomeKey(rec.cycleId));
    assert.equal(hash.outcome, "merged");
    assert.equal(hash.tokens, "130000");
    // Untouched fields survive — additive HSET, not a re-init.
    assert.equal(hash.runIdPrefix, "277e4476");
    assert.equal(hash.skill, "hydra-dev");
    assert.equal(hash.recordedAt, String(rec.recordedAt));
  });

  test("upgrade re-applies the TTL only when the key has none (#2926 leak backstop)", async () => {
    const rec = record();
    await putDispatchOutcome(rec);
    await redis.persist(dispatchOutcomeKey(rec.cycleId)); // simulate a TTL-less orphan
    assert.equal(await redis.ttl(dispatchOutcomeKey(rec.cycleId)), -1);

    await upgradeDispatchOutcome(rec.cycleId, { outcome: "merged" });
    const ttl = await redis.ttl(dispatchOutcomeKey(rec.cycleId));
    assert.ok(ttl > 0 && ttl <= DISPATCH_OUTCOME_TTL_SECONDS, `ttl=${ttl}`);
  });

  test("getDispatchOutcomesForRun matches on the 8-char run prefix, newest-first (AC3)", async () => {
    await putDispatchOutcome(
      record({ cycleId: "worktree-agent-277e4476-t2-dev_orch", turn: 2, recordedAt: 100 }),
    );
    await putDispatchOutcome(
      record({ cycleId: "worktree-agent-277e4476-t5-qa_orch", className: "qa_orch", skill: "hydra-qa", turn: 5, recordedAt: 300 }),
    );
    await putDispatchOutcome(
      record({ cycleId: "worktree-agent-deadbeef-t1-dev_target", runIdPrefix: "deadbeef", className: "dev_target", turn: 1, recordedAt: 200 }),
    );

    const res = await getDispatchOutcomesForRun("277e4476-1234-5678-9abc-def012345678");
    assert.equal(res.ok, true);
    if (res.ok !== true) return;
    assert.equal(res.records.length, 2);
    // Newest-first (recordedAt 300 before 100).
    assert.equal(res.records[0].cycleId, "worktree-agent-277e4476-t5-qa_orch");
    assert.equal(res.records[1].cycleId, "worktree-agent-277e4476-t2-dev_orch");
  });

  test("listDispatchOutcomes honours the rolling sinceMs window (AC3)", async () => {
    await putDispatchOutcome(record({ cycleId: "worktree-agent-277e4476-t1-dev_orch", recordedAt: 100 }));
    await putDispatchOutcome(record({ cycleId: "worktree-agent-277e4476-t2-dev_orch", recordedAt: 200 }));
    await putDispatchOutcome(record({ cycleId: "worktree-agent-277e4476-t3-dev_orch", recordedAt: 300 }));

    const res = await listDispatchOutcomes({ sinceMs: 200 });
    assert.equal(res.ok, true);
    if (res.ok !== true) return;
    assert.deepEqual(
      res.records.map((r) => r.cycleId),
      ["worktree-agent-277e4476-t3-dev_orch", "worktree-agent-277e4476-t2-dev_orch"],
    );
  });

  test("an index member whose hash expired is skipped, never fabricated", async () => {
    const rec = record();
    await putDispatchOutcome(rec);
    await redis.del(dispatchOutcomeKey(rec.cycleId)); // simulate hash TTL-reaped first

    const res = await listDispatchOutcomes({ sinceMs: 0 });
    assert.equal(res.ok, true);
    if (res.ok !== true) return;
    assert.equal(res.records.length, 0);
  });
});

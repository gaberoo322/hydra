/**
 * Regression tests for the durable GLM A/B assignment log Redis accessor
 * (issue #4125, epic #4123): `getGlmAbAssignment` / `recordGlmAbAssignment`
 * in `src/redis/autopilot.ts`.
 *
 * Mirrors the `src/redis/autopilot.ts — GLM drainer heartbeat liveness`
 * suite's pattern in `test/autopilot-board.test.mts` (#3754): a self-contained
 * Redis lifecycle (one client for the suite, wiped per case) exercising the
 * REAL accessor against a real Redis DB, distinct from the chore-level
 * unit tests in `test/glm-eligibility-sweep.test.mts` (which inject fakes and
 * touch no Redis at all).
 */

import { test, describe, beforeEach, before, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

import {
  getGlmAbAssignment,
  recordGlmAbAssignment,
  GLM_AB_ASSIGNMENT_KEY_PREFIX,
  type GlmAbAssignmentRecord,
} from "../src/redis/autopilot.ts";

// Same REDIS_URL re-assertion pattern as the GLM drainer heartbeat suite: the
// test launcher sets REDIS_URL for DB isolation; re-assert it so the
// accessor's shared connection singleton lands on the same DB this suite's
// own client writes to.
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/1";
process.env.REDIS_URL = REDIS_URL;

function keyFor(issue: number): string {
  return `${GLM_AB_ASSIGNMENT_KEY_PREFIX}${issue}`;
}

describe("src/redis/autopilot.ts — GLM A/B assignment log (issue #4125)", () => {
  let redis: any;
  const issues = [9001, 9002, 9003, 9004, 9005];

  before(() => {
    redis = new Redis(REDIS_URL);
  });
  after(async () => {
    if (redis) {
      await redis.del(...issues.map(keyFor));
      redis.disconnect();
    }
  });
  beforeEach(async () => {
    await redis.del(...issues.map(keyFor));
  });

  test("getGlmAbAssignment: absent key => not already-assigned, reason absent, no record", async () => {
    const lookup = await getGlmAbAssignment(9001);
    assert.equal(lookup.alreadyAssigned, false);
    assert.equal(lookup.reason, "absent");
    assert.equal(lookup.record, null);
  });

  test("recordGlmAbAssignment writes a record getGlmAbAssignment reads back verbatim", async () => {
    const record: GlmAbAssignmentRecord = {
      issue: 9002,
      arm: "control",
      assignedAt: "2026-08-28T00:00:00.000Z",
      sweepRunId: "sweep-abc",
    };
    const res = await recordGlmAbAssignment(record);
    assert.equal(res.ok, true);

    const lookup = await getGlmAbAssignment(9002);
    assert.equal(lookup.alreadyAssigned, true);
    assert.equal(lookup.reason, "found");
    assert.deepEqual(lookup.record, record);
  });

  test("writes the record under the exported key prefix (SCAN-able by a downstream analysis)", async () => {
    const record: GlmAbAssignmentRecord = {
      issue: 9003,
      arm: "treatment",
      assignedAt: "2026-08-28T00:00:00.000Z",
      sweepRunId: "sweep-def",
    };
    await recordGlmAbAssignment(record);
    const raw = await redis.get(`${GLM_AB_ASSIGNMENT_KEY_PREFIX}9003`);
    assert.ok(raw, "expected a value stored under the exported key prefix");
    assert.deepEqual(JSON.parse(raw), record);
  });

  test("getGlmAbAssignment: unparseable value => alreadyAssigned true, reason unreadable (fail-closed)", async () => {
    await redis.set(keyFor(9004), "not-json{{{");
    const lookup = await getGlmAbAssignment(9004);
    assert.equal(lookup.alreadyAssigned, true);
    assert.equal(lookup.reason, "unreadable");
    assert.equal(lookup.record, null);
  });

  test("repeated writes overwrite the previous value (last write wins)", async () => {
    await recordGlmAbAssignment({
      issue: 9005,
      arm: "treatment",
      assignedAt: "2026-08-01T00:00:00.000Z",
      sweepRunId: "sweep-first",
    });
    await recordGlmAbAssignment({
      issue: 9005,
      arm: "control",
      assignedAt: "2026-08-02T00:00:00.000Z",
      sweepRunId: "sweep-second",
    });
    const lookup = await getGlmAbAssignment(9005);
    assert.equal(lookup.record?.arm, "control");
    assert.equal(lookup.record?.sweepRunId, "sweep-second");
  });

  test("the assignment-log key does not expire (no TTL) — a durable analysis record, not a heartbeat", async () => {
    await recordGlmAbAssignment({
      issue: 9001,
      arm: "treatment",
      assignedAt: "2026-08-28T00:00:00.000Z",
      sweepRunId: "sweep-ttl-check",
    });
    const ttl = await redis.ttl(keyFor(9001));
    assert.equal(ttl, -1, "expected no TTL (-1) on the durable assignment record");
  });
});

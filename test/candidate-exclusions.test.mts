/**
 * test/candidate-exclusions.test.mts — Candidate Exclusion telemetry (issue
 * #3964, design decided on wayfinder #3954).
 *
 * `scripts/autopilot/collect-state.sh` re-evaluates the four live Candidate
 * Exclusion predicates (target-scope #2701, in-flight-dev #3711, mechanical
 * #1230, trivial-anchor #1088) against every open `ready-for-agent`
 * orchestrator issue and threads the verdicts into
 * `state.candidate_exclusions`. `decide.py` re-emits one `candidate_exclusion`
 * event per evaluation (identical mechanism to `cascade_routing_blocked`);
 * this seam gives them a durable, anchor+member-KEYED bounded home (updated,
 * not appended — the #3927 amplification pathology) and a pure aggregation
 * lens the metrics surface reads.
 *
 * Three suites:
 *   1. PURE — `candidateExclusionEvaluationFromEvent`, `rollupCandidateExclusions`.
 *      No Redis.
 *   2. REDIS — upsert (anchor, member) round-trip through the bounded ring:
 *      insert, re-fire (turns increment, `first_seen_ts` preserved,
 *      `last_seen_ts`/verdict/evidence updated), and the read-time fold
 *      (real Redis db 2).
 *   3. BRIDGE — `persistCandidateExclusionTelemetry` end-to-end through the
 *      redis seam (same best-effort contract as `persistCascadeTelemetry`).
 *
 * Split into top-level suites so the Redis-backed ones own their own
 * before/after lifecycle (CLAUDE.md: never piggyback a sibling's shared-Redis
 * teardown).
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/2";

// The pure fold lives in the aggregator leaf and is imported directly from
// it — this pure-fold suite pulls in zero Redis surface.
const { rollupCandidateExclusions } = await import("../src/aggregators/candidate-exclusions.ts");
// The I/O seam (event parsing, ring upsert/read) stays in the redis adapter.
const {
  candidateExclusionEvaluationFromEvent,
  recordCandidateExclusion,
  getCandidateExclusionTelemetry,
  clearCandidateExclusionTelemetry,
} = await import("../src/redis/candidate-exclusions.ts");
const { persistCandidateExclusionTelemetry } = await import("../src/autopilot/slot-events-bridge.ts");
const { closeRedisConnections } = await import("../src/redis/connection.ts");

const LEDGER_KEY = "hydra:autopilot:candidate-exclusions:ledger";

// ---------------------------------------------------------------------------
// PURE — no Redis
// ---------------------------------------------------------------------------

describe("candidate-exclusions — candidateExclusionEvaluationFromEvent (pure)", () => {
  test("translates a candidate_exclusion event into an evaluation", () => {
    const ev = candidateExclusionEvaluationFromEvent({
      event: "candidate_exclusion",
      anchor: "issue-3711",
      member: "in-flight-dev-exclusion",
      verdict: "excluded",
      evidence: "pr-body-ref",
      turn_n: "42",
      run_id: "r-1",
      ts_epoch: "1700000200",
    });
    assert.ok(ev);
    assert.equal(ev!.anchor, "issue-3711");
    assert.equal(ev!.member, "in-flight-dev-exclusion");
    assert.equal(ev!.verdict, "excluded");
    assert.equal(ev!.evidence, "pr-body-ref");
    assert.equal(ev!.turnN, 42);
    assert.equal(ev!.runId, "r-1");
    assert.equal(ev!.ts, 1700000200);
  });

  test("a survived verdict carries empty evidence through untouched", () => {
    const ev = candidateExclusionEvaluationFromEvent({
      event: "candidate_exclusion",
      anchor: "issue-1",
      member: "target-scope-exclusion",
      verdict: "survived",
      evidence: "",
      turn_n: "1",
      run_id: "r",
      ts_epoch: "1",
    });
    assert.ok(ev);
    assert.equal(ev!.verdict, "survived");
    assert.equal(ev!.evidence, "");
  });

  test("an unrecognised verdict string defaults to survived (fail toward the non-alarming arm)", () => {
    const ev = candidateExclusionEvaluationFromEvent({
      event: "candidate_exclusion",
      anchor: "issue-1",
      member: "target-scope-exclusion",
      verdict: "garbage",
      evidence: "",
      turn_n: "1",
      run_id: "r",
      ts_epoch: "1",
    });
    assert.ok(ev);
    assert.equal(ev!.verdict, "survived");
  });

  test("returns null for a non-candidate_exclusion event (cheap bridge skip)", () => {
    assert.equal(candidateExclusionEvaluationFromEvent({ event: "subagent_stop", slot: "x" }), null);
    assert.equal(candidateExclusionEvaluationFromEvent({ event: "cascade_routing_blocked" }), null);
    assert.equal(candidateExclusionEvaluationFromEvent(null), null);
    assert.equal(candidateExclusionEvaluationFromEvent(undefined), null);
    assert.equal(candidateExclusionEvaluationFromEvent({}), null);
  });

  test("returns null when anchor or member is missing (malformed event)", () => {
    assert.equal(
      candidateExclusionEvaluationFromEvent({
        event: "candidate_exclusion",
        member: "target-scope-exclusion",
        verdict: "excluded",
      }),
      null,
    );
    assert.equal(
      candidateExclusionEvaluationFromEvent({
        event: "candidate_exclusion",
        anchor: "issue-1",
        verdict: "excluded",
      }),
      null,
    );
  });
});

describe("candidate-exclusions — rollupCandidateExclusions (pure)", () => {
  function rec(
    anchor: string,
    member: string,
    verdict: "excluded" | "survived",
    evidence = "",
  ) {
    return {
      anchor,
      member,
      verdict,
      evidence,
      first_seen_ts: 1,
      last_seen_ts: 1,
      turns: 1,
      run_id: "r",
      turn_n: 1,
    };
  }

  test("empty input yields an empty rollup", () => {
    const r = rollupCandidateExclusions([]);
    assert.equal(r.sampleSize, 0);
    assert.deepEqual(r.byMember, {});
  });

  test("computes considered/excluded/survived + exclusionRate per member independently", () => {
    const r = rollupCandidateExclusions([
      rec("issue-1", "in-flight-dev-exclusion", "excluded", "pr-body-ref"),
      rec("issue-2", "in-flight-dev-exclusion", "excluded", "pr-body-ref"),
      rec("issue-3", "in-flight-dev-exclusion", "survived"),
      rec("issue-1", "target-scope-exclusion", "survived"),
      rec("issue-2", "target-scope-exclusion", "survived"),
      rec("issue-3", "target-scope-exclusion", "survived"),
    ]);
    assert.equal(r.sampleSize, 6);
    assert.deepEqual(r.byMember["in-flight-dev-exclusion"], {
      considered: 3,
      excluded: 2,
      survived: 1,
      exclusionRate: Math.round((2 / 3) * 1000) / 1000,
      byEvidence: { "pr-body-ref": 2 },
    });
    assert.deepEqual(r.byMember["target-scope-exclusion"], {
      considered: 3,
      excluded: 0,
      survived: 3,
      exclusionRate: 0,
      byEvidence: {},
    });
  });

  test("breaks excluded counts down by evidence within one member", () => {
    const r = rollupCandidateExclusions([
      rec("issue-1", "in-flight-dev-exclusion", "excluded", "pr-body-ref"),
      rec("issue-2", "in-flight-dev-exclusion", "excluded", "pr-branch-name"),
      rec("issue-3", "in-flight-dev-exclusion", "excluded", "in-progress-label"),
      rec("issue-4", "in-flight-dev-exclusion", "excluded", "pr-body-ref"),
    ]);
    assert.deepEqual(r.byMember["in-flight-dev-exclusion"].byEvidence, {
      "pr-body-ref": 2,
      "pr-branch-name": 1,
      "in-progress-label": 1,
    });
  });

  test("a malformed record (bad verdict) is skipped, never crashes the fold", () => {
    const r = rollupCandidateExclusions([
      rec("issue-1", "target-scope-exclusion", "excluded", "target-backlog-label"),
      { anchor: "issue-2", member: "target-scope-exclusion", verdict: "maybe" } as any,
    ]);
    assert.equal(r.byMember["target-scope-exclusion"].considered, 1);
  });
});

// ---------------------------------------------------------------------------
// REDIS — upsert round-trip + bridge persist (real Redis db 2). ONE
// top-level suite owning ONE before/after lifecycle (CLAUDE.md: a second
// top-level suite calling `closeRedisConnections()` in its own `after()`
// tears down the shared connection pool out from under a sibling suite that
// runs later — bit exactly this while authoring this file).
// ---------------------------------------------------------------------------

let raw: any;
async function rawRedis() {
  if (!raw) raw = new Redis(process.env.REDIS_URL!);
  return raw;
}

describe("candidate-exclusions — Redis (upsert round-trip + bridge persist)", () => {
  beforeEach(async () => {
    const r = await rawRedis();
    await r.del(LEDGER_KEY);
  });

  after(async () => {
    if (raw) {
      await raw.del(LEDGER_KEY);
      raw.disconnect();
    }
    closeRedisConnections();
  });

  test("a first evaluation inserts a new (anchor, member) row with turns=1", async () => {
    await recordCandidateExclusion({
      anchor: "issue-3711",
      member: "in-flight-dev-exclusion",
      verdict: "excluded",
      evidence: "pr-body-ref",
      runId: "r-1",
      turnN: 1,
      ts: 1000,
    });
    const rollup = await getCandidateExclusionTelemetry();
    assert.equal(rollup.sampleSize, 1);
    assert.equal(rollup.byMember["in-flight-dev-exclusion"].considered, 1);
    assert.equal(rollup.byMember["in-flight-dev-exclusion"].excluded, 1);
  });

  test("a re-fire on the same (anchor, member) UPDATES the row, not appends", async () => {
    await recordCandidateExclusion({
      anchor: "issue-3711",
      member: "in-flight-dev-exclusion",
      verdict: "excluded",
      evidence: "pr-body-ref",
      runId: "r-1",
      turnN: 1,
      ts: 1000,
    });
    await recordCandidateExclusion({
      anchor: "issue-3711",
      member: "in-flight-dev-exclusion",
      verdict: "excluded",
      evidence: "pr-body-ref",
      runId: "r-1",
      turnN: 2,
      ts: 2000,
    });
    await recordCandidateExclusion({
      anchor: "issue-3711",
      member: "in-flight-dev-exclusion",
      verdict: "excluded",
      evidence: "pr-body-ref",
      runId: "r-1",
      turnN: 3,
      ts: 3000,
    });
    const r = await rawRedis();
    assert.equal(await r.llen(LEDGER_KEY), 1); // ONE row, not three appended entries.

    const rollup = await getCandidateExclusionTelemetry();
    assert.equal(rollup.sampleSize, 1);
    assert.equal(rollup.byMember["in-flight-dev-exclusion"].considered, 1);
    assert.equal(rollup.byMember["in-flight-dev-exclusion"].excluded, 1);
  });

  test("re-fire preserves first_seen_ts, bumps turns, and updates the verdict/evidence to the latest", async () => {
    await recordCandidateExclusion({
      anchor: "issue-42",
      member: "trivial-anchor-exclusion",
      verdict: "excluded",
      evidence: "expected-tier-t1",
      runId: "r-1",
      turnN: 1,
      ts: 1000,
    });
    await recordCandidateExclusion({
      anchor: "issue-42",
      member: "trivial-anchor-exclusion",
      verdict: "survived", // the needs-design-concept label got added mid-flight
      evidence: "",
      runId: "r-1",
      turnN: 2,
      ts: 2000,
    });
    const ledger = await rawRedis();
    const raws = await ledger.lrange(LEDGER_KEY, 0, -1);
    assert.equal(raws.length, 1);
    const stored = JSON.parse(raws[0]);
    assert.equal(stored.first_seen_ts, 1000); // unchanged — still the ORIGINAL sighting.
    assert.equal(stored.last_seen_ts, 2000); // bumped to the latest evaluation.
    assert.equal(stored.turns, 2); // amplification factor incremented.
    assert.equal(stored.verdict, "survived"); // latest verdict wins.
    assert.equal(stored.evidence, "");
  });

  test("distinct (anchor, member) pairs for the SAME anchor are independent rows", async () => {
    await recordCandidateExclusion({
      anchor: "issue-7",
      member: "in-flight-dev-exclusion",
      verdict: "survived",
      evidence: "",
      runId: "r",
      turnN: 1,
      ts: 1,
    });
    await recordCandidateExclusion({
      anchor: "issue-7",
      member: "target-scope-exclusion",
      verdict: "excluded",
      evidence: "target-backlog-label",
      runId: "r",
      turnN: 1,
      ts: 1,
    });
    const r = await rawRedis();
    assert.equal(await r.llen(LEDGER_KEY), 2);
    const rollup = await getCandidateExclusionTelemetry();
    assert.equal(rollup.byMember["in-flight-dev-exclusion"].survived, 1);
    assert.equal(rollup.byMember["target-scope-exclusion"].excluded, 1);
  });

  test("clearCandidateExclusionTelemetry empties the ring", async () => {
    await recordCandidateExclusion({
      anchor: "issue-1",
      member: "mechanical-exclusion",
      verdict: "excluded",
      evidence: "cleanup-scan-label",
      runId: "r",
      turnN: 1,
      ts: 1,
    });
    await clearCandidateExclusionTelemetry();
    const rollup = await getCandidateExclusionTelemetry();
    assert.equal(rollup.sampleSize, 0);
  });

  // --- BRIDGE — persistCandidateExclusionTelemetry end-to-end, same suite/lifecycle ---

  test("persists a raw slot-events candidate_exclusion payload into the ring", async () => {
    await persistCandidateExclusionTelemetry({
      event: "candidate_exclusion",
      anchor: "issue-2701",
      member: "target-scope-exclusion",
      verdict: "excluded",
      evidence: "target-backlog-label",
      turn_n: "5",
      run_id: "run-a",
      ts_epoch: "500",
    });
    const rollup = await getCandidateExclusionTelemetry();
    assert.equal(rollup.byMember["target-scope-exclusion"].excluded, 1);
  });

  test("a non-candidate_exclusion event is a silent no-op (never throws)", async () => {
    await assert.doesNotReject(() => persistCandidateExclusionTelemetry({ event: "subagent_stop" }));
    const rollup = await getCandidateExclusionTelemetry();
    assert.equal(rollup.sampleSize, 0);
  });

  test("a malformed payload never throws (best-effort contract)", async () => {
    await assert.doesNotReject(() => persistCandidateExclusionTelemetry(null));
    await assert.doesNotReject(() => persistCandidateExclusionTelemetry(undefined));
    await assert.doesNotReject(() => persistCandidateExclusionTelemetry("not-an-object"));
  });
});

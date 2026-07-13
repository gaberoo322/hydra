/**
 * test/cascade-telemetry.test.mts — cascade-routing telemetry seam (issue #3284).
 *
 * PR #3274 shipped cascade-routing escalation blind: nothing measured whether
 * cascading triggered, how often the usage gate throttled it, or what cost delta
 * it delivered. decide.py now emits `cascade_routing_escalation` /
 * `cascade_routing_blocked` events; this seam gives them a durable bounded home
 * (the escalation/block COUNTS) and a pure aggregation lens the
 * `/metrics/cascade-routing` card reads.
 *
 * The token COST-DELTA + post-escalation MERGE RATE do NOT come from a static
 * per-model estimate (design-concept invariant 7 rejects that): they are folded
 * from the escalated dispatches' ACTUAL recorded tokens + terminal outcomes on
 * the durable per-dispatch outcome plane (`DispatchOutcomeRecord`, #2942). The
 * `rollupEscalationOutcomes` lens does that fold.
 *
 * Two suites:
 *   1. PURE — `cascadeRecordFromEvent`, `rollupCascadeTelemetry`, and
 *      `rollupEscalationOutcomes`. No Redis.
 *   2. REDIS — record/read round-trip over the bounded ring + a live
 *      escalation-tagged outcome record joined into the rollup (real Redis db 2).
 *
 * Split into two TOP-LEVEL suites so the Redis suite owns its own before/after
 * lifecycle (CLAUDE.md: never piggyback a sibling's shared-Redis teardown).
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/2";

const {
  cascadeRecordFromEvent,
  rollupCascadeTelemetry,
  rollupEscalationOutcomes,
  recordCascade,
  getCascadeTelemetry,
  clearCascadeTelemetry,
} = await import("../src/redis/cascade-telemetry.ts");
const { putDispatchOutcome, dispatchOutcomesIndexKey, dispatchOutcomeKey } = await import(
  "../src/redis/dispatch-outcomes.ts"
);
const { closeRedisConnections } = await import("../src/redis/connection.ts");

const LEDGER_KEY = "hydra:autopilot:cascade-telemetry:ledger";

// A helper to build a minimal DispatchOutcomeRecord for the outcome-fold tests.
function outcome(
  overrides: Partial<{
    cycleId: string;
    outcome: string;
    tokens: number | null;
    escalationAttempt: number | null;
    escalatedModel: string | null;
  }> = {},
) {
  return {
    cycleId: overrides.cycleId ?? "c",
    runIdPrefix: null,
    turn: null,
    className: "cleanup_orch",
    skill: null,
    outcome: overrides.outcome ?? "completed",
    tokens: overrides.tokens ?? null,
    durationMs: null,
    escalationAttempt:
      overrides.escalationAttempt === undefined ? 2 : overrides.escalationAttempt,
    escalatedModel: overrides.escalatedModel === undefined ? "sonnet" : overrides.escalatedModel,
    recordedAt: 1_000,
  };
}

// ---------------------------------------------------------------------------
// PURE — no Redis
// ---------------------------------------------------------------------------

describe("cascade-telemetry — cascadeRecordFromEvent (pure)", () => {
  test("translates a cascade_routing_escalation event into an escalation record", () => {
    const rec = cascadeRecordFromEvent({
      event: "cascade_routing_escalation",
      class: "cleanup_orch",
      trigger_reason: "subagent_noop",
      from_model: "haiku",
      to_model: "sonnet",
      attempt: "2",
      ts_epoch: "1700000200",
      run_id: "abc",
    });
    assert.ok(rec);
    assert.equal(rec!.kind, "escalation");
    assert.equal(rec!.cls, "cleanup_orch");
    assert.equal(rec!.triggerReason, "subagent_noop");
    assert.equal(rec!.fromModel, "haiku");
    assert.equal(rec!.toModel, "sonnet");
    assert.equal(rec!.attempt, 2);
    assert.equal(rec!.ts, 1700000200);
    assert.equal(rec!.runId, "abc");
  });

  test("translates a cascade_routing_blocked event into a blocked record", () => {
    const rec = cascadeRecordFromEvent({
      event: "cascade_routing_blocked",
      class: "cleanup_orch",
      trigger_reason: "subagent_failure",
      to_model: "sonnet",
      block_reason: "usage_dispatch_blocked",
      ts_epoch: "1700000300",
      run_id: "abc",
    });
    assert.ok(rec);
    assert.equal(rec!.kind, "blocked");
    assert.equal(rec!.cls, "cleanup_orch");
    assert.equal(rec!.triggerReason, "subagent_failure");
    assert.equal(rec!.toModel, "sonnet");
    assert.equal(rec!.blockReason, "usage_dispatch_blocked");
    assert.equal(rec!.attempt, 0);
    assert.equal(rec!.fromModel, "");
  });

  test("returns null for a non-cascade event (cheap bridge skip)", () => {
    assert.equal(cascadeRecordFromEvent({ event: "subagent_stop", slot: "x" }), null);
    assert.equal(cascadeRecordFromEvent({ event: "turn_end" }), null);
    assert.equal(cascadeRecordFromEvent(null), null);
    assert.equal(cascadeRecordFromEvent(undefined), null);
    assert.equal(cascadeRecordFromEvent({}), null);
  });
});

describe("cascade-telemetry — rollupCascadeTelemetry (pure)", () => {
  function esc(cls: string, trigger: string, from = "haiku", to = "sonnet") {
    return {
      kind: "escalation" as const,
      cls,
      triggerReason: trigger,
      fromModel: from,
      toModel: to,
      attempt: 2,
      blockReason: "",
      ts: 1,
      runId: "r",
    };
  }
  function blk(cls: string, trigger: string) {
    return {
      kind: "blocked" as const,
      cls,
      triggerReason: trigger,
      fromModel: "",
      toModel: "sonnet",
      attempt: 0,
      blockReason: "usage_dispatch_blocked",
      ts: 1,
      runId: "r",
    };
  }

  test("empty input yields all-zero rollup with 0 (never NaN) rates", () => {
    const r = rollupCascadeTelemetry([]);
    assert.equal(r.sampleSize, 0);
    assert.equal(r.escalations, 0);
    assert.equal(r.blocked, 0);
    assert.equal(r.gateBlockRate, 0);
    // Cost/merge fields default to the empty outcome fold (invariants 7 + 8).
    assert.equal(r.costDeltaTokens, 0);
    assert.equal(r.measuredEscalations, 0);
    assert.equal(r.avgCostDeltaPerEscalation, 0);
    assert.equal(r.postEscalationMergeRate, 0);
    assert.equal(r.terminalEscalations, 0);
    assert.deepEqual(r.byClass, {});
    assert.deepEqual(r.byTrigger, {});
  });

  test("counts escalations + blocks and derives the gate-block rate", () => {
    const r = rollupCascadeTelemetry([
      esc("cleanup_orch", "subagent_noop"),
      esc("cleanup_orch", "subagent_failure"),
      esc("cleanup_orch", "subagent_noop"),
      blk("cleanup_orch", "subagent_noop"),
    ]);
    assert.equal(r.escalations, 3);
    assert.equal(r.blocked, 1);
    // blocked / (escalations + blocked) = 1/4 = 0.25.
    assert.equal(r.gateBlockRate, 0.25);
    assert.equal(r.byClass.cleanup_orch.escalations, 3);
    assert.equal(r.byClass.cleanup_orch.blocked, 1);
    assert.equal(r.byTrigger.subagent_noop, 2);
    assert.equal(r.byTrigger.subagent_failure, 1);
  });

  test("the count-fold NEVER re-estimates a cost delta — cost fields come only from the outcome fold", () => {
    // Invariant 7: rollupCascadeTelemetry over ONLY decision-time records must
    // report a zero cost delta (no static per-model estimator). The cost is
    // supplied separately by the outcome fold; absent it, the answer is 0.
    const r = rollupCascadeTelemetry([
      esc("cleanup_orch", "subagent_noop"),
      esc("cleanup_orch", "subagent_noop"),
      blk("cleanup_orch", "subagent_noop"),
    ]);
    assert.equal(r.costDeltaTokens, 0);
    assert.equal(r.avgCostDeltaPerEscalation, 0);
    assert.equal(r.measuredEscalations, 0);
  });

  test("mixes in a supplied outcome fold (actual-token cost + merge rate)", () => {
    const fold = rollupEscalationOutcomes([
      outcome({ tokens: 100, outcome: "merged" }),
      outcome({ tokens: 300, outcome: "failed" }),
    ]);
    const r = rollupCascadeTelemetry([esc("cleanup_orch", "subagent_noop")], fold);
    assert.equal(r.costDeltaTokens, 400);
    assert.equal(r.measuredEscalations, 2);
    assert.equal(r.avgCostDeltaPerEscalation, 200);
    // 1 merged of 2 terminal → 0.5.
    assert.equal(r.postEscalationMergeRate, 0.5);
    assert.equal(r.terminalEscalations, 2);
  });

  test("gate-block rate is 0 (not NaN) when there are only escalations", () => {
    const r = rollupCascadeTelemetry([esc("cleanup_orch", "subagent_noop")]);
    assert.equal(r.gateBlockRate, 0);
  });
});

describe("cascade-telemetry — rollupEscalationOutcomes (pure, invariants 7 + 8)", () => {
  test("only escalation-tagged records participate; plain dispatches are ignored", () => {
    const fold = rollupEscalationOutcomes([
      outcome({ tokens: 500, outcome: "merged" }),
      // Not an escalation (escalationAttempt null) → ignored entirely.
      outcome({ tokens: 9999, outcome: "merged", escalationAttempt: null }),
    ]);
    assert.equal(fold.costDeltaTokens, 500);
    assert.equal(fold.measuredEscalations, 1);
    assert.equal(fold.terminalEscalations, 1);
    assert.equal(fold.postEscalationMergeRate, 1);
  });

  test("cost-delta sums ACTUAL recorded tokens; null-tokens records are truthful unknowns", () => {
    const fold = rollupEscalationOutcomes([
      outcome({ tokens: 200, outcome: "merged" }),
      // Escalated but tokens unknown → does NOT contribute a fabricated 0.
      outcome({ tokens: null, outcome: "merged" }),
    ]);
    assert.equal(fold.costDeltaTokens, 200);
    assert.equal(fold.measuredEscalations, 1); // only the record with a known figure
    assert.equal(fold.avgCostDeltaPerEscalation, 200);
    // Both are terminal + merged, so the merge rate counts both.
    assert.equal(fold.terminalEscalations, 2);
    assert.equal(fold.postEscalationMergeRate, 1);
  });

  test("post-escalation merge rate excludes in-flight escalations from the denominator", () => {
    const fold = rollupEscalationOutcomes([
      outcome({ tokens: 100, outcome: "merged" }),
      outcome({ tokens: 100, outcome: "failed" }),
      // An in-flight escalation (status neither merged nor failed) — excluded
      // from the terminal denominator so it never dilutes the rate.
      outcome({ tokens: 100, outcome: "in-progress" }),
    ]);
    assert.equal(fold.terminalEscalations, 2);
    assert.equal(fold.postEscalationMergeRate, 0.5);
    // But its tokens still count toward the measured cost delta.
    assert.equal(fold.costDeltaTokens, 300);
    assert.equal(fold.measuredEscalations, 3);
  });

  test("empty / no-escalation input yields a zero fold (never NaN)", () => {
    assert.deepEqual(rollupEscalationOutcomes([]), {
      costDeltaTokens: 0,
      measuredEscalations: 0,
      avgCostDeltaPerEscalation: 0,
      postEscalationMergeRate: 0,
      terminalEscalations: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// REDIS — record/read round-trip (real Redis db 2)
// ---------------------------------------------------------------------------

let raw: any;
async function rawRedis() {
  if (!raw) raw = new Redis(process.env.REDIS_URL!);
  return raw;
}

describe("cascade-telemetry — record/read round-trip (Redis)", () => {
  const OUTCOME_CID = "worktree-agent-deadbeef-t3-cleanup_orch";

  beforeEach(async () => {
    const r = await rawRedis();
    await r.del(LEDGER_KEY);
    await r.del(dispatchOutcomesIndexKey());
    await r.del(dispatchOutcomeKey(OUTCOME_CID));
  });

  after(async () => {
    if (raw) {
      await raw.del(LEDGER_KEY);
      await raw.del(dispatchOutcomesIndexKey());
      await raw.del(dispatchOutcomeKey(OUTCOME_CID));
      raw.disconnect();
    }
    closeRedisConnections();
  });

  test("recorded events round-trip through the ring into a correct count rollup", async () => {
    await recordCascade(
      cascadeRecordFromEvent({
        event: "cascade_routing_escalation",
        class: "cleanup_orch",
        trigger_reason: "subagent_noop",
        from_model: "haiku",
        to_model: "sonnet",
        attempt: "2",
        ts_epoch: "100",
        run_id: "r",
      })!,
    );
    await recordCascade(
      cascadeRecordFromEvent({
        event: "cascade_routing_blocked",
        class: "cleanup_orch",
        trigger_reason: "subagent_noop",
        to_model: "sonnet",
        block_reason: "usage_dispatch_blocked",
        ts_epoch: "101",
        run_id: "r",
      })!,
    );

    const rollup = await getCascadeTelemetry();
    assert.equal(rollup.escalations, 1);
    assert.equal(rollup.blocked, 1);
    assert.equal(rollup.gateBlockRate, 0.5);
    assert.equal(rollup.byClass.cleanup_orch.escalations, 1);
    assert.equal(rollup.byClass.cleanup_orch.blocked, 1);
    // No escalated OUTCOME record written yet → the cost/merge arm reads 0
    // (the outcome plane lags the decision-time count). Invariant 7: no
    // fabricated estimate.
    assert.equal(rollup.costDeltaTokens, 0);
    assert.equal(rollup.postEscalationMergeRate, 0);
  });

  test("joins a live escalation-tagged outcome record into the cost + merge fold", async () => {
    // A realised escalation event in the ring (the decision-time count) ...
    await recordCascade(
      cascadeRecordFromEvent({
        event: "cascade_routing_escalation",
        class: "cleanup_orch",
        trigger_reason: "subagent_noop",
        from_model: "haiku",
        to_model: "sonnet",
        attempt: "2",
        ts_epoch: "100",
        run_id: "deadbeef",
      })!,
    );
    // ... and the escalated dispatch's ACTUAL outcome record with real tokens
    // + a merged terminal outcome (the #2942 token plane, invariant 7 + 8).
    const put = await putDispatchOutcome({
      cycleId: OUTCOME_CID,
      runIdPrefix: "deadbeef",
      turn: 3,
      className: "cleanup_orch",
      skill: "hydra-dev",
      outcome: "merged",
      tokens: 12345,
      durationMs: null,
      escalationAttempt: 2,
      escalatedModel: "sonnet",
      recordedAt: Date.now(),
    });
    assert.equal(put.ok, true);

    const rollup = await getCascadeTelemetry();
    assert.equal(rollup.escalations, 1);
    // Cost-delta is the ACTUAL recorded tokens, not a per-model estimate.
    assert.equal(rollup.costDeltaTokens, 12345);
    assert.equal(rollup.measuredEscalations, 1);
    assert.equal(rollup.avgCostDeltaPerEscalation, 12345);
    // 1 merged of 1 terminal escalation → 100% post-escalation merge rate.
    assert.equal(rollup.postEscalationMergeRate, 1);
    assert.equal(rollup.terminalEscalations, 1);
  });

  test("clear empties the ring", async () => {
    await recordCascade({
      kind: "escalation",
      cls: "cleanup_orch",
      triggerReason: "subagent_noop",
      fromModel: "haiku",
      toModel: "sonnet",
      attempt: 2,
      blockReason: "",
      ts: 1,
      runId: "r",
    });
    await clearCascadeTelemetry();
    const rollup = await getCascadeTelemetry();
    assert.equal(rollup.sampleSize, 0);
    assert.equal(rollup.escalations, 0);
  });
});

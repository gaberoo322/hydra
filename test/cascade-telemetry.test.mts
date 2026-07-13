/**
 * test/cascade-telemetry.test.mts — cascade-routing telemetry seam (issue #3284).
 *
 * PR #3274 shipped cascade-routing escalation blind: nothing measured whether
 * cascading triggered, how often the usage gate throttled it, or what cost delta
 * it delivered. decide.py now emits `cascade_routing_escalation` /
 * `cascade_routing_blocked` events; this seam gives them a durable bounded home
 * and a pure aggregation lens the `/metrics/cascade-routing` card reads.
 *
 * Two suites:
 *   1. PURE — `cascadeRecordFromEvent` (event → record translation) and
 *      `rollupCascadeTelemetry` (records → rollup). No Redis.
 *   2. REDIS — record/read round-trip over the bounded ring (real Redis db 2).
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
  modelTierTokens,
  recordCascade,
  getCascadeTelemetry,
  clearCascadeTelemetry,
} = await import("../src/redis/cascade-telemetry.ts");
const { closeRedisConnections } = await import("../src/redis/connection.ts");

const LEDGER_KEY = "hydra:autopilot:cascade-telemetry:ledger";

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

  test("modelTierTokens maps known tiers and returns 0 for unknown (honest unknown)", () => {
    assert.ok(modelTierTokens("sonnet") > modelTierTokens("haiku"));
    assert.ok(modelTierTokens("opus") > modelTierTokens("sonnet"));
    assert.equal(modelTierTokens("gpt-9"), 0);
    assert.equal(modelTierTokens(null), 0);
    assert.equal(modelTierTokens(undefined), 0);
    // Case-insensitive.
    assert.equal(modelTierTokens("Sonnet"), modelTierTokens("sonnet"));
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
    assert.equal(r.estimatedCostDelta, 0);
    assert.equal(r.avgCostDeltaPerEscalation, 0);
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

  test("estimated cost delta sums strong-minus-cheap over escalations only", () => {
    const delta = modelTierTokens("sonnet") - modelTierTokens("haiku");
    const r = rollupCascadeTelemetry([
      esc("cleanup_orch", "subagent_noop"),
      esc("cleanup_orch", "subagent_noop"),
      // A block contributes to the count but NOT to the cost delta (nothing ran).
      blk("cleanup_orch", "subagent_noop"),
    ]);
    assert.equal(r.estimatedCostDelta, 2 * delta);
    assert.equal(r.avgCostDeltaPerEscalation, delta);
  });

  test("gate-block rate is 0 (not NaN) when there are only escalations", () => {
    const r = rollupCascadeTelemetry([esc("cleanup_orch", "subagent_noop")]);
    assert.equal(r.gateBlockRate, 0);
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

  test("recorded events round-trip through the ring into a correct rollup", async () => {
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
    assert.ok(rollup.estimatedCostDelta > 0);
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

/**
 * test/slot-events-bridge.test.mts — covers bridgeBroadcast translation.
 *
 * Slice 4 of /now-pixel (#642, #646). The bridge consumes from
 * `hydra:autopilot:slot-events` and re-broadcasts over WS. The Redis
 * round-trip is exercised by the broader integration in production; here
 * we pin the pure shape-translation contract via a mock eventBus.
 *
 * The contract: every field on the raw stream event becomes a string under
 * the envelope's `payload`, and the envelope ships under the WS stream
 * `autopilot:slot-events` so the dashboard hook can route on it.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/2";
import {
  bridgeBroadcast,
  persistCascadeTelemetry,
} from "../src/autopilot/slot-events-bridge.ts";
import { getCascadeTelemetry } from "../src/redis/cascade-telemetry.ts";
import { closeRedisConnections } from "../src/redis/connection.ts";

// A recording WsBroadcastRegistry stub (issue #1965): bridgeBroadcast now
// targets the named registry surface (`.broadcast`) instead of reaching the
// bus's former private `_broadcastToClients`. The destructured field stays
// named `bus` so the per-test call sites are unchanged.
function makeMockBus() {
  const calls: Array<{ stream: string; event: unknown }> = [];
  return {
    bus: {
      broadcast: (stream: string, event: unknown) => {
        calls.push({ stream, event });
      },
    },
    calls,
  };
}

test("bridgeBroadcast: subagent_stop success event → WS envelope under autopilot:slot-events", () => {
  const { bus, calls } = makeMockBus();
  // _parseFields hoists payload-as-JSON; for slot-events there's no
  // structured payload, just flat field/value pairs.
  const raw = {
    event: "subagent_stop",
    slot: "dev_orch",
    status: "success",
    task_id: "acee0055abbf856cb",
    subagent_type: "hydra-dev",
    summary: "PR #650 opened",
    ts_epoch: "1779907573",
  };
  const env = bridgeBroadcast(bus as any, raw);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].stream, "autopilot:slot-events");
  assert.equal(env.type, "slot-event");
  assert.equal(env.payload.event, "subagent_stop");
  assert.equal(env.payload.slot, "dev_orch");
  assert.equal(env.payload.status, "success");
  assert.equal(env.payload.subagent_type, "hydra-dev");
});

test("bridgeBroadcast: slot_waiting_permission event preserves all fields verbatim", () => {
  const { bus, calls } = makeMockBus();
  const raw = {
    event: "slot_waiting_permission",
    slot: "dev_target",
    task_id: "ad690170483aac21a",
    subagent_type: "hydra-target-build",
    ts_epoch: "1779907800",
    tool: "Write",
  };
  const env = bridgeBroadcast(bus as any, raw);
  assert.equal(calls[0].stream, "autopilot:slot-events");
  assert.equal(env.payload.event, "slot_waiting_permission");
  assert.equal(env.payload.slot, "dev_target");
  assert.equal(env.payload.tool, "Write");
});

test("bridgeBroadcast: failure event under subagent_stop status=failure is forwarded for the Hurt animation", () => {
  const { bus, calls } = makeMockBus();
  const raw = {
    event: "subagent_stop",
    slot: "qa_target",
    status: "failure",
    task_id: "af08fe1f4d7e2b47b",
    subagent_type: "hydra-qa",
    summary: "Could not approve own PR",
    ts_epoch: "1779907900",
  };
  bridgeBroadcast(bus as any, raw);
  assert.equal(calls[0].stream, "autopilot:slot-events");
  const env = calls[0].event as { payload: Record<string, string> };
  assert.equal(env.payload.status, "failure");
});

test("bridgeBroadcast: drops non-string field values (Redis stream sometimes returns Buffers) but keeps everything stringly typed", () => {
  const { bus, calls } = makeMockBus();
  // pngjs / ioredis can hand us Buffer values in some configurations;
  // bridgeBroadcast only forwards strings + numbers. This guards against
  // a malformed payload nuking the broadcast.
  const raw: any = {
    event: "subagent_stop",
    slot: "dev_orch",
    bin: Buffer.from([0xff, 0xfe]),
    weird: { nested: "object" },
    nums: 42,
  };
  bridgeBroadcast(bus as any, raw);
  const env = calls[0].event as { payload: Record<string, string> };
  assert.equal(env.payload.event, "subagent_stop");
  assert.equal(env.payload.slot, "dev_orch");
  assert.equal(env.payload.nums, "42");
  // Buffer + nested object are not strings/numbers — silently skipped.
  assert.equal(env.payload.bin, undefined);
  assert.equal(env.payload.weird, undefined);
});

test("bridgeBroadcast: subagent_tool_call (issue #671) round-trips category/tool/target verbatim", () => {
  const { bus, calls } = makeMockBus();
  // The PostToolUse hook XADDs `event=subagent_tool_call` with category/
  // tool/target. The bridge MUST forward all of these so the dashboard can
  // route on `category` (milestone/io/background) for the per-tool sprite
  // animations introduced alongside slice 4 of /now-pixel.
  const raw = {
    event: "subagent_tool_call",
    slot: "dev_orch",
    task_id: "b910a44aa1b65ff7d",
    tool: "Write",
    category: "milestone",
    target: "/home/gabe/hydra/src/foo.ts",
    duration_ms: "42",
    success: "true",
    ts_epoch: "1779908100",
  };
  const env = bridgeBroadcast(bus as any, raw);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].stream, "autopilot:slot-events");
  assert.equal(env.payload.event, "subagent_tool_call");
  assert.equal(env.payload.tool, "Write");
  assert.equal(env.payload.category, "milestone");
  assert.equal(env.payload.target, "/home/gabe/hydra/src/foo.ts");
  assert.equal(env.payload.slot, "dev_orch");
  assert.equal(env.payload.duration_ms, "42");
  assert.equal(env.payload.success, "true");
});

test("bridgeBroadcast: subagent_tool_call background category still broadcasts (covers Read/Grep/Glob)", () => {
  const { bus, calls } = makeMockBus();
  const raw = {
    event: "subagent_tool_call",
    slot: "qa_orch",
    tool: "Read",
    category: "background",
    target: "/home/gabe/hydra/CLAUDE.md",
    ts_epoch: "1779908200",
  };
  bridgeBroadcast(bus as any, raw);
  const env = calls[0].event as { payload: Record<string, string> };
  assert.equal(env.payload.category, "background");
  assert.equal(env.payload.tool, "Read");
});

test("bridgeBroadcast: empty / null fields produce an empty payload but still broadcast (sentinel)", () => {
  const { bus, calls } = makeMockBus();
  bridgeBroadcast(bus as any, {});
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].event, {
    type: "slot-event",
    id: "",
    timestamp: (calls[0].event as any).timestamp,
    payload: {},
  });
});

// ---------------------------------------------------------------------------
// Slice A of autopilot observability epic (issue #668, parent #667)
//
// decide.py now emits three new event types on the same
// `hydra:autopilot:slot-events` Redis stream alongside the bash-hook
// events. The bridge is field-agnostic — every string/number on the
// raw event becomes a string under `payload` — so the new
// discriminators MUST round-trip without any bridge code changes. These
// tests pin that round-trip contract.
// ---------------------------------------------------------------------------

test("bridgeBroadcast: turn_start event round-trips under autopilot:slot-events (#668)", () => {
  const { bus, calls } = makeMockBus();
  const raw = {
    event: "turn_start",
    turn_n: "7",
    epoch: "1700000000",
    run_id: "abcd1234-deadbeef",
    ts_epoch: "1700000123",
  };
  const env = bridgeBroadcast(bus as any, raw);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].stream, "autopilot:slot-events");
  assert.equal(env.type, "slot-event");
  assert.equal(env.payload.event, "turn_start");
  assert.equal(env.payload.turn_n, "7");
  assert.equal(env.payload.run_id, "abcd1234-deadbeef");
  assert.equal(env.payload.epoch, "1700000000");
  assert.equal(env.payload.ts_epoch, "1700000123");
});

test("bridgeBroadcast: turn_end event round-trips with dispatches/skipped/idle/tokens_after (#668)", () => {
  const { bus, calls } = makeMockBus();
  const raw = {
    event: "turn_end",
    turn_n: "7",
    epoch: "1700000000",
    run_id: "abcd1234-deadbeef",
    dispatches: "2",
    skipped: "11",
    idle: "0",
    tokens_after: "54321",
    ts_epoch: "1700000456",
  };
  const env = bridgeBroadcast(bus as any, raw);
  assert.equal(calls[0].stream, "autopilot:slot-events");
  assert.equal(env.payload.event, "turn_end");
  assert.equal(env.payload.dispatches, "2");
  assert.equal(env.payload.skipped, "11");
  assert.equal(env.payload.idle, "0");
  assert.equal(env.payload.tokens_after, "54321");
  assert.equal(env.payload.run_id, "abcd1234-deadbeef");
});

test("bridgeBroadcast: dispatch_decision event round-trips with class/outcome/reason (#668)", () => {
  const { bus, calls } = makeMockBus();
  const raw = {
    event: "dispatch_decision",
    turn_n: "7",
    class: "dev_orch",
    outcome: "cooldown",
    reason: "slot busy",
    ts_epoch: "1700000789",
  };
  const env = bridgeBroadcast(bus as any, raw);
  assert.equal(calls[0].stream, "autopilot:slot-events");
  assert.equal(env.payload.event, "dispatch_decision");
  assert.equal(env.payload.class, "dev_orch");
  assert.equal(env.payload.outcome, "cooldown");
  assert.equal(env.payload.reason, "slot busy");
  assert.equal(env.payload.turn_n, "7");
});

test("bridgeBroadcast: dispatch_decision with outcome=dispatched + outcome=idle both forwarded (#668)", () => {
  // Sanity-check the four valid outcome enum values all flow through.
  for (const outcome of ["dispatched", "cooldown", "budget", "idle"]) {
    const { bus, calls } = makeMockBus();
    const raw = {
      event: "dispatch_decision",
      turn_n: "1",
      class: "qa_orch",
      outcome,
      reason: `test-${outcome}`,
      ts_epoch: "1700000000",
    };
    bridgeBroadcast(bus as any, raw);
    assert.equal(calls[0].stream, "autopilot:slot-events");
    const env = calls[0].event as { payload: Record<string, string> };
    assert.equal(env.payload.outcome, outcome, `outcome=${outcome} should round-trip verbatim`);
  }
});

// ---------------------------------------------------------------------------
// Cascade-routing telemetry events (issue #3284)
//
// decide.py emits `cascade_routing_escalation` / `cascade_routing_blocked` on
// the same slot-events stream; the field-agnostic bridge forwards them verbatim
// (round-trip below), AND `persistCascadeTelemetry` records them into the
// durable ring for the metrics card (Redis round-trip below).
// ---------------------------------------------------------------------------

test("bridgeBroadcast: cascade_routing_escalation round-trips verbatim (#3284)", () => {
  const { bus, calls } = makeMockBus();
  const raw = {
    event: "cascade_routing_escalation",
    turn_n: "4",
    run_id: "abcd1234",
    class: "cleanup_orch",
    attempt: "2",
    trigger_reason: "subagent_noop",
    from_model: "haiku",
    to_model: "sonnet",
    ts_epoch: "1700000200",
  };
  const env = bridgeBroadcast(bus as any, raw);
  assert.equal(calls[0].stream, "autopilot:slot-events");
  assert.equal(env.payload.event, "cascade_routing_escalation");
  assert.equal(env.payload.class, "cleanup_orch");
  assert.equal(env.payload.trigger_reason, "subagent_noop");
  assert.equal(env.payload.from_model, "haiku");
  assert.equal(env.payload.to_model, "sonnet");
  assert.equal(env.payload.attempt, "2");
});

test("bridgeBroadcast: cascade_routing_blocked round-trips verbatim (#3284)", () => {
  const { bus, calls } = makeMockBus();
  const raw = {
    event: "cascade_routing_blocked",
    turn_n: "5",
    run_id: "abcd1234",
    class: "cleanup_orch",
    trigger_reason: "subagent_noop",
    to_model: "sonnet",
    block_reason: "usage_dispatch_blocked",
    ts_epoch: "1700000200",
  };
  const env = bridgeBroadcast(bus as any, raw);
  assert.equal(env.payload.event, "cascade_routing_blocked");
  assert.equal(env.payload.block_reason, "usage_dispatch_blocked");
  assert.equal(env.payload.to_model, "sonnet");
});

describe("persistCascadeTelemetry — durable ring side-effect (issue #3284, Redis)", () => {
  const LEDGER_KEY = "hydra:autopilot:cascade-telemetry:ledger";
  let raw: any;

  async function rawRedis() {
    if (!raw) raw = new Redis(process.env.REDIS_URL!);
    return raw;
  }

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

  test("records a cascade event into the ring", async () => {
    await persistCascadeTelemetry({
      event: "cascade_routing_escalation",
      class: "cleanup_orch",
      trigger_reason: "subagent_noop",
      from_model: "haiku",
      to_model: "sonnet",
      attempt: "2",
      ts_epoch: "100",
      run_id: "r",
    });
    const rollup = await getCascadeTelemetry();
    assert.equal(rollup.escalations, 1);
    assert.equal(rollup.byClass.cleanup_orch.escalations, 1);
  });

  test("a non-cascade event is a no-op (ring stays empty)", async () => {
    await persistCascadeTelemetry({ event: "subagent_stop", slot: "dev_orch" });
    const rollup = await getCascadeTelemetry();
    assert.equal(rollup.sampleSize, 0);
  });
});

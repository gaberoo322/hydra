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

import { test } from "node:test";
import assert from "node:assert/strict";
import { bridgeBroadcast } from "../src/autopilot/slot-events-bridge.ts";

function makeMockBus() {
  const calls: Array<{ stream: string; event: unknown }> = [];
  return {
    bus: {
      _broadcastToClients: (stream: string, event: unknown) => {
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

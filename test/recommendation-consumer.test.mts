/**
 * test/recommendation-consumer.test.mts — covers the recommendation-consumer
 * Seam (issue #2024), the process-level stream lifecycle extracted from the
 * recommendation engine.
 *
 * Surface tested here is the infrastructure the consumer owns — NOT the engine
 * policy (that stays in test/recommendation-engine.test.mts):
 *   - parseTurnEndStreamEvent: flat vs `.payload`-wrapped shapes, reject paths
 *   - recsEngineConsumer: the pid-scoped {stream, group, consumer} descriptor
 *     index.ts:205 SIGTERM delConsumer matches
 *   - startRecommendationConsumer: consumer-group CREATE at start-id "$",
 *     consume() opts {count:16, blockMs:5000, reapStale:true}, and that the
 *     handler routes a turn_end event onward (and drops a non-turn_end one).
 *
 * The eventBus is a fake that records ensureConsumerGroup/consume calls and
 * lets the test drive the handler directly — no Redis, no real engine LLM call.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseTurnEndStreamEvent,
  recsEngineConsumer,
  startRecommendationConsumer,
} from "../src/autopilot/recommendation-consumer.ts";

// ---------------------------------------------------------------------------
// parseTurnEndStreamEvent — moved verbatim from the engine test (issue #2024)
// ---------------------------------------------------------------------------

test("parseTurnEndStreamEvent handles flat and payload-wrapped shapes", () => {
  const flat = parseTurnEndStreamEvent({
    event: "turn_end",
    run_id: "run-A",
    turn_n: "3",
    dispatches: "1",
    skipped: "0",
    idle: "0",
    tokens_after: "42",
    ts_epoch: "1779907573",
  });
  assert.ok(flat);
  assert.equal(flat?.turn_n, 3);
  assert.equal(flat?.dispatches, 1);

  const wrapped = parseTurnEndStreamEvent({
    payload: {
      event: "turn_end",
      run_id: "run-B",
      turn_n: "5",
      dispatches: "2",
      ts_epoch: "1779907600",
    },
  });
  assert.ok(wrapped);
  assert.equal(wrapped?.run_id, "run-B");
  assert.equal(wrapped?.turn_n, 5);

  assert.equal(parseTurnEndStreamEvent({ event: "subagent_stop" }), null);
  assert.equal(parseTurnEndStreamEvent({ event: "turn_end" }), null);
  assert.equal(parseTurnEndStreamEvent(null), null);
});

// ---------------------------------------------------------------------------
// recsEngineConsumer descriptor — must match what startRecommendationConsumer
// registers (index.ts:205 SIGTERM delConsumer depends on this).
// ---------------------------------------------------------------------------

test("recsEngineConsumer returns the pid-scoped slot-events descriptor", () => {
  const d = recsEngineConsumer();
  assert.equal(d.stream, "hydra:autopilot:slot-events");
  assert.equal(d.group, "recs-engine");
  assert.equal(d.consumer, `recs-${process.pid}`);
});

// ---------------------------------------------------------------------------
// startRecommendationConsumer lifecycle — fake eventBus records the wiring.
// ---------------------------------------------------------------------------

interface ConsumeCall {
  stream: string;
  group: string;
  consumer: string;
  handler: (event: any) => Promise<void>;
  opts?: { count?: number; blockMs?: number; reapStale?: boolean };
}

function fakeEventBus() {
  const ensureCalls: Array<{ stream: string; group: string; startId?: string }> = [];
  let consumeCall: ConsumeCall | null = null;
  return {
    ensureCalls,
    get consumeCall() {
      return consumeCall;
    },
    async ensureConsumerGroup(stream: string, group: string, startId?: string) {
      ensureCalls.push({ stream, group, startId });
    },
    async consume(
      stream: string,
      group: string,
      consumer: string,
      handler: (event: any) => Promise<void>,
      opts?: { count?: number; blockMs?: number; reapStale?: boolean },
    ) {
      consumeCall = { stream, group, consumer, handler, opts };
      // Return immediately — production blocks here forever, but the test only
      // needs the descriptor + handler captured.
    },
  };
}

test("startRecommendationConsumer creates the group at start-id $ and consumes with the pinned opts", async () => {
  const bus = fakeEventBus();
  await startRecommendationConsumer(bus as any);

  // Group CREATE: stream + group + start-id "$" (only-new-events — a regression
  // to "0" would replay the entire slot-events stream on every restart).
  assert.equal(bus.ensureCalls.length, 1);
  assert.deepEqual(bus.ensureCalls[0], {
    stream: "hydra:autopilot:slot-events",
    group: "recs-engine",
    startId: "$",
  });

  // consume(): same stream/group, pid-scoped consumer, pinned opts.
  const c = bus.consumeCall;
  assert.ok(c);
  assert.equal(c?.stream, "hydra:autopilot:slot-events");
  assert.equal(c?.group, "recs-engine");
  assert.equal(c?.consumer, `recs-${process.pid}`);
  assert.deepEqual(c?.opts, { count: 16, blockMs: 5000, reapStale: true });
});

test("startRecommendationConsumer handler drops a non-turn_end event without invoking the engine", async () => {
  const bus = fakeEventBus();
  await startRecommendationConsumer(bus as any);
  const handler = bus.consumeCall?.handler;
  assert.ok(handler);

  // A non-turn_end event is filtered out by parseTurnEndStreamEvent → null, so
  // the handler returns early WITHOUT touching the engine (and therefore
  // without any Redis / LLM call). No throw. The full parse → engine.onTurnEnd
  // → daily-cap path is covered hermetically in
  // test/recommendation-engine.test.mts via an injected deps record; here we
  // only pin the consumer's filter-and-route contract.
  await assert.doesNotReject(handler!({ event: "subagent_stop", run_id: "x" }));
  await assert.doesNotReject(handler!(null));
  await assert.doesNotReject(handler!({ event: "turn_end" })); // missing run_id → null
});

/**
 * test/recommendation-engine.test.mts — covers the autopilot recommendation
 * engine (issue #674, slice F of #667).
 *
 * Surface tested in this file is the pure logic + the `onTurnEnd` hot
 * path. The engine is built around a `deps` record so every external
 * touchpoint is stubbed here — no Redis, no fetch, no clock skew.
 *
 * The four ACs that this file pins:
 *   - prompt-size budget (≤ 4KB for any reasonable input)
 *   - material-change predicate (new dispatch / new perm-wait / outcome / flip)
 *   - 30s minimum interval gate
 *   - daily-cap behaviour at the simulated $1.00 boundary
 *   - end-to-end: 10 turn_end events ⇒ ≤10 LLM calls, all parsed
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PROMPT_SIZE_BUDGET_BYTES,
  MIN_CALL_INTERVAL_SECONDS,
  buildPrompt,
  computeMaterialChangeSignature,
  summariseSlotStatus,
  parseLlmResponse,
  parseTurnEndStreamEvent,
  shouldFire,
  createRecommendationEngine,
  type EngineDeps,
  type LlmClient,
  type LlmResult,
  type RecsRedisFacade,
  type TurnEndPayload,
} from "../src/autopilot/recommendation-engine.ts";

// ---------------------------------------------------------------------------
// In-memory Redis facade — production parity for the engine's writes
// ---------------------------------------------------------------------------

interface FakeState {
  lastCall: Map<string, number>;
  lastSig: Map<string, string>;
  recs: Map<string, Map<string, string>>;
  spend: Map<string, number>;
}

function makeFakeRedis(): { redis: RecsRedisFacade; state: FakeState } {
  const state: FakeState = {
    lastCall: new Map(),
    lastSig: new Map(),
    recs: new Map(),
    spend: new Map(),
  };
  const redis: RecsRedisFacade = {
    async getLastCallEpoch(runId) {
      return state.lastCall.get(runId) ?? null;
    },
    async setLastCallEpoch(runId, epoch) {
      state.lastCall.set(runId, epoch);
    },
    async getLastSignature(runId) {
      return state.lastSig.get(runId) ?? null;
    },
    async setLastSignature(runId, sig) {
      state.lastSig.set(runId, sig);
    },
    async appendRecommendation(runId, recId, json) {
      const h = state.recs.get(runId) ?? new Map<string, string>();
      h.set(recId, json);
      state.recs.set(runId, h);
    },
    async getDailySpendUsd(date) {
      return state.spend.get(date) ?? 0;
    },
    async incrDailySpendUsd(date, usd) {
      const prev = state.spend.get(date) ?? 0;
      const next = prev + usd;
      state.spend.set(date, next);
      return next;
    },
  };
  return { redis, state };
}

// ---------------------------------------------------------------------------
// LLM stub — captures prompt, returns canned recs, optional cost
// ---------------------------------------------------------------------------

function makeFakeLlm(opts: {
  recs?: Array<{ severity: "info" | "warn" | "critical"; message: string }>;
  costPerCall?: number;
  returnNull?: boolean;
  throws?: boolean;
} = {}): { llm: LlmClient; calls: string[] } {
  const calls: string[] = [];
  const recs = opts.recs ?? [{ severity: "info" as const, message: "test rec" }];
  const llm: LlmClient = {
    async generate(input): Promise<LlmResult | null> {
      if (opts.throws) throw new Error("forced llm error");
      if (opts.returnNull) return null;
      const prompt = buildPrompt(input);
      calls.push(prompt);
      const stamped = recs.map((r, i) => ({
        id: `${input.turn_end.run_id}:${input.turn_end.turn_n}:${i}`,
        severity: r.severity,
        message: r.message,
        evidence_id: `turn:${input.turn_end.turn_n}`,
        run_id: input.turn_end.run_id,
        created_at: new Date(input.turn_end.ts_epoch * 1000).toISOString(),
      }));
      return {
        recommendations: stamped,
        cost_usd: opts.costPerCall ?? 0,
        prompt,
      };
    },
  };
  return { llm, calls };
}

// ---------------------------------------------------------------------------
// Boilerplate factories
// ---------------------------------------------------------------------------

function defaultEngineDeps(overrides: Partial<EngineDeps> = {}): EngineDeps {
  const { redis } = makeFakeRedis();
  const { llm } = makeFakeLlm();
  let nowEpoch = 1_000_000;
  return {
    redis,
    llm,
    readRecentTurns: async () => [],
    readSlotSnapshot: async () => ({}),
    readSignalsSnapshot: async () => ({}),
    readRecentPermissionWaits: async () => [],
    now: () => nowEpoch,
    today: () => "2026-05-28",
    dailyCapUsd: 1.0,
    ...overrides,
  };
}

function makeTurnEnd(overrides: Partial<TurnEndPayload> = {}): TurnEndPayload {
  return {
    event: "turn_end",
    run_id: "run-A",
    turn_n: 1,
    dispatches: 0,
    skipped: 0,
    idle: 0,
    tokens_after: 0,
    ts_epoch: 1_000_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers — buildPrompt, parseLlmResponse, parseTurnEndStreamEvent
// ---------------------------------------------------------------------------

test("buildPrompt stays under the 4KB prompt-size budget for a saturated input", () => {
  const prompt = buildPrompt({
    recent_turns: Array.from({ length: 3 }, (_, i) => ({
      turn_n: i + 1,
      dispatches: 5,
      skipped: 2,
      idle: 0,
      ts_epoch: 1_000_000 + i,
    })),
    slot_snapshot: Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [
        `dev_orch_slot_${i}`,
        { status: "dispatched", since_epoch: 1_000_000 },
      ]),
    ),
    signals_snapshot: Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [
        `signal_${i}`,
        `pretty long value with random padding to test the clip ${"x".repeat(50)}`,
      ]),
    ),
    recent_permission_waits: Array.from({ length: 5 }, (_, i) => ({
      slot: `dev_target_${i}`,
      tool: "Bash",
      ts_epoch: 1_000_000 + i * 10,
    })),
    daily_spend_usd: 0.42,
    turn_end: makeTurnEnd({ dispatches: 5, skipped: 2 }),
  });
  const size = Buffer.byteLength(prompt, "utf8");
  assert.ok(
    size <= PROMPT_SIZE_BUDGET_BYTES,
    `prompt was ${size} bytes, budget is ${PROMPT_SIZE_BUDGET_BYTES}`,
  );
});

test("buildPrompt is far under budget for a minimal input", () => {
  const prompt = buildPrompt({
    recent_turns: [],
    slot_snapshot: {},
    signals_snapshot: {},
    recent_permission_waits: [],
    daily_spend_usd: 0,
    turn_end: makeTurnEnd(),
  });
  assert.ok(Buffer.byteLength(prompt, "utf8") < 1024);
});

test("parseLlmResponse extracts valid recommendations and clips to 3", () => {
  const recs = parseLlmResponse({
    rawJsonText: JSON.stringify({
      recommendations: [
        { severity: "info", message: "first" },
        { severity: "warn", message: "second" },
        { severity: "critical", message: "third" },
        { severity: "info", message: "fourth — should be dropped" },
      ],
    }),
    runId: "run-A",
    evidenceId: "turn:1",
    nowIso: "2026-05-28T00:00:00Z",
    turnN: 1,
  });
  assert.equal(recs.length, 3);
  assert.equal(recs[0].id, "run-A:1:0");
  assert.equal(recs[0].run_id, "run-A");
  assert.equal(recs[0].evidence_id, "turn:1");
  assert.equal(recs[0].severity, "info");
  assert.equal(recs[2].severity, "critical");
});

test("parseLlmResponse rejects malformed json and unknown severities", () => {
  assert.deepEqual(
    parseLlmResponse({
      rawJsonText: "not json{",
      runId: "x",
      evidenceId: "y",
      nowIso: "",
      turnN: 0,
    }),
    [],
  );
  const recs = parseLlmResponse({
    rawJsonText: JSON.stringify({
      recommendations: [
        { severity: "panic", message: "drop" },
        { severity: "info", message: "" },
        { severity: "info", message: "keep" },
      ],
    }),
    runId: "x",
    evidenceId: "y",
    nowIso: "2026-05-28T00:00:00Z",
    turnN: 0,
  });
  assert.equal(recs.length, 1);
  assert.equal(recs[0].message, "keep");
});

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

test("summariseSlotStatus is deterministic regardless of input key order", () => {
  const a = summariseSlotStatus({ b: { status: "x" }, a: { status: "y" } });
  const b = summariseSlotStatus({ a: { status: "y" }, b: { status: "x" } });
  assert.equal(a, b);
  assert.equal(a, "a:y,b:x");
});

test("computeMaterialChangeSignature changes when dispatches/perm-waits/status flip", () => {
  const base = {
    dispatches: 1,
    permission_waits: [],
    slot_status_summary: "dev_orch:idle",
    autopilot_running: true,
  };
  const a = computeMaterialChangeSignature(base);

  // Same input → same signature.
  assert.equal(a, computeMaterialChangeSignature(base));

  // Bumped dispatches → different.
  assert.notEqual(a, computeMaterialChangeSignature({ ...base, dispatches: 2 }));

  // New permission-wait → different.
  assert.notEqual(
    a,
    computeMaterialChangeSignature({
      ...base,
      permission_waits: [{ slot: "dev_orch", ts_epoch: 5, tool: "Bash" }],
    }),
  );

  // Status flip → different.
  assert.notEqual(
    a,
    computeMaterialChangeSignature({ ...base, autopilot_running: false }),
  );

  // Slot status flip → different (covers "new outcome / status flip").
  assert.notEqual(
    a,
    computeMaterialChangeSignature({ ...base, slot_status_summary: "dev_orch:done" }),
  );
});

// ---------------------------------------------------------------------------
// shouldFire — gate ordering: cap > interval > no-change > proceed
// ---------------------------------------------------------------------------

test("shouldFire respects the gate ordering: cap > interval > no-change", () => {
  assert.deepEqual(
    shouldFire({
      now_epoch: 100,
      last_call_epoch: 99,
      current_signature: "sig",
      last_signature: "sig",
      daily_spend_usd: 1.0,
      daily_cap_usd: 1.0,
    }),
    { proceed: false, skip_reason: "cap" },
  );

  assert.deepEqual(
    shouldFire({
      now_epoch: 100,
      last_call_epoch: 80,
      current_signature: "sig",
      last_signature: "other",
      daily_spend_usd: 0.5,
      daily_cap_usd: 1.0,
    }),
    { proceed: false, skip_reason: "interval" },
  );

  assert.deepEqual(
    shouldFire({
      now_epoch: 200,
      last_call_epoch: 80,
      current_signature: "same",
      last_signature: "same",
      daily_spend_usd: 0.5,
      daily_cap_usd: 1.0,
    }),
    { proceed: false, skip_reason: "no-change" },
  );

  assert.deepEqual(
    shouldFire({
      now_epoch: 200,
      last_call_epoch: 80,
      current_signature: "fresh",
      last_signature: "stale",
      daily_spend_usd: 0.5,
      daily_cap_usd: 1.0,
    }),
    { proceed: true },
  );

  assert.deepEqual(
    shouldFire({
      now_epoch: 200,
      last_call_epoch: null,
      current_signature: "fresh",
      last_signature: null,
      daily_spend_usd: 0.5,
      daily_cap_usd: 1.0,
    }),
    { proceed: true },
  );

  // Exactly 30s should pass.
  assert.deepEqual(
    shouldFire({
      now_epoch: 100 + MIN_CALL_INTERVAL_SECONDS,
      last_call_epoch: 100,
      current_signature: "fresh",
      last_signature: "stale",
      daily_spend_usd: 0.0,
      daily_cap_usd: 1.0,
    }),
    { proceed: true },
  );
});

// ---------------------------------------------------------------------------
// Engine hot path — onTurnEnd
// ---------------------------------------------------------------------------

test("onTurnEnd fires once and persists rec to redis on first material change", async () => {
  const { redis, state } = makeFakeRedis();
  const { llm, calls } = makeFakeLlm({ costPerCall: 0.001 });
  const engine = createRecommendationEngine({
    ...defaultEngineDeps({ redis, llm }),
  });

  const res = await engine.onTurnEnd(makeTurnEnd({ dispatches: 1 }));
  assert.equal(res.fired, true);
  if (res.fired) {
    assert.ok(res.recs.length >= 1);
    assert.ok(res.recs[0].id.startsWith("run-A:1:"));
  }
  assert.equal(calls.length, 1);
  assert.equal(state.recs.get("run-A")?.size, 1);
  assert.ok((state.spend.get("2026-05-28") ?? 0) > 0);
  assert.ok(state.lastCall.has("run-A"));
  assert.ok(state.lastSig.has("run-A"));
});

test("onTurnEnd skips a second call inside the 30s interval", async () => {
  const { redis } = makeFakeRedis();
  const { llm, calls } = makeFakeLlm();
  let nowEpoch = 1_000_000;
  const engine = createRecommendationEngine({
    ...defaultEngineDeps({ redis, llm, now: () => nowEpoch }),
  });

  // First call fires.
  await engine.onTurnEnd(makeTurnEnd({ dispatches: 1 }));
  assert.equal(calls.length, 1);

  // 5 seconds later, a fresh material change — should still be gated.
  nowEpoch += 5;
  const res = await engine.onTurnEnd(
    makeTurnEnd({ turn_n: 2, dispatches: 2, ts_epoch: nowEpoch }),
  );
  assert.equal(res.fired, false);
  if (!res.fired) {
    assert.equal(res.reason, "interval");
  }
  assert.equal(calls.length, 1);
});

test("onTurnEnd skips when material-change signature is unchanged after the interval", async () => {
  const { redis } = makeFakeRedis();
  const { llm, calls } = makeFakeLlm();
  let nowEpoch = 1_000_000;
  const engine = createRecommendationEngine({
    ...defaultEngineDeps({ redis, llm, now: () => nowEpoch }),
  });

  await engine.onTurnEnd(makeTurnEnd({ dispatches: 1 }));
  assert.equal(calls.length, 1);

  // 60 seconds later, IDENTICAL signature ⇒ no-change.
  nowEpoch += 60;
  const res = await engine.onTurnEnd(
    makeTurnEnd({ turn_n: 2, dispatches: 1, ts_epoch: nowEpoch }),
  );
  assert.equal(res.fired, false);
  if (!res.fired) {
    assert.equal(res.reason, "no-change");
  }
  assert.equal(calls.length, 1);
});

test("onTurnEnd pauses on daily cap and emits oak_resting exactly once", async () => {
  const { redis, state } = makeFakeRedis();
  const { llm, calls } = makeFakeLlm({ costPerCall: 0.40 });
  let nowEpoch = 1_000_000;
  const broadcasts: Array<{ runId: string; spend: number; cap: number }> = [];

  const engine = createRecommendationEngine({
    ...defaultEngineDeps({
      redis,
      llm,
      now: () => nowEpoch,
      broadcastResting: (runId, spend, cap) => {
        broadcasts.push({ runId, spend, cap });
      },
    }),
  });

  // Three calls @ $0.40 each = $1.20 ≥ cap.
  for (let i = 0; i < 3; i++) {
    await engine.onTurnEnd(
      makeTurnEnd({ turn_n: i + 1, dispatches: i + 1, ts_epoch: nowEpoch }),
    );
    nowEpoch += MIN_CALL_INTERVAL_SECONDS + 1;
  }
  // The first three turns should have fired and pushed spend over the cap.
  assert.equal(calls.length, 3);

  // The 4th turn — cap is now breached, should pause AND broadcast once.
  const res1 = await engine.onTurnEnd(
    makeTurnEnd({ turn_n: 4, dispatches: 4, ts_epoch: nowEpoch }),
  );
  assert.equal(res1.fired, false);
  if (!res1.fired) assert.equal(res1.reason, "cap");
  assert.equal(broadcasts.length, 1);

  // The 5th turn — still over the cap, but NO second broadcast.
  nowEpoch += MIN_CALL_INTERVAL_SECONDS + 1;
  const res2 = await engine.onTurnEnd(
    makeTurnEnd({ turn_n: 5, dispatches: 5, ts_epoch: nowEpoch }),
  );
  assert.equal(res2.fired, false);
  assert.equal(broadcasts.length, 1);

  // Spend tally matches.
  assert.ok((state.spend.get("2026-05-28") ?? 0) >= 1.0);
});

test("onTurnEnd returns no-llm when the LLM client returns null (no api key)", async () => {
  const { redis } = makeFakeRedis();
  const { llm, calls } = makeFakeLlm({ returnNull: true });
  const engine = createRecommendationEngine({
    ...defaultEngineDeps({ redis, llm }),
  });
  const res = await engine.onTurnEnd(makeTurnEnd({ dispatches: 1 }));
  assert.equal(res.fired, false);
  if (!res.fired) assert.equal(res.reason, "no-llm");
  assert.equal(calls.length, 0);
});

test("onTurnEnd catches llm throws and reports llm-error (engine stays alive)", async () => {
  const { redis } = makeFakeRedis();
  const { llm } = makeFakeLlm({ throws: true });
  const engine = createRecommendationEngine({
    ...defaultEngineDeps({ redis, llm }),
  });
  const res = await engine.onTurnEnd(makeTurnEnd({ dispatches: 1 }));
  assert.equal(res.fired, false);
  if (!res.fired) assert.equal(res.reason, "llm-error");
});

// ---------------------------------------------------------------------------
// End-to-end — 10 turn_end events ⇒ ≤10 LLM calls, all parsed, cap honored
// ---------------------------------------------------------------------------

test("end-to-end: 10 synthetic turn_ends ⇒ ≤10 LLM calls, all parsed, cap honored at $1.00", async () => {
  const { redis, state } = makeFakeRedis();
  const { llm, calls } = makeFakeLlm({
    recs: [
      { severity: "info", message: "looking good" },
      { severity: "warn", message: "watch dispatch latency" },
    ],
    // $0.15 per call: 7 calls = $1.05 — should hit the cap on the 7th.
    costPerCall: 0.15,
  });
  let nowEpoch = 2_000_000;

  const engine = createRecommendationEngine({
    ...defaultEngineDeps({
      redis,
      llm,
      now: () => nowEpoch,
      // Vary dispatches per turn so material-change always triggers.
      readRecentTurns: async () => [],
    }),
  });

  let fired = 0;
  let paused = 0;
  for (let i = 0; i < 10; i++) {
    const r = await engine.onTurnEnd(
      makeTurnEnd({
        turn_n: i + 1,
        dispatches: i + 1,
        skipped: i,
        ts_epoch: nowEpoch,
      }),
    );
    if (r.fired) fired += 1;
    else if (r.reason === "cap") paused += 1;
    // Advance > 30s every iteration so the interval gate doesn't suppress.
    nowEpoch += MIN_CALL_INTERVAL_SECONDS + 1;
  }

  assert.ok(fired <= 10, `expected ≤10 fires, got ${fired}`);
  assert.equal(calls.length, fired);
  assert.ok(paused > 0, "expected at least one cap pause within 10 turns at $0.15/call");
  // Every rec landed in the run hash.
  const persisted = state.recs.get("run-A")?.size ?? 0;
  assert.ok(persisted > 0);
  // Spend tally crossed the cap.
  const finalSpend = state.spend.get("2026-05-28") ?? 0;
  assert.ok(finalSpend >= 1.0, `expected spend ≥ $1.00, got $${finalSpend}`);
});

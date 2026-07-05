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
  MIN_CALL_INTERVAL_SECONDS,
  DEFAULT_DAILY_CAP_USD,
  envDailyCap,
  utcDateStamp,
  buildPrompt,
  computeMaterialChangeSignature,
  summariseSlotStatus,
  shouldFire,
  createRecommendationEngine,
  createCapEnforcer,
  type EngineDeps,
  type LlmClient,
  type LlmResult,
  type RecsRedisFacade,
  type CapRedisFacade,
  type TurnEndPayload,
} from "../src/autopilot/recommendation-engine.ts";
// The materiality gate (#1986), prompt grammar (#2240) and daily-cap ledger
// (#2119) were folded back into recommendation-engine.ts as concern sections
// (#2317); this file imports all three from the single engine module and covers
// them end-to-end alongside the engine's onTurnEnd hot path.
// parseTurnEndStreamEvent + the stream lifecycle stay in the
// recommendation-consumer Seam (#2024) — their dedicated test lives in
// test/recommendation-consumer.test.mts.

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

/**
 * Build engine deps for a test. The billing ledger moved to
 * recommendation-cap.ts (issue #2119), so the cap policy is now injected as a
 * `capEnforcer`. To keep the existing test wiring ergonomic, this factory
 * accepts the pre-extraction cap knobs (`broadcastResting`, `dailyCapUsd`,
 * `today`) and folds them into a default enforcer built over the SAME fake
 * redis the engine uses — so the spend asserts (state.spend) still observe the
 * charges. A caller can still override `capEnforcer` directly.
 */
function defaultEngineDeps(
  overrides: Partial<EngineDeps> & {
    broadcastResting?: (runId: string, spend: number, cap: number) => void;
    dailyCapUsd?: number;
    today?: () => string;
  } = {},
): EngineDeps {
  const { broadcastResting, dailyCapUsd, today, ...engineOverrides } = overrides;
  const redis = engineOverrides.redis ?? makeFakeRedis().redis;
  const { llm } = makeFakeLlm();
  const nowEpoch = 1_000_000;
  const capEnforcer =
    engineOverrides.capEnforcer ??
    createCapEnforcer({
      redis,
      now: engineOverrides.now ?? (() => nowEpoch),
      today: today ?? (() => "2026-05-28"),
      dailyCapUsd: dailyCapUsd ?? 1.0,
      broadcastResting,
    });
  return {
    redis,
    llm,
    readRecentTurns: async () => [],
    readSlotSnapshot: async () => ({}),
    readSignalsSnapshot: async () => ({}),
    readRecentPermissionWaits: async () => [],
    now: () => nowEpoch,
    ...engineOverrides,
    capEnforcer,
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
// Pure helpers — materiality gate (buildPrompt / parseLlmResponse / the
// prompt-size budget now live in test/recommendation-prompt.test.mts, the
// focused leaf test extracted by #2867; the engine still re-exports them and
// makeFakeLlm above exercises buildPrompt through the engine surface).
// ---------------------------------------------------------------------------

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

// ===========================================================================
// Daily-cap ledger (SECTION 4 of recommendation-engine.ts — was
// recommendation-cap.ts, issue #2119, folded back in #2317).
//
// The cap ledger owns the recs-engine's billing concern: the
// HYDRA_RECS_DAILY_CAP_USD resolution, the UTC date stamp, the spend
// read/charge, and the once-per-UTC-day `oak_resting` broadcast latch. The
// cap > interval > no-change ORDERING is NOT here (that stays in `shouldFire`
// above); this ledger only feeds daily_spend_usd + daily_cap_usd in. These
// tests pin:
//   - env cap resolution (default / valid / invalid)
//   - the UTC date stamper
//   - charge-after-success-only (no-op when costUsd <= 0)
//   - the oak_resting once-per-UTC-day latch + date-rollover reset
// ===========================================================================

function makeFakeCapRedis(): { redis: CapRedisFacade; spend: Map<string, number> } {
  const spend = new Map<string, number>();
  const redis: CapRedisFacade = {
    async getDailySpendUsd(date) {
      return spend.get(date) ?? 0;
    },
    async incrDailySpendUsd(date, usd) {
      const next = (spend.get(date) ?? 0) + usd;
      spend.set(date, next);
      return next;
    },
  };
  return { redis, spend };
}

// envDailyCap — the single HYDRA_RECS_DAILY_CAP_USD home

test("envDailyCap falls back to the default when unset", () => {
  const prev = process.env.HYDRA_RECS_DAILY_CAP_USD;
  delete process.env.HYDRA_RECS_DAILY_CAP_USD;
  try {
    assert.equal(envDailyCap(), DEFAULT_DAILY_CAP_USD);
    assert.equal(DEFAULT_DAILY_CAP_USD, 1.0);
  } finally {
    if (prev === undefined) delete process.env.HYDRA_RECS_DAILY_CAP_USD;
    else process.env.HYDRA_RECS_DAILY_CAP_USD = prev;
  }
});

test("envDailyCap honors a valid override and rejects invalid/negative", () => {
  const prev = process.env.HYDRA_RECS_DAILY_CAP_USD;
  try {
    process.env.HYDRA_RECS_DAILY_CAP_USD = "2.5";
    assert.equal(envDailyCap(), 2.5);

    process.env.HYDRA_RECS_DAILY_CAP_USD = "not-a-number";
    assert.equal(envDailyCap(), DEFAULT_DAILY_CAP_USD);

    process.env.HYDRA_RECS_DAILY_CAP_USD = "-1";
    assert.equal(envDailyCap(), DEFAULT_DAILY_CAP_USD);
  } finally {
    if (prev === undefined) delete process.env.HYDRA_RECS_DAILY_CAP_USD;
    else process.env.HYDRA_RECS_DAILY_CAP_USD = prev;
  }
});

// utcDateStamp — the per-day bucket key

test("utcDateStamp produces a zero-padded UTC YYYY-MM-DD", () => {
  assert.equal(utcDateStamp(new Date("2026-01-05T23:59:59Z")), "2026-01-05");
  // A late-UTC instant still stamps the UTC date, not the local one.
  assert.equal(utcDateStamp(new Date(Date.UTC(2026, 11, 9, 0, 0, 0))), "2026-12-09");
});

// getDailyCapUsd + readDailySpend

test("getDailyCapUsd returns the injected cap; readDailySpend reads the ledger", async () => {
  const { redis, spend } = makeFakeCapRedis();
  spend.set("2026-05-28", 0.42);
  const cap = createCapEnforcer({ redis, dailyCapUsd: 1.0, today: () => "2026-05-28" });
  assert.equal(cap.getDailyCapUsd(), 1.0);
  assert.equal(cap.today(), "2026-05-28");
  assert.equal(await cap.readDailySpend("2026-05-28"), 0.42);
});

// chargeIfPositive — charge-after-success-only invariant

test("chargeIfPositive charges only on a positive cost and is a no-op otherwise", async () => {
  const { redis, spend } = makeFakeCapRedis();
  const cap = createCapEnforcer({ redis, dailyCapUsd: 1.0, today: () => "2026-05-28" });

  await cap.chargeIfPositive("2026-05-28", 0);
  assert.equal(spend.get("2026-05-28") ?? 0, 0, "zero cost must not charge");

  await cap.chargeIfPositive("2026-05-28", -0.5);
  assert.equal(spend.get("2026-05-28") ?? 0, 0, "negative cost must not charge");

  await cap.chargeIfPositive("2026-05-28", 0.15);
  assert.equal(spend.get("2026-05-28"), 0.15);

  await cap.chargeIfPositive("2026-05-28", 0.10);
  assert.ok(Math.abs((spend.get("2026-05-28") ?? 0) - 0.25) < 1e-9);
});

// maybeEmitResting — once-per-UTC-day latch + date-rollover reset

test("maybeEmitResting broadcasts oak_resting at most once per UTC day", () => {
  const broadcasts: Array<{ runId: string; spend: number; cap: number }> = [];
  const cap = createCapEnforcer({
    dailyCapUsd: 1.0,
    today: () => "2026-05-28",
    broadcastResting: (runId, spend, capUsd) =>
      broadcasts.push({ runId, spend, cap: capUsd }),
  });

  assert.equal(cap.maybeEmitResting(1.2), true);
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].runId, "__system__");
  assert.equal(broadcasts[0].spend, 1.2);
  assert.equal(broadcasts[0].cap, 1.0);

  // Second call same UTC day — latched, no second broadcast.
  assert.equal(cap.maybeEmitResting(1.3), false);
  assert.equal(broadcasts.length, 1);
});

test("maybeEmitResting resets on UTC date rollover", () => {
  const broadcasts: number[] = [];
  let date = "2026-05-28";
  const cap = createCapEnforcer({
    dailyCapUsd: 1.0,
    today: () => date,
    broadcastResting: (_runId, spend) => broadcasts.push(spend),
  });

  assert.equal(cap.maybeEmitResting(1.1), true);
  assert.equal(cap.maybeEmitResting(1.1), false);
  assert.equal(broadcasts.length, 1);

  // New UTC day — the latch resets and the broadcast fires again.
  date = "2026-05-29";
  assert.equal(cap.maybeEmitResting(2.2), true);
  assert.equal(broadcasts.length, 2);
  assert.deepEqual(broadcasts, [1.1, 2.2]);
});

test("maybeEmitResting swallows a throwing broadcaster but still latches", () => {
  const cap = createCapEnforcer({
    dailyCapUsd: 1.0,
    today: () => "2026-05-28",
    broadcastResting: () => {
      throw new Error("ws registry down");
    },
  });
  // Must not throw — the broadcaster failure is logged, not propagated.
  assert.equal(cap.maybeEmitResting(1.5), true);
  // Still latched despite the throw.
  assert.equal(cap.maybeEmitResting(1.5), false);
});

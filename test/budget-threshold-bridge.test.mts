/**
 * test/budget-threshold-bridge.test.mts — covers issue #673 acceptance criteria
 * for the budget-threshold detector.
 *
 * Pure logic (computeCrossedThresholds, parseDailySpendBlob,
 * getDailySpendCapUsd) is tested in isolation; the idempotency contract
 * (one event per (UTC day, threshold) pair, persisted via SETNX with 30h
 * TTL) and the emit shape are tested against a real Redis on database /2
 * (kept off the production /0 used elsewhere in this suite).
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

// Pin the test DB BEFORE any module-level Redis imports run.
process.env.REDIS_URL = "redis://localhost:6379/2";

const {
  computeCrossedThresholds,
  parseDailySpendBlob,
  getDailySpendCapUsd,
  emitBudgetThresholdEvent,
  startBudgetThresholdBridge,
  BUDGET_THRESHOLD_TTL_SECONDS,
  DEFAULT_THRESHOLDS,
  SLOT_EVENTS_STREAM,
} = await import("../src/autopilot/budget-threshold-bridge.ts");

const {
  setDailySpendRaw,
  claimBudgetThresholdSeen,
  getBudgetThresholdSeen,
  _clearBudgetThresholdSeen,
} = await import("../src/redis/scheduler.ts");

let testRedis: any;

async function ensureRedis() {
  if (!testRedis) {
    testRedis = new Redis("redis://localhost:6379/2");
  }
  return testRedis;
}

async function cleanTestKeys() {
  const r = await ensureRedis();
  const patterns = [
    "hydra:autopilot:budget-threshold:*",
    "hydra:autopilot:slot-events",
    "hydra:scheduler:daily-spend",
  ];
  for (const pat of patterns) {
    const keys = await r.keys(pat);
    if (keys.length > 0) await r.del(...keys);
  }
}

const { closeRedisConnections } = await import("../src/redis/connection.ts");

after(async () => {
  if (testRedis) {
    await cleanTestKeys();
    testRedis.disconnect();
  }
  // Close the module-level singleton used by the bridge so the test process
  // can exit without --test-force-exit.
  closeRedisConnections();
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("budget-threshold-bridge: pure helpers", () => {
  test("computeCrossedThresholds returns ascending crossed thresholds", () => {
    // 60% of $50 = $30 — crosses 50% only
    assert.deepEqual(computeCrossedThresholds(30, 50), [50]);
    // 80% — crosses 50 + 75
    assert.deepEqual(computeCrossedThresholds(40, 50), [50, 75]);
    // 95% — crosses all three
    assert.deepEqual(computeCrossedThresholds(47.5, 50), [50, 75, 90]);
  });

  test("computeCrossedThresholds: under 50% returns empty", () => {
    assert.deepEqual(computeCrossedThresholds(10, 50), []);
  });

  test("computeCrossedThresholds: invalid inputs are guarded", () => {
    assert.deepEqual(computeCrossedThresholds(NaN, 50), []);
    assert.deepEqual(computeCrossedThresholds(-5, 50), []);
    assert.deepEqual(computeCrossedThresholds(40, 0), []);
    assert.deepEqual(computeCrossedThresholds(40, -10), []);
    assert.deepEqual(computeCrossedThresholds(40, NaN), []);
  });

  test("computeCrossedThresholds honours custom threshold lists", () => {
    assert.deepEqual(computeCrossedThresholds(45, 50, [80, 95]), [80]);
    assert.deepEqual(computeCrossedThresholds(48, 50, [80, 95]), [80, 95]);
  });

  test("computeCrossedThresholds sorts thresholds even if caller passes unsorted", () => {
    // 35/50 = 70% — crosses 50 only when thresholds = [90,50,75]
    assert.deepEqual(computeCrossedThresholds(35, 50, [90, 50, 75]), [50]);
    // 45/50 = 90% — crosses all three; sort yields [50, 75, 90]
    assert.deepEqual(computeCrossedThresholds(45, 50, [90, 50, 75]), [50, 75, 90]);
  });

  test("DEFAULT_THRESHOLDS pins the #673 spec [50, 75, 90]", () => {
    assert.deepEqual([...DEFAULT_THRESHOLDS], [50, 75, 90]);
  });

  test("BUDGET_THRESHOLD_TTL_SECONDS is 30h (> 24h to survive UTC boundary jitter)", () => {
    assert.equal(BUDGET_THRESHOLD_TTL_SECONDS, 30 * 3600);
    assert.ok(BUDGET_THRESHOLD_TTL_SECONDS > 24 * 3600);
  });
});

describe("budget-threshold-bridge: parseDailySpendBlob", () => {
  test("returns 0 for null / undefined / empty", () => {
    assert.equal(parseDailySpendBlob(null, "2026-05-27"), 0);
    assert.equal(parseDailySpendBlob("", "2026-05-27"), 0);
  });

  test("returns 0 when the blob's date doesn't match today", () => {
    const raw = JSON.stringify({ date: "2026-05-26", usd: 30, updatedAt: "x" });
    assert.equal(parseDailySpendBlob(raw, "2026-05-27"), 0);
  });

  test("returns the usd value when the date matches today", () => {
    const raw = JSON.stringify({ date: "2026-05-27", usd: 42.5, updatedAt: "x" });
    assert.equal(parseDailySpendBlob(raw, "2026-05-27"), 42.5);
  });

  test("returns 0 on unparseable JSON", () => {
    assert.equal(parseDailySpendBlob("not json", "2026-05-27"), 0);
  });

  test("returns 0 on non-finite or negative usd values", () => {
    assert.equal(parseDailySpendBlob(JSON.stringify({ date: "2026-05-27", usd: -5 }), "2026-05-27"), 0);
    assert.equal(parseDailySpendBlob(JSON.stringify({ date: "2026-05-27", usd: "abc" }), "2026-05-27"), 0);
  });
});

describe("budget-threshold-bridge: getDailySpendCapUsd", () => {
  const saved = process.env.HYDRA_AUTOPILOT_DAILY_SPEND_CAP_USD;

  after(() => {
    if (saved === undefined) delete process.env.HYDRA_AUTOPILOT_DAILY_SPEND_CAP_USD;
    else process.env.HYDRA_AUTOPILOT_DAILY_SPEND_CAP_USD = saved;
  });

  test("defaults to 50.0 when env unset", () => {
    delete process.env.HYDRA_AUTOPILOT_DAILY_SPEND_CAP_USD;
    assert.equal(getDailySpendCapUsd(), 50.0);
  });

  test("parses env override", () => {
    process.env.HYDRA_AUTOPILOT_DAILY_SPEND_CAP_USD = "12.5";
    assert.equal(getDailySpendCapUsd(), 12.5);
  });

  test("clamps invalid / negative values to 0 (disabled)", () => {
    process.env.HYDRA_AUTOPILOT_DAILY_SPEND_CAP_USD = "garbage";
    assert.equal(getDailySpendCapUsd(), 0);
    process.env.HYDRA_AUTOPILOT_DAILY_SPEND_CAP_USD = "-5";
    assert.equal(getDailySpendCapUsd(), 0);
  });

  test("allows operator opt-out via cap=0", () => {
    process.env.HYDRA_AUTOPILOT_DAILY_SPEND_CAP_USD = "0";
    assert.equal(getDailySpendCapUsd(), 0);
  });
});

// ---------------------------------------------------------------------------
// Redis-backed idempotency contract (#673 acceptance criterion 2)
// ---------------------------------------------------------------------------

describe("budget-threshold-bridge: SETNX idempotency", () => {
  beforeEach(async () => {
    await cleanTestKeys();
  });

  test("claimBudgetThresholdSeen returns true exactly once per (date, threshold) pair", async () => {
    const date = "2026-05-27";
    const ttl = 30 * 3600;

    const first = await claimBudgetThresholdSeen(date, 50, ttl);
    assert.equal(first, true);

    const second = await claimBudgetThresholdSeen(date, 50, ttl);
    assert.equal(second, false);

    const third = await claimBudgetThresholdSeen(date, 50, ttl);
    assert.equal(third, false);
  });

  test("different (date, threshold) pairs are independent claims", async () => {
    const ttl = 30 * 3600;
    assert.equal(await claimBudgetThresholdSeen("2026-05-27", 50, ttl), true);
    assert.equal(await claimBudgetThresholdSeen("2026-05-27", 75, ttl), true);
    assert.equal(await claimBudgetThresholdSeen("2026-05-27", 90, ttl), true);
    assert.equal(await claimBudgetThresholdSeen("2026-05-28", 50, ttl), true);

    // Re-claim each one — all should fail
    assert.equal(await claimBudgetThresholdSeen("2026-05-27", 50, ttl), false);
    assert.equal(await claimBudgetThresholdSeen("2026-05-27", 75, ttl), false);
    assert.equal(await claimBudgetThresholdSeen("2026-05-27", 90, ttl), false);
    assert.equal(await claimBudgetThresholdSeen("2026-05-28", 50, ttl), false);
  });

  test("getBudgetThresholdSeen reads the sentinel value", async () => {
    const date = "2026-05-27";
    const ttl = 30 * 3600;
    assert.equal(await getBudgetThresholdSeen(date, 50), null);
    await claimBudgetThresholdSeen(date, 50, ttl);
    const v = await getBudgetThresholdSeen(date, 50);
    assert.ok(v && /^\d+$/.test(v));
  });

  test("_clearBudgetThresholdSeen allows re-claiming (test helper sanity check)", async () => {
    const ttl = 30 * 3600;
    await claimBudgetThresholdSeen("2026-05-27", 50, ttl);
    await _clearBudgetThresholdSeen("2026-05-27", 50);
    assert.equal(await claimBudgetThresholdSeen("2026-05-27", 50, ttl), true);
  });

  test("ten rapid claims for the same (date, threshold) → exactly one true result", async () => {
    // Acceptance criterion #6: "ten rapid threshold crossings within a UTC
    // day produce exactly one event per threshold".
    const date = "2026-05-27";
    const ttl = 30 * 3600;
    const results = await Promise.all(
      Array.from({ length: 10 }, () => claimBudgetThresholdSeen(date, 50, ttl)),
    );
    const trues = results.filter((r) => r).length;
    assert.equal(trues, 1, `expected exactly 1 winner, got ${trues}: ${JSON.stringify(results)}`);
  });
});

// ---------------------------------------------------------------------------
// Stream-emission shape
// ---------------------------------------------------------------------------

describe("budget-threshold-bridge: emitBudgetThresholdEvent", () => {
  beforeEach(async () => {
    await cleanTestKeys();
  });

  test("XADDs a flat field/value pair shape on the slot-events stream", async () => {
    const r = await ensureRedis();
    const id = await emitBudgetThresholdEvent({
      threshold: 75,
      spendUsd: 37.5,
      capUsd: 50,
      date: "2026-05-27",
    });
    assert.ok(id);

    const range = await r.xrange(SLOT_EVENTS_STREAM, "-", "+");
    assert.equal(range.length, 1);
    const [_streamId, fields] = range[0];
    const map: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) map[fields[i]] = fields[i + 1];

    assert.equal(map.event, "budget_threshold");
    assert.equal(map.threshold, "75");
    assert.equal(map.date, "2026-05-27");
    assert.equal(map.spend_usd, "37.5000");
    assert.equal(map.cap_usd, "50.0000");
    assert.equal(map.pct_spent, "75.00");
    assert.ok(map.ts_epoch && /^\d+$/.test(map.ts_epoch));
  });
});

// ---------------------------------------------------------------------------
// Bridge end-to-end (one-shot mode)
// ---------------------------------------------------------------------------

describe("budget-threshold-bridge: bridge end-to-end (oneShot)", () => {
  beforeEach(async () => {
    await cleanTestKeys();
    delete process.env.HYDRA_AUTOPILOT_DAILY_SPEND_CAP_USD;
  });

  test("tick fires events for crossed thresholds and is idempotent on repeat", async () => {
    const r = await ensureRedis();
    const today = new Date().toISOString().slice(0, 10);

    process.env.HYDRA_AUTOPILOT_DAILY_SPEND_CAP_USD = "50";
    await setDailySpendRaw(JSON.stringify({ date: today, usd: 40, updatedAt: "x" }));

    // First tick — fires 50 + 75 (40/50 = 80%).
    await startBudgetThresholdBridge({ oneShot: true });

    let range = await r.xrange(SLOT_EVENTS_STREAM, "-", "+");
    const eventThresholds = range
      .map(([, fields]) => {
        const m: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) m[fields[i]] = fields[i + 1];
        return m;
      })
      .filter((m) => m.event === "budget_threshold")
      .map((m) => m.threshold)
      .sort();
    assert.deepEqual(eventThresholds, ["50", "75"]);

    // Second tick at the same spend — no new events (SETNX guards).
    await startBudgetThresholdBridge({ oneShot: true });
    range = await r.xrange(SLOT_EVENTS_STREAM, "-", "+");
    const reEventCount = range.filter(([, fields]) => {
      for (let i = 0; i < fields.length; i += 2) {
        if (fields[i] === "event" && fields[i + 1] === "budget_threshold") return true;
      }
      return false;
    }).length;
    assert.equal(reEventCount, 2, "idempotent — second tick adds no events");
  });

  test("tick is a no-op when cap is 0 (operator opt-out)", async () => {
    const r = await ensureRedis();
    const today = new Date().toISOString().slice(0, 10);

    process.env.HYDRA_AUTOPILOT_DAILY_SPEND_CAP_USD = "0";
    await setDailySpendRaw(JSON.stringify({ date: today, usd: 999, updatedAt: "x" }));

    await startBudgetThresholdBridge({ oneShot: true });
    const range = await r.xrange(SLOT_EVENTS_STREAM, "-", "+");
    assert.equal(range.length, 0);
  });

  test("tick is a no-op when spend is 0 (start of day)", async () => {
    const r = await ensureRedis();
    process.env.HYDRA_AUTOPILOT_DAILY_SPEND_CAP_USD = "50";
    // No daily-spend key set → spend is 0.
    await startBudgetThresholdBridge({ oneShot: true });
    const range = await r.xrange(SLOT_EVENTS_STREAM, "-", "+");
    assert.equal(range.length, 0);
  });

  test("crossing 90% later in the day fires only the new 90% event", async () => {
    const r = await ensureRedis();
    const today = new Date().toISOString().slice(0, 10);
    process.env.HYDRA_AUTOPILOT_DAILY_SPEND_CAP_USD = "50";

    // Morning: 40/50 = 80% — fires 50 + 75
    await setDailySpendRaw(JSON.stringify({ date: today, usd: 40, updatedAt: "x" }));
    await startBudgetThresholdBridge({ oneShot: true });
    let range = await r.xrange(SLOT_EVENTS_STREAM, "-", "+");
    assert.equal(range.length, 2);

    // Afternoon: 47/50 = 94% — fires only 90 (50 + 75 already claimed)
    await setDailySpendRaw(JSON.stringify({ date: today, usd: 47, updatedAt: "x" }));
    await startBudgetThresholdBridge({ oneShot: true });
    range = await r.xrange(SLOT_EVENTS_STREAM, "-", "+");
    assert.equal(range.length, 3);

    // Check the third event is the 90% threshold
    const [, fields] = range[range.length - 1];
    const m: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) m[fields[i]] = fields[i + 1];
    assert.equal(m.threshold, "90");
  });
});

// ---------------------------------------------------------------------------
// Round-trip via slot-events-bridge (acceptance criterion 4)
// ---------------------------------------------------------------------------

describe("budget-threshold-bridge: slot-events round-trip", () => {
  test("a budget_threshold event survives slot-events-bridge translation verbatim", async () => {
    const { bridgeBroadcast } = await import("../src/autopilot/slot-events-bridge.ts");
    const calls: Array<{ stream: string; event: any }> = [];
    const mockBus = {
      _broadcastToClients: (stream: string, event: any) => calls.push({ stream, event }),
    };
    const env = bridgeBroadcast(mockBus as any, {
      event: "budget_threshold",
      threshold: "75",
      date: "2026-05-27",
      spend_usd: "37.5000",
      cap_usd: "50.0000",
      pct_spent: "75.00",
      ts_epoch: "1779907800",
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].stream, "autopilot:slot-events");
    assert.equal(env.type, "slot-event");
    assert.equal(env.payload.event, "budget_threshold");
    assert.equal(env.payload.threshold, "75");
    assert.equal(env.payload.spend_usd, "37.5000");
    assert.equal(env.payload.cap_usd, "50.0000");
    assert.equal(env.payload.pct_spent, "75.00");
  });
});

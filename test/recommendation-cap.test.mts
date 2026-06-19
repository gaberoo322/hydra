/**
 * test/recommendation-cap.test.mts — covers the recommendation daily-cap
 * ledger Module (issue #2119), extracted from recommendation-engine.ts.
 *
 * The cap module owns the recs-engine's billing concern: the
 * HYDRA_RECS_DAILY_CAP_USD resolution, the UTC date stamp, the spend
 * read/charge, and the once-per-UTC-day `oak_resting` broadcast latch. The
 * cap > interval > no-change ORDERING is NOT here (that stays in
 * recommendation-materiality.ts `shouldFire`); this Module only feeds
 * daily_spend_usd + daily_cap_usd in. These tests pin:
 *   - env cap resolution (default / valid / invalid)
 *   - the UTC date stamper
 *   - charge-after-success-only (no-op when costUsd <= 0)
 *   - the oak_resting once-per-UTC-day latch + date-rollover reset
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_DAILY_CAP_USD,
  envDailyCap,
  utcDateStamp,
  createCapEnforcer,
  type CapRedisFacade,
} from "../src/autopilot/recommendation-cap.ts";

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

// ---------------------------------------------------------------------------
// envDailyCap — the single HYDRA_RECS_DAILY_CAP_USD home
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// utcDateStamp — the per-day bucket key
// ---------------------------------------------------------------------------

test("utcDateStamp produces a zero-padded UTC YYYY-MM-DD", () => {
  assert.equal(utcDateStamp(new Date("2026-01-05T23:59:59Z")), "2026-01-05");
  // A late-UTC instant still stamps the UTC date, not the local one.
  assert.equal(utcDateStamp(new Date(Date.UTC(2026, 11, 9, 0, 0, 0))), "2026-12-09");
});

// ---------------------------------------------------------------------------
// getDailyCapUsd + readDailySpend
// ---------------------------------------------------------------------------

test("getDailyCapUsd returns the injected cap; readDailySpend reads the ledger", async () => {
  const { redis, spend } = makeFakeCapRedis();
  spend.set("2026-05-28", 0.42);
  const cap = createCapEnforcer({ redis, dailyCapUsd: 1.0, today: () => "2026-05-28" });
  assert.equal(cap.getDailyCapUsd(), 1.0);
  assert.equal(cap.today(), "2026-05-28");
  assert.equal(await cap.readDailySpend("2026-05-28"), 0.42);
});

// ---------------------------------------------------------------------------
// chargeIfPositive — charge-after-success-only invariant
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// maybeEmitResting — once-per-UTC-day latch + date-rollover reset
// ---------------------------------------------------------------------------

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

/**
 * test/recommendation-cap.test.mts — covers the recs-engine daily-cap ledger
 * leaf in isolation (issue #3499).
 *
 * The whole point of the #3499 extraction is that the cap's billing behavior is
 * assertable WITHOUT the engine factory: this file imports ONLY from
 * `../src/autopilot/recommendation-cap.ts`, so it loads neither the Anthropic
 * Request Adapter, the prompt grammar, nor the `createRecommendationEngine`
 * factory. Every cap invariant is a pure in-memory state question.
 *
 * (The end-to-end cap-vs-interval ordering — that a capped day never fires a
 * paid LLM call — stays pinned in test/recommendation-engine.test.mts against
 * `shouldFire` + `onTurnEnd`, since the ordering is the engine/materiality
 * concern, not the ledger's.)
 *
 * Invariants pinned here:
 *   - env cap resolution (default / valid / invalid / negative)
 *   - the UTC date stamper (incl. the midnight-crossing day-rotation boundary)
 *   - getDailyCapUsd + readDailySpend read-through
 *   - charge-after-success-only (no-op when costUsd <= 0)
 *   - the oak_resting once-per-UTC-day latch + date-rollover reset
 *   - a throwing broadcaster is swallowed but still latches
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

// envDailyCap — the single HYDRA_RECS_DAILY_CAP_USD home

test("[cap-leaf] envDailyCap falls back to the default when unset", () => {
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

test("[cap-leaf] envDailyCap honors a valid override and rejects invalid/negative", () => {
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

// utcDateStamp — the per-day bucket key + the day-rotation boundary (#3499)

test("[cap-leaf] utcDateStamp produces a zero-padded UTC YYYY-MM-DD", () => {
  assert.equal(utcDateStamp(new Date("2026-01-05T23:59:59Z")), "2026-01-05");
  // A late-UTC instant still stamps the UTC date, not the local one.
  assert.equal(utcDateStamp(new Date(Date.UTC(2026, 11, 9, 0, 0, 0))), "2026-12-09");
});

test("[cap-leaf] utcDateStamp rotates the bucket key exactly at the UTC midnight boundary", () => {
  // One second before UTC midnight is still the old day...
  assert.equal(
    utcDateStamp(new Date(Date.UTC(2026, 4, 28, 23, 59, 59))),
    "2026-05-28",
  );
  // ...and the very next second is the new day — the boundary a session that
  // crosses midnight hinges on. This is the edge #3499 makes directly assertable
  // (previously only reachable via a full engine instantiation).
  assert.equal(
    utcDateStamp(new Date(Date.UTC(2026, 4, 29, 0, 0, 0))),
    "2026-05-29",
  );
});

// getDailyCapUsd + readDailySpend

test("[cap-leaf] getDailyCapUsd returns the injected cap; readDailySpend reads the ledger", async () => {
  const { redis, spend } = makeFakeCapRedis();
  spend.set("2026-05-28", 0.42);
  const cap = createCapEnforcer({ redis, dailyCapUsd: 1.0, today: () => "2026-05-28" });
  assert.equal(cap.getDailyCapUsd(), 1.0);
  assert.equal(cap.today(), "2026-05-28");
  assert.equal(await cap.readDailySpend("2026-05-28"), 0.42);
});

test("[cap-leaf] today() derives the UTC stamp from the injected clock", () => {
  // A clock parked one second before UTC midnight stamps the old day; advancing
  // it past the boundary rotates the bucket key — no engine needed.
  let epoch = Math.floor(Date.UTC(2026, 4, 28, 23, 59, 59) / 1000);
  const cap = createCapEnforcer({ dailyCapUsd: 1.0, now: () => epoch });
  assert.equal(cap.today(), "2026-05-28");
  epoch = Math.floor(Date.UTC(2026, 4, 29, 0, 0, 0) / 1000);
  assert.equal(cap.today(), "2026-05-29");
});

// chargeIfPositive — charge-after-success-only invariant

test("[cap-leaf] chargeIfPositive charges only on a positive cost and is a no-op otherwise", async () => {
  const { redis, spend } = makeFakeCapRedis();
  const cap = createCapEnforcer({ redis, dailyCapUsd: 1.0, today: () => "2026-05-28" });

  await cap.chargeIfPositive("2026-05-28", 0);
  assert.equal(spend.get("2026-05-28") ?? 0, 0, "zero cost must not charge");

  await cap.chargeIfPositive("2026-05-28", -0.5);
  assert.equal(spend.get("2026-05-28") ?? 0, 0, "negative cost must not charge");

  await cap.chargeIfPositive("2026-05-28", 0.15);
  assert.equal(spend.get("2026-05-28"), 0.15);

  await cap.chargeIfPositive("2026-05-28", 0.1);
  assert.ok(Math.abs((spend.get("2026-05-28") ?? 0) - 0.25) < 1e-9);
});

// maybeEmitResting — once-per-UTC-day latch + date-rollover reset

test("[cap-leaf] maybeEmitResting broadcasts oak_resting at most once per UTC day", () => {
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

test("[cap-leaf] maybeEmitResting resets on UTC date rollover", () => {
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

test("[cap-leaf] maybeEmitResting swallows a throwing broadcaster but still latches", () => {
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

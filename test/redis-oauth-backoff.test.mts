/**
 * Unit tests for the OAuth-meter backoff-state Redis seam
 * (`src/redis/oauth-backoff.ts`, issue #2840) — slice of #2972.
 *
 * Exercises the read → write → clear round-trip, the 24h TTL stamp, and the
 * fail-open validation path (missing key, non-JSON, malformed shape all read
 * back as `null`). The module owns a single fixed key
 * (`hydra:metrics:oauth-usage:backoff`), so the suite cleans exactly that key
 * in its own before/after lifecycle — it never FLUSHDBs the run-shared test DB
 * (see scripts/test/redis-db-launch.mjs).
 *
 * REDIS_URL is set by the test launcher to a per-worktree DB (2..15, never
 * production DB 0). This suite defers to it verbatim.
 */

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

const {
  readOAuthBackoff,
  writeOAuthBackoff,
  clearOAuthBackoff,
  readGhRateLimitBackoff,
  writeGhRateLimitBackoff,
  clearGhRateLimitBackoff,
  nextGhRateLimitBackoff,
  recordGhRateLimited,
  getGhRateLimitedWindow,
  utcHourKey,
} = await import("../src/redis/oauth-backoff.ts");

// The single key this module owns — mirrored here so the suite can seed
// malformed values and clean up without importing module internals.
const OAUTH_BACKOFF_KEY = "hydra:metrics:oauth-usage:backoff";
const GH_RATE_LIMIT_BACKOFF_KEY = "hydra:metrics:github-api:rate-limit-backoff";

describe("redis/oauth-backoff seam", () => {
  let raw: any;

  before(() => {
    raw = new Redis(process.env.REDIS_URL as string);
  });

  // Per-case reset: several cases both read and write the single owned key, so
  // the cleanup must be fresh-per-case (a sibling case reads what a prior case
  // wrote otherwise) — beforeEach, not before (CLAUDE.md isolation pitfall).
  beforeEach(async () => {
    await raw.del(OAUTH_BACKOFF_KEY);
  });

  after(async () => {
    await raw.del(OAUTH_BACKOFF_KEY);
    raw.disconnect();
  });

  test("read returns null when no state is stored", async () => {
    const got = await readOAuthBackoff();
    assert.equal(got, null);
  });

  test("write → read round-trips the backoff state", async () => {
    const state = { failures: 3, nextAttemptMs: Date.now() + 900_000 };
    await writeOAuthBackoff(state);
    const got = await readOAuthBackoff();
    assert.deepEqual(got, state);
  });

  test("write stamps a bounded TTL (<= 24h, > 0)", async () => {
    await writeOAuthBackoff({ failures: 1, nextAttemptMs: Date.now() });
    const ttl = await raw.ttl(OAUTH_BACKOFF_KEY);
    const DAY = 24 * 60 * 60;
    assert.ok(ttl > 0 && ttl <= DAY, `TTL should be 1..${DAY}, got ${ttl}`);
  });

  test("write overwrites a prior value", async () => {
    await writeOAuthBackoff({ failures: 1, nextAttemptMs: 111 });
    await writeOAuthBackoff({ failures: 9, nextAttemptMs: 222 });
    const got = await readOAuthBackoff();
    assert.deepEqual(got, { failures: 9, nextAttemptMs: 222 });
  });

  test("clear removes a stored gate", async () => {
    await writeOAuthBackoff({ failures: 2, nextAttemptMs: 1 });
    assert.notEqual(await readOAuthBackoff(), null);
    await clearOAuthBackoff();
    assert.equal(await readOAuthBackoff(), null);
  });

  test("clear on an absent key is a no-op (never throws)", async () => {
    await clearOAuthBackoff();
    assert.equal(await readOAuthBackoff(), null);
  });

  test("read ignores a non-JSON stored value (fails open to null)", async () => {
    await raw.set(OAUTH_BACKOFF_KEY, "not-json-at-all");
    const got = await readOAuthBackoff();
    assert.equal(got, null);
  });

  test("read rejects a malformed shape — missing nextAttemptMs", async () => {
    await raw.set(OAUTH_BACKOFF_KEY, JSON.stringify({ failures: 4 }));
    assert.equal(await readOAuthBackoff(), null);
  });

  test("read rejects failures < 1 (a fresh ladder has failures >= 1)", async () => {
    await raw.set(
      OAUTH_BACKOFF_KEY,
      JSON.stringify({ failures: 0, nextAttemptMs: 123 }),
    );
    assert.equal(await readOAuthBackoff(), null);
  });

  test("read rejects a non-finite nextAttemptMs", async () => {
    // JSON has no Infinity literal; a hostile/corrupt writer could store null.
    await raw.set(
      OAUTH_BACKOFF_KEY,
      JSON.stringify({ failures: 2, nextAttemptMs: null }),
    );
    assert.equal(await readOAuthBackoff(), null);
  });

  test("read accepts the boundary failures === 1", async () => {
    await writeOAuthBackoff({ failures: 1, nextAttemptMs: 5 });
    assert.deepEqual(await readOAuthBackoff(), {
      failures: 1,
      nextAttemptMs: 5,
    });
  });
});

// A separate top-level suite with its own before/after lifecycle (CLAUDE.md:
// never nest under a sibling that owns a shared-Redis teardown).
describe("redis/oauth-backoff — gh-API rate-limit gate (issue #3137)", () => {
  let raw: any;

  before(() => {
    raw = new Redis(process.env.REDIS_URL as string);
  });

  beforeEach(async () => {
    await raw.del(GH_RATE_LIMIT_BACKOFF_KEY);
  });

  after(async () => {
    await raw.del(GH_RATE_LIMIT_BACKOFF_KEY);
    raw.disconnect();
  });

  // --- pure ladder (no Redis) ---

  test("nextGhRateLimitBackoff: first failure arms the 30s base", () => {
    const now = 1_000_000;
    assert.deepEqual(nextGhRateLimitBackoff(1, now), {
      failures: 1,
      nextAttemptMs: now + 30_000,
    });
  });

  test("nextGhRateLimitBackoff: doubles per consecutive failure", () => {
    const now = 0;
    assert.equal(nextGhRateLimitBackoff(2, now).nextAttemptMs, 60_000);
    assert.equal(nextGhRateLimitBackoff(3, now).nextAttemptMs, 120_000);
    assert.equal(nextGhRateLimitBackoff(4, now).nextAttemptMs, 240_000);
  });

  test("nextGhRateLimitBackoff: clamps to the ~15min ceiling", () => {
    const now = 0;
    const MAX = 15 * 60_000;
    assert.equal(nextGhRateLimitBackoff(50, now).nextAttemptMs, MAX);
  });

  test("nextGhRateLimitBackoff: clamps failures up to >= 1", () => {
    const now = 0;
    assert.deepEqual(nextGhRateLimitBackoff(0, now), {
      failures: 1,
      nextAttemptMs: 30_000,
    });
    assert.deepEqual(nextGhRateLimitBackoff(-5, now), {
      failures: 1,
      nextAttemptMs: 30_000,
    });
  });

  // --- persisted gate round-trip ---

  test("write → read round-trips the gh gate", async () => {
    const now = Date.now();
    const state = { failures: 2, nextAttemptMs: now + 60_000 };
    await writeGhRateLimitBackoff(state);
    assert.deepEqual(await readGhRateLimitBackoff(now), state);
  });

  test("write stamps a bounded TTL (<= 24h, > 0)", async () => {
    await writeGhRateLimitBackoff({ failures: 1, nextAttemptMs: Date.now() });
    const ttl = await raw.ttl(GH_RATE_LIMIT_BACKOFF_KEY);
    const DAY = 24 * 60 * 60;
    assert.ok(ttl > 0 && ttl <= DAY, `TTL should be 1..${DAY}, got ${ttl}`);
  });

  test("clear removes a stored gh gate", async () => {
    await writeGhRateLimitBackoff({ failures: 2, nextAttemptMs: Date.now() + 1 });
    assert.notEqual(await readGhRateLimitBackoff(), null);
    await clearGhRateLimitBackoff();
    assert.equal(await readGhRateLimitBackoff(), null);
  });

  test("clear on an absent key is a no-op (never throws)", async () => {
    await clearGhRateLimitBackoff();
    assert.equal(await readGhRateLimitBackoff(), null);
  });

  test("read fails open to null on a non-JSON value", async () => {
    await raw.set(GH_RATE_LIMIT_BACKOFF_KEY, "not-json");
    assert.equal(await readGhRateLimitBackoff(), null);
  });

  test("read rejects a malformed shape (missing nextAttemptMs)", async () => {
    await raw.set(GH_RATE_LIMIT_BACKOFF_KEY, JSON.stringify({ failures: 3 }));
    assert.equal(await readGhRateLimitBackoff(), null);
  });

  test("read clamps a stale nextAttemptMs down to the max ceiling", async () => {
    const now = 1_000_000_000;
    const MAX = 15 * 60_000;
    // A hostile/stale writer parks the gate 10 days out — the hydrate clamp
    // must pull it back to `now + MAX` so gh calls can never be parked longer
    // than a freshly-armed max backoff.
    await writeGhRateLimitBackoff({
      failures: 3,
      nextAttemptMs: now + 10 * 24 * 60 * 60_000,
    });
    const got = await readGhRateLimitBackoff(now);
    assert.deepEqual(got, { failures: 3, nextAttemptMs: now + MAX });
  });

  test("read does NOT clamp a within-ceiling nextAttemptMs", async () => {
    const now = 2_000_000;
    const within = now + 30_000;
    await writeGhRateLimitBackoff({ failures: 1, nextAttemptMs: within });
    assert.deepEqual(await readGhRateLimitBackoff(now), {
      failures: 1,
      nextAttemptMs: within,
    });
  });
});

// Own top-level suite + lifecycle (CLAUDE.md: never nest under a sibling's
// teardown). Covers the hour-bucketed gh-rate-limited observability counter
// (issue #3137, artifact Q6) — the historical counterpart to the resettable gate.
describe("redis/oauth-backoff — gh-rate-limited hour-bucketed counter (issue #3137 Q6)", () => {
  let raw: any;
  const COUNTER_PREFIX = "hydra:metrics:github-api:rate-limited:window-1h";

  before(() => {
    raw = new Redis(process.env.REDIS_URL as string);
  });

  // Fixed instants so the counter buckets are deterministic. Clean the exact
  // hour keys each case touches — beforeEach, not before (per-case isolation).
  const HOUR_A = new Date("2026-07-11T10:15:00.000Z"); // bucket 2026-07-11T10
  const HOUR_B = new Date("2026-07-11T11:05:00.000Z"); // bucket 2026-07-11T11

  const keyFor = (d: Date) => `${COUNTER_PREFIX}:${utcHourKey(d)}`;

  beforeEach(async () => {
    await raw.del(keyFor(HOUR_A), keyFor(HOUR_B));
  });

  after(async () => {
    await raw.del(keyFor(HOUR_A), keyFor(HOUR_B));
    raw.disconnect();
  });

  test("a rate-limited event increments the current UTC-hour bucket to 1", async () => {
    const hour = await recordGhRateLimited(HOUR_A);
    assert.equal(hour, "2026-07-11T10");
    assert.equal(await raw.hget(keyFor(HOUR_A), "count"), "1");
  });

  test("repeated rate-limited events accumulate within the same hour bucket", async () => {
    await recordGhRateLimited(HOUR_A);
    await recordGhRateLimited(HOUR_A);
    await recordGhRateLimited(HOUR_A);
    assert.equal(await raw.hget(keyFor(HOUR_A), "count"), "3");
  });

  test("the counter bucket carries a rolling TTL (<= 7 days)", async () => {
    await recordGhRateLimited(HOUR_A);
    const ttl = await raw.ttl(keyFor(HOUR_A));
    assert.ok(ttl > 0 && ttl <= 7 * 24 * 60 * 60, `ttl in (0, 7d]; got ${ttl}`);
  });

  test("window read rolls up counts across hour buckets, newest-first", async () => {
    await recordGhRateLimited(HOUR_A); // 10:00 bucket → 1
    await recordGhRateLimited(HOUR_B); // 11:00 bucket → 1
    await recordGhRateLimited(HOUR_B); // 11:00 bucket → 2
    // Read a 2-hour window ending at 11:xx: buckets are [11, 10].
    const win = await getGhRateLimitedWindow(2, HOUR_B);
    assert.equal(win.windowHours, 2);
    assert.equal(win.total, 3);
    assert.equal(win.buckets.length, 2);
    assert.equal(win.buckets[0].hour, "2026-07-11T11");
    assert.equal(win.buckets[0].count, 2);
    assert.equal(win.buckets[1].hour, "2026-07-11T10");
    assert.equal(win.buckets[1].count, 1);
  });

  test("window read returns an all-zero window when no events were recorded", async () => {
    const win = await getGhRateLimitedWindow(3, HOUR_B);
    assert.equal(win.total, 0);
    assert.equal(win.buckets.length, 3);
    for (const b of win.buckets) assert.equal(b.count, 0);
  });
});

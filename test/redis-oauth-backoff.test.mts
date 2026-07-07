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
} = await import("../src/redis/oauth-backoff.ts");

// The single key this module owns — mirrored here so the suite can seed
// malformed values and clean up without importing module internals.
const OAUTH_BACKOFF_KEY = "hydra:metrics:oauth-usage:backoff";

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

/**
 * Integration test for the OAuth backoff-persistence seam across service
 * restarts (issue #3343).
 *
 * COMPOSITION UNDER TEST — the REAL Redis adapter (`src/redis/oauth-backoff.ts`,
 * issue #2840) wired into the cached-read state machine
 * (`src/cost/oauth-read-cache.ts`, extracted #2923) via
 * `makeReadOAuth({ persistBackoff: true })` (`src/cost/transcript-scan.ts`).
 * The existing suites each cover HALF of this seam: the adapter round-trip
 * tests (`test/redis-oauth-backoff.test.mts`) never touch the state machine,
 * and the #2840 restart-resume tests (`test/usage-tracker.test.mts`) inject a
 * FAKE store, so a key-name drift, JSON-shape drift, TTL regression, or
 * fire-and-forget settlement bug in the real composition would hide from both.
 * This suite pins the composition: key name, JSON shape, TTL stamp, restart
 * resume, ladder continuation, and recovery clear — all through real ioredis.
 *
 * Service restart is simulated by `clearOAuthCache()`, which nulls the module
 * cache/backoff/in-flight state AND re-arms the once-per-process hydrate flag —
 * byte-for-byte a fresh process's module state — while the Redis key survives,
 * exactly as across `systemctl restart`. (A real subprocess spawn was rejected
 * in the design concept: the backoff state is module-level process memory, so a
 * restart IS a module-state reset.)
 *
 * `makeReadOAuth` is driven DIRECTLY (not through `getUsage()`): `getUsage`
 * computes `persistBackoff: true` only on the pure production path with no
 * injected reader, so the injected-counting-reader + real-persistence
 * composition is only reachable through this exported seam.
 *
 * The production write/clear path is fire-and-forget (`void
 * oauthBackoffPersistence.write/clear` in `oauth-read-cache.ts`), so every
 * assertion about Redis state after a read awaits settlement via BOUNDED
 * POLLING of the raw key (10ms interval, 2s hard deadline, descriptive
 * failure) — never a fixed sleep.
 *
 * Suite lifecycle (CLAUDE.md authoring rules + oauth-read-cache invariant 5):
 * a NEW top-level describe with its own before/beforeEach/afterEach/after; the
 * suite touches EXACTLY one Redis key (`hydra:metrics:oauth-usage:backoff`),
 * deleting it per-case and at teardown via a suite-owned raw ioredis client
 * (never FLUSHDB — the test DB is run-shared); afterEach restores the no-op
 * persistence adapter via `setOAuthBackoffPersistence()` AND calls
 * `clearOAuthCache()` so the live Redis seam installed by
 * `wireOAuthBackoffPersistence(true)` can never leak into a sibling suite's
 * cached-path test; only the raw fixture client is disconnected — the shared
 * `getRedisConnection()` seam connection is reaped by `--test-force-exit`.
 *
 * REDIS_URL is set by the test launcher to a per-worktree DB (2..15, never
 * production DB 0); cross-file collision on the shared key is impossible
 * within a run because `npm test` pins `--test-concurrency=1`.
 */

import { test, describe, before, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

const { makeReadOAuth } = await import("../src/cost/transcript-scan.ts");
const { setOAuthBackoffPersistence, clearOAuthCache } = await import(
  "../src/cost/oauth-read-cache.ts"
);
import type { OAuthUsageResult } from "../src/cost/oauth-usage.ts";

// The single key this suite owns — mirrored from src/redis/oauth-backoff.ts so
// the raw fixture client can seed/assert/clean without importing internals
// (same convention as test/redis-oauth-backoff.test.mts).
const OAUTH_BACKOFF_KEY = "hydra:metrics:oauth-usage:backoff";

// Env knobs pinned per-case so the ladder math is deterministic:
//   TTL 60s · maxStale 10min · backoff base 30s · backoff ceiling 15min.
const TTL_MS = 60_000;
const MAX_STALE_MS = 600_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 900_000;

const ENV_KEYS = [
  "HYDRA_OAUTH_USAGE_TTL_MS",
  "HYDRA_OAUTH_USAGE_MAX_STALE_MS",
  "HYDRA_OAUTH_USAGE_BACKOFF_BASE_MS",
  "HYDRA_OAUTH_USAGE_BACKOFF_MAX_MS",
] as const;

/** Snapshot the env knobs this suite mutates; returns the restore closure. */
function withEnvSnapshot(): () => void {
  const saved = new Map<string, string | undefined>();
  for (const k of ENV_KEYS) saved.set(k, process.env[k]);
  return () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

/**
 * Deterministic injected meter reader (the OAuth Usage Adapter seam replaced
 * per the design concept — never a live GET). Serves `results` in order,
 * repeating the last entry, and counts calls so GET-suppression is observable.
 */
function countingReader(results: OAuthUsageResult[]): {
  reader: () => Promise<OAuthUsageResult>;
  calls: () => number;
} {
  let calls = 0;
  return {
    reader: async () => {
      const r = results[Math.min(calls, results.length - 1)];
      calls++;
      return r;
    },
    calls: () => calls,
  };
}

const FAIL_429: OAuthUsageResult = { ok: false, code: "oauth-usage-non-2xx" };
const OK_READ: OAuthUsageResult = {
  ok: true,
  data: {
    fiveHour: { utilization: 42, resetsAt: null },
    sevenDay: { utilization: 17, resetsAt: null },
  },
};

/**
 * Bounded polling for the fire-and-forget persistence writes/clears (design
 * invariant: never a fixed sleep). Polls every 10ms up to a 2s hard deadline;
 * fails with a descriptive message carrying the last observed value.
 */
async function pollUntil<T>(
  read: () => Promise<T>,
  accept: (v: T) => boolean,
  what: string,
): Promise<T> {
  const deadlineMs = Date.now() + 2_000;
  for (;;) {
    const v = await read();
    if (accept(v)) return v;
    if (Date.now() >= deadlineMs) {
      assert.fail(
        `timed out (2s) waiting for ${what}; last observed: ${JSON.stringify(v)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("OAuth backoff persistence integration — real Redis adapter across restart (issue #3343)", () => {
  let raw: Redis;
  let restoreEnv: () => void;

  before(() => {
    raw = new Redis(process.env.REDIS_URL as string);
  });

  // Per-case reset (beforeEach, not before — CLAUDE.md per-case isolation rule):
  // every case reads and writes the single owned key and the module-level cache
  // state, so both must be fresh per case.
  beforeEach(async () => {
    restoreEnv = withEnvSnapshot();
    process.env.HYDRA_OAUTH_USAGE_TTL_MS = String(TTL_MS);
    process.env.HYDRA_OAUTH_USAGE_MAX_STALE_MS = String(MAX_STALE_MS);
    process.env.HYDRA_OAUTH_USAGE_BACKOFF_BASE_MS = String(BACKOFF_BASE_MS);
    process.env.HYDRA_OAUTH_USAGE_BACKOFF_MAX_MS = String(BACKOFF_MAX_MS);
    await raw.del(OAUTH_BACKOFF_KEY);
    setOAuthBackoffPersistence(); // no-op default until makeReadOAuth wires the real seam
    clearOAuthCache();
  });

  // Restore the no-op adapter AND clear the module cache so the live Redis seam
  // installed by makeReadOAuth({persistBackoff:true}) never leaks into a sibling
  // suite's cached-path test (oauth-read-cache.ts invariant 5).
  afterEach(() => {
    setOAuthBackoffPersistence();
    clearOAuthCache();
    restoreEnv();
  });

  after(async () => {
    await raw.del(OAUTH_BACKOFF_KEY);
    raw.disconnect(); // ONLY the suite-owned fixture client — never the shared seam connection
  });

  /** One cached-path read at logical instant `nowMs` through the REAL seam. */
  function readAt(nowMs: number, reader: () => Promise<OAuthUsageResult>) {
    return makeReadOAuth({
      readUsage: reader,
      nowMs,
      bypassOAuthCache: false,
      persistBackoff: true,
    })();
  }

  test("arming the backoff writes through to the real Redis key — name, JSON shape, TTL", async () => {
    const t0 = Date.parse("2026-07-15T12:00:00.000Z");
    const m = countingReader([FAIL_429]);

    const got = await readAt(t0, m.reader);
    assert.equal(m.calls(), 1, "cold cache + no gate → exactly one GET attempted");
    assert.equal(got.result.ok, false, "no last-good in a cold process → failure passes through (estimate path)");

    // The write is fire-and-forget — poll the raw key until it materializes.
    const rawValue = await pollUntil(
      () => raw.get(OAUTH_BACKOFF_KEY),
      (v) => v !== null,
      `the armed gate to appear at ${OAUTH_BACKOFF_KEY}`,
    );
    assert.deepEqual(
      JSON.parse(rawValue as string),
      { failures: 1, nextAttemptMs: t0 + BACKOFF_BASE_MS },
      "persisted JSON shape: consecutive failure #1, gate = failure instant + base delay",
    );
    const ttl = await raw.ttl(OAUTH_BACKOFF_KEY);
    const DAY_SECONDS = 24 * 60 * 60;
    assert.ok(
      ttl > 0 && ttl <= DAY_SECONDS,
      `write stamps the bounded 24h TTL (0 < ttl <= ${DAY_SECONDS}); got ${ttl}`,
    );
  });

  test("a restart mid-window RESUMES the ladder: hydrate from Redis suppresses the GET", async () => {
    const t0 = Date.parse("2026-07-15T12:00:00.000Z");

    // Arm the gate through the real seam at t0 (failures #1, window 30s).
    const armer = countingReader([FAIL_429]);
    await readAt(t0, armer.reader);
    await pollUntil(
      () => raw.get(OAUTH_BACKOFF_KEY),
      (v) => v !== null,
      "the armed gate to persist before the restart",
    );

    // "systemctl restart": module state wiped, hydrate flag re-armed, Redis
    // key left INTACT.
    clearOAuthCache();
    assert.notEqual(
      await raw.get(OAUTH_BACKOFF_KEY),
      null,
      "the persisted gate survives the restart",
    );

    // First read of the "new process", INSIDE the persisted window (t0+10s).
    const m = countingReader([FAIL_429]);
    const got = await readAt(t0 + 10_000, m.reader);
    assert.equal(
      m.calls(),
      0,
      "resumed gate SUPPRESSES the external GET — the restart did not reset the ladder",
    );
    assert.equal(
      got.result.ok,
      false,
      "no last-good in the fresh process → falls to the estimate path, never a silent 0",
    );
    assert.equal(got.stale, false, "nothing served → not a stale last-good");
    assert.equal(got.ageMs, null, "no value served → no age");
    assert.equal(got.lastKnownOAuth, null, "fresh process has no last-known meter value");
  });

  test("a post-restart failure ADVANCES the ladder from the persisted count (N → N+1), never resets to #1", async () => {
    const t0 = Date.parse("2026-07-15T12:00:00.000Z");
    // Seed a mid-ladder gate directly via the raw fixture client (a prior
    // process at consecutive failure #3, window open until t0+120s).
    await raw.set(
      OAUTH_BACKOFF_KEY,
      JSON.stringify({ failures: 3, nextAttemptMs: t0 + 120_000 }),
    );
    clearOAuthCache(); // fresh process

    const m = countingReader([FAIL_429]);

    // Read 1 — inside the resumed window: hydrates the gate, suppresses the GET.
    const suppressed = await readAt(t0 + 30_000, m.reader);
    assert.equal(m.calls(), 0, "hydrated mid-ladder gate suppresses the GET");
    assert.equal(suppressed.result.ok, false);

    // Read 2 — past the resumed window: the endpoint is probed, fails again,
    // and the ladder must continue from the PERSISTED count: 3 → 4.
    const t2 = t0 + 130_000;
    await readAt(t2, m.reader);
    assert.equal(m.calls(), 1, "post-window read re-probes exactly once");

    const advanced = await pollUntil(
      async () => {
        const v = await raw.get(OAUTH_BACKOFF_KEY);
        return v === null ? null : (JSON.parse(v) as { failures: number; nextAttemptMs: number });
      },
      (v) => v !== null && v.failures === 4,
      "the persisted ladder to advance to consecutive failure #4",
    );
    assert.deepEqual(
      advanced,
      // failures=4 → delay = base * 2^3 = 240s (below the 15min ceiling).
      { failures: 4, nextAttemptMs: t2 + BACKOFF_BASE_MS * 2 ** 3 },
      "persisted gate = resumed count + 1 with the exponential delay from that count",
    );
  });

  test("recovery after a resumed ladder CLEARS the real Redis key, so the next restart starts clean", async () => {
    const t0 = Date.parse("2026-07-15T12:00:00.000Z");

    // Arm at t0 through the real seam, then "restart".
    const armer = countingReader([FAIL_429]);
    await readAt(t0, armer.reader);
    await pollUntil(
      () => raw.get(OAUTH_BACKOFF_KEY),
      (v) => v !== null,
      "the armed gate to persist before the restart",
    );
    clearOAuthCache();

    const m = countingReader([OK_READ]);

    // Read 1 — inside the resumed window: hydrate seeds the in-memory gate from
    // Redis (GET still suppressed), so the later success exercises the true
    // recovery-clear path, not the spent-gate hydrate drop.
    await readAt(t0 + 10_000, m.reader);
    assert.equal(m.calls(), 0, "resumed window still suppresses the GET");

    // Read 2 — past the window: the probe SUCCEEDS → in-memory gate resets and
    // the persisted gate is cleared (fire-and-forget → poll until absent).
    const recovered = await readAt(t0 + 40_000, m.reader);
    assert.equal(m.calls(), 1, "post-window probe fired once and succeeded");
    assert.equal(recovered.result.ok, true, "recovered read serves the fresh meter value");
    assert.equal(recovered.stale, false);
    assert.equal(recovered.ageMs, 0, "a fresh success has age 0");

    await pollUntil(
      () => raw.get(OAUTH_BACKOFF_KEY),
      (v) => v === null,
      "recovery to clear the persisted gate",
    );
  });
});

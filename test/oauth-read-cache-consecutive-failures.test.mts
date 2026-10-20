/**
 * Unit test for the `consecutiveFailures` field on `CachedOAuthRead` (issue
 * #3821), the primitive that lets a caller distinguish "one transient blip"
 * from "a genuinely sustained outage" instead of treating every
 * `result.ok === false` from `readOAuthCached` as equally severe.
 *
 * Before this field existed, `eligibility-usage.ts` set `meterUnavailable:
 * true` off the very FIRST failed read against a cold (`null`) `oauthCache` —
 * exactly the state of every freshly-restarted process (i.e. after every
 * deploy) — which forced `allow=false` for the whole autopilot on one
 * transient GET failure. `consecutiveFailures` mirrors the SAME
 * `oauthBackoff.failures` counter the sustained-OAuth-failure alarm (issue
 * #3601, `test/oauth-sustained-failure-alarm.test.mts`) already keys on, so
 * this suite pins: 0 while healthy, incrementing per real failed GET,
 * carried forward (not re-incremented) on a backoff-suppressed synthetic
 * failure, and reset to 0 on recovery.
 *
 * Driven DIRECTLY through the exported `readOAuthCached(readUsage, nowMs)`
 * seam with an injected reader and the default no-op persistence adapter
 * (invariant 5 — no Redis), mirroring the sustained-failure-alarm suite.
 *
 * Suite lifecycle (CLAUDE.md authoring rules): a NEW top-level describe with
 * its own beforeEach/afterEach; env knobs pinned per-case; module cache +
 * backoff state reset per-case via `clearOAuthCache()`.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const { readOAuthCached, clearOAuthCache, OAUTH_SUSTAINED_FAILURE_THRESHOLD } = await import(
  "../src/cost/oauth-read-cache.ts"
);
import type { OAuthUsageResult } from "../src/cost/oauth-usage.ts";

const TTL_MS = 60_000;
const MAX_STALE_MS = 0; // no stale headroom — every post-TTL failure is a hard failure
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 900_000;
const STEP_MS = 30 * 60_000; // > the backoff ceiling, so every call clears the prior gate

const ENV_KEYS = [
  "HYDRA_OAUTH_USAGE_TTL_MS",
  "HYDRA_OAUTH_USAGE_MAX_STALE_MS",
  "HYDRA_OAUTH_USAGE_BACKOFF_BASE_MS",
  "HYDRA_OAUTH_USAGE_BACKOFF_MAX_MS",
] as const;

const FAIL: OAuthUsageResult = { ok: false, code: "oauth-usage-non-2xx" };
const OK_READ: OAuthUsageResult = {
  ok: true,
  data: {
    fiveHour: { utilization: 12, resetsAt: null },
    sevenDay: { utilization: 34, resetsAt: null },
  },
};

function fixedReader(r: OAuthUsageResult): () => Promise<OAuthUsageResult> {
  return async () => r;
}

describe("readOAuthCached consecutiveFailures field (issue #3821)", () => {
  let saved: Map<string, string | undefined>;

  beforeEach(() => {
    saved = new Map();
    for (const k of ENV_KEYS) saved.set(k, process.env[k]);
    process.env.HYDRA_OAUTH_USAGE_TTL_MS = String(TTL_MS);
    process.env.HYDRA_OAUTH_USAGE_MAX_STALE_MS = String(MAX_STALE_MS);
    process.env.HYDRA_OAUTH_USAGE_BACKOFF_BASE_MS = String(BACKOFF_BASE_MS);
    process.env.HYDRA_OAUTH_USAGE_BACKOFF_MAX_MS = String(BACKOFF_MAX_MS);
    clearOAuthCache();
  });

  afterEach(() => {
    clearOAuthCache();
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("a cold cache with a healthy meter reports consecutiveFailures: 0", async () => {
    const t0 = Date.parse("2026-07-31T00:00:00.000Z");
    const r = await readOAuthCached(fixedReader(OK_READ), t0);
    assert.equal(r.result.ok, true);
    assert.equal(r.consecutiveFailures, 0);
  });

  test("the FIRST failed read against a cold cache reports consecutiveFailures: 1 (below threshold)", async () => {
    const t0 = Date.parse("2026-07-31T00:00:00.000Z");
    const r = await readOAuthCached(fixedReader(FAIL), t0);
    assert.equal(r.result.ok, false, "no last-good to serve — cold cache");
    assert.equal(r.consecutiveFailures, 1);
    assert.ok(
      r.consecutiveFailures < OAUTH_SUSTAINED_FAILURE_THRESHOLD,
      "one blip must stay below the sustained-failure threshold",
    );
  });

  test("consecutiveFailures increments by one per re-probed failure and reaches the threshold at the 3rd", async () => {
    const t0 = Date.parse("2026-07-31T00:00:00.000Z");
    const r1 = await readOAuthCached(fixedReader(FAIL), t0);
    const r2 = await readOAuthCached(fixedReader(FAIL), t0 + STEP_MS);
    const r3 = await readOAuthCached(fixedReader(FAIL), t0 + 2 * STEP_MS);
    assert.equal(r1.consecutiveFailures, 1);
    assert.equal(r2.consecutiveFailures, 2);
    assert.equal(r3.consecutiveFailures, 3);
    assert.equal(r3.consecutiveFailures, OAUTH_SUSTAINED_FAILURE_THRESHOLD);
  });

  test("a backoff-suppressed synthetic failure (no GET made) carries the count forward, never re-increments it", async () => {
    const t0 = Date.parse("2026-07-31T00:00:00.000Z");
    let calls = 0;
    const countingFail = async (): Promise<OAuthUsageResult> => {
      calls++;
      return FAIL;
    };
    const r1 = await readOAuthCached(countingFail, t0);
    assert.equal(r1.consecutiveFailures, 1);
    // Immediately re-read WITHOUT advancing past the backoff gate: the gate
    // suppresses the GET, so this is the synthetic-failure branch.
    const r2 = await readOAuthCached(countingFail, t0 + 1);
    assert.equal(calls, 1, "the second call was suppressed by the backoff gate — no new GET");
    assert.equal(
      r2.consecutiveFailures,
      1,
      "the suppressed re-probe carries the count forward rather than re-incrementing it",
    );
  });

  test("a successful read resets consecutiveFailures to 0, clearing the ladder", async () => {
    const t0 = Date.parse("2026-07-31T00:00:00.000Z");
    await readOAuthCached(fixedReader(FAIL), t0);
    await readOAuthCached(fixedReader(FAIL), t0 + STEP_MS);
    const recovered = await readOAuthCached(fixedReader(OK_READ), t0 + 2 * STEP_MS);
    assert.equal(recovered.result.ok, true);
    assert.equal(recovered.consecutiveFailures, 0, "recovery clears the ladder back to 0");
  });
});

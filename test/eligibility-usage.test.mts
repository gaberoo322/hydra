/**
 * Unit test for `getEligibilityUsage()` (`src/cost/eligibility-usage.ts`),
 * which had ZERO test coverage before this suite (issue #3821).
 *
 * PRIMARY ACCEPTANCE CRITERION (issue #3821): a single failed usage read
 * against a cold (`null`) OAuth cache must NOT produce `meterUnavailable:
 * true` / force `allow=false` on the whole autopilot. Before this fix, PR
 * #3804 wired `overlayMeterUnavailableEligibility` to force `allow=false`
 * whenever `getEligibilityUsage()` reported `meterUnavailable: true` — and
 * that flag flipped true on the VERY FIRST failed GET whenever `oauthCache`
 * was `null`, which is the state of every freshly-restarted process (i.e.
 * after every deploy). One transient GET blip right after a deploy could
 * silently halt the whole autopilot until the next successful read.
 *
 * The fix requires SUSTAINED failure — the consecutive-failed-read count
 * reaching `OAUTH_SUSTAINED_FAILURE_THRESHOLD` (3), the same threshold
 * `oauth-read-cache.ts`'s sustained-failure alarm (#3601) already uses —
 * before `meterUnavailable` is set. This suite drives `getEligibilityUsage`
 * with an injected `readUsage`/`now`, exercising the real
 * `readOAuthCached` cache/backoff state machine underneath (not a stub),
 * so the threshold crossing is pinned end-to-end.
 *
 * Suite lifecycle (CLAUDE.md authoring rules): a NEW top-level describe with
 * its own beforeEach/afterEach; env knobs pinned per-case; the shared
 * `oauth-read-cache.ts` module state reset per-case via `clearOAuthCache()`
 * so no episode leaks across cases (mirrors
 * `test/oauth-sustained-failure-alarm.test.mts`).
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const { getEligibilityUsage } = await import("../src/cost/eligibility-usage.ts");
const { projectEligibility } = await import("../src/cost/eligibility.ts");
const { clearOAuthCache, OAUTH_SUSTAINED_FAILURE_THRESHOLD } = await import(
  "../src/cost/oauth-read-cache.ts"
);
import type { OAuthUsageResult } from "../src/cost/oauth-usage.ts";

const TTL_MS = 60_000;
const MAX_STALE_MS = 0; // no stale headroom — isolates the cold-cache failure path
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 900_000;
const STEP_MS = 30 * 60_000; // > the backoff ceiling, so every call re-probes

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

describe("getEligibilityUsage meterUnavailable gating (issue #3821)", () => {
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

  test("a healthy meter reports meterUnavailable: false with real percentages", async () => {
    const r = await getEligibilityUsage({ readUsage: fixedReader(OK_READ), now: () => 0 });
    assert.equal(r.meterUnavailable, false);
    assert.equal(r.input.usageSource, "oauth");
    assert.equal(r.input.percentLast5h, 12);
    assert.equal(r.input.percentLast7d, 34);
  });

  test("ACCEPTANCE: a single failed read against a cold cache does NOT set meterUnavailable", async () => {
    const t0 = Date.parse("2026-07-31T00:00:00.000Z");
    const r = await getEligibilityUsage({ readUsage: fixedReader(FAIL), now: () => t0 });
    assert.equal(
      r.meterUnavailable,
      false,
      "one transient blip against a cold cache (every process restart, i.e. every deploy) " +
        "must not force allow=false for the whole autopilot",
    );
    // Fail-open input is still preserved — usageSource stays 'estimate' with
    // zeroed percentages so deriveHardStop's #1124 guard stays inert.
    assert.equal(r.input.usageSource, "estimate");
    assert.equal(r.input.percentLast5h, 0);
    assert.equal(r.input.percentLast7d, 0);
  });

  test("the SECOND consecutive failed read also stays below the sustained threshold", async () => {
    const t0 = Date.parse("2026-07-31T00:00:00.000Z");
    await getEligibilityUsage({ readUsage: fixedReader(FAIL), now: () => t0 });
    const r2 = await getEligibilityUsage({ readUsage: fixedReader(FAIL), now: () => t0 + STEP_MS });
    assert.equal(r2.meterUnavailable, false);
  });

  test("SUSTAINED failure (3 consecutive) sets meterUnavailable: true", async () => {
    const t0 = Date.parse("2026-07-31T00:00:00.000Z");
    let last;
    for (let i = 0; i < OAUTH_SUSTAINED_FAILURE_THRESHOLD; i++) {
      last = await getEligibilityUsage({
        readUsage: fixedReader(FAIL),
        now: () => t0 + i * STEP_MS,
      });
    }
    assert.equal(
      last!.meterUnavailable,
      true,
      "the Nth failure crossing the sustained-failure threshold must block",
    );
    assert.equal(last!.input.usageSource, "estimate");
  });

  test("a recovery read after sub-threshold failures clears the ladder and stays available", async () => {
    const t0 = Date.parse("2026-07-31T00:00:00.000Z");
    await getEligibilityUsage({ readUsage: fixedReader(FAIL), now: () => t0 });
    const recovered = await getEligibilityUsage({
      readUsage: fixedReader(OK_READ),
      now: () => t0 + STEP_MS,
    });
    assert.equal(recovered.meterUnavailable, false);
    assert.equal(recovered.input.usageSource, "oauth");
  });

  test("a thrown reader (programming/IO fault, not a meter outage) reports meterUnavailable immediately", async () => {
    const throwing = async (): Promise<OAuthUsageResult> => {
      throw new Error("boom");
    };
    const r = await getEligibilityUsage({ readUsage: throwing, now: () => 0 });
    assert.equal(
      r.meterUnavailable,
      true,
      "a throw from the cached reader is a code fault, not a transient blip — it never " +
        "had the sustained-vs-transient distinction to make",
    );
    assert.equal(r.input.usageSource, "estimate");
  });
});

// Separate top-level describe (CLAUDE.md authoring rule: never nest under a
// sibling describe's shared teardown). This pins issue #3751's headline fix:
// the admission path's `weeklyResetAnchor` is projected forward in 7-day
// multiples (CONTEXT.md:217), so the Pacing Curve is a ramp — not a step
// permanently pinned at the Pacing Ceiling.
describe("Pacing Curve anchor rollover on the admission path (issue #3751)", () => {
  // projectEligibility (top-level import above) turns the meter input into the
  // pacing verdict; the admission path (getEligibilityUsage) must feed it a
  // ROLLED anchor.
  const ANCHOR_KEY = "HYDRA_USAGE_WEEKLY_RESET_ANCHOR";
  const CEILING_KEY = "HYDRA_USAGE_WEEKLY_PACE_CEILING";
  let saved: Map<string, string | undefined>;

  beforeEach(() => {
    saved = new Map();
    for (const k of [ANCHOR_KEY, CEILING_KEY, ...ENV_KEYS]) saved.set(k, process.env[k]);
    // The LIVE stale seed that inerts the curve when served raw (8+ weeks old
    // at filing). `getWeeklyResetAnchorMs` reads this at call time.
    process.env.HYDRA_USAGE_WEEKLY_RESET_ANCHOR = "2026-06-03T17:00:00.000Z";
    delete process.env.HYDRA_USAGE_WEEKLY_PACE_CEILING; // default ceiling 0.92
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

  // 50% rolling-7d utilization — well above any early-window ramp target, well
  // below the 90% hard stop, so it is the burn level that MUST be able to read
  // "ahead" once the anchor rolls (it could not when targetPercent was pinned 92).
  const OK_50: OAuthUsageResult = {
    ok: true,
    data: {
      fiveHour: { utilization: 30, resetsAt: null },
      sevenDay: { utilization: 50, resetsAt: null },
    },
  };

  test("INV-1: the served weeklyResetAnchor is rolled forward to the current window, not the raw seed", async () => {
    // Exactly 8 weeks after the 2026-06-03 seed → the current-window boundary is
    // 2026-07-29T17:00:00Z. Serving the raw 2026-06-03 seed is the bug.
    const now = Date.parse("2026-07-29T17:00:00.000Z");
    const r = await getEligibilityUsage({ readUsage: fixedReader(OK_50), now: () => now });
    assert.equal(r.input.weeklyResetAnchor, "2026-07-29T17:00:00.000Z");
    assert.notEqual(r.input.weeklyResetAnchor, "2026-06-03T17:00:00.000Z");
  });

  test("INV-2/3: targetPercent is a ramp (not pinned at 92) and 'ahead' is reachable below the hard stop", async () => {
    // 3h into a fresh rolled window → fraction ~0.018 → targetPercent ~1.6.
    const now = Date.parse("2026-07-29T20:00:00.000Z");
    const r = await getEligibilityUsage({ readUsage: fixedReader(OK_50), now: () => now });
    const elig = projectEligibility(r.input);
    assert.ok(
      elig.targetPercent > 0 && elig.targetPercent < 10,
      `early-window target should be a low ramp value, got ${elig.targetPercent}`,
    );
    // 50% burn >> ~1.6 target + 2 tolerance → "ahead", and 50 < 90 so the weekly
    // hard stop has NOT fired — the previously-unreachable paceState.
    assert.equal(elig.paceState, "ahead");
    assert.equal(elig.reasons.weeklyEmergencyStop, false);
    assert.equal(elig.allow, true);
  });

  test("the ramp approaches the ceiling near the window end (varies, not a constant 92)", async () => {
    // ~1h before the next boundary (6d 23h into the window): fraction ~0.994 →
    // targetPercent ~91.4, so a 50% burn now reads "behind". This is the
    // correct ramp; pre-fix, target was 92 at EVERY instant.
    const now = Date.parse("2026-07-29T16:00:00.000Z");
    const r = await getEligibilityUsage({ readUsage: fixedReader(OK_50), now: () => now });
    const elig = projectEligibility(r.input);
    assert.ok(
      elig.targetPercent > 85 && elig.targetPercent < 92,
      `late-window target should approach (but track) the ceiling, got ${elig.targetPercent}`,
    );
    assert.equal(elig.paceState, "behind");
  });
});

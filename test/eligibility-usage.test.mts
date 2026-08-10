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
const { clearOAuthCache, OAUTH_SUSTAINED_FAILURE_THRESHOLD } = await import(
  "../src/cost/oauth-read-cache.ts"
);
const { projectEligibility } = await import("../src/cost/eligibility.ts");
const { projectResetWindow } = await import("../src/cost/token-math.ts");
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

/**
 * Regression suite for issue #3751: the admission path's Pacing Curve ran INERT
 * because `getEligibilityUsage` seeded `weeklyResetAnchor` from the RAW env instant
 * instead of rolling it forward to the current-window boundary. With a stale
 * anchor (e.g. 8 weeks old), `projectPacingCurve` clamped `fraction = clamp01((now
 * - anchor)/7d)` to 1.000, pinning `targetPercent` at the full Pacing Ceiling —
 * which made `paceState === "ahead"` mathematically unreachable (you can never be
 * ahead of a target already at the ceiling) and removed the Pacing Curve's whole
 * burn-sensitivity.
 *
 * These tests pin the END-TO-END meter-only admission path (getEligibilityUsage →
 * EligibilityUsageInput → projectEligibility), driving `readUsage`/`now` with the
 * env anchor set to a deliberately STALE instant so the rollover is exercised.
 * New top-level describe with its own beforeEach/afterEach (CLAUDE.md authoring
 * rules), so the stale-anchor env never leaks into the #3821 block above.
 */
describe("getEligibilityUsage Pacing Curve anchor rollover (issue #3751)", () => {
  const ANCHOR_ENV = "2026-05-25T00:00:00.000Z"; // deliberately stale seed
  const ANCHOR_MS = Date.parse(ANCHOR_ENV);
  const DAY = 86_400_000;
  const RESET_ANCHOR_KEY = "HYDRA_USAGE_WEEKLY_RESET_ANCHOR";
  // The Pacing-Curve arithmetic below (target ≈ 13 at 1 day, < 92 at 6 days) is
  // pinned to the 0.92 default ceiling; set it explicitly so a polluted env can't
  // move it under the assertions.
  const CEILING_KEY = "HYDRA_USAGE_WEEKLY_PACE_CEILING";
  let saved: Map<string, string | undefined>;

  // A successful meter read with caller-chosen utilizations. `resetsAt: null`
  // matches the snapshot path — the env anchor, not the meter boundary, drives
  // the Pacing Curve window (INV-1/#1083's deliberate deferral).
  function okRead(opts: { fiveHour?: number; sevenDay?: number }): OAuthUsageResult {
    return {
      ok: true,
      data: {
        fiveHour: { utilization: opts.fiveHour ?? 0, resetsAt: null },
        sevenDay: { utilization: opts.sevenDay ?? 0, resetsAt: null },
      },
    };
  }

  beforeEach(() => {
    saved = new Map();
    for (const k of ENV_KEYS) saved.set(k, process.env[k]);
    saved.set(RESET_ANCHOR_KEY, process.env[RESET_ANCHOR_KEY]);
    saved.set(CEILING_KEY, process.env[CEILING_KEY]);
    process.env.HYDRA_OAUTH_USAGE_TTL_MS = String(TTL_MS);
    process.env.HYDRA_OAUTH_USAGE_MAX_STALE_MS = String(MAX_STALE_MS);
    process.env.HYDRA_OAUTH_USAGE_BACKOFF_BASE_MS = String(BACKOFF_BASE_MS);
    process.env.HYDRA_OAUTH_USAGE_BACKOFF_MAX_MS = String(BACKOFF_MAX_MS);
    process.env[RESET_ANCHOR_KEY] = ANCHOR_ENV;
    process.env[CEILING_KEY] = "0.92";
    clearOAuthCache();
  });

  afterEach(() => {
    clearOAuthCache();
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("INV-1: weeklyResetAnchor is the rolled-forward boundary, NOT the raw stale env seed", async () => {
    // 26 days = 3 full 7-day windows + 5 days. The current-window boundary is
    // ANCHOR + 3*7d (= 21d in), NOT the raw ANCHOR seed itself.
    const nowMs = ANCHOR_MS + 26 * DAY;
    const r = await getEligibilityUsage({ readUsage: fixedReader(okRead({ sevenDay: 40 })), now: () => nowMs });
    const expectedRolled = new Date(projectResetWindow(ANCHOR_MS, nowMs).currentMs).toISOString();
    assert.equal(r.input.weeklyResetAnchor, expectedRolled);
    assert.notEqual(
      r.input.weeklyResetAnchor,
      new Date(ANCHOR_MS).toISOString(),
      "the raw stale env seed must NOT surface as the admission anchor — that is the bug",
    );
  });

  test("INV-2: targetPercent RAMPs with window position (not pinned at the ceiling)", async () => {
    // Same burn; two different positions in the window. targetPercent must
    // increase as `fraction` grows — the defining property of a ramp. Before the
    // fix a stale anchor pinned fraction at 1.000, collapsing both to 92.
    const early = await getEligibilityUsage({
      readUsage: fixedReader(okRead({ sevenDay: 10 })),
      now: () => ANCHOR_MS + 1 * DAY,
    });
    clearOAuthCache();
    const late = await getEligibilityUsage({
      readUsage: fixedReader(okRead({ sevenDay: 10 })),
      now: () => ANCHOR_MS + 6 * DAY,
    });
    const earlyTarget = projectEligibility(early.input).targetPercent;
    const lateTarget = projectEligibility(late.input).targetPercent;
    assert.ok(
      earlyTarget > 0 && lateTarget > earlyTarget,
      `targetPercent must ramp up across the window (early=${earlyTarget}, late=${lateTarget})`,
    );
    assert.ok(lateTarget < 92, "target stays below the 92% ceiling mid-window (not pinned at it)");
  });

  test("INV-3: paceState 'ahead' IS reachable below the 90% emergency-stop threshold", async () => {
    // 1 day in: fraction ≈ 1/7 → target ≈ 0.92*100*(1/7) ≈ 13.1. A burn of 20%
    // sits ABOVE target+2 (ahead) yet WELL BELOW the 90% stop. Before the fix
    // target was pinned at 92, so 20% read as 'behind' and 'ahead' was unreachable
    // for any sub-90 burn.
    const r = await getEligibilityUsage({
      readUsage: fixedReader(okRead({ fiveHour: 20, sevenDay: 20 })),
      now: () => ANCHOR_MS + 1 * DAY,
    });
    const v = projectEligibility(r.input);
    assert.equal(v.paceState, "ahead", "low burn early in the window must read as 'ahead'");
    assert.equal(v.reasons.weeklyEmergencyStop, false, "20% is far below the weekly stop");
    assert.equal(v.allow, true);
  });

  test("INV-4: a meter outage yields neutral paceState 'on', not a false 'behind' from the zero", async () => {
    // Mid-window (target ≈ 66) but no meter value: the fail-open input carries
    // zeros. Those zeros MUST NOT read as 'behind' (the Pacing Curve would then
    // chase the meter during its own outage). Only the authoritative oauth source
    // drives an ahead/behind verdict.
    const nowMs = ANCHOR_MS + 26 * DAY;
    const r = await getEligibilityUsage({ readUsage: fixedReader(FAIL), now: () => nowMs });
    assert.equal(r.input.usageSource, "estimate");
    assert.equal(r.input.percentSinceReset, 0);
    assert.equal(r.meterUnavailable, false, "a single transient failure is below the sustained threshold");
    const v = projectEligibility(r.input);
    assert.equal(v.paceState, "on", "non-oauth source is neutral 'on', never a verdict off the zeros");
    assert.equal(v.allow, true, "transient outage preserves the #1124 fail-open");
  });

  test("AC1: percentSinceReset === percentLast7d (the meter's 7d utilization doubles as window position)", async () => {
    const r = await getEligibilityUsage({
      readUsage: fixedReader(okRead({ sevenDay: 42 })),
      now: () => ANCHOR_MS + 26 * DAY,
    });
    assert.equal(r.input.percentLast7d, 42);
    assert.equal(r.input.percentSinceReset, 42);
    assert.equal(r.input.percentSinceReset, r.input.percentLast7d);
  });
});

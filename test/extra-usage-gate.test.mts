/**
 * Paid-overage ("extra usage") dispatch gate.
 *
 * WHY THIS GATE EXISTS. Subscription quota is prepaid; **extra usage bills real
 * money OUTSIDE the subscription** once a rolling window is exhausted. The
 * operator's standing rule is to never spend it on ANY account. That cannot be
 * enforced by configuration, because:
 *
 *   - it is an ACCOUNT-level setting, not a Hydra one, and Hydra has no API to
 *     switch it off (the only true guarantee is the console toggle); and
 *   - `readAccessToken()` (oauth-usage.ts) re-reads the credentials file on
 *     every call so the meter auto-follows a `/login`, which means the armed
 *     state can change under a running orchestrator with no restart, no deploy,
 *     and no config edit.
 *
 * So the gate is a REFUSAL TO DISPATCH keyed off the meter: an account with
 * overage armed is one where an autopilot run could bill, and the autopilot
 * stays dark until it is disabled in the console. Because the signal rides the
 * meter, the protection follows an account switch automatically — which is the
 * property a per-account env constant could never have.
 *
 * NOT A QUOTA SIGNAL. `armed` says nothing about remaining headroom. The
 * `blocks even at trivial burn` case below is the load-bearing one: the two
 * emergency stops fire at 90% utilization, but overage engages at 100%, so a
 * threshold-based guard can only ever narrow the window — it cannot close it,
 * because the operator's own interactive sessions burn the same quota ungated.
 *
 * Two top-level describes (parser, then gate) with their own lifecycles, per
 * the CLAUDE.md authoring rules.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const { parseOAuthUsageBody } = await import("../src/cost/oauth-usage.ts");
const { getEligibilityUsage } = await import("../src/cost/eligibility-usage.ts");
const { projectEligibility } = await import("../src/cost/eligibility.ts");
const { clearOAuthCache, OAUTH_SUSTAINED_FAILURE_THRESHOLD } = await import(
  "../src/cost/oauth-read-cache.ts"
);
import type { OAuthUsageResult } from "../src/cost/oauth-usage.ts";

/** A minimal well-formed body; `extra_usage` is spliced in per-case. */
function body(extraUsage: unknown): unknown {
  const b: Record<string, unknown> = {
    five_hour: { utilization: 10, resets_at: "2026-08-14T19:49:59.000Z" },
    seven_day: { utilization: 39, resets_at: "2026-08-15T09:59:59.000Z" },
  };
  if (extraUsage !== undefined) b.extra_usage = extraUsage;
  return b;
}

describe("parseOAuthUsageBody extra_usage parsing", () => {
  test("is_enabled with the user not opting out reads as ARMED", () => {
    const d = parseOAuthUsageBody(body({ is_enabled: true, user_disabled: false, used_credits: 51547 }));
    assert.equal(d?.extraUsage?.armed, true);
    assert.equal(d?.extraUsage?.usedCredits, 51547);
  });

  test("the user's own opt-out disarms it even while the plan enables it", () => {
    const d = parseOAuthUsageBody(body({ is_enabled: true, user_disabled: true, used_credits: 10 }));
    assert.equal(
      d?.extraUsage?.armed,
      false,
      "user_disabled is the operator's console off switch — it must win over is_enabled",
    );
  });

  test("a disabled facility is not armed", () => {
    const d = parseOAuthUsageBody(body({ is_enabled: false, user_disabled: false }));
    assert.equal(d?.extraUsage?.armed, false);
  });

  test("an ABSENT extra_usage object means no overage facility, not 'armed'", () => {
    const d = parseOAuthUsageBody(body(undefined));
    assert.equal(d?.extraUsage?.armed, false);
    assert.equal(d?.extraUsage?.usedCredits, null);
  });

  test("garbage in extra_usage disarms WITHOUT invalidating an otherwise-good body", () => {
    const d = parseOAuthUsageBody(body("not-an-object"));
    assert.notEqual(d, null, "the two rolling windows remain the availability contract");
    assert.equal(d?.extraUsage?.armed, false);
    assert.equal(d?.fiveHour.utilization, 10);
    assert.equal(d?.sevenDay.utilization, 39);
  });

  test("non-boolean is_enabled does not coerce into armed", () => {
    const d = parseOAuthUsageBody(body({ is_enabled: "true", user_disabled: false }));
    assert.equal(d?.extraUsage?.armed, false, "strict === true, never a truthy coercion");
  });

  test("a non-numeric used_credits degrades to null rather than NaN", () => {
    const d = parseOAuthUsageBody(body({ is_enabled: true, used_credits: "51547" }));
    assert.equal(d?.extraUsage?.usedCredits, null);
    assert.equal(d?.extraUsage?.armed, true, "an unreadable counter must not disarm the gate");
  });

  test("OBSERVED 2026-08-14: the real team-account payload reads as ARMED", () => {
    // Verbatim shape from the live meter on the account this gate was built for.
    // `utilization: 100.0` does not reconcile with used_credits/monthly_limit
    // under either unit reading, which is exactly why the parser keeps
    // usedCredits opaque and gates on the booleans instead.
    const d = parseOAuthUsageBody(
      body({
        is_enabled: true,
        monthly_limit: 1000,
        used_credits: 51547.0,
        utilization: 100.0,
        currency: "USD",
        decimal_places: 2,
        disabled_reason: null,
        user_disabled: false,
        spend_limit_reached: false,
        credits_ever_enabled: true,
        daily: null,
        weekly: null,
      }),
    );
    assert.equal(d?.extraUsage?.armed, true);
    assert.equal(d?.extraUsage?.usedCredits, 51547);
  });
});

describe("extra usage armed blocks autopilot dispatch", () => {
  const ENV_KEYS = [
    "HYDRA_OAUTH_USAGE_TTL_MS",
    "HYDRA_OAUTH_USAGE_MAX_STALE_MS",
    "HYDRA_OAUTH_USAGE_BACKOFF_BASE_MS",
    "HYDRA_OAUTH_USAGE_BACKOFF_MAX_MS",
  ] as const;
  const STEP_MS = 30 * 60_000;
  const NOW = Date.parse("2026-08-14T18:00:00.000Z");
  let saved: Map<string, string | undefined>;

  function read(armed: boolean, sevenDay: number): OAuthUsageResult {
    return {
      ok: true,
      data: {
        fiveHour: { utilization: 0, resetsAt: null },
        sevenDay: { utilization: sevenDay, resetsAt: null },
        extraUsage: { armed, usedCredits: armed ? 51547 : null },
      },
    };
  }

  beforeEach(() => {
    saved = new Map();
    for (const k of ENV_KEYS) saved.set(k, process.env[k]);
    process.env.HYDRA_OAUTH_USAGE_TTL_MS = "60000";
    process.env.HYDRA_OAUTH_USAGE_MAX_STALE_MS = "0";
    process.env.HYDRA_OAUTH_USAGE_BACKOFF_BASE_MS = "30000";
    process.env.HYDRA_OAUTH_USAGE_BACKOFF_MAX_MS = "900000";
    clearOAuthCache();
  });

  afterEach(() => {
    clearOAuthCache();
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("ACCEPTANCE: an armed account yields allow=false with the reason named", async () => {
    const r = await getEligibilityUsage({ readUsage: async () => read(true, 39), now: () => NOW });
    assert.equal(r.input.extraUsageArmed, true);
    const v = projectEligibility(r.input);
    assert.equal(v.allow, false, "the autopilot must not dispatch on an account that can bill overage");
    assert.equal(v.reasons.extraUsageArmed, true);
  });

  test("a disarmed account is unaffected", async () => {
    const r = await getEligibilityUsage({ readUsage: async () => read(false, 39), now: () => NOW });
    assert.equal(r.input.extraUsageArmed, false);
    const v = projectEligibility(r.input);
    assert.equal(v.allow, true);
    assert.equal(v.reasons.extraUsageArmed, false);
  });

  test("LOAD-BEARING: it blocks at trivial burn, where no emergency stop can reach", async () => {
    // 1% weekly. Both hard stops fire at 90% and overage engages at 100%, so a
    // threshold guard is silent here — yet this account can still bill the
    // moment anything (including the operator's own interactive sessions,
    // which no Hydra gate sees) drives a window to exhaustion.
    const r = await getEligibilityUsage({ readUsage: async () => read(true, 1), now: () => NOW });
    const v = projectEligibility(r.input);
    assert.equal(v.reasons.emergencyStop, false);
    assert.equal(v.reasons.weeklyEmergencyStop, false);
    assert.equal(v.allow, false, "armed must block independently of any utilization threshold");
    assert.equal(v.reasons.extraUsageArmed, true);
  });

  test("a meter with no extra_usage at all does not fabricate an armed state", async () => {
    const noField: OAuthUsageResult = {
      ok: true,
      data: {
        fiveHour: { utilization: 0, resetsAt: null },
        sevenDay: { utilization: 39, resetsAt: null },
      },
    };
    const r = await getEligibilityUsage({ readUsage: async () => noField, now: () => NOW });
    assert.equal(r.input.extraUsageArmed, false);
    assert.equal(projectEligibility(r.input).allow, true);
  });

  test("a dark meter reports NOT armed — the block comes from meterUnavailable instead", async () => {
    // Attributing "armed" to an account we cannot read would be a fabricated
    // reason, and would turn every GET blip into a misleading permanent-looking
    // halt. The sustained-failure path already forces allow=false (#3804), so
    // nothing dispatches unverified.
    const fail: OAuthUsageResult = { ok: false, code: "oauth-usage-non-2xx" };
    let last;
    for (let i = 0; i < OAUTH_SUSTAINED_FAILURE_THRESHOLD; i++) {
      last = await getEligibilityUsage({ readUsage: async () => fail, now: () => NOW + i * STEP_MS });
    }
    assert.equal(last!.meterUnavailable, true);
    assert.equal(
      last!.input.extraUsageArmed,
      false,
      "no meter value means no evidence — never a fabricated overage reason",
    );
  });

  test("a snapshot-shaped input without the field defaults to not-armed", () => {
    // `UsageSnapshot` satisfies EligibilityUsageInput structurally and carries
    // no extraUsageArmed. That path gates nothing, so it must stay inert rather
    // than blocking on an absent field.
    const v = projectEligibility({
      percentLast5h: 10,
      percentLast7d: 20,
      percentSinceReset: 20,
      usageSource: "oauth",
      emergencyStop: false,
      weeklyEmergencyStop: false,
      pacingState: "under",
      calibrated: true,
      weeklyResetAnchor: null,
      generatedAt: new Date(NOW).toISOString(),
    });
    assert.equal(v.reasons.extraUsageArmed, false);
    assert.equal(v.allow, true);
  });

  test("the armed block composes with, and does not mask, an emergency stop", async () => {
    const both = await getEligibilityUsage({
      readUsage: async () => ({
        ok: true,
        data: {
          fiveHour: { utilization: 95, resetsAt: null },
          sevenDay: { utilization: 95, resetsAt: null },
          extraUsage: { armed: true, usedCredits: 1 },
        },
      }),
      now: () => NOW,
    });
    const v = projectEligibility(both.input);
    assert.equal(v.allow, false);
    assert.equal(v.reasons.emergencyStop, true, "both reasons stay independently legible");
    assert.equal(v.reasons.weeklyEmergencyStop, true);
    assert.equal(v.reasons.extraUsageArmed, true);
  });
});

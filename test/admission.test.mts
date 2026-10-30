/**
 * decideAdmission — pure mirror of pace-gate.sh's launcher ladder (issue #5101).
 *
 * Scenario map vs test/pace-gate-allow.test.mts (left untouched): every
 * ladder-reason scenario is mirrored below as a pure case. Bash-owned until slice 2/3
 * (NOT decideAdmission cases): record_tick HYDRA_REDIS_DB (x2),
 * HYDRA_AUTOPILOT_TRIGGER export (x2), missing-.allow fail-safe, #4585 model
 * selection (x7), #4843 token-refresh nudge (x6).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  decideAdmission,
  isFutureInstant,
  ADMISSION_REASONS,
  ADMISSION_CLASS_OF,
  type UsageEligibility,
  type AdmissionContext,
} from "../src/cost/index.ts";
import { classifyLaunchSignal } from "../src/redis/launch-flow.ts";

const NOW = Date.parse("2026-10-25T12:00:00.000Z");
const FUTURE = "2026-10-25T13:00:00.000Z";
const PAST = "2026-10-25T11:00:00.000Z";

function verdict(
  over: { allow?: boolean; paceState?: string; reasons?: Record<string, unknown> } = {},
): UsageEligibility {
  return {
    allow: over.allow ?? true,
    shed: [],
    reasons: {
      emergencyStop: false,
      weeklyEmergencyStop: false,
      pacingShed: false,
      fiveHourThrottleShed: false,
      calibrated: true,
      extraUsageArmed: false,
      extraUsageBlocking: false,
      paused: false,
      sessionBlockedUntil: null,
      worklessUntil: null,
      postQuotaUntil: null,
      fableExhaustedUntil: null,
      meterUnavailable: false,
      meterStale: false,
      meterAgeMs: 0,
      ...over.reasons,
    },
    paceState: over.paceState ?? "behind",
    targetPercent: 10,
    sinceResetPercent: 5,
    anchor: null,
    usage: {},
  } as unknown as UsageEligibility;
}

function ctx(over: Partial<AdmissionContext> = {}): AdmissionContext {
  return { nowMs: NOW, mode: "timer", serviceActive: false, pidAlive: false, ...over };
}

function expectReason(v: UsageEligibility, c: AdmissionContext, reason: string, admit = false) {
  const out = decideAdmission(v, c);
  assert.equal(out.reason, reason);
  assert.equal(out.admit, admit);
  assert.equal(out.class, (ADMISSION_CLASS_OF as Record<string, string>)[reason]);
  return out;
}

describe("isFutureInstant", () => {
  test("true only for a parseable instant strictly after now", () => {
    assert.equal(isFutureInstant(FUTURE, NOW), true);
    assert.equal(isFutureInstant(PAST, NOW), false);
    assert.equal(isFutureInstant(new Date(NOW).toISOString(), NOW), false);
  });
  test("null, empty and unparseable fall through", () => {
    assert.equal(isFutureInstant(null, NOW), false);
    assert.equal(isFutureInstant(undefined, NOW), false);
    assert.equal(isFutureInstant("", NOW), false);
    assert.equal(isFutureInstant("not-a-date", NOW), false);
  });
});

describe("decideAdmission ladder arms", () => {
  test("already-running-service (timer mode only)", () => {
    expectReason(verdict(), ctx({ serviceActive: true }), "already-running-service");
    expectReason(verdict(), ctx({ serviceActive: true, mode: "exec" }), "eligible-exec", true);
  });
  test("already-running-pid", () => {
    expectReason(verdict(), ctx({ pidAlive: true }), "already-running-pid");
  });
  test("paused", () => {
    expectReason(verdict({ allow: false, reasons: { paused: true } }), ctx(), "paused");
  });
  test("session-blocked while future; past falls through to launch", () => {
    expectReason(
      verdict({ allow: false, reasons: { sessionBlockedUntil: FUTURE } }),
      ctx(),
      "session-blocked",
    );
    expectReason(verdict({ reasons: { sessionBlockedUntil: PAST } }), ctx(), "eligible-launch", true);
  });
  test("emergency-stop", () => {
    expectReason(verdict({ allow: false, reasons: { emergencyStop: true } }), ctx(), "emergency-stop");
  });
  test("weekly-emergency-stop (#1790)", () => {
    expectReason(
      verdict({ allow: false, reasons: { weeklyEmergencyStop: true } }),
      ctx(),
      "weekly-emergency-stop",
    );
  });
  test("extra-usage-armed keys off extraUsageBlocking (#4560)", () => {
    expectReason(
      verdict({ allow: false, reasons: { extraUsageArmed: true, extraUsageBlocking: true } }),
      ctx(),
      "extra-usage-armed",
    );
  });
  test("armed but not blocking launches with the informational note (#4560)", () => {
    const out = expectReason(
      verdict({ reasons: { extraUsageArmed: true } }),
      ctx(),
      "eligible-launch",
      true,
    );
    assert.equal(out.note, "extra-usage-armed-not-blocking");
  });
  test("legacy route: armed folded into allow:false with no blocking field => allow-false (#4560)", () => {
    expectReason(
      verdict({ allow: false, reasons: { extraUsageArmed: true } }),
      ctx(),
      "allow-false",
    );
  });
  test("meter-unavailable", () => {
    expectReason(
      verdict({ allow: false, reasons: { meterUnavailable: true } }),
      ctx(),
      "meter-unavailable",
    );
  });
  test("allow:false with no specific reason is the catch-all (#1790)", () => {
    expectReason(verdict({ allow: false }), ctx(), "allow-false");
    expectReason(verdict({ allow: false }), ctx({ mode: "exec" }), "allow-false");
  });
  test("pace-ahead coexists with allow:true", () => {
    expectReason(verdict({ paceState: "ahead" }), ctx(), "pace-ahead");
  });
  test("five-hour-headroom in both modes; shed:false launches (#4836)", () => {
    expectReason(verdict({ reasons: { fiveHourThrottleShed: true } }), ctx(), "five-hour-headroom");
    expectReason(
      verdict({ reasons: { fiveHourThrottleShed: true } }),
      ctx({ mode: "exec" }),
      "five-hour-headroom",
    );
    expectReason(verdict({ reasons: { fiveHourThrottleShed: false } }), ctx(), "eligible-launch", true);
  });
  test("post-quota-cooldown future in both modes; past launches (#4836)", () => {
    expectReason(verdict({ reasons: { postQuotaUntil: FUTURE } }), ctx(), "post-quota-cooldown");
    expectReason(
      verdict({ reasons: { postQuotaUntil: FUTURE } }),
      ctx({ mode: "exec" }),
      "post-quota-cooldown",
    );
    expectReason(verdict({ reasons: { postQuotaUntil: PAST } }), ctx(), "eligible-launch", true);
  });
  test("workless-backoff future skips without flipping allow; past launches (#2956)", () => {
    expectReason(verdict({ reasons: { worklessUntil: FUTURE } }), ctx(), "workless-backoff");
    expectReason(verdict({ reasons: { worklessUntil: PAST } }), ctx(), "eligible-launch", true);
  });
  test("eligible-launch on behind; eligible-exec in exec mode", () => {
    expectReason(verdict(), ctx(), "eligible-launch", true);
    expectReason(verdict(), ctx({ mode: "exec" }), "eligible-exec", true);
  });
  test("a read-only fold never mutates the verdict", () => {
    const v = verdict({ reasons: { worklessUntil: FUTURE } });
    const before = JSON.stringify(v);
    decideAdmission(v, ctx());
    assert.equal(JSON.stringify(v), before);
  });
});

describe("decideAdmission arm ordering", () => {
  test("first matching arm wins when several arms are satisfied at once", () => {
    const everything = verdict({
      allow: false,
      paceState: "ahead",
      reasons: {
        paused: true,
        sessionBlockedUntil: FUTURE,
        emergencyStop: true,
        weeklyEmergencyStop: true,
        extraUsageBlocking: true,
        meterUnavailable: true,
        fiveHourThrottleShed: true,
        postQuotaUntil: FUTURE,
        worklessUntil: FUTURE,
      },
    });
    const peel: Array<[string, (v: UsageEligibility, c: AdmissionContext) => void]> = [
      ["already-running-service", () => {}],
      ["already-running-pid", (_v, c) => (c.serviceActive = false)],
      ["paused", (_v, c) => (c.pidAlive = false)],
      ["session-blocked", (v) => (v.reasons.paused = false)],
      ["emergency-stop", (v) => (v.reasons.sessionBlockedUntil = null)],
      ["weekly-emergency-stop", (v) => (v.reasons.emergencyStop = false)],
      ["extra-usage-armed", (v) => (v.reasons.weeklyEmergencyStop = false)],
      ["meter-unavailable", (v) => (v.reasons.extraUsageBlocking = false)],
      ["allow-false", (v) => (v.reasons.meterUnavailable = false)],
      ["pace-ahead", (v) => (v.allow = true)],
      ["five-hour-headroom", (v) => (v.paceState = "on")],
      ["post-quota-cooldown", (v) => (v.reasons.fiveHourThrottleShed = false)],
      ["workless-backoff", (v) => (v.reasons.postQuotaUntil = null)],
      ["eligible-launch", (v) => (v.reasons.worklessUntil = null)],
    ];
    const c = ctx({ serviceActive: true, pidAlive: true });
    for (const [reason, mutate] of peel) {
      mutate(everything, c);
      assert.equal(decideAdmission(everything, c).reason, reason);
    }
  });
});

describe("reason vocabulary", () => {
  test("ADMISSION_REASONS covers the record_tick literals in pace-gate.sh (post-#5102)", () => {
    const script = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "autopilot", "pace-gate.sh"),
      "utf8",
    );
    // Literal first arguments only: `record_tick "$VAR"` pass-throughs do not match.
    const literals = new Set(
      [...script.matchAll(/record_tick "([a-z][^"]*)"/g)].map((m) => m[1]),
    );
    assert.deepEqual(
      [...literals].sort(),
      [
        "allow-invalid",
        "curl-missing",
        "eligibility-unparseable",
        "eligibility-unreachable",
        "jq-missing",
        "token-refresh-nudge",
      ],
    );
    const known = new Set<string>(ADMISSION_REASONS);
    for (const l of literals) assert.ok(known.has(l), l);
    assert.equal(ADMISSION_REASONS.length, 21);
    assert.ok(script.includes('record_tick "$ADMISSION_REASON" "$ADMISSION_CLASS"'));
    const owned = [
      "already-running-service",
      "already-running-pid",
      "paused",
      "session-blocked",
      "emergency-stop",
      "weekly-emergency-stop",
      "extra-usage-armed",
      "meter-unavailable",
      "allow-false",
      "pace-ahead",
      "five-hour-headroom",
      "post-quota-cooldown",
      "workless-backoff",
      "eligible-exec",
      "eligible-launch",
    ];
    for (const r of owned) assert.ok(!literals.has(r), `${r} must not be a bash literal`);
  });
  test("every reason has a class", () => {
    for (const r of ADMISSION_REASONS) assert.ok(ADMISSION_CLASS_OF[r], r);
  });
  test("the watchdog reason map classifies unknown reasons as healthy", () => {
    assert.equal(classifyLaunchSignal("paused"), "pause");
    assert.equal(classifyLaunchSignal("something-new"), "healthy");
  });
});

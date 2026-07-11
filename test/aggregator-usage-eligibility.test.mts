/**
 * Zero-IO composition tests for the usage-eligibility aggregator leaf
 * (issue #3182, arch-scan #788).
 *
 * These exercise `getEligibilityView` DIRECTLY — no Express Router, no
 * supertest, no mockReq/mockRes. The verdict is constructed purely from a
 * canned snapshot + injected stub readers + a fixed clock, which is the
 * structural proof the leaf is zero-IO: it composes only what its `deps` bag
 * hands it.
 *
 * The high-value cases here are the three fail-safe fallback branches that were
 * INVISIBLE before this extraction — reachable end-to-end only through a full
 * Express request cycle against a Redis that happened to be down. Each is now a
 * first-class unit case: a rejected overlay-input read must degrade its slice to
 * the safe default (not paused / no block / not workless) and NEVER wedge the
 * verdict off.
 *
 * Authored as NEW top-level describes (not nested under a sibling teardown),
 * per the CLAUDE.md authoring rule. Zero Redis: every read is a stub.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  getEligibilityView,
  type EligibilityViewDeps,
} from "../src/aggregators/usage-eligibility.ts";
import type { UsageSnapshot } from "../src/cost/index.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW_MS = Date.parse("2026-06-02T12:00:00.000Z");
const FUTURE_MS = NOW_MS + 60 * 60 * 1000; // +1h — a live block/hint
const PAST_MS = NOW_MS - 60 * 60 * 1000; // -1h — an expired block/hint

const emptyBreakdown = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreation: 0,
  total: 0,
};

/** A minimal, calibrated, fully-eligible snapshot (allow=true, no shed). */
function snapshotWith(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  const base: UsageSnapshot = {
    tokensLast5h: { ...emptyBreakdown },
    tokensLast7d: { ...emptyBreakdown },
    tokensLast24h: 0,
    percentLast5h: 20,
    percentLast7d: 20,
    usageSource: "estimate",
    oauthError: null,
    oauthStale: false,
    oauthAgeMs: null,
    oauthFiveHourResetsAt: null,
    oauthSevenDayResetsAt: null,
    projectedWeeklyPercent: 20,
    pacingState: "under",
    emergencyStop: false,
    weeklyEmergencyStop: false,
    calibrated: true,
    byModel: {
      opus: { ...emptyBreakdown },
      sonnet: { ...emptyBreakdown },
      haiku: { ...emptyBreakdown },
      unknown: { ...emptyBreakdown },
    },
    bySkillByModel: {},
    bySkillWoW: {},
    byDispatchKind: {
      "autopilot-dispatched": {
        opus: { ...emptyBreakdown },
        sonnet: { ...emptyBreakdown },
        haiku: { ...emptyBreakdown },
        unknown: { ...emptyBreakdown },
      },
      "operator-invoked": {
        opus: { ...emptyBreakdown },
        sonnet: { ...emptyBreakdown },
        haiku: { ...emptyBreakdown },
        unknown: { ...emptyBreakdown },
      },
      interactive: {
        opus: { ...emptyBreakdown },
        sonnet: { ...emptyBreakdown },
        haiku: { ...emptyBreakdown },
        unknown: { ...emptyBreakdown },
      },
    },
    attributedPercent: 0,
    quotaWeightLast5h: 0,
    quotaWeightLast7d: 0,
    quotaWeightCalibrated: false,
    weeklyQuotaTokens: 0,
    fiveHourQuotaTokens: 0,
    filesScanned: 0,
    filesSkippedByMtime: 0,
    linesParsed: 0,
    linesWithUsage: 0,
    parseErrors: 0,
    generatedAt: "2026-06-02T00:00:00.000Z",
    cacheHitRatioLast5h: 0,
    cacheHitRatioLast7d: 0,
    tokensSinceReset: { ...emptyBreakdown },
    percentSinceReset: 0,
    weeklyResetAnchor: null,
  };
  return { ...base, ...overrides };
}

function deps(overrides: Partial<EligibilityViewDeps> = {}): EligibilityViewDeps {
  return {
    snapshot: snapshotWith(),
    readPaused: async () => false,
    readSessionBlockedUntil: async () => null,
    readWorklessUntil: async () => null,
    now: () => NOW_MS,
    ...overrides,
  };
}

// A rejecting reader that also proves the failMessage path is exercised.
const boom = <T>() => async (): Promise<T> => {
  throw new Error("redis-down");
};

// ---------------------------------------------------------------------------
// Happy-path composition
// ---------------------------------------------------------------------------

describe("getEligibilityView — pure composition (issue #3182)", () => {
  test("all reads clean, nothing set → allow=true, no overlays applied", async () => {
    const v = await getEligibilityView(deps());
    assert.equal(v.allow, true);
    assert.equal(v.reasons.paused, false);
    assert.equal(v.reasons.sessionBlockedUntil, null);
    assert.equal(v.reasons.worklessUntil, null);
  });

  test("emergencyStop snapshot → allow=false (projection, no overlay needed)", async () => {
    const v = await getEligibilityView(
      deps({ snapshot: snapshotWith({ emergencyStop: true }) }),
    );
    assert.equal(v.allow, false);
    assert.equal(v.reasons.emergencyStop, true);
  });

  test("paused=true → allow=false + reasons.paused=true", async () => {
    const v = await getEligibilityView(deps({ readPaused: async () => true }));
    assert.equal(v.allow, false);
    assert.equal(v.reasons.paused, true);
  });

  test("future session block → allow=false + ISO sessionBlockedUntil", async () => {
    const v = await getEligibilityView(
      deps({ readSessionBlockedUntil: async () => FUTURE_MS }),
    );
    assert.equal(v.allow, false);
    assert.equal(
      v.reasons.sessionBlockedUntil,
      new Date(FUTURE_MS).toISOString(),
    );
  });

  test("past session block → no overlay (self-clears), allow stays true", async () => {
    const v = await getEligibilityView(
      deps({ readSessionBlockedUntil: async () => PAST_MS }),
    );
    assert.equal(v.allow, true);
    assert.equal(v.reasons.sessionBlockedUntil, null);
  });

  test("future workless hint → advisory only: worklessUntil set, allow UNCHANGED", async () => {
    const v = await getEligibilityView(
      deps({ readWorklessUntil: async () => FUTURE_MS }),
    );
    // The workless overlay must NOT flip allow (ADMISSION-vs-work boundary).
    assert.equal(v.allow, true);
    assert.equal(v.reasons.worklessUntil, new Date(FUTURE_MS).toISOString());
  });

  test("clock injection drives the future-vs-past cutoff", async () => {
    // Same block instant, but a clock PAST it → no overlay.
    const v = await getEligibilityView(
      deps({
        readSessionBlockedUntil: async () => FUTURE_MS,
        now: () => FUTURE_MS + 1,
      }),
    );
    assert.equal(v.allow, true);
    assert.equal(v.reasons.sessionBlockedUntil, null);
  });

  test("all three overlays compose: pause + session-block + workless", async () => {
    const v = await getEligibilityView(
      deps({
        readPaused: async () => true,
        readSessionBlockedUntil: async () => FUTURE_MS,
        readWorklessUntil: async () => FUTURE_MS,
      }),
    );
    assert.equal(v.allow, false);
    assert.equal(v.reasons.paused, true);
    assert.equal(
      v.reasons.sessionBlockedUntil,
      new Date(FUTURE_MS).toISOString(),
    );
    assert.equal(v.reasons.worklessUntil, new Date(FUTURE_MS).toISOString());
  });
});

// ---------------------------------------------------------------------------
// Fail-safe fallback branches — the previously-invisible coverage
// ---------------------------------------------------------------------------

describe("getEligibilityView — fail-safe overlay-input reads (issue #3182)", () => {
  test("pause read throws → degrades to NOT paused (never blocks), allow stays true", async () => {
    const v = await getEligibilityView(deps({ readPaused: boom<boolean>() }));
    assert.equal(v.allow, true);
    assert.equal(v.reasons.paused, false);
  });

  test("session-block read throws → degrades to NO block, allow stays true", async () => {
    const v = await getEligibilityView(
      deps({ readSessionBlockedUntil: boom<number | null>() }),
    );
    assert.equal(v.allow, true);
    assert.equal(v.reasons.sessionBlockedUntil, null);
  });

  test("workless read throws → degrades to NOT workless, worklessUntil null", async () => {
    const v = await getEligibilityView(
      deps({ readWorklessUntil: boom<number | null>() }),
    );
    assert.equal(v.reasons.worklessUntil, null);
  });

  test("every overlay read throws AT ONCE → verdict degrades to the clean projection", async () => {
    const v = await getEligibilityView(
      deps({
        readPaused: boom<boolean>(),
        readSessionBlockedUntil: boom<number | null>(),
        readWorklessUntil: boom<number | null>(),
      }),
    );
    // All three reads down must NOT wedge the loop off: the verdict is exactly
    // the pure snapshot projection with no overlays applied.
    assert.equal(v.allow, true);
    assert.equal(v.reasons.paused, false);
    assert.equal(v.reasons.sessionBlockedUntil, null);
    assert.equal(v.reasons.worklessUntil, null);
  });

  test("a failed pause read does NOT suppress a live session block on another read", async () => {
    // Independent degradation: pause slice fails safe, but the session-block
    // read still succeeds and its overlay still applies.
    const v = await getEligibilityView(
      deps({
        readPaused: boom<boolean>(),
        readSessionBlockedUntil: async () => FUTURE_MS,
      }),
    );
    assert.equal(v.reasons.paused, false);
    assert.equal(v.allow, false);
    assert.equal(
      v.reasons.sessionBlockedUntil,
      new Date(FUTURE_MS).toISOString(),
    );
  });

  test("getEligibilityView never rejects even when all overlay reads reject", async () => {
    // The composition is total over overlay-read rejection (the snapshot is
    // pre-read by the route outside the guards; only the three overlay reads
    // are guarded here). await must resolve, not throw.
    await assert.doesNotReject(() =>
      getEligibilityView(
        deps({
          readPaused: boom<boolean>(),
          readSessionBlockedUntil: boom<number | null>(),
          readWorklessUntil: boom<number | null>(),
        }),
      ),
    );
  });
});

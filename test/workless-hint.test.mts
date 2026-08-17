/**
 * Regression tests for the workless-board backoff hint (issue #2956).
 *
 * The Pace Gate's admission check is purely usage-based; it never asks whether
 * any work is eligible. When every autopilot class is on cooldown and no signals
 * fire, a launched session's first decide.py turn is wait-only with zero
 * occupied slots and it terminates cause=idle after ~2 minutes, having
 * dispatched nothing — ~14% of runs were these zero-dispatch idle exits, each
 * burning a full claude session bootstrap for nothing. Shape 1 (idle-exit
 * backoff): endRun stamps a short temporal hint on a zero-dispatch idle exit,
 * and while it is future the pace-gate skips relaunch. This suite pins:
 *
 *   - the Redis accessor: set/get/clear round-trip, TTL, fail-safe-to-not-
 *     workless on a corrupt / absent / past value, set refuses a non-future
 *     instant;
 *   - worklessBackoffSec: env override + fail-safe-to-default on garbage;
 *   - overlayWorklessEligibility (pure): surfaces reasons.worklessUntil while
 *     future WITHOUT flipping allow; no-op on null/past;
 *   - the eligibility verdict's composition leaf (`getEligibilityView`, what the
 *     GET /usage/eligibility route delegates to): folds the workless hint into
 *     reasons.worklessUntil — pinned with injected deps, never live quota state
 *     (issue #3765).
 *
 * The endRun zero-dispatch stamping is pinned in test/autopilot-runs-deps.test.mts
 * (the deps-injection suite that already owns the endRun idempotency cases).
 *
 * Uses Redis DB 1 — never touches production (DB 0). A file-level after() hook
 * closes the Redis client so the runner emits `# pass N` lines (PR #518 lesson).
 */

import { test, describe, beforeEach, after, before } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

import {
  getWorklessUntil,
  setWorklessUntil,
  clearWorklessUntil,
  worklessBackoffSec,
  worklessBackoffPostworkSec,
  WORKLESS_BACKOFF_DEFAULT_SEC,
  WORKLESS_BACKOFF_POSTWORK_DEFAULT_SEC,
  WORKLESS_TTL_BUFFER_SEC,
} from "../src/redis/workless-hint.ts";
import { overlayWorklessEligibility, projectEligibility } from "../src/cost/eligibility.ts";
import type { UsageSnapshot } from "../src/cost/index.ts";
import { redisKeys } from "../src/redis/keys.ts";
import { getEligibilityView, type EligibilityViewDeps } from "../src/aggregators/usage-eligibility.ts";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/1";
process.env.REDIS_URL = REDIS_URL;

let redis: any;

async function cleanKey() {
  await redis.del(redisKeys.autopilotWorklessUntil());
}

// Single module-level lifecycle: open the shared client ONCE and close it ONCE
// at the very end (PR #518 / shared-client lesson).
before(() => {
  redis = new Redis(REDIS_URL);
});

after(async () => {
  if (redis) {
    await cleanKey();
    redis.disconnect();
  }
});

/**
 * A minimal snapshot that projects to a clean, fully-eligible verdict
 * (`allow=true`, no shed) — the deterministic baseline the advisory workless
 * overlay is folded onto. Shared by the pure-overlay and composition cases
 * below. Cast through `unknown` so a test stub needn't build a whole
 * `UsageSnapshot` (`projectEligibility` only reads the hard-stop + pacing
 * scalars on this slice).
 */
const CLEAN_ELIGIBLE_SNAPSHOT = {
  emergencyStop: false,
  weeklyEmergencyStop: false,
  calibrated: true,
  weeklyResetAnchor: null,
  percentSinceReset: 0,
} as unknown as UsageSnapshot;

// Fixed clock + a future workless-hint instant, injected into `getEligibilityView`
// so the future-vs-past overlay cutoff never depends on wall-clock time or live
// Redis (issue #3765).
const NOW_MS = Date.parse("2026-06-02T12:00:00.000Z");
const FUTURE_HINT_MS = NOW_MS + 30 * 60 * 1000; // +30m — a live workless hint

/**
 * Build a resolved `EligibilityViewDeps` bag pinned to the clean snapshot + a
 * fixed clock, with the three overlay-input readers defaulting to their safe
 * "nothing set" values. The workless reader — the one knob these cases vary —
 * is the single overridable input. Mirrors the injection pattern in
 * `test/aggregator-usage-eligibility.test.mts`, so the verdict is decided by
 * the injected snapshot alone, NEVER by live production quota state.
 */
function eligibilityDeps(
  overrides: Partial<EligibilityViewDeps> = {},
): EligibilityViewDeps {
  return {
    snapshot: CLEAN_ELIGIBLE_SNAPSHOT,
    readPaused: async () => false,
    readSessionBlockedUntil: async () => null,
    readWorklessUntil: async () => null,
    now: () => NOW_MS,
    ...overrides,
  };
}

describe("workless-hint Redis accessor (issue #2956)", () => {
  beforeEach(cleanKey);

  test("absent key reads as not workless (null)", async () => {
    assert.equal(await getWorklessUntil(), null);
  });

  test("set writes the instant and a self-expiring TTL; get reads it back", async () => {
    const now = Date.now();
    const worklessUntil = now + 45 * 60 * 1000; // +45m
    const stored = await setWorklessUntil(worklessUntil, now);
    assert.equal(stored, worklessUntil);

    assert.equal(await getWorklessUntil(now), worklessUntil);

    const ttl = await redis.ttl(redisKeys.autopilotWorklessUntil());
    const expected = 45 * 60 + WORKLESS_TTL_BUFFER_SEC;
    assert.ok(ttl > expected - 10 && ttl <= expected + 1, `ttl=${ttl} expected≈${expected}`);
  });

  test("clear removes the key", async () => {
    const now = Date.now();
    await setWorklessUntil(now + 60_000, now);
    await clearWorklessUntil();
    assert.equal(await getWorklessUntil(now), null);
  });

  test("a past instant reads as not workless (self-clear guard)", async () => {
    const now = Date.now();
    // Write a raw past value directly (set() would refuse it).
    await redis.set(redisKeys.autopilotWorklessUntil(), String(now - 5000));
    assert.equal(await getWorklessUntil(now), null);
  });

  test("a corrupt value fails SAFE to not workless", async () => {
    await redis.set(redisKeys.autopilotWorklessUntil(), "not-a-number");
    assert.equal(await getWorklessUntil(), null);
  });

  test("set refuses a non-future instant (no-op, returns null)", async () => {
    const now = Date.now();
    assert.equal(await setWorklessUntil(now - 1000, now), null);
    assert.equal(await redis.get(redisKeys.autopilotWorklessUntil()), null);
  });
});

describe("worklessBackoffSec (issue #2956)", () => {
  test("missing env => the 45-min default", () => {
    assert.equal(worklessBackoffSec({}), WORKLESS_BACKOFF_DEFAULT_SEC);
  });

  test("a valid positive value is honored", () => {
    assert.equal(worklessBackoffSec({ HYDRA_WORKLESS_BACKOFF_SEC: "600" }), 600);
  });

  test("a non-positive / garbage value fails SAFE to the default", () => {
    assert.equal(worklessBackoffSec({ HYDRA_WORKLESS_BACKOFF_SEC: "0" }), WORKLESS_BACKOFF_DEFAULT_SEC);
    assert.equal(worklessBackoffSec({ HYDRA_WORKLESS_BACKOFF_SEC: "-5" }), WORKLESS_BACKOFF_DEFAULT_SEC);
    assert.equal(worklessBackoffSec({ HYDRA_WORKLESS_BACKOFF_SEC: "nope" }), WORKLESS_BACKOFF_DEFAULT_SEC);
  });
});

// Issue #3867 slice 2 — the POST-WORK window: a deliberate SIBLING of
// worklessBackoffSec (own constant, own env override) rather than a mode
// parameter, so each window stays independently tunable and unit-testable.
describe("worklessBackoffPostworkSec (issue #3867)", () => {
  test("missing env => the 20-min post-work default", () => {
    assert.equal(worklessBackoffPostworkSec({}), WORKLESS_BACKOFF_POSTWORK_DEFAULT_SEC);
  });

  test("a valid positive value is honored via its OWN env var", () => {
    assert.equal(
      worklessBackoffPostworkSec({ HYDRA_WORKLESS_BACKOFF_POSTWORK_SEC: "300" }),
      300,
    );
  });

  test("a non-positive / garbage value fails SAFE to the post-work default", () => {
    for (const raw of ["0", "-5", "nope", ""]) {
      assert.equal(
        worklessBackoffPostworkSec({ HYDRA_WORKLESS_BACKOFF_POSTWORK_SEC: raw }),
        WORKLESS_BACKOFF_POSTWORK_DEFAULT_SEC,
        `raw=${JSON.stringify(raw)} must fail safe to the default`,
      );
    }
  });

  test("the two windows are INDEPENDENT — neither env var bleeds into the other", () => {
    // Overriding the zero-dispatch window must not move the post-work window,
    // and vice-versa: they are separate operator knobs.
    assert.equal(
      worklessBackoffPostworkSec({ HYDRA_WORKLESS_BACKOFF_SEC: "999" }),
      WORKLESS_BACKOFF_POSTWORK_DEFAULT_SEC,
    );
    assert.equal(
      worklessBackoffSec({ HYDRA_WORKLESS_BACKOFF_POSTWORK_SEC: "999" }),
      WORKLESS_BACKOFF_DEFAULT_SEC,
    );
  });

  test("the post-work default is strictly SHORTER than the zero-dispatch default", () => {
    assert.ok(
      WORKLESS_BACKOFF_POSTWORK_DEFAULT_SEC < WORKLESS_BACKOFF_DEFAULT_SEC,
      "a productive drain must back off for LESS time than a workless board",
    );
    // ...and longer than the pace-gate's ~15-min tick, or it would fail to
    // suppress the one wasted relaunch it exists to prevent.
    assert.ok(
      WORKLESS_BACKOFF_POSTWORK_DEFAULT_SEC > 15 * 60,
      "must outlast the ~15-min pace-gate tick to suppress the wasted relaunch",
    );
  });
});

describe("overlayWorklessEligibility (pure) (issue #2956)", () => {
  // Reuses CLEAN_ELIGIBLE_SNAPSHOT (projects allow=true, paceState "on").

  test("a FUTURE hint surfaces reasons.worklessUntil WITHOUT flipping allow", () => {
    const now = Date.now();
    const base = projectEligibility(CLEAN_ELIGIBLE_SNAPSHOT);
    assert.equal(base.allow, true, "precondition: base projection allows");

    const overlaid = overlayWorklessEligibility(base, now + 30 * 60 * 1000, now);
    // Launcher-only: allow is untouched so decide.py never drains on it.
    assert.equal(overlaid.allow, true);
    assert.equal(typeof overlaid.reasons.worklessUntil, "string");
    assert.equal(new Date(overlaid.reasons.worklessUntil as string).getTime(), now + 30 * 60 * 1000);
  });

  test("a null hint returns the input UNCHANGED", () => {
    const now = Date.now();
    const base = projectEligibility(CLEAN_ELIGIBLE_SNAPSHOT);
    const overlaid = overlayWorklessEligibility(base, null, now);
    assert.equal(overlaid.reasons.worklessUntil, null);
    assert.equal(overlaid.allow, base.allow);
  });

  test("a PAST hint returns the input UNCHANGED (self-heals)", () => {
    const now = Date.now();
    const base = projectEligibility(CLEAN_ELIGIBLE_SNAPSHOT);
    const overlaid = overlayWorklessEligibility(base, now - 1000, now);
    assert.equal(overlaid.reasons.worklessUntil, null);
  });
});

describe("GET /api/usage/eligibility folds the workless hint (issue #2956)", () => {
  // The verdict's `allow` is decided by the projected snapshot, NOT by the
  // workless overlay. We exercise the pure composition leaf (`getEligibilityView`)
  // the route delegates to, with a canned clean snapshot + injected readers + a
  // fixed clock — NOT the real `createUsageRouter()` handler, which reads LIVE
  // production quota state out of shared Redis (`getUsage`) and then asserts
  // `allow`, going red whenever the weekly emergency stop is tripped (issue
  // #3765). The workless overlay is advisory-only; these cases pin that boundary
  // deterministically against injected state.

  test("a future workless hint appears under reasons.worklessUntil; allow stays true", async () => {
    // Baseline: a clean snapshot with no hint admits (allow=true, worklessUntil=null).
    const baseline = await getEligibilityView(
      eligibilityDeps({ readWorklessUntil: async () => null }),
    );
    assert.equal(baseline.allow, true, "baseline: a clean snapshot allows");
    assert.equal(baseline.reasons.worklessUntil, null);

    // With a future hint the overlay surfaces the instant but must NOT flip allow.
    const overlaid = await getEligibilityView(
      eligibilityDeps({ readWorklessUntil: async () => FUTURE_HINT_MS }),
    );
    assert.equal(overlaid.allow, true, "advisory overlay must not flip allow");
    assert.equal(
      overlaid.reasons.worklessUntil,
      new Date(FUTURE_HINT_MS).toISOString(),
    );
  });

  test("no hint => reasons.worklessUntil is null", async () => {
    const v = await getEligibilityView(
      eligibilityDeps({ readWorklessUntil: async () => null }),
    );
    assert.equal(v.reasons.worklessUntil, null);
  });
});

/**
 * Unit tests for `src/holdback-policy.ts` — the pure Outcome-Holdback
 * tier-enrollment policy (issue #3095, anchoring the module extracted in
 * #2671).
 *
 * The module owns three deterministic predicates:
 *   - `isEnrolledTier`     — which tiers enroll in an Outcome Holdback watch.
 *   - `windowCyclesForTier` — how long the watch window runs for a tier.
 *   - `isHoldbackEligibleOutcome` — which declared outcomes may drive the
 *     decision (`kind: leading` + `holdback: include`, issue #4413).
 *
 * All are pure — tier arithmetic over env-read constants, or a function of
 * the validated outcome record; no Redis, no filesystem, no event bus — so
 * these are pure unit tests with no fixture. They pin the tier-membership +
 * monotonic-window contract the module's docstring commits to (#741,
 * ADR-0015 monotonic ladder) so a future edit can't silently break which
 * merges get an Outcome Holdback watch, or invert the window ordering.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  isEnrolledTier,
  windowCyclesForTier,
  isHoldbackEligibleOutcome,
  HOLDBACK_WINDOW_CYCLES,
  HOLDBACK_WINDOW_CYCLES_T3,
  HOLDBACK_ENROL_MAX_ATTEMPTS,
  classifyEnrolNoEnrollState,
  nextEnrolFailureRecord,
  nextEnrolOutcomeRecord,
  shouldRecordManualAttemptFailure,
} from "../src/holdback-policy.ts";

describe("holdback-policy — isEnrolledTier (tier-membership contract)", () => {
  test("T1 (prompt-shaped) does not enroll", () => {
    assert.equal(isEnrolledTier(1), false);
  });

  test("T2, T3, T4 enroll (the carry-up tiers)", () => {
    assert.equal(isEnrolledTier(2), true);
    assert.equal(isEnrolledTier(3), true);
    assert.equal(isEnrolledTier(4), true);
  });

  test("null / undefined never enroll (unresolvable tier is 'no signal')", () => {
    assert.equal(isEnrolledTier(null), false);
    assert.equal(isEnrolledTier(undefined), false);
  });

  test("tiers outside the {2,3,4} set (0, 5, negatives) do not enroll", () => {
    assert.equal(isEnrolledTier(0), false);
    assert.equal(isEnrolledTier(5), false);
    assert.equal(isEnrolledTier(-1), false);
  });
});

describe("holdback-policy — windowCyclesForTier (monotonic + floor contract)", () => {
  test("T2 returns the floor window (HOLDBACK_WINDOW_CYCLES)", () => {
    assert.equal(windowCyclesForTier(2), HOLDBACK_WINDOW_CYCLES);
  });

  test("T3 is at least the T2 floor and matches the configured T3 window", () => {
    const t3 = windowCyclesForTier(3);
    assert.equal(t3, Math.max(HOLDBACK_WINDOW_CYCLES_T3, HOLDBACK_WINDOW_CYCLES));
    assert.ok(t3 >= windowCyclesForTier(2), "T3 window must be >= T2 window");
  });

  test("window is monotonic non-decreasing across T2 <= T3 <= T4", () => {
    const t2 = windowCyclesForTier(2);
    const t3 = windowCyclesForTier(3);
    const t4 = windowCyclesForTier(4);
    assert.ok(t2 <= t3, `T2 (${t2}) must be <= T3 (${t3})`);
    assert.ok(t3 <= t4, `T3 (${t3}) must be <= T4 (${t4})`);
  });

  test("T1 / null / undefined fall back to the T2 floor", () => {
    assert.equal(windowCyclesForTier(1), HOLDBACK_WINDOW_CYCLES);
    assert.equal(windowCyclesForTier(null), HOLDBACK_WINDOW_CYCLES);
    assert.equal(windowCyclesForTier(undefined), HOLDBACK_WINDOW_CYCLES);
  });

  test("all windows are finite non-negative integers (floor-clamped)", () => {
    for (const tier of [1, 2, 3, 4, null, undefined] as const) {
      const w = windowCyclesForTier(tier);
      assert.ok(Number.isFinite(w), `window for tier ${tier} must be finite`);
      assert.ok(w >= 0, `window for tier ${tier} must be non-negative`);
    }
  });
});

describe("holdback-policy — isHoldbackEligibleOutcome (per-outcome holdback opt-out, #4413)", () => {
  // The predicate is pure over the validated Outcome record: eligibility is
  // `kind === "leading" && holdback === "include"`. All four cells of the
  // (kind × holdback) matrix are pinned so neither conjunct can be dropped
  // silently. The former hardcoded exclusion name set (#4247, emptied by #4410)
  // is gone — a target declares the opt-out in outcomes.yaml, not in src/.
  test("leading + include → eligible (the default for every declared leading outcome)", () => {
    assert.equal(isHoldbackEligibleOutcome({ kind: "leading", holdback: "include" }), true);
  });

  test("leading + exclude → NOT eligible (declarative display-only opt-out)", () => {
    assert.equal(isHoldbackEligibleOutcome({ kind: "leading", holdback: "exclude" }), false);
  });

  test("terminal outcomes are never eligible regardless of the holdback field", () => {
    // Terminal outcomes are too slow for any watch window (outcomes.yaml +
    // CONTEXT.md). `holdback: exclude` on a terminal row is accepted and
    // inert — the kind conjunct already rules it out.
    assert.equal(isHoldbackEligibleOutcome({ kind: "terminal", holdback: "include" }), false);
    assert.equal(isHoldbackEligibleOutcome({ kind: "terminal", holdback: "exclude" }), false);
  });
});

describe("holdback-policy — classifyEnrolNoEnrollState (issue #4632)", () => {
  test("an exemption reason classifies as 'exempt'", () => {
    assert.equal(
      classifyEnrolNoEnrollState("tier T1 is exempt from Outcome Holdback (only T2/T3/T4 enroll)"),
      "exempt",
    );
  });

  test("any other enrolled:false reason classifies as 'no-signal'", () => {
    assert.equal(classifyEnrolNoEnrollState("no leading outcomes declared"), "no-signal");
    assert.equal(classifyEnrolNoEnrollState("no leading-outcome adapter returned data at enroll time"), "no-signal");
    assert.equal(classifyEnrolNoEnrollState(undefined), "no-signal");
  });
});

describe("holdback-policy — nextEnrolFailureRecord / nextEnrolOutcomeRecord attempt ladder (issue #4632 INV-6)", () => {
  test("a first-ever failure starts the ladder at attempts=1, state='retrying', firstSeenAt=now", () => {
    const next = nextEnrolFailureRecord(null, "2026-09-20T00:00:00.000Z");
    assert.deepEqual(next, { attempts: 1, firstSeenAt: "2026-09-20T00:00:00.000Z", state: "retrying" });
  });

  test("the ladder reaches 'failed' exactly at HOLDBACK_ENROL_MAX_ATTEMPTS, never before", () => {
    let prior: { attempts: number; firstSeenAt: string } | null = null;
    for (let i = 1; i <= HOLDBACK_ENROL_MAX_ATTEMPTS; i++) {
      const next = nextEnrolFailureRecord(prior, "2026-09-20T00:00:00.000Z");
      assert.equal(next.attempts, i);
      if (i < HOLDBACK_ENROL_MAX_ATTEMPTS) {
        assert.equal(next.state, "retrying", `attempt ${i} of ${HOLDBACK_ENROL_MAX_ATTEMPTS} must still be retrying`);
      } else {
        assert.equal(next.state, "failed", `attempt ${i} reaches the ceiling and must be failed`);
      }
      prior = next;
    }
  });

  test("firstSeenAt carries forward from the prior record across the ladder", () => {
    const first = nextEnrolFailureRecord(null, "2026-09-19T00:00:00.000Z");
    const second = nextEnrolFailureRecord(first, "2026-09-20T00:00:00.000Z");
    assert.equal(second.firstSeenAt, "2026-09-19T00:00:00.000Z");
  });

  test("nextEnrolOutcomeRecord always resets attempts to 0 and carries firstSeenAt forward", () => {
    const priorFailure = nextEnrolFailureRecord(null, "2026-09-19T00:00:00.000Z");
    const outcome = nextEnrolOutcomeRecord(priorFailure, "2026-09-20T00:00:00.000Z");
    assert.deepEqual(outcome, { attempts: 0, firstSeenAt: "2026-09-19T00:00:00.000Z" });
  });

  test("nextEnrolOutcomeRecord on a genuinely new SHA (no prior record) uses now as firstSeenAt", () => {
    const outcome = nextEnrolOutcomeRecord(null, "2026-09-20T00:00:00.000Z");
    assert.deepEqual(outcome, { attempts: 0, firstSeenAt: "2026-09-20T00:00:00.000Z" });
  });
});

describe("holdback-policy — shouldRecordManualAttemptFailure (issue #4632 INV-11)", () => {
  test("a SHA with no prior enrol-state record must NEVER get one invented on an enroll failure", () => {
    assert.equal(shouldRecordManualAttemptFailure(null), false);
    assert.equal(shouldRecordManualAttemptFailure(undefined), false);
  });

  test("a SHA that already has a prior enrol-state record DOES get an attempt-failure recorded", () => {
    assert.equal(shouldRecordManualAttemptFailure({ state: "retrying" }), true);
  });
});

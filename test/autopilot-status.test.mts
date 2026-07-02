/**
 * Regression tests for the shared AutopilotStatus seam (issue #2673).
 *
 * `getAutopilotStatusSnapshot()` composes the "what is the autopilot doing
 * right now" read-model from injectable readers under the deps-injectable /
 * never-throw / opt-in-field-group contract. These tests pin:
 *
 *   1. Always-read field-groups (lifecycle, currentRun, scheduler) project from
 *      their readers.
 *   2. Never-throw: a rejecting sub-reader degrades to its safe default and the
 *      rest still ship; the entrypoint never throws.
 *   3. Opt-in field-groups: `eligibility` / `history` are `null` unless
 *      requested — so a non-consumer (the autopilot-tick projection) issues no
 *      extra read.
 *   4. Source-of-truth ordering: the lifecycle slice is the truth for `running`
 *      (issue #888); the scheduler heartbeat is carried separately.
 *
 * All readers are stubbed — no live Redis, no subprocess, no server.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  getAutopilotStatusSnapshot,
  type AutopilotStatusDeps,
  type EligibilityView,
} from "../src/autopilot/status.ts";
import type { AutopilotLifecycle } from "../src/autopilot/run-projections.ts";
import type { LiveRunView, RunDigest } from "../src/autopilot/run-health.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RUNNING_LIFECYCLE: AutopilotLifecycle = {
  state: "running",
  run_id: "ap-1",
  term_reason: null,
  ended_epoch: null,
};

const CURRENT_RUN_VIEW: Record<string, unknown> = {
  run_id: "ap-1",
  started: "2026-07-02T11:00:00Z",
  turns: 4,
};

const ELIGIBILITY: EligibilityView = {
  paceState: "on",
  targetPercent: 42,
  sinceResetPercent: 40,
  anchor: "2026-06-30T00:00:00Z",
  emergencyStop: false,
  calibrated: true,
  percentLast5h: 12,
};

/** Deps that resolve every reader with a fixed fixture — no I/O. */
function stubDeps(over: Partial<AutopilotStatusDeps> = {}): AutopilotStatusDeps {
  return {
    readLifecycle: async () => RUNNING_LIFECYCLE,
    readCurrentRun: async () => CURRENT_RUN_VIEW,
    readScheduler: async () => ({
      running: false,
      lastTickAt: "2026-07-02T11:59:00Z",
    }),
    readEligibility: async () => ELIGIBILITY,
    readLiveRun: async () => CURRENT_RUN_VIEW as unknown as LiveRunView,
    readRecentRuns: async () =>
      [{ term_reason: "idle", dispatches: 0 }] as unknown as RunDigest[],
    readOsHeartbeatAgeS: () => 7,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Always-read field-groups
// ---------------------------------------------------------------------------

describe("getAutopilotStatusSnapshot — always-read slices (issue #2673)", () => {
  test("projects lifecycle, currentRun, scheduler from their readers", async () => {
    const snap = await getAutopilotStatusSnapshot(stubDeps());
    assert.equal(snap.lifecycle.state, "running");
    assert.equal(snap.lifecycle.run_id, "ap-1");
    assert.equal(snap.currentRun?.run_id, "ap-1");
    assert.equal(snap.scheduler.running, false);
    assert.equal(snap.scheduler.lastTickAt, "2026-07-02T11:59:00Z");
  });

  test("running is lifecycle truth, not scheduler (issue #888)", async () => {
    // Scheduler heartbeat says NOT running, lifecycle says running → the
    // lifecycle slice is the truth the tick route keys `running` off.
    const snap = await getAutopilotStatusSnapshot(
      stubDeps({
        readScheduler: async () => ({ running: false, lastTickAt: "t" }),
      }),
    );
    assert.equal(snap.lifecycle.state === "running", true);
    assert.equal(snap.scheduler.running, false);
  });
});

// ---------------------------------------------------------------------------
// Opt-in field-groups
// ---------------------------------------------------------------------------

describe("getAutopilotStatusSnapshot — opt-in field-groups (issue #2673)", () => {
  test("eligibility + history are null when not requested (no extra read)", async () => {
    let eligRead = false;
    let recentRead = false;
    const snap = await getAutopilotStatusSnapshot(
      stubDeps({
        readEligibility: async () => {
          eligRead = true;
          return ELIGIBILITY;
        },
        readRecentRuns: async () => {
          recentRead = true;
          return [];
        },
      }),
    );
    assert.equal(snap.eligibility, null);
    assert.equal(snap.history, null);
    assert.equal(eligRead, false, "eligibility reader must not be called");
    assert.equal(recentRead, false, "recent-runs reader must not be called");
  });

  test("eligibility is read only when options.eligibility is set", async () => {
    const snap = await getAutopilotStatusSnapshot(stubDeps(), {
      eligibility: true,
    });
    assert.equal(snap.eligibility?.paceState, "on");
    assert.equal(snap.eligibility?.targetPercent, 42);
    assert.equal(snap.history, null);
  });

  test("history is read only when options.history is set", async () => {
    const snap = await getAutopilotStatusSnapshot(stubDeps(), {
      history: true,
      historyWindow: 5,
    });
    assert.equal(snap.eligibility, null);
    assert.equal(snap.history?.liveRun !== null, true);
    assert.equal(snap.history?.recentRuns.length, 1);
    assert.equal(snap.history?.osHeartbeatAgeS, 7);
  });

  test("historyWindow is forwarded to the recent-runs reader", async () => {
    let sawLimit = -1;
    await getAutopilotStatusSnapshot(
      stubDeps({
        readRecentRuns: async (limit) => {
          sawLimit = limit;
          return [];
        },
      }),
      { history: true, historyWindow: 9 },
    );
    assert.equal(sawLimit, 9);
  });
});

// ---------------------------------------------------------------------------
// Never-throw contract
// ---------------------------------------------------------------------------

describe("getAutopilotStatusSnapshot — never-throw (issue #2673)", () => {
  test("a rejecting lifecycle reader degrades to idle; the rest still ship", async () => {
    const snap = await getAutopilotStatusSnapshot(
      stubDeps({
        readLifecycle: async () => {
          throw new Error("redis down");
        },
      }),
    );
    assert.equal(snap.lifecycle.state, "idle");
    assert.equal(snap.lifecycle.run_id, null);
    // Sibling slices still shipped.
    assert.equal(snap.currentRun?.run_id, "ap-1");
    assert.equal(snap.scheduler.lastTickAt, "2026-07-02T11:59:00Z");
  });

  test("a rejecting current-run reader degrades to null", async () => {
    const snap = await getAutopilotStatusSnapshot(
      stubDeps({
        readCurrentRun: async () => {
          throw new Error("boom");
        },
      }),
    );
    assert.equal(snap.currentRun, null);
    assert.equal(snap.lifecycle.state, "running");
  });

  test("a rejecting eligibility reader degrades to null (opt-in)", async () => {
    const snap = await getAutopilotStatusSnapshot(
      stubDeps({
        readEligibility: async () => {
          throw new Error("cost read failed");
        },
      }),
      { eligibility: true },
    );
    assert.equal(snap.eligibility, null);
  });

  test("a rejecting history reader degrades its slice; the group still ships", async () => {
    const snap = await getAutopilotStatusSnapshot(
      stubDeps({
        readLiveRun: async () => {
          throw new Error("live read failed");
        },
      }),
      { history: true },
    );
    assert.equal(snap.history?.liveRun, null);
    assert.equal(snap.history?.recentRuns.length, 1);
  });

  test("a throwing os-heartbeat reader fails open to null age", async () => {
    const snap = await getAutopilotStatusSnapshot(
      stubDeps({
        readOsHeartbeatAgeS: () => {
          throw new Error("hb file gone");
        },
      }),
      { history: true },
    );
    assert.equal(snap.history?.osHeartbeatAgeS, null);
  });
});

/**
 * Unit tests for the autopilot-tick aggregator (issue #3114).
 *
 * These call `getAutopilotTick(deps)` DIRECTLY with injected reader stubs —
 * no Express Router, no mockReq/mockRes, no findHandler. That is the zero-IO
 * proof: the leaf constructs the response purely from injected readers + a
 * fixed clock, importing no snapshot/Redis seam.
 *
 * The four route-level cases in test/now-page.test.mts stay unchanged and
 * green (they prove the route wires the aggregator end-to-end); these add the
 * pure/zero-IO composition seam alongside them.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  getAutopilotTick,
  defaultReadSchedulerStatus,
  defaultReadCurrentRun,
  defaultReadAutopilotLifecycle,
} from "../src/aggregators/autopilot-tick.ts";
import { AutopilotTickResponseSchema } from "../src/schemas/now-page.ts";
import type { AutopilotStatusSnapshot } from "../src/autopilot/status.ts";

const CLOCK = () => new Date("2026-06-02T12:00:00.000Z");

describe("getAutopilotTick — pure composition (issue #3114)", () => {
  test("running derives from lifecycle.state, NOT the scheduler heartbeat (#888)", async () => {
    // Scheduler heartbeat says running=true, but lifecycle is idle → running=false.
    const result = await getAutopilotTick({
      readSchedulerStatus: async () => ({
        running: true,
        lastTickAt: "2026-06-02T11:59:00Z",
      }),
      readCurrentRun: async () => null,
      readLifecycle: async () => ({
        state: "idle",
        runId: "ap-1",
        termReason: "budget",
        endedEpoch: 1700,
      }),
      now: CLOCK,
    });
    assert.equal(
      result.running,
      false,
      "running must follow lifecycle, not heartbeat",
    );
    assert.equal(result.lastTickAt, "2026-06-02T11:59:00Z");
    assert.equal(result.lifecycle.state, "idle");
    assert.equal(result.lifecycle.termReason, "budget");
    assert.equal(result.generatedAt, "2026-06-02T12:00:00.000Z");
    assert.equal(AutopilotTickResponseSchema.safeParse(result).success, true);
  });

  test("lifecycle running → running=true, currentRun passes through", async () => {
    const result = await getAutopilotTick({
      readSchedulerStatus: async () => ({ running: false, lastTickAt: null }),
      readCurrentRun: async () => ({
        id: "ap-2",
        startedAt: "2026-06-02T11:30:00Z",
        trigger: "scheduled",
        turns: 3,
        dispatches: 1,
        elapsedSeconds: 1800,
        ageSeconds: 5,
      }),
      readLifecycle: async () => ({
        state: "running",
        runId: "ap-2",
        termReason: null,
        endedEpoch: null,
      }),
      now: CLOCK,
    });
    assert.equal(result.running, true);
    assert.equal(result.lifecycle.state, "running");
    assert.equal(result.currentRun?.id, "ap-2");
    assert.equal(AutopilotTickResponseSchema.safeParse(result).success, true);
  });

  test("rejected lifecycle degrades to idle + running=false, other slices survive (never-throw)", async () => {
    const result = await getAutopilotTick({
      readSchedulerStatus: async () => ({
        running: true,
        lastTickAt: "2026-06-02T11:59:00Z",
      }),
      readCurrentRun: async () => null,
      readLifecycle: async () => {
        throw new Error("redis down");
      },
      now: CLOCK,
    });
    assert.equal(result.running, false);
    assert.equal(result.lifecycle.state, "idle");
    assert.equal(result.lifecycle.runId, null);
    // scheduler slice survived the lifecycle rejection
    assert.equal(result.lastTickAt, "2026-06-02T11:59:00Z");
    assert.equal(AutopilotTickResponseSchema.safeParse(result).success, true);
  });

  test("rejected scheduler-status degrades to lastTickAt=null while lifecycle/run survive", async () => {
    const result = await getAutopilotTick({
      readSchedulerStatus: async () => {
        throw new Error("scheduler read failed");
      },
      readCurrentRun: async () => null,
      readLifecycle: async () => ({
        state: "crashed",
        runId: "ap-3",
        termReason: "crash",
        endedEpoch: 1800,
      }),
      now: CLOCK,
    });
    assert.equal(result.lastTickAt, null);
    assert.equal(result.running, false);
    assert.equal(result.lifecycle.state, "crashed");
    assert.equal(result.lifecycle.termReason, "crash");
    assert.equal(result.lifecycle.endedEpoch, 1800);
    assert.equal(AutopilotTickResponseSchema.safeParse(result).success, true);
  });

  test("rejected current-run degrades to null while other slices survive", async () => {
    const result = await getAutopilotTick({
      readSchedulerStatus: async () => ({
        running: false,
        lastTickAt: "2026-06-02T11:59:00Z",
      }),
      readCurrentRun: async () => {
        throw new Error("run read failed");
      },
      readLifecycle: async () => ({
        state: "running",
        runId: "ap-4",
        termReason: null,
        endedEpoch: null,
      }),
      now: CLOCK,
    });
    assert.equal(result.currentRun, null);
    assert.equal(result.running, true);
    assert.equal(AutopilotTickResponseSchema.safeParse(result).success, true);
  });

  test("now defaults to a real clock when omitted (generatedAt is an ISO string)", async () => {
    const result = await getAutopilotTick({
      readSchedulerStatus: async () => ({ running: false, lastTickAt: null }),
      readCurrentRun: async () => null,
      readLifecycle: async () => ({
        state: "idle",
        runId: null,
        termReason: null,
        endedEpoch: null,
      }),
    });
    assert.equal(typeof result.generatedAt, "string");
    assert.ok(
      Number.isFinite(Date.parse(result.generatedAt)),
      "generatedAt parses as a date",
    );
    assert.equal(AutopilotTickResponseSchema.safeParse(result).success, true);
  });
});

// ---------------------------------------------------------------------------
// Default snapshot projections (issue #3181).
//
// These call the three `defaultRead*` helpers DIRECTLY with a canned
// `AutopilotStatusSnapshot` — no Express, no snapshot IO. Before #3181 this
// normalization (the `trigger` fallback to `"manual"`, the `view.age_s`
// coerce-to-0, the `run_id`/`started` guards) lived in the route file and could
// only be exercised through a full request cycle.
// ---------------------------------------------------------------------------

function baseSnapshot(
  over: Partial<AutopilotStatusSnapshot> = {},
): AutopilotStatusSnapshot {
  return {
    lifecycle: {
      state: "idle",
      run_id: null,
      term_reason: null,
      ended_epoch: null,
    },
    currentRun: null,
    scheduler: { running: false, lastTickAt: null },
    eligibility: null,
    history: null,
    ...over,
  };
}

describe("defaultReadSchedulerStatus — projection (issue #3181)", () => {
  test("projects scheduler.{running,lastTickAt} verbatim", () => {
    const out = defaultReadSchedulerStatus(
      baseSnapshot({
        scheduler: { running: true, lastTickAt: "2026-06-02T11:59:00Z" },
      }),
    );
    assert.deepEqual(out, {
      running: true,
      lastTickAt: "2026-06-02T11:59:00Z",
    });
  });

  test("carries a null lastTickAt through", () => {
    const out = defaultReadSchedulerStatus(
      baseSnapshot({ scheduler: { running: false, lastTickAt: null } }),
    );
    assert.deepEqual(out, { running: false, lastTickAt: null });
  });
});

describe("defaultReadCurrentRun — projection + normalization (issue #3181)", () => {
  test("null currentRun view → null", () => {
    assert.equal(defaultReadCurrentRun(baseSnapshot({ currentRun: null })), null);
  });

  test("missing run_id → null (guard)", () => {
    const out = defaultReadCurrentRun(
      baseSnapshot({ currentRun: { started: "2026-06-02T11:30:00Z" } }),
    );
    assert.equal(out, null);
  });

  test("missing started → null (guard)", () => {
    const out = defaultReadCurrentRun(
      baseSnapshot({ currentRun: { run_id: "ap-1" } }),
    );
    assert.equal(out, null);
  });

  test("fully-populated view projects every field", () => {
    const out = defaultReadCurrentRun(
      baseSnapshot({
        currentRun: {
          run_id: "ap-2",
          started: "2026-06-02T11:30:00Z",
          trigger: "scheduled",
          turns: 3,
          dispatches: 1,
          elapsed_s: 1800,
          age_s: 5,
        },
      }),
    );
    assert.deepEqual(out, {
      id: "ap-2",
      startedAt: "2026-06-02T11:30:00Z",
      trigger: "scheduled",
      turns: 3,
      dispatches: 1,
      elapsedSeconds: 1800,
      ageSeconds: 5,
    });
  });

  test("missing/non-number optional fields normalize (trigger→manual, numbers→0)", () => {
    const out = defaultReadCurrentRun(
      baseSnapshot({
        currentRun: {
          run_id: "ap-3",
          started: "2026-06-02T11:30:00Z",
          // trigger absent, turns/dispatches/elapsed_s/age_s wrong-typed
          turns: "3",
          dispatches: null,
          elapsed_s: undefined,
          age_s: "5",
        },
      }),
    );
    assert.deepEqual(out, {
      id: "ap-3",
      startedAt: "2026-06-02T11:30:00Z",
      trigger: "manual",
      turns: 0,
      dispatches: 0,
      elapsedSeconds: 0,
      ageSeconds: 0,
    });
  });
});

describe("defaultReadAutopilotLifecycle — projection (issue #3181)", () => {
  test("renames snapshot lifecycle fields to the payload shape", () => {
    const out = defaultReadAutopilotLifecycle(
      baseSnapshot({
        lifecycle: {
          state: "crashed",
          run_id: "ap-9",
          term_reason: "crash",
          ended_epoch: 1800,
        },
      }),
    );
    assert.deepEqual(out, {
      state: "crashed",
      runId: "ap-9",
      termReason: "crash",
      endedEpoch: 1800,
    });
  });

  test("carries null lifecycle fields through (idle)", () => {
    const out = defaultReadAutopilotLifecycle(baseSnapshot());
    assert.deepEqual(out, {
      state: "idle",
      runId: null,
      termReason: null,
      endedEpoch: null,
    });
  });
});

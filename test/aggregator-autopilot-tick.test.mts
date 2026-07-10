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

import { getAutopilotTick } from "../src/aggregators/autopilot-tick.ts";
import { AutopilotTickResponseSchema } from "../src/schemas/now-page.ts";

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

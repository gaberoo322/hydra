/**
 * Regression tests for the behavior-gallery aggregator (issue #620, PRD #615).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  getBehaviorGallery,
  classifyOutcome,
  runMatchesFilters,
  clampLimit,
  type BehaviorRow,
} from "../src/aggregators/behavior-gallery.ts";

function row(overrides: Partial<BehaviorRow> = {}): BehaviorRow {
  return {
    runId: "run-stub",
    startedAt: "2026-05-26T00:00:00Z",
    durationS: 600,
    status: "completed",
    outcome: "success",
    trigger: "manual",
    turns: 1,
    dispatches: 0,
    mergedCount: 0,
    failedCount: 0,
    totalTokens: 0,
    totalCostUsd: 0,
    exitCode: 0,
    termReason: null,
    classes: [],
    detailHref: "/autopilot/run-stub",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure classifiers
// ---------------------------------------------------------------------------

describe("classifyOutcome", () => {
  test("running status → in-progress", () => {
    assert.equal(classifyOutcome("running", null, null), "in-progress");
  });
  test("completed + exit 0 → success", () => {
    assert.equal(classifyOutcome("completed", 0, null), "success");
  });
  test("completed + exit 1 → failure", () => {
    assert.equal(classifyOutcome("completed", 1, null), "failure");
  });
  test("completed + no exit code → success (pre-issue-498 schema)", () => {
    assert.equal(classifyOutcome("completed", null, null), "success");
  });
  test("failed status → failure", () => {
    assert.equal(classifyOutcome("failed", null, null), "failure");
  });
  test("aborted status → aborted", () => {
    assert.equal(classifyOutcome("aborted", null, null), "aborted");
  });
  test("term_reason aborted → aborted even when status is empty", () => {
    assert.equal(classifyOutcome("", null, "aborted"), "aborted");
  });
  test("unknown status → unknown", () => {
    assert.equal(classifyOutcome("weird", null, null), "unknown");
  });
});

describe("runMatchesFilters", () => {
  test("no filters → match everything", () => {
    assert.equal(runMatchesFilters(row(), {}), true);
  });
  test("outcome mismatch → reject", () => {
    assert.equal(runMatchesFilters(row({ outcome: "success" }), { outcome: "failure" }), false);
  });
  test("outcome match → accept", () => {
    assert.equal(runMatchesFilters(row({ outcome: "success" }), { outcome: "success" }), true);
  });
  test("class filter matches when class present", () => {
    assert.equal(
      runMatchesFilters(row({ classes: ["dev_orch", "qa"] }), { class: "dev_orch" }),
      true,
    );
  });
  test("class filter rejects when class absent", () => {
    assert.equal(
      runMatchesFilters(row({ classes: ["qa"] }), { class: "dev_orch" }),
      false,
    );
  });
  test("class filter is case-insensitive", () => {
    assert.equal(
      runMatchesFilters(row({ classes: ["DEV_ORCH"] }), { class: "dev_orch" }),
      true,
    );
  });
});

describe("clampLimit", () => {
  test("default for non-finite", () => {
    assert.equal(clampLimit(NaN), 50);
  });
  test("clamps below 1", () => {
    assert.equal(clampLimit(0), 1);
  });
  test("clamps above 200", () => {
    assert.equal(clampLimit(500), 200);
  });
});

// ---------------------------------------------------------------------------
// Integration shape
// ---------------------------------------------------------------------------

describe("getBehaviorGallery — happy path", () => {
  test("returns rows with classified outcome and joined classes", async () => {
    const listRuns = async () => ({
      ok: true as const,
      runs: [
        {
          run_id: "r1",
          started: "2026-05-26T00:00:00Z",
          duration_s: 120,
          status: "completed",
          exit_code: 0,
          term_reason: null,
          trigger: "manual",
          turns: 3,
          dispatches: 2,
          merged_count: 1,
          failed_count: 0,
          total_tokens: 5000,
          total_cost_usd: 0.05,
        },
        {
          run_id: "r2",
          started: "2026-05-26T01:00:00Z",
          duration_s: null,
          status: "running",
          exit_code: undefined,
          term_reason: null,
          trigger: "scheduled",
          turns: 1,
          dispatches: 0,
          merged_count: 0,
          failed_count: 0,
          total_tokens: 0,
          total_cost_usd: 0,
        },
      ],
    });
    const fetchClasses = async (id: string) => (id === "r1" ? ["dev_orch", "qa"] : []);

    const result = await getBehaviorGallery(10, {}, { listRuns, fetchClasses });
    assert.equal(result.length, 2);
    assert.equal(result[0].runId, "r1");
    assert.equal(result[0].outcome, "success");
    assert.deepEqual(result[0].classes, ["dev_orch", "qa"]);
    assert.equal(result[1].outcome, "in-progress");
    assert.equal(result[0].detailHref, "/autopilot/r1");
  });

  test("filters by outcome before limit", async () => {
    const listRuns = async () => ({
      ok: true as const,
      runs: [
        { run_id: "a", started: "x", status: "running", duration_s: null, trigger: "m", turns: 0, dispatches: 0, merged_count: 0, failed_count: 0, total_tokens: 0, total_cost_usd: 0 },
        { run_id: "b", started: "x", status: "completed", exit_code: 0, duration_s: 1, trigger: "m", turns: 0, dispatches: 0, merged_count: 0, failed_count: 0, total_tokens: 0, total_cost_usd: 0 },
        { run_id: "c", started: "x", status: "failed", duration_s: 1, trigger: "m", turns: 0, dispatches: 0, merged_count: 0, failed_count: 0, total_tokens: 0, total_cost_usd: 0 },
      ],
    });
    const fetchClasses = async () => [];
    const result = await getBehaviorGallery(10, { outcome: "failure" }, { listRuns, fetchClasses });
    assert.equal(result.length, 1);
    assert.equal(result[0].runId, "c");
  });

  test("returns [] on listRuns failure", async () => {
    const listRuns = async () => ({ ok: false as const, error: "down", code: "redis-error" });
    const result = await getBehaviorGallery(10, {}, { listRuns });
    assert.deepEqual(result, []);
  });
});

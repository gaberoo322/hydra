/**
 * Regression tests for design-concept Phase B telemetry (issue #465).
 *
 * Two layers:
 *   1. Pure-function tests against an in-memory reader (no Redis IO).
 *   2. Integration tests against test Redis DB 1 with seeded counters
 *      via the real `setString` / `listRPush` / `hashSet` adapters.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

// Force test DB before any module that reads REDIS_URL is loaded.
process.env.REDIS_URL = "redis://localhost:6379/1";

const telemetry = await import("../src/design-concept/telemetry.ts");
const adapter = await import("../src/redis-adapter.ts");

// ---------------------------------------------------------------------------
// In-memory reader — exercises the pure-function rollup with no IO.
// ---------------------------------------------------------------------------

function makeMemReader(state: {
  ints?: Record<string, number>;
  lists?: Record<string, number[]>;
  hashes?: Record<string, Record<string, string>>;
}): telemetry.TelemetryReader {
  const ints = state.ints ?? {};
  const lists = state.lists ?? {};
  const hashes = state.hashes ?? {};
  return {
    readInt: async (key) => ints[key] ?? 0,
    readNumberList: async (key) => lists[key] ?? [],
    readListLen: async (key) => (lists[key]?.length ?? 0),
    readHash: async (key) => hashes[key] ?? {},
  };
}

// ---------------------------------------------------------------------------
// Pure-function tests
// ---------------------------------------------------------------------------

describe("design-concept telemetry — pure functions", () => {
  test("computeStatus: above_is_green green/yellow/red bands", () => {
    // green
    assert.equal(telemetry.computeStatus(0.85, 0.8, "above_is_green"), "green");
    assert.equal(telemetry.computeStatus(0.8, 0.8, "above_is_green"), "green");
    // yellow — within 10% below
    assert.equal(telemetry.computeStatus(0.75, 0.8, "above_is_green"), "yellow");
    // red — >10% below
    assert.equal(telemetry.computeStatus(0.5, 0.8, "above_is_green"), "red");
  });

  test("computeStatus: below_is_green green/yellow/red bands", () => {
    // green
    assert.equal(telemetry.computeStatus(0.1, 0.2, "below_is_green"), "green");
    assert.equal(telemetry.computeStatus(0.2, 0.2, "below_is_green"), "green");
    // yellow — within 10% above
    assert.equal(telemetry.computeStatus(0.21, 0.2, "below_is_green"), "yellow");
    // red — >10% above
    assert.equal(telemetry.computeStatus(0.5, 0.2, "below_is_green"), "red");
  });

  test("computeStatus: zero threshold + below_is_green flags any non-zero as red", () => {
    assert.equal(telemetry.computeStatus(0, 0, "below_is_green"), "green");
    assert.equal(telemetry.computeStatus(0.01, 0, "below_is_green"), "red");
  });

  test("median: odd, even, empty", () => {
    assert.equal(telemetry.median([3, 1, 2]), 2);
    assert.equal(telemetry.median([1, 2, 3, 4]), 2.5);
    assert.equal(telemetry.median([]), 0);
    assert.equal(telemetry.median([5]), 5);
  });

  test("ymd + rollingDays produce 7 UTC-stable days, newest first", () => {
    const now = new Date(Date.UTC(2026, 4, 17, 12, 0, 0)); // 2026-05-17
    const days = telemetry.rollingDays(now, 7);
    assert.equal(days.length, 7);
    assert.equal(days[0], "2026-05-17");
    assert.equal(days[6], "2026-05-11");
  });

  test("snapshotAllGreen: empty snapshot is NOT green (fresh deploy can't ratchet)", () => {
    assert.equal(telemetry.snapshotAllGreen({}), false);
    assert.equal(telemetry.snapshotAllGreen({ writtenAt: "x" }), false);
  });

  test("snapshotAllGreen: all-green excluding metadata fields", () => {
    assert.equal(
      telemetry.snapshotAllGreen({
        artifact_rate: "green",
        gate_pass_rate: "green",
        min_sample: "green",
        writtenAt: "2026-05-16T23:59:00Z",
      }),
      true,
    );
  });

  test("snapshotAllGreen: any non-green status flips false", () => {
    assert.equal(
      telemetry.snapshotAllGreen({
        artifact_rate: "green",
        gate_pass_rate: "yellow",
        min_sample: "green",
      }),
      false,
    );
  });

  test("computeTelemetry: all-green inputs with green snapshots → ready=true, 3 consecutive days", async () => {
    const now = new Date(Date.UTC(2026, 4, 17, 12, 0, 0));
    const days = telemetry.rollingDays(now, 7);

    // Seed enough events to clear every threshold AND min_sample (20).
    const reader = makeMemReader({
      ints: Object.fromEntries(
        days.flatMap((d) => [
          [telemetry.counterKey("dispatch_count", d), 5], // 35 total
          [telemetry.counterKey("artifact_produced_count", d), 5], // 35/35 = 100%
          [telemetry.counterKey("artifact_approved_count", d), 5], // 35/35 = 100%
          [telemetry.counterKey("artifact_warn_count", d), 0],
          [telemetry.counterKey("handoff_filed_count", d), 0], // 0/day handoff rate
          [telemetry.counterKey("dev_with_artifact_count", d), 5], // 35 dev PRs total
          [telemetry.counterKey("dev_without_artifact_count", d), 0],
          [telemetry.counterKey("grill_timeout_count", d), 0],
          [telemetry.counterKey("grill_crash_count", d), 0],
        ]),
      ),
      lists: {
        [telemetry.HISTOGRAM_QA_TRACE]: Array.from({ length: 30 }, () => 10),
        [telemetry.HISTOGRAM_GLOSSARY_GAPS]: [],
        [telemetry.HISTOGRAM_DEV_PR_LATENCY]: Array.from(
          { length: 30 },
          () => 1000,
        ),
      },
      hashes: {
        [telemetry.KEY_GATE_FAIL_REASONS]: {},
        [telemetry.KEY_OPERATOR_OVERRIDE_REASONS]: {},
        // Baseline of 1000ms → ratio 1.0 (green).
        // Snapshots for yesterday + day-before all green.
        [telemetry.dailySnapshotKey(days[1])]: {
          artifact_rate: "green",
          gate_pass_rate: "green",
          handoff_rate_per_day: "green",
          median_qa_trace: "green",
          dev_pr_latency_ratio: "green",
          exempt_rate: "green",
          min_sample: "green",
          writtenAt: "x",
        },
        [telemetry.dailySnapshotKey(days[2])]: {
          artifact_rate: "green",
          gate_pass_rate: "green",
          handoff_rate_per_day: "green",
          median_qa_trace: "green",
          dev_pr_latency_ratio: "green",
          exempt_rate: "green",
          min_sample: "green",
          writtenAt: "x",
        },
      },
    });

    // Mem reader doesn't auto-resolve the baseline integer — seed it.
    const seededInts: Record<string, number> = {};
    for (const d of days) {
      seededInts[telemetry.counterKey("dispatch_count", d)] = 5;
      seededInts[telemetry.counterKey("artifact_produced_count", d)] = 5;
      seededInts[telemetry.counterKey("artifact_approved_count", d)] = 5;
      seededInts[telemetry.counterKey("artifact_warn_count", d)] = 0;
      seededInts[telemetry.counterKey("handoff_filed_count", d)] = 0;
      seededInts[telemetry.counterKey("dev_with_artifact_count", d)] = 5;
      seededInts[telemetry.counterKey("dev_without_artifact_count", d)] = 0;
      seededInts[telemetry.counterKey("grill_timeout_count", d)] = 0;
      seededInts[telemetry.counterKey("grill_crash_count", d)] = 0;
    }
    seededInts[telemetry.KEY_BASELINE_DEV_PR_LATENCY] = 1000;
    const reader2: telemetry.TelemetryReader = {
      ...reader,
      readInt: async (key) => seededInts[key] ?? 0,
    };

    const view = await telemetry.readAndCompute(reader2, now);

    assert.equal(view.window_days, 7);
    assert.equal(view.criteria.artifact_rate.status, "green");
    assert.equal(view.criteria.gate_pass_rate.status, "green");
    assert.equal(view.criteria.median_qa_trace.status, "green");
    assert.equal(view.criteria.dev_pr_latency_ratio.status, "green");
    assert.equal(view.criteria.exempt_rate.status, "green");
    assert.equal(view.criteria.handoff_rate_per_day.status, "green");
    assert.equal(view.min_sample.status, "green");
    assert.equal(view.min_sample.value, 35); // 7 * 5 dev_with_artifact

    assert.equal(view.promotion_eligibility.ready, true);
    assert.equal(view.promotion_eligibility.consecutive_green_days, 3);
    assert.deepEqual(view.promotion_eligibility.blocking_criteria, []);
    assert.equal(view.promotion_eligibility.estimated_ready_date, null);
  });

  test("computeTelemetry: failing gate_pass_rate makes ready=false and lists blocker", async () => {
    const now = new Date(Date.UTC(2026, 4, 17, 12, 0, 0));
    const days = telemetry.rollingDays(now, 7);
    const ints: Record<string, number> = {};
    for (const d of days) {
      ints[telemetry.counterKey("dispatch_count", d)] = 5;
      ints[telemetry.counterKey("artifact_produced_count", d)] = 5;
      // Only 50% gate pass rate — well below 0.7 threshold.
      ints[telemetry.counterKey("artifact_approved_count", d)] = 2;
      ints[telemetry.counterKey("artifact_warn_count", d)] = 2;
      ints[telemetry.counterKey("dev_with_artifact_count", d)] = 5;
    }
    ints[telemetry.KEY_BASELINE_DEV_PR_LATENCY] = 1000;
    const reader: telemetry.TelemetryReader = {
      readInt: async (k) => ints[k] ?? 0,
      readNumberList: async (k) =>
        k === telemetry.HISTOGRAM_QA_TRACE
          ? Array.from({ length: 30 }, () => 10)
          : k === telemetry.HISTOGRAM_DEV_PR_LATENCY
            ? Array.from({ length: 30 }, () => 1000)
            : [],
      readListLen: async () => 0,
      readHash: async (k) => {
        if (k === telemetry.KEY_GATE_FAIL_REASONS) {
          return { "qaTrace.length < 6": "10", "glossaryGaps non-empty": "3" };
        }
        return {};
      },
    };

    const view = await telemetry.readAndCompute(reader, now);
    assert.equal(view.criteria.gate_pass_rate.status, "red");
    assert.equal(view.promotion_eligibility.ready, false);
    assert.ok(
      view.promotion_eligibility.blocking_criteria.includes("gate_pass_rate"),
      "blocking_criteria includes gate_pass_rate",
    );
    // Diagnostics surface so the dashboard can show top failure reasons.
    assert.equal(view.diagnostics.gate_fail_reasons["qaTrace.length < 6"], 10);
  });

  test("computeTelemetry: insufficient sample blocks promotion even when other criteria green", async () => {
    const now = new Date(Date.UTC(2026, 4, 17, 12, 0, 0));
    const days = telemetry.rollingDays(now, 7);
    const ints: Record<string, number> = {};
    // Only 1 dispatch/day → 7 total < min_sample threshold of 20.
    for (const d of days) {
      ints[telemetry.counterKey("dispatch_count", d)] = 1;
      ints[telemetry.counterKey("artifact_produced_count", d)] = 1;
      ints[telemetry.counterKey("artifact_approved_count", d)] = 1;
      ints[telemetry.counterKey("dev_with_artifact_count", d)] = 1;
    }
    ints[telemetry.KEY_BASELINE_DEV_PR_LATENCY] = 1000;
    const reader: telemetry.TelemetryReader = {
      readInt: async (k) => ints[k] ?? 0,
      readNumberList: async (k) =>
        k === telemetry.HISTOGRAM_QA_TRACE
          ? Array.from({ length: 10 }, () => 10)
          : k === telemetry.HISTOGRAM_DEV_PR_LATENCY
            ? Array.from({ length: 10 }, () => 1000)
            : [],
      readListLen: async () => 0,
      readHash: async () => ({}),
    };
    const view = await telemetry.readAndCompute(reader, now);
    assert.equal(view.min_sample.status, "red");
    assert.equal(view.promotion_eligibility.ready, false);
    assert.ok(view.promotion_eligibility.blocking_criteria.includes("min_sample"));
  });

  test("computeTelemetry: ready flips false when prior snapshots aren't all green", async () => {
    const now = new Date(Date.UTC(2026, 4, 17, 12, 0, 0));
    const days = telemetry.rollingDays(now, 7);
    const ints: Record<string, number> = {};
    for (const d of days) {
      ints[telemetry.counterKey("dispatch_count", d)] = 5;
      ints[telemetry.counterKey("artifact_produced_count", d)] = 5;
      ints[telemetry.counterKey("artifact_approved_count", d)] = 5;
      ints[telemetry.counterKey("dev_with_artifact_count", d)] = 5;
    }
    ints[telemetry.KEY_BASELINE_DEV_PR_LATENCY] = 1000;
    const reader: telemetry.TelemetryReader = {
      readInt: async (k) => ints[k] ?? 0,
      readNumberList: async (k) =>
        k === telemetry.HISTOGRAM_QA_TRACE
          ? Array.from({ length: 30 }, () => 10)
          : k === telemetry.HISTOGRAM_DEV_PR_LATENCY
            ? Array.from({ length: 30 }, () => 1000)
            : [],
      readListLen: async () => 0,
      readHash: async (k) => {
        if (k === telemetry.dailySnapshotKey(days[1])) {
          // Yesterday all green
          return {
            artifact_rate: "green",
            gate_pass_rate: "green",
            min_sample: "green",
          };
        }
        if (k === telemetry.dailySnapshotKey(days[2])) {
          // Day before NOT all green
          return {
            artifact_rate: "green",
            gate_pass_rate: "red",
            min_sample: "green",
          };
        }
        return {};
      },
    };
    const view = await telemetry.readAndCompute(reader, now);
    // Today green + yesterday green + day-before NOT-green → only 2 consecutive.
    assert.equal(view.promotion_eligibility.consecutive_green_days, 2);
    assert.equal(view.promotion_eligibility.ready, false);
    // Today's all green so estimated_ready_date is today + 1 day.
    assert.equal(view.promotion_eligibility.estimated_ready_date, "2026-05-18");
  });

  test("snapshotFromView flattens status-only HASH ready for daily snapshot", () => {
    const now = new Date("2026-05-17T23:59:00Z");
    const view: telemetry.TelemetryView = {
      window_days: 7,
      criteria: {
        artifact_rate: { value: 0.9, threshold: 0.8, status: "green" },
        gate_pass_rate: { value: 0.5, threshold: 0.7, status: "red" },
        handoff_rate_per_day: { value: 0.5, threshold: 1.0, status: "green" },
        median_qa_trace: { value: 9, threshold: 8, status: "green" },
        dev_pr_latency_ratio: { value: 1.0, threshold: 1.2, status: "green" },
        exempt_rate: { value: 0.05, threshold: 0.2, status: "green" },
      },
      min_sample: { value: 25, threshold: 20, status: "green" },
      diagnostics: { gate_fail_reasons: {}, operator_override_reasons: {} },
      promotion_eligibility: {
        ready: false,
        consecutive_green_days: 1,
        blocking_criteria: ["gate_pass_rate"],
        estimated_ready_date: null,
      },
    };
    const snap = telemetry.snapshotFromView(view, now);
    assert.equal(snap.artifact_rate, "green");
    assert.equal(snap.gate_pass_rate, "red");
    assert.equal(snap.min_sample, "green");
    assert.equal(snap.writtenAt, "2026-05-17T23:59:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// Integration tests — Redis DB 1 via the real adapter.
// ---------------------------------------------------------------------------

const TEST_NS_PREFIX = "hydra:dc:";
let testRedis: any;

async function cleanTestKeys() {
  if (!testRedis) testRedis = new Redis("redis://localhost:6379/1");
  const keys = await testRedis.keys(TEST_NS_PREFIX + "*");
  if (keys.length > 0) await testRedis.del(...keys);
}

describe("design-concept telemetry — integration via Redis adapter", () => {
  beforeEach(async () => {
    await cleanTestKeys();
  });

  after(async () => {
    await cleanTestKeys();
    if (testRedis) testRedis.disconnect();
  });

  test("readAndCompute against real adapter — seed counters + histograms produce green view", async () => {
    const now = new Date(Date.UTC(2026, 4, 17, 12, 0, 0));
    const days = telemetry.rollingDays(now, 7);

    // Seed counters via adapter.setString (it stores under the same key).
    for (const d of days) {
      await adapter.setString(
        telemetry.counterKey("dispatch_count", d),
        "5",
      );
      await adapter.setString(
        telemetry.counterKey("artifact_produced_count", d),
        "5",
      );
      await adapter.setString(
        telemetry.counterKey("artifact_approved_count", d),
        "5",
      );
      await adapter.setString(
        telemetry.counterKey("artifact_warn_count", d),
        "0",
      );
      await adapter.setString(
        telemetry.counterKey("dev_with_artifact_count", d),
        "5",
      );
    }
    await adapter.setString(telemetry.KEY_BASELINE_DEV_PR_LATENCY, "1000");

    // Histograms.
    for (let i = 0; i < 30; i += 1) {
      await adapter.listRPush(telemetry.HISTOGRAM_QA_TRACE, "10");
      await adapter.listRPush(telemetry.HISTOGRAM_DEV_PR_LATENCY, "1000");
    }

    // Build the same reader the API route uses (against the real adapter).
    const reader: telemetry.TelemetryReader = {
      readInt: async (key) => {
        const raw = await adapter.getString(key);
        if (raw === null) return 0;
        const n = parseInt(raw, 10);
        return Number.isFinite(n) ? n : 0;
      },
      readNumberList: async (key) => {
        const raw = await adapter.listRange(key, 0, -1);
        return raw.map((s) => parseFloat(s)).filter((n) => Number.isFinite(n));
      },
      readListLen: async (key) => adapter.listLen(key),
      readHash: async (key) => (await adapter.hashGetAll(key)) ?? {},
    };

    const view = await telemetry.readAndCompute(reader, now);
    assert.equal(view.criteria.artifact_rate.status, "green");
    assert.equal(view.criteria.gate_pass_rate.status, "green");
    assert.equal(view.criteria.dev_pr_latency_ratio.status, "green");
    assert.equal(view.criteria.median_qa_trace.status, "green");
    assert.equal(view.min_sample.value, 35);
    assert.equal(view.min_sample.status, "green");
  });

  test("daily snapshot integration — write via snapshotFromView, read via hashGetAll", async () => {
    const now = new Date("2026-05-17T23:59:00Z");
    const view: telemetry.TelemetryView = {
      window_days: 7,
      criteria: {
        artifact_rate: { value: 0.9, threshold: 0.8, status: "green" },
        gate_pass_rate: { value: 0.9, threshold: 0.7, status: "green" },
        handoff_rate_per_day: { value: 0.5, threshold: 1.0, status: "green" },
        median_qa_trace: { value: 10, threshold: 8, status: "green" },
        dev_pr_latency_ratio: { value: 1.0, threshold: 1.2, status: "green" },
        exempt_rate: { value: 0.05, threshold: 0.2, status: "green" },
      },
      min_sample: { value: 25, threshold: 20, status: "green" },
      diagnostics: { gate_fail_reasons: {}, operator_override_reasons: {} },
      promotion_eligibility: {
        ready: false,
        consecutive_green_days: 1,
        blocking_criteria: [],
        estimated_ready_date: null,
      },
    };
    const flat = telemetry.snapshotFromView(view, now);
    const key = telemetry.dailySnapshotKey("2026-05-17");
    // Mimic what dc-telemetry-snapshot.sh does — hashSet field/value pairs.
    const args: string[] = [];
    for (const [k, v] of Object.entries(flat)) {
      args.push(k, v);
    }
    await adapter.hashSet(key, ...args);
    await adapter.expireKey(key, 2_592_000);

    const got = await adapter.hashGetAll(key);
    assert.equal(got.artifact_rate, "green");
    assert.equal(got.min_sample, "green");
    assert.ok(got.writtenAt, "writtenAt persisted");

    // Snapshot should test as all-green.
    assert.equal(telemetry.snapshotAllGreen(got), true);
  });
});

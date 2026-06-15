/**
 * Write-read contract for the cycle-metrics numeric schema (issue #1890).
 *
 * `recordCycleMetrics` (write, src/metrics/record.ts) and `getMetricsTrend`
 * (read, src/metrics/trend.ts) used to keep two independent copies of the
 * numeric field list: the writer accepted `any`, the reader hard-coded a
 * `NUMERIC_FIELDS` array. A field renamed/added on one side but not the other
 * was a silent runtime zero with no compile error (the failure mode that left
 * `reflectionMatchSource` reading "none" until #1136 Slice 2).
 *
 * Fix: the reader derives its parse list from the writer's exported
 * `NUMERIC_FIELD_NAMES` tuple, which also types `CycleMetricsInput`'s numeric
 * keys. These tests lock that single-source-of-truth so a future split is a
 * test failure, not a silent drift.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

const { recordCycleMetrics, NUMERIC_FIELD_NAMES } = await import("../src/metrics/record.ts");
const { getMetricsTrend } = await import("../src/metrics/trend.ts");

let testRedis: any;

async function cleanTestKeys() {
  const keys = await testRedis.keys("hydra:metrics:*");
  if (keys.length > 0) await testRedis.del(...keys);
  await testRedis.del("hydra:metrics:index");
}

describe("cycle metrics write-read numeric contract (issue #1890)", () => {
  beforeEach(async () => {
    if (!testRedis) testRedis = new Redis(process.env.REDIS_URL);
    await cleanTestKeys();
  });

  after(async () => {
    await cleanTestKeys();
    if (testRedis) testRedis.disconnect();
  });

  test("NUMERIC_FIELD_NAMES is a non-empty, duplicate-free tuple", () => {
    assert.ok(NUMERIC_FIELD_NAMES.length > 0, "tuple must name at least one field");
    const unique = new Set(NUMERIC_FIELD_NAMES);
    assert.equal(
      unique.size,
      NUMERIC_FIELD_NAMES.length,
      "NUMERIC_FIELD_NAMES must not contain duplicate field names",
    );
  });

  test("every NUMERIC_FIELD_NAMES key round-trips write→read as a number", async () => {
    const cycleId = "cycle-1890-roundtrip";

    // Build a metrics object that sets EVERY numeric field to a distinct value.
    // If a field the reader parses is missing from the writer's tuple it reads
    // as a string; if a field the writer accepts is missing from the reader's
    // parse list it also reads as a string — either way this assertion fails.
    const metrics: Record<string, number> = {};
    NUMERIC_FIELD_NAMES.forEach((name, i) => {
      metrics[name] = i + 1;
    });

    await recordCycleMetrics(cycleId, metrics);
    const trend = await getMetricsTrend(1);
    assert.equal(trend.length, 1, "expected the one recorded cycle in the trend");

    const m = trend[0];
    NUMERIC_FIELD_NAMES.forEach((name, i) => {
      assert.strictEqual(
        m[name],
        i + 1,
        `field "${name}" must round-trip as the number ${i + 1}, got ${JSON.stringify(m[name])} (${typeof m[name]})`,
      );
    });
  });

  test("a numeric field absent at the write site reads as null (not a stale string)", async () => {
    // Documents the documented gap the type closes: a NUMERIC_FIELD that no
    // caller writes is simply absent — never present as a non-numeric string.
    const cycleId = "cycle-1890-partial";
    await recordCycleMetrics(cycleId, { tasksMerged: 3 });

    const trend = await getMetricsTrend(1);
    const m = trend[0];
    assert.strictEqual(m.tasksMerged, 3, "written numeric field parses to a number");
    assert.strictEqual(
      m.tasksFailed,
      undefined,
      "an unwritten numeric field is absent, not a parsed zero or stale string",
    );
  });
});

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
const { getMetricsTrend, normalizeAnchorType } = await import("../src/metrics/trend.ts");
const { redisKeys } = await import("../src/redis/keys.ts");

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
      // Issue #2930: `tokenCost` is no longer read back from the cycle-metrics
      // hash — it is JOINED at read time from the separate per-cycle token key
      // (`hydra:metrics:tokens:by-cycle:<id>`) via getCycleTokensRaw. This test
      // seeds no such key, so the joined value is the truthful null sentinel
      // (asserted in the dedicated case below), NOT the value written into the
      // hash here. Exclude it from the hash round-trip assertion; the write→read
      // hash contract this test guards still holds for every other numeric field.
      if (name === "tokenCost") return;
      assert.strictEqual(
        m[name],
        i + 1,
        `field "${name}" must round-trip as the number ${i + 1}, got ${JSON.stringify(m[name])} (${typeof m[name]})`,
      );
    });
  });

  test("tokenCost is a read-time join, not a hash round-trip (issue #2930)", async () => {
    // A value written into the `tokenCost` slot of the cycle-metrics HASH is
    // deliberately overridden by the read-time join from the separate per-cycle
    // token key. With no token key seeded, the trend row reads the null
    // unattributed sentinel regardless of any stale hash value.
    const cycleId = "cycle-2930-hash-override";
    await recordCycleMetrics(cycleId, { tasksMerged: 1, tokenCost: 999 });

    const trend = await getMetricsTrend(1);
    assert.strictEqual(
      trend[0].tokenCost,
      null,
      "tokenCost must reflect the joined per-cycle token key (null when absent), not a value stored on the metrics hash",
    );
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

/**
 * Read-path anchorType normalization (issue #2699).
 *
 * f95fee2 (#2689) fixed the WRITE path so new cycle records classify anchorType
 * explicitly, but the ~12 pre-fix records already persisted in Redis carry a
 * null/absent anchorType — a JS `null` flattened by record.ts via `String(null)`
 * into the literal string "null". The stats aggregator already folds those to
 * "unknown" (`m.anchorType || "unknown"`), but the trend read path passed them
 * through raw so they surfaced as `null`/"null" in the trend array. These tests
 * pin that `getMetricsTrend` now normalizes at the parse step.
 *
 * Own top-level describe with its own before/after lifecycle so it never
 * piggybacks on the sibling suite's shared-Redis teardown (CLAUDE.md authoring
 * rule).
 */
describe("trend read-path anchorType normalization (issue #2699)", () => {
  let redis: any;

  async function cleanKeys() {
    const keys = await redis.keys("hydra:metrics:*");
    if (keys.length > 0) await redis.del(...keys);
    await redis.del("hydra:metrics:index");
  }

  beforeEach(async () => {
    if (!redis) redis = new Redis(process.env.REDIS_URL);
    await cleanKeys();
  });

  after(async () => {
    await cleanKeys();
    if (redis) redis.disconnect();
  });

  // Seed a legacy cycle-metrics hash the way a pre-fix write persisted it: a JS
  // null anchorType flattened to the LITERAL string "null" (record.ts skips
  // undefined but stringifies null). Writing the hash directly reproduces the
  // stored shape without depending on the now-fixed writer emitting null.
  async function seedLegacyCycle(cycleId: string, anchorTypeRaw: string | null) {
    const fields: Record<string, string> = {
      cycleId,
      recordedAt: new Date().toISOString(),
      tasksMerged: "1",
    };
    if (anchorTypeRaw !== null) fields.anchorType = anchorTypeRaw;
    await redis.hset(redisKeys.metrics(cycleId), ...Object.entries(fields).flat());
    await redis.zadd(redisKeys.metricsIndex(), Date.now(), cycleId);
  }

  test('a stored literal-"null" anchorType surfaces as "unknown" in the trend', async () => {
    await seedLegacyCycle("cycle-2699-literal-null", "null");
    const trend = await getMetricsTrend(1);
    assert.equal(trend.length, 1, "expected the one seeded legacy cycle");
    assert.strictEqual(
      trend[0].anchorType,
      "unknown",
      'a stored literal "null" anchorType must render as "unknown", not "null"',
    );
  });

  test("a cycle with an absent anchorType surfaces as \"unknown\" in the trend", async () => {
    await seedLegacyCycle("cycle-2699-absent", null);
    const trend = await getMetricsTrend(1);
    assert.equal(trend.length, 1, "expected the one seeded legacy cycle");
    assert.strictEqual(
      trend[0].anchorType,
      "unknown",
      "an absent anchorType must render as \"unknown\", not undefined/null",
    );
  });

  test("a real anchorType passes through the trend unchanged", async () => {
    await seedLegacyCycle("cycle-2699-real", "failing-test");
    const trend = await getMetricsTrend(1);
    assert.strictEqual(
      trend[0].anchorType,
      "failing-test",
      "a genuine anchorType must not be rewritten to unknown",
    );
  });

  test("normalizeAnchorType folds every unknown form, keeps real values (pure)", () => {
    // Pure helper — no Redis. Locks the fold logic the trend read depends on.
    assert.strictEqual(normalizeAnchorType("null"), "unknown");
    assert.strictEqual(normalizeAnchorType("undefined"), "unknown");
    assert.strictEqual(normalizeAnchorType(""), "unknown");
    assert.strictEqual(normalizeAnchorType("  "), "unknown");
    assert.strictEqual(normalizeAnchorType(undefined), "unknown");
    assert.strictEqual(normalizeAnchorType(null), "unknown");
    assert.strictEqual(normalizeAnchorType("priorities"), "priorities");
    assert.strictEqual(normalizeAnchorType("  failing-test  "), "failing-test");
  });
});

/**
 * Issue #2824: the metrics READ path must mirror the WRITE path's malformed-
 * anchorType rejection. `classifyAnchorType`/`isMalformedAnchorType` in
 * cycle-close.ts (#2806) collapse flag-shaped (`--*`) and `unmapped:*` values
 * to `unclassified`, but rows persisted BEFORE that fix carry the raw garbage
 * string; `normalizeAnchorType` now reuses the write path's own predicate as
 * the single source of truth so those stale rows fold into the same
 * `unclassified` bucket instead of surfacing as distinct garbage buckets.
 *
 * Own top-level describe with its own before/after lifecycle (CLAUDE.md
 * authoring rule — never piggyback on a sibling's shared-Redis teardown).
 */
describe("trend read-path malformed anchorType rejection (issue #2824)", () => {
  let redis: any;

  async function cleanKeys() {
    const keys = await redis.keys("hydra:metrics:*");
    if (keys.length > 0) await redis.del(...keys);
    await redis.del("hydra:metrics:index");
  }

  beforeEach(async () => {
    if (!redis) redis = new Redis(process.env.REDIS_URL);
    await cleanKeys();
  });

  after(async () => {
    await cleanKeys();
    if (redis) redis.disconnect();
  });

  async function seedLegacyCycle(cycleId: string, anchorTypeRaw: string) {
    await redis.hset(
      redisKeys.metrics(cycleId),
      ...Object.entries({
        cycleId,
        recordedAt: new Date().toISOString(),
        tasksMerged: "0",
        anchorType: anchorTypeRaw,
      }).flat(),
    );
    await redis.zadd(redisKeys.metricsIndex(), Date.now(), cycleId);
  }

  test('a stored flag-shaped "--status" anchorType surfaces as "unclassified" in the trend', async () => {
    // Reproduces the issue #2824 evidence: hydra:metrics:--cycle-id carried
    // anchorType "--status", a leaked CLI flag from a positional-arg bug.
    await seedLegacyCycle("cycle-2824-flag", "--status");
    const trend = await getMetricsTrend(1);
    assert.equal(trend.length, 1, "expected the one seeded legacy cycle");
    assert.strictEqual(
      trend[0].anchorType,
      "unclassified",
      'a stored "--status" anchorType must render as "unclassified", not "--status"',
    );
  });

  test('a stored "unmapped:<skill>" anchorType surfaces as "unclassified" in the trend', async () => {
    await seedLegacyCycle("cycle-2824-unmapped", "unmapped:completed");
    const trend = await getMetricsTrend(1);
    assert.strictEqual(
      trend[0].anchorType,
      "unclassified",
      'a stored "unmapped:*" sentinel must render as "unclassified", not the raw string',
    );
  });

  test("normalizeAnchorType folds malformed forms to unclassified, keeps real values (pure)", () => {
    // Flag-shaped: any leading-dash token is a leaked CLI flag, never a lane.
    assert.strictEqual(normalizeAnchorType("--status"), "unclassified");
    assert.strictEqual(normalizeAnchorType("-x"), "unclassified");
    assert.strictEqual(normalizeAnchorType("  --apply  "), "unclassified");
    // dispatch.sh's unmapped-skill gap-marker sentinel.
    assert.strictEqual(normalizeAnchorType("unmapped"), "unclassified");
    assert.strictEqual(normalizeAnchorType("unmapped:completed"), "unclassified");
    assert.strictEqual(normalizeAnchorType("unmapped:grill"), "unclassified");
    // Genuine anchor types (including ones that merely CONTAIN a dash) pass through.
    assert.strictEqual(normalizeAnchorType("work-queue"), "work-queue");
    assert.strictEqual(normalizeAnchorType("qa-review"), "qa-review");
    assert.strictEqual(normalizeAnchorType("failing-test"), "failing-test");
    // No-value forms still fold to "unknown", NOT "unclassified".
    assert.strictEqual(normalizeAnchorType(""), "unknown");
    assert.strictEqual(normalizeAnchorType("null"), "unknown");
    assert.strictEqual(normalizeAnchorType(undefined), "unknown");
  });
});

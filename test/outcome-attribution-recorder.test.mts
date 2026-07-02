/**
 * Regression tests for the outcome-attribution spine (issue #2629, epic #2628):
 * the append-only ledger seam (`src/redis/attribution.ts`) + the window recorder
 * (`src/outcome-attribution/recorder.ts`).
 *
 * Two layers, mirroring holdback.test.mts:
 *   1. Pure recorder policy against a FAKE ledger (no Redis): dark-metric skip,
 *      empty-window null-model row, delta derivation, raw (un-split) rows.
 *   2. The Redis accessor round-trip against a live Redis (DB 1, skipped if
 *      unreachable): append → read-all preserves the row, append-only.
 *
 * Bug class this guards against:
 *   - Emitting a synthetic zero for a dark (no-data) metric.
 *   - Dropping the empty-window null-model row the #2630 estimator needs.
 *   - Trimming/mutating the ledger (it must be append-only, full history).
 *   - A write-time credit split (rows must stay RAW).
 */

// Point the Redis singleton at DB 1 before any seam import (matches holdback.test).
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

import type { LeadingOutcomeSample } from "../src/outcome-regression.ts";
import {
  deriveObservations,
  recordWindow,
  type WindowContext,
} from "../src/outcome-attribution/recorder.ts";
import type {
  AttributionLedger,
  AttributionObservation,
  AppendObservationResult,
  LoadObservationsResult,
} from "../src/redis/attribution.ts";
import {
  appendObservation,
  getObservations,
  attributionLedgerKey,
  _resetLedger,
  redisAttributionLedger,
} from "../src/redis/attribution.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A fake, in-memory append-only ledger for the pure-policy layer. */
function makeFakeLedger(): AttributionLedger & { rows: AttributionObservation[] } {
  const rows: AttributionObservation[] = [];
  return {
    rows,
    async appendObservation(obs: AttributionObservation): Promise<AppendObservationResult> {
      rows.push(obs);
      return { ok: true };
    },
    async appendVoidMarker(): Promise<AppendObservationResult> {
      return { ok: true };
    },
    async getObservations(): Promise<LoadObservationsResult> {
      return { ok: true, observations: [...rows] };
    },
  };
}

/** A fake ledger that always fails to append (best-effort error surfacing). */
function makeFailingLedger(): AttributionLedger {
  return {
    async appendObservation(): Promise<AppendObservationResult> {
      return { ok: false, error: "boom" };
    },
    async appendVoidMarker(): Promise<AppendObservationResult> {
      return { ok: false, error: "boom" };
    },
    async getObservations(): Promise<LoadObservationsResult> {
      return { ok: true, observations: [] };
    },
  };
}

function sample(name: string, value: number | null): LeadingOutcomeSample {
  return { name, direction: "up", noiseEpsilon: 0, value };
}

const CTX_ACTIVE: WindowContext = {
  classCounts: { dev_orch: 2, dev_target: 1 },
  scopeTouched: "orch",
  tier: 3,
};

const CTX_EMPTY: WindowContext = {
  classCounts: {},
  scopeTouched: "orch",
  tier: null,
};

// ---------------------------------------------------------------------------
// Layer 1 — pure recorder policy (fake ledger, no Redis)
// ---------------------------------------------------------------------------

describe("attribution recorder policy (fake ledger)", () => {
  test("derives delta = current - baseline, matched by metric name", () => {
    const baseline = [sample("brier", 0.25), sample("roi", 1.5)];
    const current = [
      { name: "brier", value: 0.2 },
      { name: "roi", value: 1.8 },
    ];
    const rows = deriveObservations(baseline, current, CTX_ACTIVE, 123);
    assert.equal(rows.length, 2);
    const brier = rows.find((r) => r.metric === "brier")!;
    assert.ok(Math.abs(brier.delta - -0.05) < 1e-9);
    const roi = rows.find((r) => r.metric === "roi")!;
    assert.ok(Math.abs(roi.delta - 0.3) < 1e-9);
    // Rows are RAW: classCounts carried verbatim, no write-time split.
    assert.deepEqual(brier.classCounts, { dev_orch: 2, dev_target: 1 });
    assert.equal(brier.scopeTouched, "orch");
    assert.equal(brier.tier, 3);
    assert.equal(brier.recordedAt, 123);
  });

  test("dark metric (null in either snapshot) produces NO row — never a synthetic zero", () => {
    const baseline = [
      sample("live", 0.4),
      sample("dark_baseline", null), // null at baseline
      sample("dark_current", 0.9), // present at baseline...
    ];
    const current = [
      { name: "live", value: 0.5 },
      { name: "dark_baseline", value: 0.7 },
      { name: "dark_current", value: null }, // ...but null now
    ];
    const rows = deriveObservations(baseline, current, CTX_ACTIVE, 1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].metric, "live");
    // No synthetic zero anywhere.
    assert.ok(!rows.some((r) => r.metric === "dark_baseline"));
    assert.ok(!rows.some((r) => r.metric === "dark_current"));
  });

  test("a metric missing from the current snapshot is dark (no row)", () => {
    const baseline = [sample("present", 0.3), sample("vanished", 0.6)];
    const current = [{ name: "present", value: 0.35 }]; // "vanished" absent
    const rows = deriveObservations(baseline, current, CTX_ACTIVE, 1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].metric, "present");
  });

  test("empty (zero-merge) window IS recorded as a null-model row (classCounts={})", async () => {
    const baseline = [sample("brier", 0.25)];
    const current = [{ name: "brier", value: 0.24 }];
    const ledger = makeFakeLedger();
    const res = await recordWindow(ledger, baseline, current, CTX_EMPTY, 7);
    assert.equal(res.appended.length, 1);
    assert.equal(ledger.rows.length, 1);
    const row = ledger.rows[0];
    assert.deepEqual(row.classCounts, {}); // null-model marker
    assert.equal(row.tier, null);
    // Empty ≠ dark: the metric still has DATA, so the delta is recorded.
    assert.ok(Math.abs(row.delta - -0.01) < 1e-9);
  });

  test("recordWindow appends non-dark rows and reports dark metrics", async () => {
    const baseline = [sample("live", 1.0), sample("dark", null)];
    const current = [
      { name: "live", value: 1.2 },
      { name: "dark", value: 2.0 },
    ];
    const ledger = makeFakeLedger();
    const res = await recordWindow(ledger, baseline, current, CTX_ACTIVE, 1);
    assert.equal(res.appended.length, 1);
    assert.deepEqual(res.darkMetrics, ["dark"]);
    assert.equal(res.errors.length, 0);
    assert.equal(ledger.rows.length, 1);
  });

  test("recordWindow surfaces append errors without throwing", async () => {
    const baseline = [sample("live", 1.0)];
    const current = [{ name: "live", value: 1.1 }];
    const res = await recordWindow(makeFailingLedger(), baseline, current, CTX_ACTIVE, 1);
    assert.equal(res.appended.length, 0);
    assert.deepEqual(res.errors, ["boom"]);
  });

  test("no baseline metrics → no rows (nothing to attribute)", async () => {
    const ledger = makeFakeLedger();
    const res = await recordWindow(ledger, [], [], CTX_EMPTY, 1);
    assert.equal(res.appended.length, 0);
    assert.equal(ledger.rows.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — Redis accessor round-trip (live Redis DB 1, skipped if unreachable)
// ---------------------------------------------------------------------------

describe("attribution ledger Redis accessor (live)", () => {
  let redisUp = false;
  let probe: Redis;

  before(async () => {
    // Single-string-arg ioredis overload (`new Redis(url)`), matching
    // holdback.test.mts: it connects on construction; `ping()` (guarded by the
    // catch) surfaces an unreachable Redis so the live-DB tests skip cleanly.
    probe = new Redis(process.env.REDIS_URL!);
    try {
      await probe.ping();
      redisUp = true;
    } catch {
      redisUp = false;
    }
  });

  beforeEach(async () => {
    if (redisUp) await _resetLedger();
  });

  after(async () => {
    if (redisUp) await _resetLedger();
    if (probe) probe.disconnect();
  });

  test("a raw observation round-trips through the accessor", async (t) => {
    if (!redisUp) return t.skip("Redis unreachable");
    const obs: AttributionObservation = {
      metric: "brier",
      delta: -0.05,
      classCounts: { dev_orch: 2 },
      scopeTouched: "orch",
      tier: 3,
      recordedAt: 1000,
    };
    const appendRes = await appendObservation(obs);
    assert.equal(appendRes.ok, true);
    const loadRes = await getObservations();
    assert.equal(loadRes.ok, true);
    assert.ok(loadRes.ok && loadRes.observations.length === 1);
    assert.deepEqual(loadRes.ok && loadRes.observations[0], obs);
  });

  test("ledger is append-only: read-all returns the FULL history in order", async (t) => {
    if (!redisUp) return t.skip("Redis unreachable");
    for (let i = 0; i < 5; i++) {
      await appendObservation({
        metric: "roi",
        delta: i,
        classCounts: {},
        scopeTouched: "orch",
        tier: null,
        recordedAt: i,
      });
    }
    const res = await getObservations();
    assert.ok(res.ok);
    assert.equal(res.ok && res.observations.length, 5);
    assert.deepEqual(
      res.ok && res.observations.map((o) => o.delta),
      [0, 1, 2, 3, 4],
    );
  });

  test("recordWindow persists through the live redisAttributionLedger", async (t) => {
    if (!redisUp) return t.skip("Redis unreachable");
    const baseline = [sample("brier", 0.25), sample("dark", null)];
    const current = [
      { name: "brier", value: 0.2 },
      { name: "dark", value: 0.9 },
    ];
    const res = await recordWindow(redisAttributionLedger, baseline, current, CTX_ACTIVE, 42);
    assert.equal(res.appended.length, 1);
    const loaded = await getObservations();
    assert.ok(loaded.ok && loaded.observations.length === 1);
    assert.equal(loaded.ok && loaded.observations[0].metric, "brier");
    assert.equal(loaded.ok && loaded.observations[0].recordedAt, 42);
  });
});

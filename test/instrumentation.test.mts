/**
 * Hot-path timing instrumentation (issue #2353).
 *
 * Pins the design-concept invariants for `time(label, fn)` and
 * `getInstrumentationSnapshot()`:
 *   - Zero-cost / no-record when HYDRA_PERF_INSTRUMENT is unset/falsy.
 *   - Transparent wrapping: return value passed through unchanged; thrown /
 *     rejected errors re-thrown unchanged (and the failed-path duration still
 *     recorded when enabled).
 *   - Async durations span the full awaited operation.
 *   - Snapshot exposes per-label p50/p95/p99 over a bounded ring.
 *   - A helper-internal failure never propagates into the wrapped path.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  time,
  isInstrumentationEnabled,
  getInstrumentationSnapshot,
  resetInstrumentation,
} from "../src/metrics/instrumentation.ts";

const ENV_KEY = "HYDRA_PERF_INSTRUMENT";

describe("instrumentation: time()", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
    resetInstrumentation();
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedEnv;
    resetInstrumentation();
  });

  test("disabled: passes return value through and records nothing", () => {
    const out = time("x", () => 42);
    assert.equal(out, 42);
    const snap = getInstrumentationSnapshot();
    assert.equal(snap.enabled, false);
    assert.equal(snap.labels.length, 0);
  });

  test("disabled: re-throws synchronous errors unchanged, records nothing", () => {
    const boom = new Error("sync boom");
    assert.throws(() => time("x", () => { throw boom; }), /sync boom/);
    assert.equal(getInstrumentationSnapshot().labels.length, 0);
  });

  test("enabled flag parsing: 1/true/yes/on are truthy, others falsy", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on", " on "]) {
      process.env[ENV_KEY] = v;
      assert.equal(isInstrumentationEnabled(), true, `'${v}' should enable`);
    }
    for (const v of ["0", "false", "no", "off", "", "x"]) {
      process.env[ENV_KEY] = v;
      assert.equal(isInstrumentationEnabled(), v === "" ? false : false, `'${v}' should NOT enable`);
    }
    delete process.env[ENV_KEY];
    assert.equal(isInstrumentationEnabled(), false, "unset should NOT enable");
  });

  test("enabled: sync call records a sample and exposes percentiles", () => {
    process.env[ENV_KEY] = "1";
    const out = time("sync-label", () => "result");
    assert.equal(out, "result");
    const snap = getInstrumentationSnapshot();
    assert.equal(snap.enabled, true);
    assert.equal(snap.labels.length, 1);
    const stats = snap.labels[0];
    assert.equal(stats.label, "sync-label");
    assert.equal(stats.count, 1);
    assert.equal(stats.total, 1);
    assert.ok(stats.p50 >= 0 && stats.p95 >= 0 && stats.p99 >= 0);
    assert.ok(stats.min >= 0 && stats.max >= stats.min);
  });

  test("enabled: async call awaits the promise and records the awaited duration", async () => {
    process.env[ENV_KEY] = "1";
    const out = await time("async-label", async () => {
      await new Promise((r) => setTimeout(r, 5));
      return "async-result";
    });
    assert.equal(out, "async-result");
    const stats = getInstrumentationSnapshot().labels.find((l) => l.label === "async-label");
    assert.ok(stats, "async-label should be recorded");
    assert.equal(stats!.count, 1);
    // Duration must span the awaited 5ms sleep (allow scheduler slack).
    assert.ok(stats!.p50 >= 3, `expected p50 >= ~5ms, got ${stats!.p50}`);
  });

  test("enabled: re-throws rejected promises unchanged and records the failed-path duration", async () => {
    process.env[ENV_KEY] = "1";
    const boom = new Error("async boom");
    await assert.rejects(
      () => time("rej-label", async () => { throw boom; }) as Promise<unknown>,
      /async boom/,
    );
    const stats = getInstrumentationSnapshot().labels.find((l) => l.label === "rej-label");
    assert.ok(stats, "failed path should still be recorded");
    assert.equal(stats!.count, 1);
  });

  test("enabled: percentiles are monotonic over many samples", () => {
    process.env[ENV_KEY] = "1";
    // 100 deterministic samples via a busy-ish loop so durations vary.
    for (let i = 0; i < 100; i++) {
      time("multi", () => {
        let s = 0;
        for (let j = 0; j < (i + 1) * 50; j++) s += j;
        return s;
      });
    }
    const stats = getInstrumentationSnapshot().labels.find((l) => l.label === "multi");
    assert.ok(stats);
    assert.equal(stats!.count, 100);
    assert.equal(stats!.total, 100);
    assert.ok(stats!.p50 <= stats!.p95, "p50 <= p95");
    assert.ok(stats!.p95 <= stats!.p99, "p95 <= p99");
    assert.ok(stats!.max >= stats!.p99, "max >= p99");
    assert.ok(stats!.min <= stats!.p50, "min <= p50");
  });

  test("ring buffer is bounded: total keeps counting past capacity, count caps", () => {
    process.env[ENV_KEY] = "1";
    for (let i = 0; i < 1200; i++) {
      time("bounded", () => i);
    }
    const stats = getInstrumentationSnapshot().labels.find((l) => l.label === "bounded");
    assert.ok(stats);
    assert.equal(stats!.count, 1000, "window count capped at RING_CAPACITY");
    assert.equal(stats!.total, 1200, "total counts all observations");
  });

  test("snapshot labels are sorted by label name", () => {
    process.env[ENV_KEY] = "1";
    time("zebra", () => 1);
    time("alpha", () => 1);
    time("mango", () => 1);
    const labels = getInstrumentationSnapshot().labels.map((l) => l.label);
    assert.deepEqual(labels, ["alpha", "mango", "zebra"]);
  });
});

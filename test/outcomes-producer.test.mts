/**
 * Regression tests for the forecast-calibration-brier producer (issue #1657).
 *
 * The 2026-06-10 direction refresh (PR #1658) declared a new leading outcome
 * `forecast-calibration-brier` backed by `source: file` reading
 * `metrics/forecast-calibration-brier.txt`. The producer
 * (`publishForecastCalibrationBrierMetric`, src/metrics/publish.ts) samples
 * the target's aggregate Brier score from hydra-betting
 * `GET /api/calibration/forecast-metrics` and writes the single numeric value
 * to disk; it runs as a Housekeeping chore (src/scheduler/housekeeping.ts).
 *
 * Bug classes guarded:
 *   - Fabricated values: any failure path (unreachable target, non-200,
 *     malformed JSON, null/non-finite brierScore) must leave the metric file
 *     UNTOUCHED — stale mtime is the staleness signal, and a fabricated value
 *     would poison the Outcome Holdback regression check.
 *   - Round-trip break: the written file must parse through the outcomes
 *     file adapter (`getOutcomeValue`) as the same finite number.
 *   - Wiring rot: the Housekeeping summary must report the chore so an
 *     operator can see it sampled (ran) vs threw unexpectedly (skipped).
 *
 * Uses real Redis (DB 7) for the runHousekeeping wiring tests only — the
 * sibling chores read/write guard keys (mirrors api-maintenance.test.mts,
 * issue #948 dedicated-DB convention). The producer tests themselves are
 * hermetic: injectable fetchImpl + tmpdir filePath, no live target.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/7";
process.env.REDIS_URL = REDIS_URL;

import { publishForecastCalibrationBrierMetric } from "../src/metrics/publish.ts";
import { getOutcomeValue, type Outcome } from "../src/outcomes.ts";

let tmpDir: string;

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hydra-brier-producer-test-"));
});

after(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

/** Build a fetch stub returning a canned response. */
function fetchOk(body: unknown): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe("publishForecastCalibrationBrierMetric — successful sample", () => {
  test("writes the fetched brierScore and reports ok", async () => {
    const filePath = join(tmpDir, "brier-ok.txt");
    const result = await publishForecastCalibrationBrierMetric({
      filePath,
      fetchImpl: fetchOk({ brierScore: 0.21, sampleCount: 40 }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.value, 0.21);
    assert.equal(result.reason, undefined);
    const raw = await readFile(filePath, "utf-8");
    assert.equal(Number(raw.trim()), 0.21);
    assert.ok(raw.endsWith("\n"), "trailing newline expected (file-adapter contract)");
  });

  test("written value round-trips through the outcomes file adapter", async () => {
    const filePath = join(tmpDir, "brier-roundtrip.txt");
    const written = 0.183;
    const result = await publishForecastCalibrationBrierMetric({
      filePath,
      fetchImpl: fetchOk({ brierScore: written }),
    });
    assert.equal(result.ok, true);

    const outcome: Outcome = {
      name: "forecast-calibration-brier",
      kind: "leading",
      direction: "down",
      source: "file",
      // Absolute path so resolveFilePath() doesn't append HYDRA_ROOT.
      query: filePath,
      baseline: 0.25,
      target: 0.18,
      noise_epsilon: 0.01,
    };
    const reading = await getOutcomeValue(outcome);
    assert.ok(reading, "outcomes file adapter should return a reading, not null");
    assert.equal(reading!.value, written);
  });

  test("re-publish overwrites with the current value (hourly idempotency)", async () => {
    const filePath = join(tmpDir, "brier-rolling.txt");
    await publishForecastCalibrationBrierMetric({ filePath, fetchImpl: fetchOk({ brierScore: 0.3 }) });
    const second = await publishForecastCalibrationBrierMetric({
      filePath,
      fetchImpl: fetchOk({ brierScore: 0.22 }),
    });
    assert.equal(second.ok, true);
    assert.equal(Number((await readFile(filePath, "utf-8")).trim()), 0.22);
  });
});

describe("publishForecastCalibrationBrierMetric — never write a fabricated value", () => {
  test("unreachable target -> no file, fetch-failed", async () => {
    const filePath = join(tmpDir, "brier-unreachable.txt");
    const result = await publishForecastCalibrationBrierMetric({
      filePath,
      fetchImpl: (async () => {
        throw new TypeError("fetch failed: ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "fetch-failed");
    await assert.rejects(stat(filePath), /ENOENT/, "file must not be created on fetch failure");
  });

  test("non-200 response -> no file, non-200", async () => {
    const filePath = join(tmpDir, "brier-500.txt");
    const result = await publishForecastCalibrationBrierMetric({
      filePath,
      fetchImpl: (async () => ({
        ok: false,
        status: 500,
        json: async () => ({}),
      })) as unknown as typeof fetch,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "non-200");
    await assert.rejects(stat(filePath), /ENOENT/);
  });

  test("malformed JSON body -> no file, malformed-response", async () => {
    const filePath = join(tmpDir, "brier-malformed.txt");
    const result = await publishForecastCalibrationBrierMetric({
      filePath,
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token < in JSON");
        },
      })) as unknown as typeof fetch,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "malformed-response");
    await assert.rejects(stat(filePath), /ENOENT/);
  });

  test("null brierScore (not enough resolved forecasts) -> no file, no-score", async () => {
    const filePath = join(tmpDir, "brier-null.txt");
    const result = await publishForecastCalibrationBrierMetric({
      filePath,
      fetchImpl: fetchOk({ brierScore: null, sampleCount: 0 }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "no-score");
    await assert.rejects(stat(filePath), /ENOENT/);
  });

  test("non-numeric brierScore -> no file, no-score", async () => {
    const filePath = join(tmpDir, "brier-string.txt");
    const result = await publishForecastCalibrationBrierMetric({
      filePath,
      fetchImpl: fetchOk({ brierScore: "0.21" }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "no-score");
    await assert.rejects(stat(filePath), /ENOENT/);
  });

  test("failure leaves a previously-written value untouched (stale mtime is the signal)", async () => {
    const filePath = join(tmpDir, "brier-stale.txt");
    await writeFile(filePath, "0.24\n", "utf-8");
    const result = await publishForecastCalibrationBrierMetric({
      filePath,
      fetchImpl: (async () => {
        throw new TypeError("fetch failed: timeout");
      }) as unknown as typeof fetch,
    });
    assert.equal(result.ok, false);
    assert.equal(
      (await readFile(filePath, "utf-8")),
      "0.24\n",
      "prior value must survive a failed sample verbatim",
    );
  });
});

describe("Housekeeping wiring (issue #1657 — seventh chore)", () => {
  // runHousekeeping's sibling chores read/write Redis guard keys, so these
  // tests need a live Redis (DB 7, dedicated per #948). The producer itself
  // is injected so no live target is required.
  test("chore reports 'ran' when the producer resolves", async () => {
    const { runHousekeeping } = await import("../src/scheduler/housekeeping.ts");
    let calls = 0;
    const summary = await runHousekeeping(
      { publish: async () => {} },
      {
        publishBrierMetric: async () => {
          calls++;
          return { ok: true };
        },
      },
    );
    assert.equal(calls, 1, "producer must be invoked exactly once per housekeeping run");
    assert.ok(
      summary.ran.includes("forecast-calibration-brier"),
      `forecast-calibration-brier should be in ran, got ran=${JSON.stringify(summary.ran)}`,
    );
  });

  test("chore reports 'ran' even when the sample failed (no-write is not a throw)", async () => {
    const { runHousekeeping } = await import("../src/scheduler/housekeeping.ts");
    const summary = await runHousekeeping(
      { publish: async () => {} },
      { publishBrierMetric: async () => ({ ok: false }) },
    );
    assert.ok(
      summary.ran.includes("forecast-calibration-brier"),
      "a clean failed sample still counts as ran (producer never throws by contract)",
    );
  });

  test("chore reports 'skipped' on an unexpected throw", async () => {
    const { runHousekeeping } = await import("../src/scheduler/housekeeping.ts");
    const summary = await runHousekeeping(
      { publish: async () => {} },
      {
        publishBrierMetric: async () => {
          throw new Error("unexpected producer crash");
        },
      },
    );
    assert.ok(
      summary.skipped.includes("forecast-calibration-brier"),
      "an unexpected throw must surface in skipped, not abort the run",
    );
    assert.ok(
      !summary.ran.includes("forecast-calibration-brier"),
      "a throwing chore must not also count as ran",
    );
  });
});

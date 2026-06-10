/**
 * Regression tests for the forecast-calibration-brier outcome producer
 * (issue #1657, src/metrics/forecast-brier.ts).
 *
 * Bug classes this guards against:
 *   - `metrics/forecast-calibration-brier.txt` never written → the
 *     forecast-calibration-brier leading outcome reads as no-data forever and
 *     Outcome Holdback has no real target-health signal.
 *   - A fabricated value written while the target is unreachable / returns
 *     garbage → silently poisons holdback baselines. The contract is: any
 *     failure path leaves the file UNTOUCHED (stale mtime is the staleness
 *     signal).
 *   - `brierScore: null` (target up, no scoreable forecasts) treated as 0 —
 *     null must mean no-write, never a synthetic number.
 */

import { test, describe, beforeEach, after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import {
  publishForecastBrierMetric,
  maybePublishForecastBrierMetric,
  resetForecastBrierThrottle,
} from "../src/metrics/forecast-brier.ts";
import { getOutcomeValue, type Outcome } from "../src/outcomes.ts";

let tmpDir: string;
const servers: Server[] = [];

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hydra-brier-producer-test-"));
});

after(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  for (const s of servers) s.close();
});

beforeEach(() => {
  resetForecastBrierThrottle();
});

/** Spin up a one-route HTTP server standing in for the target's calibration API. */
function startStubTarget(
  handler: (path: string) => { status: number; body: string },
): Promise<{ baseUrl: string; server: Server; requests: string[] }> {
  return new Promise((resolvePromise) => {
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url || "");
      const { status, body } = handler(req.url || "");
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    });
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolvePromise({ baseUrl: `http://127.0.0.1:${addr.port}`, server, requests });
    });
  });
}

describe("publishForecastBrierMetric — successful write", () => {
  test("writes the aggregate brierScore to the metric file", async () => {
    const { baseUrl, requests } = await startStubTarget(() => ({
      status: 200,
      body: JSON.stringify({ totalForecasts: 12, brierScore: 0.21, logLoss: 0.5 }),
    }));
    const filePath = join(tmpDir, "written", "brier.txt");

    const result = await publishForecastBrierMetric({ baseUrl, filePath });

    assert.equal(result.ok, true);
    assert.equal(result.wrote, true);
    assert.equal(result.reason, "written");
    assert.equal(result.value, 0.21);
    // It hit the calibration route we verified live on the target.
    assert.deepEqual(requests, ["/api/calibration/forecast-metrics"]);
    // Single numeric line, same round-trip contract as the outcomes adapter.
    const raw = await readFile(filePath, "utf-8");
    assert.equal(Number(raw.trim()), 0.21);
    assert.ok(raw.endsWith("\n"), "trailing newline expected");
  });

  test("getOutcomeValue returns a real reading from the produced file", async () => {
    const { baseUrl } = await startStubTarget(() => ({
      status: 200,
      body: JSON.stringify({ brierScore: 0.19 }),
    }));
    const filePath = join(tmpDir, "outcome-read", "brier.txt");
    await publishForecastBrierMetric({ baseUrl, filePath });

    const outcome: Outcome = {
      name: "forecast-calibration-brier",
      kind: "leading",
      direction: "down",
      source: "file",
      query: filePath, // absolute, so HYDRA_ROOT resolution is a no-op
      baseline: 0.25,
      target: 0.18,
      noise_epsilon: 0.005,
    };
    const reading = await getOutcomeValue(outcome);
    assert.ok(reading, "expected a real reading, got null");
    assert.equal(reading!.value, 0.19);
  });
});

describe("publishForecastBrierMetric — unreachable target leaves file untouched", () => {
  test("connection refused → no write, target-unreachable", async () => {
    // Grab a port that is guaranteed closed: listen then close.
    const { baseUrl, server } = await startStubTarget(() => ({ status: 200, body: "{}" }));
    await new Promise<void>((r) => server.close(() => r()));

    const filePath = join(tmpDir, "unreachable", "brier.txt");
    const result = await publishForecastBrierMetric({ baseUrl, filePath, timeoutMs: 2000 });

    assert.equal(result.ok, false);
    assert.equal(result.wrote, false);
    assert.equal(result.reason, "target-unreachable");
    assert.equal(existsSync(filePath), false, "file must not be created on failure");
  });

  test("unreachable target never clobbers a previously-written value", async () => {
    const filePath = join(tmpDir, "stale.txt");
    // A prior good cycle wrote 0.22.
    const { baseUrl: goodUrl } = await startStubTarget(() => ({
      status: 200,
      body: JSON.stringify({ brierScore: 0.22 }),
    }));
    await publishForecastBrierMetric({ baseUrl: goodUrl, filePath });

    // Target goes down — stale value must survive (stale mtime is the signal).
    const { baseUrl: deadUrl, server } = await startStubTarget(() => ({ status: 200, body: "{}" }));
    await new Promise<void>((r) => server.close(() => r()));
    const result = await publishForecastBrierMetric({ baseUrl: deadUrl, filePath, timeoutMs: 2000 });

    assert.equal(result.wrote, false);
    assert.equal(Number((await readFile(filePath, "utf-8")).trim()), 0.22);
  });

  test("non-2xx response → no write", async () => {
    const { baseUrl } = await startStubTarget(() => ({
      status: 500,
      body: JSON.stringify({ error: "Failed to compute calibration forecast metrics" }),
    }));
    const filePath = join(tmpDir, "http500", "brier.txt");
    const result = await publishForecastBrierMetric({ baseUrl, filePath });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "target-unreachable");
    assert.equal(existsSync(filePath), false);
  });
});

describe("publishForecastBrierMetric — malformed response leaves file untouched", () => {
  test("non-JSON body → malformed-response, no write", async () => {
    const { baseUrl } = await startStubTarget(() => ({ status: 200, body: "<html>nope</html>" }));
    const filePath = join(tmpDir, "notjson", "brier.txt");
    const result = await publishForecastBrierMetric({ baseUrl, filePath });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "malformed-response");
    assert.equal(existsSync(filePath), false);
  });

  test("brierScore non-numeric → malformed-response, no write", async () => {
    const { baseUrl } = await startStubTarget(() => ({
      status: 200,
      body: JSON.stringify({ brierScore: "0.21-ish" }),
    }));
    const filePath = join(tmpDir, "nonnumeric", "brier.txt");
    const result = await publishForecastBrierMetric({ baseUrl, filePath });

    assert.equal(result.reason, "malformed-response");
    assert.equal(existsSync(filePath), false);
  });

  test("brierScore missing entirely → malformed-response, no write", async () => {
    const { baseUrl } = await startStubTarget(() => ({
      status: 200,
      body: JSON.stringify({ totalForecasts: 3 }),
    }));
    const filePath = join(tmpDir, "missingfield", "brier.txt");
    const result = await publishForecastBrierMetric({ baseUrl, filePath });

    assert.equal(result.reason, "malformed-response");
    assert.equal(existsSync(filePath), false);
  });

  test("brierScore null (no scoreable forecasts yet) → no-data, no write — never a fabricated 0", async () => {
    const { baseUrl } = await startStubTarget(() => ({
      status: 200,
      body: JSON.stringify({ totalForecasts: 0, brierScore: null }),
    }));
    const filePath = join(tmpDir, "nodata", "brier.txt");
    const result = await publishForecastBrierMetric({ baseUrl, filePath });

    // Healthy target, legitimately no data: ok=true but nothing written.
    assert.equal(result.ok, true);
    assert.equal(result.wrote, false);
    assert.equal(result.reason, "no-data");
    assert.equal(existsSync(filePath), false);
  });
});

describe("maybePublishForecastBrierMetric — heartbeat throttle", () => {
  test("publishes on the first call, throttles within the interval, republishes after it", async () => {
    let served = 0;
    const { baseUrl } = await startStubTarget(() => {
      served++;
      return { status: 200, body: JSON.stringify({ brierScore: 0.2 }) };
    });
    const filePath = join(tmpDir, "throttle", "brier.txt");
    const hour = 60 * 60 * 1000;
    const t0 = 10 * hour; // any epoch offset > 0 so the cold throttle (0) fires

    const first = await maybePublishForecastBrierMetric({ baseUrl, filePath, nowMs: t0 });
    assert.ok(first, "first call must publish");
    assert.equal(first!.wrote, true);

    // 5-minute-tick cadence inside the hour → throttled, no fetch.
    const second = await maybePublishForecastBrierMetric({ baseUrl, filePath, nowMs: t0 + 5 * 60 * 1000 });
    assert.equal(second, null);
    assert.equal(served, 1, "throttled call must not hit the target");

    // Past the interval → publishes again.
    const third = await maybePublishForecastBrierMetric({ baseUrl, filePath, nowMs: t0 + hour });
    assert.ok(third, "post-interval call must publish");
    assert.equal(served, 2);
  });

  test("throttle stamps at attempt start: an unreachable target is not retried inside the window", async () => {
    const { baseUrl, server } = await startStubTarget(() => ({ status: 200, body: "{}" }));
    await new Promise<void>((r) => server.close(() => r()));
    const filePath = join(tmpDir, "throttle-fail", "brier.txt");
    const t0 = 99 * 60 * 60 * 1000;

    const first = await maybePublishForecastBrierMetric({ baseUrl, filePath, nowMs: t0, timeoutMs: 2000 });
    assert.equal(first!.reason, "target-unreachable");

    const second = await maybePublishForecastBrierMetric({ baseUrl, filePath, nowMs: t0 + 60 * 1000 });
    assert.equal(second, null, "failure must still consume the hourly attempt slot");
  });
});

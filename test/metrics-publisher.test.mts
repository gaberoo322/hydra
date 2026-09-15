/**
 * Regression tests for the metrics publisher (issue #315).
 *
 * Bug class this guards against:
 *   - `metrics/orchestrator-share.txt` missing on disk because the
 *     orchestrator never publishes it -> outcomes file adapter logs ENOENT
 *     every Meta-analysis tick.
 *   - Non-finite values (NaN, Infinity) silently written -> file adapter
 *     returns null and the outcome is permanently unobservable.
 *   - Missing `metrics/` directory crashing the publisher (it has to
 *     mkdir it on first cycle).
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ORCHESTRATOR_OWNED_METRIC_QUERIES,
  isTargetMetricCandidateQuery,
  publishTargetOutcomeMetrics,
  writeMetricFile,
} from "../src/metrics/publish.ts";
import { getOutcomeValue, type Outcome } from "../src/outcomes.ts";
import {
  createTargetOutcomesPublishState,
  runTargetOutcomesPublish,
} from "../src/scheduler/chores/target-outcomes-publish.ts";
import type { TargetOutcomesPublishResult } from "../src/metrics/publish.ts";
import { logger } from "../src/logger.ts";

let tmpDir: string;

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hydra-metrics-pub-test-"));
});

after(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

describe("writeMetricFile — basic IO", () => {
  test("writes a finite share value with trailing newline", async () => {
    const filePath = join(tmpDir, "share.txt");
    const ok = await writeMetricFile(0.42, filePath);
    assert.equal(ok, true);
    const raw = await readFile(filePath, "utf-8");
    // Number(raw.trim()) must round-trip — that's what the outcomes file
    // adapter does (src/outcomes.ts readFileAdapter).
    assert.equal(Number(raw.trim()), 0.42);
    assert.ok(raw.endsWith("\n"), "trailing newline expected");
  });

  test("creates parent directories when missing", async () => {
    // Nested path that does not yet exist — first-cycle scenario.
    const filePath = join(tmpDir, "deep", "nested", "share.txt");
    const ok = await writeMetricFile(0.18, filePath);
    assert.equal(ok, true);
    const st = await stat(filePath);
    assert.ok(st.isFile());
    assert.equal(Number((await readFile(filePath, "utf-8")).trim()), 0.18);
  });

  test("overwrites previous value on subsequent writes", async () => {
    const filePath = join(tmpDir, "rolling.txt");
    assert.equal(await writeMetricFile(0.1, filePath), true);
    assert.equal(await writeMetricFile(0.3, filePath), true);
    const raw = await readFile(filePath, "utf-8");
    assert.equal(Number(raw.trim()), 0.3);
  });

  test("refuses to write non-finite values (NaN / Infinity)", async () => {
    const filePath = join(tmpDir, "bad.txt");
    assert.equal(await writeMetricFile(Number.NaN, filePath), false);
    assert.equal(await writeMetricFile(Number.POSITIVE_INFINITY, filePath), false);
    // File should not exist after refused writes.
    await assert.rejects(stat(filePath), /ENOENT/);
  });
});

describe("round-trip — writer + outcomes file adapter", () => {
  // Core regression: writing a known share value and reading it back
  // through getOutcomeValue() yields the same number. This is the
  // acceptance criterion: "Regression test: writing a known share value
  // and reading it back returns the same number through the outcome
  // adapter." (issue #315)
  test("written share is readable via outcomes file adapter", async () => {
    const filePath = join(tmpDir, "roundtrip.txt");
    const written = 0.275;
    assert.equal(await writeMetricFile(written, filePath), true);

    const outcome: Outcome = {
      name: "orchestrator-self-improvement-share",
      kind: "leading",
      direction: "up",
      source: "file",
      // Absolute path so resolveFilePath() doesn't append HYDRA_ROOT.
      query: filePath,
      baseline: 0,
      target: 0.25,
      noise_epsilon: 0.01,
      holdback: "include",
    };
    const reading = await getOutcomeValue(outcome);
    assert.ok(reading, "outcomes file adapter should return a reading, not null");
    assert.equal(reading!.value, written);
    assert.ok(typeof reading!.ts === "string" && reading!.ts.length > 0);
  });

  test("zero share is a valid reading (not null, not error)", async () => {
    // When no cycles have recorded yet, share is 0. Writing 0 must still
    // produce a parseable file — the file adapter treats 0 as a real value
    // and reports it honestly. The alternative — refusing to write — was
    // the bug this issue exists to fix.
    const filePath = join(tmpDir, "zero.txt");
    assert.equal(await writeMetricFile(0, filePath), true);

    const outcome: Outcome = {
      name: "x",
      kind: "leading",
      direction: "up",
      source: "file",
      query: filePath,
      baseline: 0,
      target: 0.25,
      noise_epsilon: 0,
      holdback: "include",
    };
    const reading = await getOutcomeValue(outcome);
    assert.ok(reading, "zero must be readable");
    assert.equal(reading!.value, 0);
  });
});

// ---------------------------------------------------------------------------
// Target outcomes publisher (issue #4477)
// ---------------------------------------------------------------------------

function fileOutcome(name: string, query: string): Outcome {
  return {
    name,
    kind: "leading",
    direction: "up",
    source: "file",
    query,
    baseline: 0,
    target: 1,
    noise_epsilon: 0,
    holdback: "include",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Fetch stub that records every call and returns `respond()`. */
function recordingFetch(respond: () => Response | Promise<Response>) {
  const calls: string[] = [];
  const impl = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return respond();
  }) as typeof fetch;
  return { calls, impl };
}

/** Capture logger.error / logger.warn / logger.info calls during `fn`. */
async function withCapturedLogs<T>(fn: () => Promise<T>) {
  const logs: { level: string; msg: string }[] = [];
  const l = logger as any;
  const orig = { error: l.error, warn: l.warn, info: l.info };
  for (const level of ["error", "warn", "info"] as const) {
    l[level] = (_obj: unknown, msg: string) => {
      logs.push({ level, msg: String(msg) });
    };
  }
  try {
    const result = await fn();
    return { result, logs };
  } finally {
    l.error = orig.error;
    l.warn = orig.warn;
    l.info = orig.info;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    /* intentional: ENOENT is the "absent" answer this helper exists to return */
    return false;
  }
}

describe("publishTargetOutcomeMetrics — Target /api/outcomes to metrics files (issue #4477)", () => {
  let root: string;
  const outcomes = [
    fileOutcome("alpha-rate", "metrics/sample/alpha/rate.txt"),
    fileOutcome("beta-count", "metrics/sample/beta/count.txt"),
  ];
  const load = async () => ({ ok: true as const, outcomes });

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "hydra-target-outcomes-"));
  });
  after(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  test("happy path writes each declared outcome to its query path", async () => {
    const dir = await mkdtemp(join(root, "happy-"));
    const f = recordingFetch(() => jsonResponse({ "alpha-rate": 12.5, "beta-count": 3, extra: 9 }));
    const res = await publishTargetOutcomeMetrics({ loadOutcomes: load, baseUrl: "http://t.test", fetchImpl: f.impl, root: dir });
    assert.equal(res.ok, true);
    assert.deepEqual(f.calls, ["http://t.test/api/outcomes"]);
    if (res.ok) assert.deepEqual(res.written, ["alpha-rate", "beta-count"]);
    assert.equal(Number((await readFile(join(dir, "metrics/sample/alpha/rate.txt"), "utf-8")).trim()), 12.5);
    assert.equal(Number((await readFile(join(dir, "metrics/sample/beta/count.txt"), "utf-8")).trim()), 3);
    // Response-only names never create files.
    assert.equal(await exists(join(dir, "metrics/extra.txt")), false);
  });

  test("null value writes nothing and leaves any prior file untouched", async () => {
    const dir = await mkdtemp(join(root, "null-"));
    const prior = join(dir, "metrics/sample/alpha/rate.txt");
    await mkdir(join(dir, "metrics/sample/alpha"), { recursive: true });
    await writeFile(prior, "7\n", "utf-8");
    const f = recordingFetch(() => jsonResponse({ "alpha-rate": null, "beta-count": null }));
    const res = await publishTargetOutcomeMetrics({ loadOutcomes: load, baseUrl: "http://t.test", fetchImpl: f.impl, root: dir });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.deepEqual(res.nulls, ["alpha-rate", "beta-count"]);
      assert.deepEqual(res.written, []);
    }
    assert.equal(await readFile(prior, "utf-8"), "7\n");
    assert.equal(await exists(join(dir, "metrics/sample/beta/count.txt")), false);
  });

  test("unreachable Target (fetch throws) writes nothing and returns fetch-failed", async () => {
    const dir = await mkdtemp(join(root, "unreach-"));
    const impl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const res = await publishTargetOutcomeMetrics({ loadOutcomes: load, baseUrl: "http://t.test", fetchImpl: impl, root: dir });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "fetch-failed");
    assert.equal(await exists(join(dir, "metrics")), false);
  });

  test("non-200 response writes nothing and returns non-200", async () => {
    const dir = await mkdtemp(join(root, "non200-"));
    const f = recordingFetch(() => jsonResponse({ "alpha-rate": 1 }, 503));
    const res = await publishTargetOutcomeMetrics({ loadOutcomes: load, baseUrl: "http://t.test", fetchImpl: f.impl, root: dir });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "non-200");
    assert.equal(await exists(join(dir, "metrics")), false);
  });

  test("malformed body (unparseable, array, null, primitive) is malformed-response and writes nothing", async () => {
    for (const raw of ["not json{", "[1,2]", "null", "42"]) {
      const dir = await mkdtemp(join(root, "malformed-"));
      const f = recordingFetch(() => jsonResponse(raw));
      const res = await publishTargetOutcomeMetrics({ loadOutcomes: load, baseUrl: "http://t.test", fetchImpl: f.impl, root: dir });
      assert.equal(res.ok, false, `body ${raw} must fail`);
      if (!res.ok) assert.equal(res.reason, "malformed-response", `body ${raw}`);
      assert.equal(await exists(join(dir, "metrics")), false);
    }
  });

  test("a declared outcome missing from the response is recorded as missing, not written", async () => {
    const dir = await mkdtemp(join(root, "missing-"));
    const f = recordingFetch(() => jsonResponse({ "alpha-rate": 2 }));
    const res = await publishTargetOutcomeMetrics({ loadOutcomes: load, baseUrl: "http://t.test", fetchImpl: f.impl, root: dir });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.deepEqual(res.written, ["alpha-rate"]);
      assert.deepEqual(res.missing, ["beta-count"]);
    }
    assert.equal(await exists(join(dir, "metrics/sample/beta/count.txt")), false);
  });

  test("non-number / non-finite values are invalid and never written", async () => {
    const dir = await mkdtemp(join(root, "invalid-"));
    const f = recordingFetch(() => jsonResponse({ "alpha-rate": "12", "beta-count": { v: 1 } }));
    const { result: res } = await withCapturedLogs(() =>
      publishTargetOutcomeMetrics({ loadOutcomes: load, baseUrl: "http://t.test", fetchImpl: f.impl, root: dir }),
    );
    assert.equal(res.ok, true);
    if (res.ok) assert.deepEqual(res.invalid, ["alpha-rate", "beta-count"]);
    assert.equal(await exists(join(dir, "metrics")), false);
  });

  test("orchestrator-owned metrics are excluded even when the Target serves that name", async () => {
    const dir = await mkdtemp(join(root, "owned-"));
    const ownedQuery = [...ORCHESTRATOR_OWNED_METRIC_QUERIES][0];
    assert.equal(ownedQuery, "metrics/orchestrator-share.txt");
    const mixed = [fileOutcome("owned-share", ownedQuery), fileOutcome("alpha-rate", "metrics/sample/alpha/rate.txt")];
    const f = recordingFetch(() => jsonResponse({ "owned-share": 0.99, "alpha-rate": 4 }));
    const res = await publishTargetOutcomeMetrics({
      loadOutcomes: async () => ({ ok: true as const, outcomes: mixed }),
      baseUrl: "http://t.test",
      fetchImpl: f.impl,
      root: dir,
    });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.candidates, 1);
      assert.deepEqual(res.written, ["alpha-rate"]);
    }
    assert.equal(await exists(join(dir, ownedQuery)), false);
  });

  test("empty candidate set makes no HTTP request and logs no failure", async () => {
    const dir = await mkdtemp(join(root, "empty-"));
    const f = recordingFetch(() => jsonResponse({}));
    const { result: res, logs } = await withCapturedLogs(() =>
      publishTargetOutcomeMetrics({
        loadOutcomes: async () => ({
          ok: true as const,
          outcomes: [fileOutcome("owned-share", "metrics/orchestrator-share.txt")],
        }),
        baseUrl: "http://t.test",
        fetchImpl: f.impl,
        root: dir,
      }),
    );
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.candidates, 0);
      assert.equal(res.fetched, false);
    }
    assert.equal(f.calls.length, 0, "no fetch when there are no candidates");
    assert.equal(logs.filter((l) => l.level === "error").length, 0);
  });

  test("outcomes load failure writes nothing and makes no request", async () => {
    const f = recordingFetch(() => jsonResponse({}));
    const res = await publishTargetOutcomeMetrics({
      loadOutcomes: async () => ({ ok: false as const, errors: ["bad yaml"] }),
      baseUrl: "http://t.test",
      fetchImpl: f.impl,
      root,
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "outcomes-load-failed");
    assert.equal(f.calls.length, 0);
  });

  test("candidate query filter accepts only relative metrics/ paths without ..", () => {
    assert.equal(isTargetMetricCandidateQuery("metrics/sample/a.txt"), true);
    assert.equal(isTargetMetricCandidateQuery("./metrics/sample/a.txt"), true);
    assert.equal(isTargetMetricCandidateQuery("metrics/../config/x.txt"), false);
    assert.equal(isTargetMetricCandidateQuery("/abs/metrics/a.txt"), false);
    assert.equal(isTargetMetricCandidateQuery("config/a.txt"), false);
    assert.equal(isTargetMetricCandidateQuery("metrics/orchestrator-share.txt"), false);
  });
});

describe("writeMetricFile — atomic write (issue #4477)", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "hydra-metrics-atomic-"));
  });
  after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("atomic write leaves no temp file behind", async () => {
    const target = join(dir, "atomic.txt");
    assert.equal(await writeMetricFile(1.5, target), true);
    assert.equal(await writeMetricFile(2.5, target), true);
    assert.deepEqual(await readdir(dir), ["atomic.txt"]);
    assert.equal(await readFile(target, "utf-8"), "2.5\n");
  });

  test("failed write returns false and leaves no temp file", async () => {
    // The target path is an existing non-empty DIRECTORY, so rename onto it fails.
    const target = join(dir, "is-a-dir");
    await mkdir(join(target, "child"), { recursive: true });
    const { result } = await withCapturedLogs(() => writeMetricFile(3, target));
    assert.equal(result, false);
    const leftovers = (await readdir(dir)).filter((n) => n.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  });
});

describe("runTargetOutcomesPublish — log once per failure streak (issue #4477)", () => {
  const failure: TargetOutcomesPublishResult = {
    ok: false,
    reason: "fetch-failed",
    detail: "ECONNREFUSED",
    url: "http://t.test/api/outcomes",
  };
  const success: TargetOutcomesPublishResult = {
    ok: true,
    candidates: 1,
    fetched: true,
    written: ["alpha-rate"],
    nulls: [],
    missing: [],
    invalid: [],
  };

  test("logs the failure once per streak and resets on the next success", async () => {
    const state = createTargetOutcomesPublishState();
    const seq = [failure, failure, failure, success, failure];
    let i = 0;
    const publish = async () => seq[i++];
    const { logs } = await withCapturedLogs(async () => {
      for (let n = 0; n < seq.length; n++) await runTargetOutcomesPublish({ publish, state });
    });
    const errors = logs.filter((l) => l.level === "error");
    assert.equal(errors.length, 2, "one error per failure streak (2 streaks)");
    assert.equal(logs.filter((l) => l.level === "info").length, 1, "one recovery line");
    assert.equal(state.failing, true);
  });

  test("never throws when the publisher throws — folds to a failure result", async () => {
    const state = createTargetOutcomesPublishState();
    const { result, logs } = await withCapturedLogs(() =>
      runTargetOutcomesPublish({
        publish: async () => {
          throw new Error("boom");
        },
        state,
      }),
    );
    assert.equal(result.ok, false);
    assert.equal(logs.filter((l) => l.level === "error").length, 1);
  });

  test("a declared outcome missing from the response logs one aggregated warn", async () => {
    const state = createTargetOutcomesPublishState();
    const { logs } = await withCapturedLogs(() =>
      runTargetOutcomesPublish({
        publish: async () => ({ ...success, missing: ["beta-count", "gamma"] }),
        state,
      }),
    );
    assert.equal(logs.filter((l) => l.level === "warn").length, 1);
    assert.equal(logs.filter((l) => l.level === "error").length, 0);
  });
});

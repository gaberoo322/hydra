/**
 * test/indexer-point-lock-retry.test.mts — the OpenViking learning-indexer's
 * bounded client-side retry for point-lock contention on the add-resource POST
 * (issue #2658).
 *
 * The indexer is a best-effort background subsystem: under concurrent semantic-
 * indexing writes OV's lock manager 500s with an INTERNAL/"Failed to acquire
 * point lock" body — a TRANSIENT contention condition on a HEALTHY container.
 * Before #2658 `indexText` gave up on the first such failure, leaving stale
 * embeddings silently. These tests stub `globalThis.fetch` (the two-step
 * temp_upload → add-resource shape) and assert:
 *   - a point-lock failure is RETRIED (with a tiny injected backoff + fixed
 *     jitter so no real second-long sleeps) and succeeds once contention clears,
 *   - an exhausted retry budget bumps the monotonic `indexerErrors` counter
 *     surfaced on the scheduler heartbeat, and
 *   - a genuine (non-lock) rejection is NOT retried and surfaces on attempt 1
 *     (the #1828 do-not-mask guard).
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { indexText } from "../src/knowledge-base/indexer.ts";
import {
  getIndexerErrorStats,
  resetIndexerErrorStats,
} from "../src/scheduler/heartbeat.ts";

/** OV's own point-lock 500 body under concurrent-indexing contention. */
const OV_POINT_LOCK_BODY =
  '{"status":"error","result":null,"error":{"code":"INTERNAL","message":"Failed to acquire point lock for [\'/local/hydra/resources/hydra-memory\']"}}';

/** A genuine, non-retryable payload rejection body. */
const OV_INVALID_ARG_BODY =
  '{"status":"error","result":null,"error":{"code":"INVALID_ARGUMENT","message":"missing field: temp_path"}}';

const realFetch = globalThis.fetch;
const realErr = console.error;
const realWarn = console.warn;
const realLog = console.log;

/**
 * Build a stubbed fetch that always answers the temp_upload step with a temp
 * path, and answers the add-resource step (`POST /api/v1/resources`) by calling
 * `addResponder` with the 1-based add-attempt number so a test can fail the
 * first N attempts then succeed. Returns a `getAddAttempts()` probe.
 */
function stubFetch(addResponder: (attempt: number) => { ok: boolean; body?: string }) {
  let addAttempts = 0;
  globalThis.fetch = (async (url: any) => {
    const u = String(url);
    if (u.endsWith("/api/v1/resources/temp_upload")) {
      return {
        ok: true,
        json: async () => ({ result: { temp_path: "/tmp/fake-temp-path" } }),
        text: async () => "",
      } as any;
    }
    // The add-resource step.
    addAttempts++;
    const r = addResponder(addAttempts);
    return {
      ok: r.ok,
      status: r.ok ? 200 : 500,
      json: async () => ({}),
      text: async () => r.body ?? "",
    } as any;
  }) as any;
  return { getAddAttempts: () => addAttempts };
}

describe("indexer point-lock retry (issue #2658)", () => {
  beforeEach(() => {
    resetIndexerErrorStats();
    // Silence the (expected) warn/error/log lines the retry loop emits.
    console.error = () => {};
    console.warn = () => {};
    console.log = () => {};
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    console.error = realErr;
    console.warn = realWarn;
    console.log = realLog;
    resetIndexerErrorStats();
  });

  test("retries a point-lock 500 and succeeds once contention clears (no error counted)", async () => {
    // Fail the first two add attempts with a point-lock body, then succeed.
    const probe = stubFetch((attempt) =>
      attempt <= 2 ? { ok: false, body: OV_POINT_LOCK_BODY } : { ok: true },
    );

    await indexText("hydra-source:test__contended.mts", "content", {
      backoffBaseMs: 1,
      jitter: () => 0, // deterministic backoff
      maxAttempts: 4,
    });

    assert.equal(probe.getAddAttempts(), 3, "should retry twice then succeed on the 3rd attempt");
    assert.equal(getIndexerErrorStats().indexerErrors, 0, "a recovered index must NOT count an error");
    assert.equal(getIndexerErrorStats().indexerRetries, 2, "two transient retries were performed");
  });

  test("exhausting the retry budget bumps the monotonic indexerErrors counter", async () => {
    // Every add attempt is a point-lock failure — the loop exhausts its budget.
    const probe = stubFetch(() => ({ ok: false, body: OV_POINT_LOCK_BODY }));

    await indexText("hydra-source:test__starved.mts", "content", {
      backoffBaseMs: 1,
      jitter: () => 0,
      maxAttempts: 3,
    });

    assert.equal(probe.getAddAttempts(), 3, "should try exactly maxAttempts times before giving up");
    assert.equal(getIndexerErrorStats().indexerErrors, 1, "an exhausted index must count exactly one error");
    assert.equal(getIndexerErrorStats().indexerRetries, 2, "maxAttempts-1 retries preceded the give-up");
  });

  test("a genuine (non-lock) rejection is NOT retried and surfaces on attempt 1 (do-not-mask guard)", async () => {
    const probe = stubFetch(() => ({ ok: false, body: OV_INVALID_ARG_BODY }));

    await indexText("hydra-source:test__badpayload.mts", "content", {
      backoffBaseMs: 1,
      jitter: () => 0,
      maxAttempts: 4,
    });

    assert.equal(probe.getAddAttempts(), 1, "a real payload rejection must not be retried");
    assert.equal(getIndexerErrorStats().indexerRetries, 0, "no retry performed for a non-retryable failure");
    assert.equal(getIndexerErrorStats().indexerErrors, 1, "the give-up on a non-retryable failure is still counted");
  });

  test("a first-attempt success performs no retries and counts nothing", async () => {
    const probe = stubFetch(() => ({ ok: true }));

    await indexText("hydra-source:test__clean.mts", "content", {
      backoffBaseMs: 1,
      jitter: () => 0,
    });

    assert.equal(probe.getAddAttempts(), 1);
    assert.equal(getIndexerErrorStats().indexerErrors, 0);
    assert.equal(getIndexerErrorStats().indexerRetries, 0);
  });
});

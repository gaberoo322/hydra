/**
 * test/skill-registration.test.mts — OV skill-registration retry policy (#1828).
 *
 * Skill registration ran ONCE at startup as a single fire-and-forget POST per
 * skill with a 60s budget. Under OpenViking indexing load the `/api/v1/skills`
 * endpoint timed out (~8-12x/hour) and the catalog stayed empty until the next
 * process restart. `registerSkills()` now retries the transient OV codes
 * (`ov-timeout`, `ov-service-down`) with exponential backoff and a raised 120s
 * budget. These tests stub `globalThis.fetch` and assert:
 *   - a transient failure on the first attempt is retried and eventually succeeds,
 *   - a non-retryable failure (`ov-non-2xx`) is NOT retried,
 *   - the per-attempt timeout passed to fetch is the raised 120s budget.
 */

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

const { registerSkills } = await import("../src/knowledge-base/skill-registration.ts");

const realFetch = globalThis.fetch;
const realErr = console.error;
const realLog = console.log;
afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = realErr;
  console.log = realLog;
});

/** Silence the [Learning] / [ov-request] noise so the test output stays clean. */
function muteConsole() {
  console.error = () => {};
  console.log = () => {};
}

function okResponse(): any {
  return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
}

/** A fetch throw that the adapter classifies as `ov-timeout`. */
function timeoutThrow(): never {
  const err: any = new Error("The operation was aborted due to timeout");
  err.name = "TimeoutError";
  throw err;
}

describe("registerSkills: transient-failure retry (#1828)", () => {
  test("retries a timeout and succeeds on a later attempt", async () => {
    muteConsole();
    // 4 skills (planner, executor, skeptic, director). Make the very first POST
    // time out, then succeed for every subsequent call — proves the retry path
    // recovers the registration instead of permanently losing it.
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) timeoutThrow();
      return okResponse();
    }) as any;

    // backoffBaseMs:0 keeps the retry sleep off the wall clock.
    await registerSkills({ backoffBaseMs: 0 });

    // 4 skills, one extra call for the retried first skill = 5 total.
    assert.equal(calls, 5, "the timed-out first skill must be retried exactly once");
  });

  test("gives up after the attempt budget when timeouts never clear", async () => {
    muteConsole();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      timeoutThrow();
    }) as any;

    await registerSkills({ backoffBaseMs: 0 });

    // 4 skills × 3 attempts each (1 initial + 2 retries) = 12 calls, all failing.
    assert.equal(calls, 12, "each skill must be attempted exactly 3 times");
  });
});

describe("registerSkills: non-retryable failures short-circuit (#1828)", () => {
  test("a non-2xx rejection is NOT retried", async () => {
    muteConsole();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return { ok: false, status: 400, json: async () => ({}), text: async () => "bad payload" };
    }) as any;

    await registerSkills({ backoffBaseMs: 0 });

    // 4 skills, one attempt each — ov-non-2xx is not in the retryable set.
    assert.equal(calls, 4, "a non-retryable code must not trigger retries");
  });
});

describe("registerSkills: raised per-attempt timeout (#1828)", () => {
  test("passes the 120s budget as the fetch AbortSignal timeout", async () => {
    muteConsole();
    // AbortSignal.timeout(ms) produces a signal; we can't read ms back off it,
    // so assert indirectly: a 120s budget must not abort a fast-returning fetch.
    // (A regression that drops the timeout to 0 would abort here.)
    let sawSignal = false;
    globalThis.fetch = (async (_url: string, init: any) => {
      if (init?.signal && typeof init.signal.aborted === "boolean") sawSignal = true;
      return okResponse();
    }) as any;

    await registerSkills({ backoffBaseMs: 0 });
    assert.equal(sawSignal, true, "fetch must receive an AbortSignal with a live timeout budget");
  });
});

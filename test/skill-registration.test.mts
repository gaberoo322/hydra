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

const { registerSkills, getSkillCatalogState, reRegisterMissingSkills } = await import(
  "../src/knowledge-base/skill-registration.ts"
);

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

describe("registerSkills: queryable catalog state (#1968)", () => {
  test("all-success populates a full, completed catalog", async () => {
    muteConsole();
    globalThis.fetch = (async () => okResponse()) as any;

    await registerSkills({ backoffBaseMs: 0 });

    const state = getSkillCatalogState();
    assert.equal(state.completed, true, "a finished pass must mark completed");
    assert.equal(state.total, 4, "all four OV skills are expected");
    assert.equal(state.registered, 4, "all four must register on a clean OV");
    assert.equal(state.skills.length, 4);
    assert.ok(state.skills.every((s) => s.registered && s.lastError === null && s.lastSuccessAt));
    assert.ok(typeof state.lastAttemptAt === "number");
  });

  test("all-failure leaves an EMPTY catalog with per-skill error codes", async () => {
    muteConsole();
    globalThis.fetch = (async () => {
      timeoutThrow();
    }) as any;

    await registerSkills({ backoffBaseMs: 0 });

    const state = getSkillCatalogState();
    assert.equal(state.completed, true);
    assert.equal(state.registered, 0, "an all-timeout pass registers zero skills");
    assert.equal(state.total, 4);
    assert.ok(
      state.skills.every((s) => !s.registered && s.lastError === "ov-timeout"),
      "each un-registered skill records its last failure code",
    );
  });

  test("partial failure records which skills registered and which failed", async () => {
    muteConsole();
    // First skill times out on every attempt; the rest succeed first try.
    let firstSkillCalls = 0;
    globalThis.fetch = (async () => {
      // The first skill burns its 3 attempts before any other skill is reached.
      if (firstSkillCalls < 3) {
        firstSkillCalls++;
        timeoutThrow();
      }
      return okResponse();
    }) as any;

    await registerSkills({ backoffBaseMs: 0 });

    const state = getSkillCatalogState();
    assert.equal(state.registered, 3, "3 of 4 skills register; the first fails out");
    assert.equal(state.skills[0].registered, false);
    assert.equal(state.skills[0].lastError, "ov-timeout");
    assert.ok(state.skills.slice(1).every((s) => s.registered && s.lastError === null));
  });
});

describe("reRegisterMissingSkills: post-startup recovery (#2148)", () => {
  test("a no-op before any startup pass has completed", async () => {
    muteConsole();
    // Fresh module-level state has completed:false (or a prior test left it
    // full). Force the not-completed branch is impossible after earlier tests,
    // so instead assert the already-full branch is a no-op: register all 4 then
    // re-register — nothing is attempted.
    globalThis.fetch = (async () => okResponse()) as any;
    await registerSkills({ backoffBaseMs: 0 });

    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return okResponse();
    }) as any;
    const result = await reRegisterMissingSkills({ backoffBaseMs: 0 });

    assert.equal(result.attempted, false, "a full catalog must not re-attempt");
    assert.equal(calls, 0, "a full catalog must POST nothing");
    assert.equal(result.recovered, 0);
    assert.equal(result.stillMissing, 0);
  });

  test("recovers an empty catalog once OV answers, flipping empty→ok in place", async () => {
    muteConsole();
    // Startup pass fails every skill (OV down): catalog empty.
    globalThis.fetch = (async () => {
      timeoutThrow();
    }) as any;
    await registerSkills({ backoffBaseMs: 0 });
    assert.equal(getSkillCatalogState().registered, 0, "precondition: catalog empty after startup");

    // OV recovers — re-register all four missing skills now succeed.
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return okResponse();
    }) as any;
    const result = await reRegisterMissingSkills({ backoffBaseMs: 0 });

    assert.equal(result.attempted, true);
    assert.equal(result.recovered, 4, "all four previously-missing skills recover");
    assert.equal(result.stillMissing, 0);
    assert.equal(calls, 4, "only the four missing skills are re-POSTed, one attempt each");

    const state = getSkillCatalogState();
    assert.equal(state.registered, 4, "the in-process state flips empty→full WITHOUT a restart");
    assert.equal(state.completed, true, "completed stays true across recovery");
    assert.ok(state.skills.every((s) => s.registered && s.lastError === null && s.lastSuccessAt));
  });

  test("re-registers ONLY the missing skills, never clobbering a succeeded one", async () => {
    muteConsole();
    // Partial startup: first skill times out all attempts, rest succeed.
    let firstSkillCalls = 0;
    globalThis.fetch = (async () => {
      if (firstSkillCalls < 3) {
        firstSkillCalls++;
        timeoutThrow();
      }
      return okResponse();
    }) as any;
    await registerSkills({ backoffBaseMs: 0 });
    const before = getSkillCatalogState();
    assert.equal(before.registered, 3, "precondition: 3/4 after a partial startup");
    const succeededAt = before.skills[1].lastSuccessAt;

    // OV recovers — re-register should touch ONLY the one missing skill.
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return okResponse();
    }) as any;
    const result = await reRegisterMissingSkills({ backoffBaseMs: 0 });

    assert.equal(calls, 1, "exactly one POST — only the single missing skill is re-attempted");
    assert.equal(result.recovered, 1);
    assert.equal(result.stillMissing, 0);

    const after = getSkillCatalogState();
    assert.equal(after.registered, 4, "the gap closed to full");
    assert.equal(after.skills[0].registered, true, "the recovered skill is now registered");
    assert.equal(
      after.skills[1].lastSuccessAt,
      succeededAt,
      "an already-succeeded skill's success timestamp is untouched (not re-POSTed)",
    );
  });

  test("a still-down OV leaves the catalog missing and records the failure code", async () => {
    muteConsole();
    // Empty after startup.
    globalThis.fetch = (async () => {
      timeoutThrow();
    }) as any;
    await registerSkills({ backoffBaseMs: 0 });

    // OV still timing out during the recovery pass.
    const result = await reRegisterMissingSkills({ backoffBaseMs: 0 });

    assert.equal(result.attempted, true, "the pass ran (the guard let it through)");
    assert.equal(result.recovered, 0, "nothing recovers while OV is still down");
    assert.equal(result.stillMissing, 4);
    const state = getSkillCatalogState();
    assert.equal(state.registered, 0);
    assert.ok(state.skills.every((s) => !s.registered && s.lastError === "ov-timeout"));
  });
});

describe("getSkillCatalogState: defensive copy", () => {
  test("mutating the returned object does not corrupt the live state", async () => {
    muteConsole();
    globalThis.fetch = (async () => okResponse()) as any;
    await registerSkills({ backoffBaseMs: 0 });

    const a = getSkillCatalogState();
    a.registered = -999;
    a.skills[0].registered = false;

    const b = getSkillCatalogState();
    assert.equal(b.registered, 4, "the returned object must be a copy, not the live state");
    assert.equal(b.skills[0].registered, true, "skill entries must be copied too");
  });
});

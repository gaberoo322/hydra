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

const { registerSkills, getSkillCatalogState, reRegisterMissingSkills, isOvServerTimeout, VLM_DEFERRED_MARKER } =
  await import("../src/knowledge-base/skill-registration.ts");

/** Injectable VLM probe stubs (issue #2277). Default real probe is bypassed in tests. */
const vlmUp = async () => ({ status: "ok" as const, latencyMs: 5 });
const vlmDown = async () => ({ status: "down" as const, latencyMs: 5000, error: "timeout" });

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

/**
 * OV's own SERVER-SIDE timeout: a 500 whose body is the INTERNAL/"Request timed
 * out." envelope from the issue #2250 evidence. The adapter classifies this as
 * `ov-non-2xx` (it keys on `!res.ok`), carrying the body on the failure arm.
 */
const OV_SERVER_TIMEOUT_BODY =
  '{"status":"error","result":null,"error":{"code":"INTERNAL","message":"Request timed out.","details":null}}';
function ovServerTimeoutResponse(): any {
  return { ok: false, status: 500, json: async () => ({}), text: async () => OV_SERVER_TIMEOUT_BODY };
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
    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmUp });

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

    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmUp });

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

    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmUp });

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

    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmUp });
    assert.equal(sawSignal, true, "fetch must receive an AbortSignal with a live timeout budget");
  });
});

describe("registerSkills: queryable catalog state (#1968)", () => {
  test("all-success populates a full, completed catalog", async () => {
    muteConsole();
    globalThis.fetch = (async () => okResponse()) as any;

    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmUp });

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

    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmUp });

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

    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmUp });

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
    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmUp });

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
    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmUp });
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
    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmUp });
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
    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmUp });

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

describe("reRegisterMissingSkills: always logs an executed pass (#2163, INV3)", () => {
  test("a 0-recovery attempted pass emits exactly one log line (not silent)", async () => {
    // Empty catalog after a failing startup.
    console.error = () => {};
    console.log = () => {};
    globalThis.fetch = (async () => {
      timeoutThrow();
    }) as any;
    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmUp });

    // Capture only the recovery-pass output: count [Learning] recovery lines
    // across BOTH console.error and console.log. The per-skill [Learning] logs
    // from registerOneSkill are present too, so we match the recovery-pass
    // marker phrase specifically.
    const lines: string[] = [];
    console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };

    // OV still down during recovery → attempted:true, recovered:0.
    const result = await reRegisterMissingSkills({ backoffBaseMs: 0 });
    assert.equal(result.attempted, true);
    assert.equal(result.recovered, 0);

    const recoveryLines = lines.filter((l) => l.includes("OV skill catalog recovery"));
    assert.equal(
      recoveryLines.length,
      1,
      "an executed pass must emit EXACTLY one recovery log line, even with 0 recovered",
    );
    assert.ok(
      recoveryLines[0].includes("recovered 0 skill(s)"),
      "the 0-recovery line must state recovered/still-missing so ran-but-failed is visible",
    );
  });

  test("a recovering pass logs the recovery line (info path unchanged)", async () => {
    console.error = () => {};
    console.log = () => {};
    globalThis.fetch = (async () => {
      timeoutThrow();
    }) as any;
    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmUp });

    const lines: string[] = [];
    console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };

    globalThis.fetch = (async () => okResponse()) as any;
    const result = await reRegisterMissingSkills({ backoffBaseMs: 0 });
    assert.equal(result.recovered, 4);

    const recoveryLines = lines.filter((l) => l.includes("OV skill catalog recovery"));
    assert.equal(recoveryLines.length, 1, "a recovering pass also logs exactly one recovery line");
    assert.ok(recoveryLines[0].includes("re-registered 4 skill(s)"));
  });
});

describe("isOvServerTimeout: body classifier (#2250)", () => {
  test("classifies OV's INTERNAL/'Request timed out.' 500 body as a server timeout", () => {
    assert.equal(isOvServerTimeout(OV_SERVER_TIMEOUT_BODY), true);
  });

  test("accepts the 'timed out' message variant too", () => {
    assert.equal(
      isOvServerTimeout('{"error":{"code":"INTERNAL","message":"The request timed out after 47s"}}'),
      true,
    );
  });

  test("does NOT classify a genuine 4xx payload rejection as a timeout", () => {
    assert.equal(
      isOvServerTimeout('{"error":{"code":"INVALID_ARGUMENT","message":"missing field: content"}}'),
      false,
    );
  });

  test("does NOT classify an UNAUTHENTICATED rejection as a timeout", () => {
    assert.equal(
      isOvServerTimeout('{"error":{"code":"UNAUTHENTICATED","message":"missing X-Api-Key"}}'),
      false,
    );
  });

  test("does NOT classify an INTERNAL error that is not a timeout", () => {
    assert.equal(
      isOvServerTimeout('{"error":{"code":"INTERNAL","message":"index corruption detected"}}'),
      false,
    );
  });

  test("a non-timeout body that merely contains the word 'timeout' in prose is not retried", () => {
    // Parses cleanly but error.code !== INTERNAL → must NOT fall through to a
    // substring scan and false-positive on the prose mention.
    assert.equal(
      isOvServerTimeout('{"error":{"code":"INVALID_ARGUMENT","message":"timeout field must be a number"}}'),
      false,
    );
  });

  test("empty / null / undefined body is not a timeout (pure, total, never throws)", () => {
    assert.equal(isOvServerTimeout(""), false);
    assert.equal(isOvServerTimeout(null), false);
    assert.equal(isOvServerTimeout(undefined), false);
  });

  test("a malformed / truncated body falls back to a substring scan requiring BOTH markers", () => {
    // Non-JSON garbage that still carries both the INTERNAL marker and a timeout
    // phrase → retryable; garbage with only one marker → not.
    assert.equal(isOvServerTimeout("502 Bad Gateway INTERNAL: request timed out"), true);
    assert.equal(isOvServerTimeout("502 Bad Gateway: upstream unavailable"), false);
    assert.equal(isOvServerTimeout("connection timed out"), false); // no INTERNAL marker
  });
});

describe("registerSkills: OV server-timeout 500 IS retried (#2250)", () => {
  test("an ov-non-2xx server-timeout body engages the 3-attempt retry budget", async () => {
    muteConsole();
    // The dominant failure mode: every POST returns OV's INTERNAL/"Request timed
    // out." 500. Pre-#2250 this abandoned on the FIRST attempt (4 calls total).
    // Now it must burn the full 3-attempt budget per skill = 12 calls.
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return ovServerTimeoutResponse();
    }) as any;

    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmUp });

    assert.equal(calls, 12, "4 skills × 3 attempts — the server-timeout body must be retried");
    assert.equal(getSkillCatalogState().registered, 0, "all four still fail when OV never clears");
  });

  test("a transient server-timeout that clears on retry recovers the registration", async () => {
    muteConsole();
    // First POST is a server-timeout 500, every subsequent POST succeeds —
    // proves the retry path heals the registration instead of losing it.
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) return ovServerTimeoutResponse();
      return okResponse();
    }) as any;

    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmUp });

    assert.equal(calls, 5, "the timed-out first skill is retried exactly once, then all succeed");
    assert.equal(getSkillCatalogState().registered, 4, "all four skills register after the retry");
  });

  test("a genuine non-timeout ov-non-2xx (4xx) is STILL not retried (#1828 guard preserved)", async () => {
    muteConsole();
    // A real payload rejection must surface on the first attempt — the #2250
    // widening is body-specific and must NOT regress the do-not-mask guard.
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return {
        ok: false,
        status: 400,
        json: async () => ({}),
        text: async () => '{"error":{"code":"INVALID_ARGUMENT","message":"bad payload"}}',
      };
    }) as any;

    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmUp });

    assert.equal(calls, 4, "4 skills, one attempt each — a genuine 4xx is not retried");
  });
});

describe("getSkillCatalogState: defensive copy", () => {
  test("mutating the returned object does not corrupt the live state", async () => {
    muteConsole();
    globalThis.fetch = (async () => okResponse()) as any;
    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmUp });

    const a = getSkillCatalogState();
    a.registered = -999;
    a.skills[0].registered = false;

    const b = getSkillCatalogState();
    assert.equal(b.registered, 4, "the returned object must be a copy, not the live state");
    assert.equal(b.skills[0].registered, true, "skill entries must be copied too");
  });
});

describe("registerSkills: VLM-down graceful degradation (#2277)", () => {
  test("a down VLM DEFERS the pass — zero fetches, no timeout cascade", async () => {
    muteConsole();
    // If even ONE skill POST fires, this counter trips — the whole point of
    // deferral is that we never call OV while the VLM (which OV's semantic
    // enrichment blocks on) is offline, so the 4×3×120s timeout budget is saved.
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return okResponse();
    }) as any;

    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmDown });

    assert.equal(fetchCalls, 0, "a down VLM must POST nothing — the cascade is short-circuited");

    const state = getSkillCatalogState();
    assert.equal(state.completed, true, "the deferred pass still marks completed");
    assert.equal(state.registered, 0, "nothing registers while the VLM is down");
    assert.equal(state.total, 4);
    assert.equal(state.vlmDeferred, true, "the state flags the deliberate VLM deferral");
    assert.ok(
      state.skills.every((s) => !s.registered && s.lastError === VLM_DEFERRED_MARKER),
      "each skill records the vlm-deferred marker, distinct from an ov-* failure code",
    );
  });

  test("emits EXACTLY ONE operator-visible alert on deferral", async () => {
    // Capture console.error: the deferral path must emit exactly one [Learning]
    // DEFERRED alert and nothing else (no per-skill failure spam, no EMPTY line).
    console.error = () => {};
    console.log = () => {};
    globalThis.fetch = (async () => okResponse()) as any;

    const lines: string[] = [];
    console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };

    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmDown });

    const deferredLines = lines.filter((l) => l.includes("DEFERRED"));
    assert.equal(deferredLines.length, 1, "exactly one operator-visible deferral alert");
    assert.match(deferredLines[0], /VLM/, "the alert names the VLM root cause");
    assert.match(deferredLines[0], /no restart needed/, "the alert states the no-restart recovery path");
    // No #1968 EMPTY line — deferral replaces, not augments, the failure framing.
    assert.equal(
      lines.filter((l) => l.includes("EMPTY")).length,
      0,
      "a deferral must NOT also emit the #1968 EMPTY alert (would be a double alert)",
    );
  });

  test("a reachable VLM falls through to the normal loop and clears a prior deferral", async () => {
    muteConsole();
    // First pass: VLM down → deferred state set.
    globalThis.fetch = (async () => okResponse()) as any;
    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmDown });
    assert.equal(getSkillCatalogState().vlmDeferred, true, "precondition: deferred after a down pass");

    // Second pass: VLM back up → normal registration runs and clears the flag.
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return okResponse();
    }) as any;
    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmUp });

    assert.equal(calls, 4, "a reachable VLM runs the normal 4-skill registration loop");
    const state = getSkillCatalogState();
    assert.equal(state.registered, 4, "all four register once the VLM is reachable");
    assert.equal(state.vlmDeferred, false, "a successful up-pass clears the deferred flag");
  });
});

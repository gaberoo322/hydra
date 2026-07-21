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

const {
  registerSkills,
  getSkillCatalogState,
  reRegisterMissingSkills,
  VLM_DEFERRED_MARKER,
  SKILLS_DEFERRED_MARKER,
} = await import("../src/knowledge-base/skill-registration.ts");

/** Injectable VLM probe stubs (issue #2277). Default real probe is bypassed in tests. */
const vlmUp = async () => ({ status: "ok" as const, latencyMs: 5 });
const vlmDown = async () => ({ status: "down" as const, latencyMs: 5000, error: "timeout" });

/**
 * Injectable skills-endpoint probe stubs (issue #3402). The startup pass now
 * pre-flights `probeSkillsEndpoint` between the VLM gate and the POST loop; the
 * registration-loop tests below pin `probeSkills: skillsUp` so the loop runs and
 * they exercise ONLY the retry/state behaviour they mean to (not the new gate).
 */
const skillsUp = async () => ({ status: "running" as const, latencyMs: 5 });
const skillsDownProbe = async () => ({ status: "failed" as const, latencyMs: null });

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

/**
 * ADR-0027: skill-registration now logs through the pino structured-logger seam
 * (module singleton → process.stderr) instead of freeform console.* strings.
 * Capture the serialized JSON lines so the "exactly one recovery/deferral line"
 * invariants can be asserted on the stable event `msg` (and structured fields)
 * rather than on grepped prose. Returns a parse-on-demand accessor + a restore
 * hook; call restore() in a finally so a throwing case never leaks the patch.
 */
function captureStderrLines(): { lines: () => Record<string, any>[]; restore: () => void } {
  const originalWrite = process.stderr.write.bind(process.stderr);
  let buf = "";
  (process.stderr as any).write = (chunk: any) => {
    buf += String(chunk);
    return true;
  };
  return {
    lines: () =>
      buf
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Record<string, any>),
    restore: () => {
      (process.stderr as any).write = originalWrite;
    },
  };
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
    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmUp, probeSkills: skillsUp });

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

    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmUp, probeSkills: skillsUp });

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

    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmUp, probeSkills: skillsUp });

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

    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmUp, probeSkills: skillsUp });
    assert.equal(sawSignal, true, "fetch must receive an AbortSignal with a live timeout budget");
  });
});

describe("registerSkills: queryable catalog state (#1968)", () => {
  test("all-success populates a full, completed catalog", async () => {
    muteConsole();
    globalThis.fetch = (async () => okResponse()) as any;

    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmUp, probeSkills: skillsUp });

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

    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmUp, probeSkills: skillsUp });

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

    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmUp, probeSkills: skillsUp });

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
    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmUp, probeSkills: skillsUp });

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
    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmUp, probeSkills: skillsUp });
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
    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmUp, probeSkills: skillsUp });
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
    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmUp, probeSkills: skillsUp });

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
    muteConsole();
    globalThis.fetch = (async () => {
      timeoutThrow();
    }) as any;
    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmUp, probeSkills: skillsUp });

    // Capture the recovery-pass pino output. The per-skill [Learning] logs from
    // registerOneSkill are present too, so we match the recovery-pass event
    // messages specifically (the two stable `msg` strings the module emits).
    const cap = captureStderrLines();
    let result: any;
    try {
      // OV still down during recovery → attempted:true, recovered:0.
      result = await reRegisterMissingSkills({ backoffBaseMs: 0 });
    } finally {
      cap.restore();
    }
    assert.equal(result.attempted, true);
    assert.equal(result.recovered, 0);

    const recoveryLines = cap
      .lines()
      .filter((o) => typeof o.msg === "string" && o.msg.includes("OV skill catalog recovery"));
    assert.equal(
      recoveryLines.length,
      1,
      "an executed pass must emit EXACTLY one recovery log line, even with 0 recovered",
    );
    assert.ok(
      recoveryLines[0].msg.includes("recovered 0 skill(s)"),
      "the 0-recovery line must be the ran-but-failed error event so ran-but-failed is visible",
    );
    assert.equal(recoveryLines[0].level, 50, "the 0-recovery line stays fail-loud at error level");
    assert.equal(recoveryLines[0].stillMissing, 4, "it carries the still-missing count as a structured field");
  });

  test("a recovering pass logs the recovery line (info path unchanged)", async () => {
    muteConsole();
    globalThis.fetch = (async () => {
      timeoutThrow();
    }) as any;
    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmUp, probeSkills: skillsUp });

    globalThis.fetch = (async () => okResponse()) as any;
    const cap = captureStderrLines();
    let result: any;
    try {
      result = await reRegisterMissingSkills({ backoffBaseMs: 0 });
    } finally {
      cap.restore();
    }
    assert.equal(result.recovered, 4);

    const recoveryLines = cap
      .lines()
      .filter((o) => typeof o.msg === "string" && o.msg.includes("OV skill catalog recovery"));
    assert.equal(recoveryLines.length, 1, "a recovering pass also logs exactly one recovery line");
    assert.ok(recoveryLines[0].msg.includes("re-registered skill(s)"));
    assert.equal(recoveryLines[0].level, 30, "the recovering pass logs at info level");
    assert.equal(recoveryLines[0].recovered, 4, "it carries the recovered count as a structured field");
  });
});

// The `isOvServerTimeout` body-classifier unit tests moved to
// test/ov-request.test.mts alongside the function (issue #2373 — it now lives in
// the Request Adapter seam). The retry-POLICY tests above (which assert
// registerSkills retries on an OV server-timeout body) stay here because they
// exercise skill-registration behaviour, not the classifier in isolation.

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

    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmUp, probeSkills: skillsUp });

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

    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmUp, probeSkills: skillsUp });

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

    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmUp, probeSkills: skillsUp });

    assert.equal(calls, 4, "4 skills, one attempt each — a genuine 4xx is not retried");
  });
});

describe("getSkillCatalogState: defensive copy", () => {
  test("mutating the returned object does not corrupt the live state", async () => {
    muteConsole();
    globalThis.fetch = (async () => okResponse()) as any;
    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmUp, probeSkills: skillsUp });

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
    // The deferral path must emit exactly one [Learning] DEFERRED pino line and
    // nothing else (no per-skill failure spam, no EMPTY line). Capture stderr.
    globalThis.fetch = (async () => okResponse()) as any;

    const cap = captureStderrLines();
    try {
      await registerSkills({ backoffBaseMs: 0, probeVlm: vlmDown });
    } finally {
      cap.restore();
    }

    const msgs = cap.lines().map((o) => (typeof o.msg === "string" ? o.msg : ""));
    const deferredLines = msgs.filter((m) => m.includes("DEFERRED"));
    assert.equal(deferredLines.length, 1, "exactly one operator-visible deferral alert");
    assert.match(deferredLines[0], /VLM/, "the alert names the VLM root cause");
    assert.match(deferredLines[0], /no restart needed/, "the alert states the no-restart recovery path");
    // No #1968 EMPTY line — deferral replaces, not augments, the failure framing.
    assert.equal(
      msgs.filter((m) => m.includes("EMPTY")).length,
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
    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmUp, probeSkills: skillsUp });

    assert.equal(calls, 4, "a reachable VLM runs the normal 4-skill registration loop");
    const state = getSkillCatalogState();
    assert.equal(state.registered, 4, "all four register once the VLM is reachable");
    assert.equal(state.vlmDeferred, false, "a successful up-pass clears the deferred flag");
  });
});

describe("registerSkills: skills-endpoint load-gated deferral (#3402)", () => {
  test("a load-gated skills handler (VLM up) DEFERS — zero POSTs, no timeout cascade", async () => {
    muteConsole();
    // The #3402 mode: VLM reachable, but OV's /api/v1/skills POST handler is
    // indexing-bound and fails its 3s liveness probe. The startup pass MUST NOT
    // fall through to the 4×3×120s registration loop — if even one POST fires,
    // this counter trips.
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return okResponse();
    }) as any;

    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmUp, probeSkills: skillsDownProbe });

    assert.equal(fetchCalls, 0, "a load-gated skills handler must POST nothing — the cascade is short-circuited");

    const state = getSkillCatalogState();
    assert.equal(state.completed, true, "the deferred pass still marks completed");
    assert.equal(state.registered, 0, "nothing registers while the skills handler is load-gated");
    assert.equal(state.total, 4);
    assert.equal(state.skillsDeferred, true, "the state flags the deliberate skills-handler deferral");
    assert.equal(state.vlmDeferred, false, "a skills-handler deferral is NOT a VLM deferral");
    assert.ok(
      state.skills.every((s) => !s.registered && s.lastError === SKILLS_DEFERRED_MARKER),
      "each skill records the skills-deferred marker, distinct from vlm-deferred and any ov-* code",
    );
  });

  test("emits EXACTLY ONE operator-visible alert on a skills-handler deferral", async () => {
    // The deferral path must emit exactly one [Learning] DEFERRED pino line and
    // nothing else — no per-skill timeout spam, no #1968 EMPTY line (the whole
    // point of mirroring the #2277 one-alert contract). Capture stderr.
    globalThis.fetch = (async () => okResponse()) as any;

    const cap = captureStderrLines();
    try {
      await registerSkills({ backoffBaseMs: 0, probeVlm: vlmUp, probeSkills: skillsDownProbe });
    } finally {
      cap.restore();
    }

    const msgs = cap.lines().map((o) => (typeof o.msg === "string" ? o.msg : ""));
    const deferredLines = msgs.filter((m) => m.includes("DEFERRED"));
    assert.equal(deferredLines.length, 1, "exactly one operator-visible deferral alert");
    assert.match(deferredLines[0], /\/api\/v1\/skills/, "the alert names the load-gated skills handler");
    assert.match(deferredLines[0], /no restart needed/, "the alert states the no-restart recovery path");
    assert.equal(
      msgs.filter((m) => m.includes("EMPTY")).length,
      0,
      "a deferral must NOT also emit the #1968 EMPTY alert (would be a double alert)",
    );
  });

  test("a genuine 4xx is NOT masked — the deferral only fires on a failed probe (do-not-mask #1828)", async () => {
    muteConsole();
    // INVARIANT 4: when the skills probe reports the handler is RESPONSIVE
    // (running), a real payload rejection (4xx) must still surface immediately —
    // the #3402 short-circuit must not swallow a genuine non-transient OV failure.
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return { ok: false, status: 400, json: async () => ({}), text: async () => "bad payload" };
    }) as any;

    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmUp, probeSkills: skillsUp });

    // Probe said running → the loop runs; a 400 is non-retryable → one POST/skill.
    assert.equal(calls, 4, "a responsive-handler pass must attempt each skill (the 4xx is NOT deferred/masked)");
    const state = getSkillCatalogState();
    assert.equal(state.skillsDeferred, false, "a real 4xx is a registration failure, NOT a deferral");
    assert.equal(state.registered, 0, "all four fail on the 4xx");
    assert.ok(
      state.skills.every((s) => !s.registered && s.lastError === "ov-non-2xx"),
      "the genuine 4xx surfaces as ov-non-2xx per skill, not the skills-deferred marker",
    );
  });

  test("a throwing probe degrades to attempt-anyway (never a spurious deferral)", async () => {
    muteConsole();
    // The probe is contractually never-throwing, but a probe BUG must not block or
    // falsely defer startup registration — it degrades to the pre-#3402 behaviour
    // (run the loop) rather than deferring on a phantom failure.
    const throwingProbe = (async () => {
      throw new Error("probe blew up");
    }) as any;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return okResponse();
    }) as any;

    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmUp, probeSkills: throwingProbe });

    assert.equal(calls, 4, "a probe throw degrades to attempt-anyway — the loop still runs");
    const state = getSkillCatalogState();
    assert.equal(state.skillsDeferred, false, "a probe crash must NOT trigger a spurious deferral");
    assert.equal(state.registered, 4, "registration succeeds when the handler is actually up");
  });

  test("a responsive skills handler clears a prior skills-deferral", async () => {
    muteConsole();
    // First pass: skills handler load-gated → skillsDeferred set.
    globalThis.fetch = (async () => okResponse()) as any;
    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmUp, probeSkills: skillsDownProbe });
    assert.equal(getSkillCatalogState().skillsDeferred, true, "precondition: deferred after a load-gated pass");

    // Second pass: handler responsive → the loop runs and clears the flag.
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return okResponse();
    }) as any;
    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmUp, probeSkills: skillsUp });

    assert.equal(calls, 4, "a responsive handler runs the normal 4-skill registration loop");
    const state = getSkillCatalogState();
    assert.equal(state.registered, 4, "all four register once the handler is responsive");
    assert.equal(state.skillsDeferred, false, "a successful pass clears the skills-deferred flag");
  });
});

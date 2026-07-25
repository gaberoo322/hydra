/**
 * Unit test for the sustained-OAuth-failure alarm (issue #3601).
 *
 * The alarm is a PURELY ADDITIVE observability signal emitted off the existing
 * `oauthBackoff.failures` counter in `src/cost/oauth-read-cache.ts`: a single
 * error-level log fires the instant the consecutive-failure count CROSSES the
 * threshold (3), so a prolonged 429/outage (expired token, hard account
 * rate-limit) is greppable rather than only inferrable from the per-failure
 * backoff lines. It must fire EXACTLY ONCE per sustained-failure episode — not
 * on failures 1 or 2 (a transient blip the last-good + exponential-backoff seam
 * is designed to ride out), not again on failure 4+, and it must re-arm after a
 * recovery so a fresh episode alarms again.
 *
 * The alarm is a log side effect only. ADR-0027: `oauth-read-cache` now logs
 * through the pino structured-logger seam (module singleton → process.stderr)
 * instead of a freeform `console.error` string, so this suite captures the
 * serialized JSON lines off `process.stderr`, asserts on the structured `level`
 * field (pino error === 50) + the stable alarm `msg`, and reads the
 * `oauth-usage-*` code + fail-open context out of the structured fields rather
 * than grepping prose. It does NOT touch the gate math, recovery bookkeeping,
 * or the #1124 fail-open invariant — those are covered by the existing
 * usage-tracker / oauth-backoff-persist suites.
 *
 * Driven DIRECTLY through the exported `readOAuthCached(readUsage, nowMs)` seam
 * with an injected reader and the default no-op persistence adapter (invariant
 * 5 — no Redis). Each call steps `nowMs` well PAST the just-armed backoff gate
 * so every read actually re-probes and advances the ladder by one; there is no
 * last-good cache, so every failed read passes through to the failure branch.
 *
 * Suite lifecycle (CLAUDE.md authoring rules): a NEW top-level describe with its
 * own beforeEach/afterEach; env knobs are pinned per-case and the module cache +
 * backoff state are reset per-case via `clearOAuthCache()` so no episode leaks
 * across cases.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const { readOAuthCached, clearOAuthCache } = await import(
  "../src/cost/oauth-read-cache.ts"
);
import type { OAuthUsageResult } from "../src/cost/oauth-usage.ts";

// Deterministic ladder knobs: TTL 60s, no maxStale headroom worth serving (we
// never populate a last-good in the failure-only cases), base 30s, ceiling
// 15min. With base 30s the gate after failure N opens at prevNow + 30s*2^(N-1);
// stepping nowMs by +30min per call clears every gate so each read re-probes.
const TTL_MS = 60_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 900_000;
const STEP_MS = 30 * 60_000; // 30min: > the 15min ceiling, so every read re-probes.

const ENV_KEYS = [
  "HYDRA_OAUTH_USAGE_TTL_MS",
  "HYDRA_OAUTH_USAGE_MAX_STALE_MS",
  "HYDRA_OAUTH_USAGE_BACKOFF_BASE_MS",
  "HYDRA_OAUTH_USAGE_BACKOFF_MAX_MS",
] as const;

const FAIL_429: OAuthUsageResult = { ok: false, code: "oauth-usage-non-2xx" };
const OK_READ: OAuthUsageResult = {
  ok: true,
  data: {
    fiveHour: { utilization: 42, resetsAt: null },
    sevenDay: { utilization: 17, resetsAt: null },
  },
};

/** A reader that always returns `r`, counting calls. */
function fixedReader(r: OAuthUsageResult): {
  reader: () => Promise<OAuthUsageResult>;
  calls: () => number;
} {
  let calls = 0;
  return {
    reader: async () => {
      calls++;
      return r;
    },
    calls: () => calls,
  };
}

const ALARM_MARKER = "ALARM: OAuth meter has failed";

describe("sustained-OAuth-failure alarm (issue #3601)", () => {
  let saved: Map<string, string | undefined>;
  /** The captured alarm log records (pino JSON objects with the alarm `msg`). */
  let alarmLines: Array<Record<string, any>>;
  let restoreStderr: () => void;

  beforeEach(() => {
    saved = new Map();
    for (const k of ENV_KEYS) saved.set(k, process.env[k]);
    process.env.HYDRA_OAUTH_USAGE_TTL_MS = String(TTL_MS);
    process.env.HYDRA_OAUTH_USAGE_MAX_STALE_MS = String(0); // no stale headroom
    process.env.HYDRA_OAUTH_USAGE_BACKOFF_BASE_MS = String(BACKOFF_BASE_MS);
    process.env.HYDRA_OAUTH_USAGE_BACKOFF_MAX_MS = String(BACKOFF_MAX_MS);
    clearOAuthCache();

    // Capture pino's serialized JSON lines off process.stderr and keep only the
    // alarm records; the noisy per-failure backoff lines are parsed and dropped
    // so they don't clutter the assertions. Non-JSON stderr chunks are ignored.
    alarmLines = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: any) => {
      for (const raw of String(chunk).split("\n")) {
        if (!raw.trim()) continue;
        let obj: Record<string, any>;
        try {
          obj = JSON.parse(raw);
        } catch {
          continue; // not a pino line
        }
        if (typeof obj.msg === "string" && obj.msg.includes(ALARM_MARKER)) {
          alarmLines.push(obj);
        }
      }
      return true;
    };
    restoreStderr = () => {
      (process.stderr as any).write = originalWrite;
    };
  });

  afterEach(() => {
    restoreStderr();
    clearOAuthCache();
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  /** Drive `n` consecutive failed reads, stepping nowMs past every gate. */
  async function driveFailures(n: number, t0: number): Promise<number> {
    const m = fixedReader(FAIL_429);
    for (let i = 0; i < n; i++) {
      await readOAuthCached(m.reader, t0 + i * STEP_MS);
    }
    return m.calls();
  }

  test("does NOT alarm on the first two consecutive failures (transient-blip band)", async () => {
    const t0 = Date.parse("2026-07-24T12:00:00.000Z");
    const calls = await driveFailures(2, t0);
    assert.equal(calls, 2, "both reads re-probed (each nowMs cleared the prior gate)");
    assert.equal(
      alarmLines.length,
      0,
      "failures 1 and 2 stay below the sustained-failure threshold — no alarm",
    );
  });

  test("fires EXACTLY ONCE the instant the third consecutive failure crosses the threshold", async () => {
    const t0 = Date.parse("2026-07-24T12:00:00.000Z");
    const calls = await driveFailures(3, t0);
    assert.equal(calls, 3, "all three reads re-probed");
    assert.equal(alarmLines.length, 1, "the crossing fires exactly one alarm");
    assert.equal(alarmLines[0].level, 50, "the alarm is emitted at pino error level (50)");
    assert.match(
      alarmLines[0].msg,
      /3 consecutive reads/,
      "alarm msg reports the consecutive-failure count",
    );
    assert.equal(
      alarmLines[0].failures,
      3,
      "alarm carries the consecutive-failure count as a structured field",
    );
    assert.equal(
      alarmLines[0].code,
      "oauth-usage-non-2xx",
      "alarm carries the last failure code as a structured field",
    );
    assert.match(
      alarmLines[0].context,
      /#1124|fail-open/,
      "alarm names the fail-open gating context, not a hard-stop",
    );
  });

  test("does NOT re-fire on the fourth, fifth, ... consecutive failure (once per episode)", async () => {
    const t0 = Date.parse("2026-07-24T12:00:00.000Z");
    const calls = await driveFailures(6, t0);
    assert.equal(calls, 6, "all six reads re-probed");
    assert.equal(
      alarmLines.length,
      1,
      "only the threshold-crossing failure alarms; 4th–6th are silent",
    );
  });

  test("re-arms after recovery: a NEW sustained episode alarms again", async () => {
    const t0 = Date.parse("2026-07-24T12:00:00.000Z");

    // Episode 1: three failures → one alarm.
    await driveFailures(3, t0);
    assert.equal(alarmLines.length, 1, "episode 1 alarms once");

    // Recovery: a successful read clears the backoff ladder (failures → null).
    const ok = fixedReader(OK_READ);
    const t1 = t0 + 3 * STEP_MS;
    const recovered = await readOAuthCached(ok.reader, t1);
    assert.equal(recovered.result.ok, true, "recovery read serves the fresh meter value");

    // Episode 2: three MORE failures, past the fresh TTL so each re-probes.
    // The counter restarted at 0 on recovery, so the third failure here is a
    // fresh crossing → a second alarm.
    const m2 = fixedReader(FAIL_429);
    for (let i = 0; i < 3; i++) {
      await readOAuthCached(m2.reader, t1 + (i + 1) * STEP_MS);
    }
    assert.equal(
      alarmLines.length,
      2,
      "the recovered ladder re-armed the alarm — the new episode alarms again",
    );
  });

  test("a single failure never alarms", async () => {
    const t0 = Date.parse("2026-07-24T12:00:00.000Z");
    await driveFailures(1, t0);
    assert.equal(alarmLines.length, 0, "one failure is well within the transient band");
  });
});

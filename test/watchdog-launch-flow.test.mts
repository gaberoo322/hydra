/**
 * Regression test for issue #3847 — the ## LAUNCH FLOW block in
 * scripts/hydra-watchdog.sh (`run_launch_flow`), plus the per-signal key
 * builders / typed reads it shares with src/redis/launch-flow.ts (epic #3844;
 * decided on maps #3807/#3809/#3812/#3813/#3814).
 *
 * The block reads the pace-gate last-tick hash ONCE per tick and asks whether a
 * defective / quota / pause signal — or a slow eligibility probe — has been
 * SUSTAINED past its threshold, tracking each of five signals (fail-safe,
 * meter-dark, quota, pause, latency) with its own `{since, fired}` Redis key
 * pair (ten keys total). Hard invariants pinned here mirror the gate-approved
 * design-concept for issue-3847:
 *
 *   INV-1  reads exactly ONE HGETALL of PACE_GATE_LAST_TICK_KEY per tick; no
 *          new HTTP probe, no second /api/usage/eligibility consumer.
 *   INV-3  reason→signal membership: fail-safe = the 5 exits; meter-dark =
 *          meter-unavailable; quota = the 3 unified reasons; pause = paused;
 *          everything else (incl. pace-ahead/workless-backoff/allow-false) is
 *          healthy and clears reason-keyed streaks.
 *   INV-4/7/8 uniform per-signal streak rule: member→SET NX since + fire once
 *          at threshold; non-member→DEL both (stateless recovery).
 *   INV-5  latency is independent of reason; over-budget extends, absent OR
 *          <=budget clears.
 *   INV-9  DETECTION ONLY — no alerts.ts / telegram / POST.
 *   INV-10 never throws / never non-zero; never clears on a read failure.
 *   INV-12 the bash key-template and the TS key builder emit identical strings.
 *
 * The block honours off-by-default injection hooks (documented in the script
 * header) so threshold crossings are exercised with ZERO real-time waits:
 *   HYDRA_WATCHDOG_LAUNCH_NOW_MS              injected `now` (epoch-ms).
 *   HYDRA_WATCHDOG_LAUNCH_*_SECONDS           per-signal thresholds (default
 *                                              2h/2h/4h/24h/1h-latency).
 *   HYDRA_REDIS_HOST / HYDRA_REDIS_PORT       redis-cli target (default docker).
 *
 * Behavioural cases that need Redis are gated on the docker `hydra-redis-1`
 * container (CI's self-hosted runners + the dev host have it; a laptop without
 * docker skips them) — the same gating contract as test/autopilot-hooks.test.mts.
 * The structural / drift-guard cases run unconditionally. Behavioural cases
 * SOURCE run_launch_flow directly (with `set -euo pipefail`, matching the
 * script's own flags) rather than execing the whole script, so they neither
 * depend on nor disturb the service-liveness / deploy-drift blocks (no
 * orchestrator restarts, no skill regen) — the entry-point wiring is covered
 * structurally below.
 */

import test, { describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  PACE_GATE_LAST_TICK_KEY,
  LAUNCH_FLOW_KEY_PREFIX,
  launchFlowSinceKey,
  launchFlowFiredKey,
  classifyLaunchSignal,
  LAUNCH_FLOW_REASON_SIGNAL,
  WATCHDOG_LAUNCH_SIGNALS,
  getLaunchFlowSince,
  isLaunchFlowFired,
  clearLaunchFlowStreak,
} from "../src/redis/launch-flow.ts";
import { getRedisConnection } from "../src/redis/connection.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const WATCHDOG = join(REPO_ROOT, "scripts", "hydra-watchdog.sh");

// A `docker exec hydra-redis-1 redis-cli ...` round-trip is normally
// sub-second, but on a shared, loaded self-hosted CI runner (4 runners plus
// the orchestrator, Redis, and live autopilot subagents on one box) it can
// stall well past a tight ceiling. The three sibling watchdog test files
// (test/autopilot-watchdog.test.mts, test/watchdog-deploy-drift.test.mts,
// test/watchdog-skill-mirror-drift.test.mts) hit this exact class of flake on
// the REQUIRED `test` gate and were fixed in PR #4054 by widening to a single
// generous shared ceiling instead of independently tuning tight ones that keep
// getting blown by ambient host load. This file kept its own 4s/8s/15s
// ceilings and was the one #4044/#4054 missed (issue #4065) — bring it in
// line with the same 120s bound, which is a hang guard, not a
// slow-but-correct-run guard.
const WATCHDOG_TIMEOUT_MS = 120_000;

const SIGNALS = ["fail-safe", "meter-dark", "quota", "pause", "latency"] as const;
const SINCE = (s: string) => `${LAUNCH_FLOW_KEY_PREFIX}:since:${s}`;
const FIRED = (s: string) => `${LAUNCH_FLOW_KEY_PREFIX}:fired:${s}`;

/** Fixed deterministic clock for threshold maths (epoch-ms). */
const T0 = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// Redis helpers (docker exec → DB 0, the watchdog's default target). Mirror the
// test/autopilot-hooks.test.mts gating contract.
// ---------------------------------------------------------------------------

/**
 * spawnSync kills the child on timeout: `status` becomes `null` (not a real
 * exit code) and `error.code` is `"ETIMEDOUT"`. A caller that only looks at
 * `status`/`stdout` sees a misleading bare exit-code (or empty-output)
 * mismatch that reads as a behaviour regression rather than contention
 * (issue #4044, the same defect class PR #4054 fixed in the sibling watchdog
 * test files). Detect it explicitly and throw a labelled error instead.
 */
function assertNotTimedOut(r: SpawnSyncReturns<string>, label: string): void {
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
    throw new Error(
      `${label} exceeded ${WATCHDOG_TIMEOUT_MS}ms timeout (killed with ${r.signal ?? "unknown signal"}); ` +
        `stdout=${r.stdout ?? ""} stderr=${r.stderr ?? ""}`,
    );
  }
}

function dockerRedisAvailable(): boolean {
  const r = spawnSync("docker", ["exec", "hydra-redis-1", "redis-cli", "PING"], {
    encoding: "utf-8",
    timeout: WATCHDOG_TIMEOUT_MS,
  });
  // Called once at module load to decide whether the whole behavioural
  // describe block below is gated (`{ skip: !DOCKER }`) — throwing here would
  // abort loading the file entirely, including the docker-independent
  // structural tests. A genuine timeout is functionally indistinguishable
  // from "docker unavailable" for gating purposes, so log it loudly and
  // degrade to skip rather than crashing the whole file.
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
    console.error(
      `[watchdog-launch-flow.test.mts] dockerRedisAvailable PING exceeded ${WATCHDOG_TIMEOUT_MS}ms — treating docker as unavailable`,
    );
    return false;
  }
  return (r.stdout ?? "").trim() === "PONG";
}

const DOCKER = dockerRedisAvailable();

function drc(args: string[]): string {
  const r = spawnSync("docker", ["exec", "hydra-redis-1", "redis-cli", "--raw", ...args], {
    encoding: "utf-8",
    timeout: WATCHDOG_TIMEOUT_MS,
  });
  assertNotTimedOut(r, `drc(${args.join(" ")})`);
  return (r.stdout ?? "").trim();
}

/** Wipe the last-tick record and ALL ten launch-flow keys for a clean slate. */
function cleanState(): void {
  const keys = [PACE_GATE_LAST_TICK_KEY];
  for (const s of SIGNALS) keys.push(SINCE(s), FIRED(s));
  const r = spawnSync("docker", ["exec", "hydra-redis-1", "redis-cli", "--raw", "DEL", ...keys], {
    encoding: "utf-8",
    timeout: WATCHDOG_TIMEOUT_MS,
  });
  assertNotTimedOut(r, "cleanState DEL");
}

function hsetLastTick(fields: Record<string, string>): void {
  const args = ["HSET", PACE_GATE_LAST_TICK_KEY];
  for (const [k, v] of Object.entries(fields)) args.push(k, v);
  const r = spawnSync("docker", ["exec", "hydra-redis-1", "redis-cli", "--raw", ...args], {
    encoding: "utf-8",
    timeout: WATCHDOG_TIMEOUT_MS,
  });
  assertNotTimedOut(r, "hsetLastTick HSET");
}

/** Pre-seed a signal's since-anchor (stands in for "the streak began long ago"). */
function seedSince(signal: string, ms: number): void {
  const r = spawnSync(
    "docker",
    ["exec", "hydra-redis-1", "redis-cli", "--raw", "SET", SINCE(signal), String(ms), "NX"],
    { encoding: "utf-8", timeout: WATCHDOG_TIMEOUT_MS },
  );
  assertNotTimedOut(r, `seedSince(${signal})`);
}

function getFired(signal: string): boolean {
  return drc(["EXISTS", FIRED(signal)]) === "1";
}
function getSince(signal: string): string {
  return drc(["GET", SINCE(signal)]);
}

// ---------------------------------------------------------------------------
// Extract run_launch_flow() into a temp file so behavioural cases can source
// it under `set -euo pipefail` without execing the whole script.
// ---------------------------------------------------------------------------

const BLOCK = join(tmpdir(), `hydra-launch-flow-block-${process.pid}.sh`);

before(() => {
  const src = readFileSync(WATCHDOG, "utf-8");
  const start = src.indexOf("run_launch_flow()");
  assert.ok(start >= 0, "run_launch_flow() not found in hydra-watchdog.sh");
  // The function body ends at the first line that is exactly "}" at column 0
  // after the start.
  const after = src.slice(start);
  const end = after.search(/^}/m);
  assert.ok(end >= 0, "run_launch_flow() closing brace not found");
  const body = after.slice(0, end + 1);
  assert.ok(body.includes("track_signal"), "extracted block missing track_signal");
  writeFileSync(BLOCK, body);
});

after(() => {
  try {
    if (DOCKER) cleanState();
    unlinkSync(BLOCK);
  } catch {
    /* best-effort cleanup */
  }
});

/** Source run_launch_flow under prod flags and call it once. */
function runBlock(env: Record<string, string>): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("bash", ["-c", `set -euo pipefail; source '${BLOCK}'; run_launch_flow`], {
    env: { ...process.env, HYDRA_REDIS_HOST: "docker", ...env, PATH: process.env.PATH ?? "" },
    encoding: "utf-8",
    timeout: WATCHDOG_TIMEOUT_MS,
  });
  assertNotTimedOut(r, "runBlock run_launch_flow");
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Extract only the launch-flow block's WARNING log lines. */
function warnLines(stdout: string): string {
  return stdout
    .split("\n")
    .filter((l) => l.includes("WARNING LAUNCH FLOW"))
    .join("\n");
}

// =============================================================================
// Structural / drift-guard cases — run unconditionally (no Redis needed).
// =============================================================================

describe("scripts/hydra-watchdog.sh — ## LAUNCH FLOW structure (issue #3847)", () => {
  test("watchdog script exists and is executable", () => {
    assert.ok(existsSync(WATCHDOG), "watchdog script missing");
    const mode = spawnSync("stat", ["-c", "%a", WATCHDOG], { encoding: "utf-8" }).stdout.trim();
    assert.match(mode, /^[7][0-9]{2}$/, `watchdog not executable (mode=${mode})`);
  });

  test("run_launch_flow is wired into the entry-point call list", () => {
    const src = readFileSync(WATCHDOG, "utf-8");
    // The call must appear AFTER the function definition (in the entry list),
    // not just as the `run_launch_flow() {` definition line.
    const defIdx = src.indexOf("run_launch_flow()");
    const entryIdx = src.indexOf("# Entry point");
    assert.ok(entryIdx > defIdx, "entry-point comment must follow the block definition");
    const entry = src.slice(entryIdx);
    // Indentation-tolerant: #3906 wrapped the entry list in a
    // `[[ "${BASH_SOURCE[0]}" == "${0}" ]]` sourcing guard, so every call in it
    // is now indented. The invariant here is that run_launch_flow is CALLED in
    // the entry list (not merely defined) — not the guard's indentation.
    assert.match(entry, /^\s*run_launch_flow$/m, "run_launch_flow must be called in the entry list");
    // …and that the call sits INSIDE the sourcing guard, so sourcing the script
    // (test/watchdog-pending-work.test.mts does) stays side-effect-free.
    const guardIdx = entry.indexOf('if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then');
    assert.ok(guardIdx >= 0, "entry list must be wrapped in the sourcing guard");
    assert.match(
      entry.slice(guardIdx),
      /^\s*run_launch_flow$/m,
      "run_launch_flow must be called inside the sourcing guard, not before it",
    );
  });

  test("INV-1: reads exactly ONE HGETALL of PACE_GATE_LAST_TICK_KEY; no new probe / no second eligibility consumer", () => {
    const src = readFileSync(WATCHDOG, "utf-8");
    const start = src.indexOf("run_launch_flow()");
    const block = src.slice(start, src.indexOf("# Entry point", start));
    const hgetall = block.match(/HGETALL/g) ?? [];
    assert.equal(hgetall.length, 1, "block must issue exactly ONE HGETALL per tick");
    assert.equal((block.match(/HGET /g) ?? []).length, 0, "must not read fields via separate HGET calls");
    assert.equal((block.match(/\/api\/usage\/eligibility/g) ?? []).length, 0, "must not consume /api/usage/eligibility");
    // A `curl` COMMAND invocation (curl + whitespace) is forbidden — the latency
    // is read from the hash's latency_ms field, never re-probed here. NB this is
    // deliberately NOT `curl\b`: that would false-match the `curl-missing`
    // REASON literal in the case pattern below (a pace-gate exit reason, not a
    // curl invocation).
    assert.equal((block.match(/curl\s/g) ?? []).length, 0, "must not issue any HTTP probe of its own (curl command)");
    // The HGETALL references the last-tick key variable, whose literal equals the TS constant.
    assert.ok(block.includes('LAST_TICK_KEY='), "block must define LAST_TICK_KEY");
    const lit = block.match(/LAST_TICK_KEY="([^"]+)"/);
    assert.ok(lit, "LAST_TICK_KEY literal assignment not found");
    assert.equal(lit![1], PACE_GATE_LAST_TICK_KEY, "watchdog LAST_TICK_KEY drifted from PACE_GATE_LAST_TICK_KEY");
  });

  test("INV-9: DETECTION ONLY — no alerts.ts / telegram / alert POST in the block", () => {
    const src = readFileSync(WATCHDOG, "utf-8");
    const block = src.slice(src.indexOf("run_launch_flow()"), src.indexOf("# Entry point"));
    for (const forbidden of ["alerts.ts", "telegram", "Telegram", "sendAlert", "POST /api/alerts"]) {
      assert.ok(!block.includes(forbidden), `launch-flow block must not reference ${forbidden} (detection only)`);
    }
  });

  test("INV-12: bash key-template and TS key builder emit identical strings", () => {
    const src = readFileSync(WATCHDOG, "utf-8");
    const block = src.slice(src.indexOf("run_launch_flow()"), src.indexOf("# Entry point"));
    const prefix = block.match(/LF_KEY_PREFIX="([^"]+)"/);
    assert.ok(prefix, "LF_KEY_PREFIX literal not found");
    assert.equal(prefix![1], LAUNCH_FLOW_KEY_PREFIX, "bash LF_KEY_PREFIX drifted from TS LAUNCH_FLOW_KEY_PREFIX");
    // Representative signal: the bash-built and TS-built since/fired strings match.
    assert.equal(launchFlowSinceKey("quota"), `${LAUNCH_FLOW_KEY_PREFIX}:since:quota`);
    assert.equal(launchFlowFiredKey("latency"), `${LAUNCH_FLOW_KEY_PREFIX}:fired:latency`);
    assert.ok(block.includes(":since:"), "bash must build since keys via the template");
    assert.ok(block.includes(":fired:"), "bash must build fired keys via the template");
  });

  test("INV-3: bash reason→signal membership matches TS classifyLaunchSignal; healthy reasons don't earn streaks", () => {
    const src = readFileSync(WATCHDOG, "utf-8");
    const block = src.slice(src.indexOf("run_launch_flow()"), src.indexOf("# Entry point"));
    // Every canonical mapped reason appears in the bash case, and TS classifies it identically.
    for (const [reason, signal] of Object.entries(LAUNCH_FLOW_REASON_SIGNAL)) {
      assert.ok(block.includes(reason), `bash must handle reason '${reason}'`);
      assert.equal(classifyLaunchSignal(reason), signal, `TS classify mismatch for '${reason}'`);
    }
    // Reasons explicitly ruled OUT (healthy — endpoint readable, not defective).
    for (const healthy of ["pace-ahead", "workless-backoff", "allow-false", "eligible-launch", "already-running-service"]) {
      assert.equal(classifyLaunchSignal(healthy), "healthy", `'${healthy}' must classify as healthy`);
    }
    assert.equal(WATCHDOG_LAUNCH_SIGNALS.length, 5, "exactly five streak signals");
    // The bash must call track_signal for all five signals.
    for (const s of WATCHDOG_LAUNCH_SIGNALS) {
      assert.ok(block.includes(`track_signal ${s}`), `bash must track signal '${s}'`);
    }
  });

  test("INV-10: block is fail-safe — source parses under set -euo pipefail without executing", () => {
    // A clean `bash -n` on the whole script + sourcing the extracted block under
    // the prod flags without env must not error (verifies no bare-unset refs).
    const syntax = spawnSync("bash", ["-n", WATCHDOG], { encoding: "utf-8" });
    assert.equal(syntax.status, 0, `watchdog bash -n failed: ${syntax.stderr}`);
    const src = spawnSync("bash", ["-c", `set -euo pipefail; source '${BLOCK}'; true`], { encoding: "utf-8" });
    assert.equal(src.status, 0, `sourcing run_launch_flow under set -euo pipefail failed: ${src.stderr}`);
  });
});

// =============================================================================
// Behavioural cases — gated on the docker redis container (CI runners + dev).
// =============================================================================

describe("scripts/hydra-watchdog.sh — ## LAUNCH FLOW behaviour (issue #3847)", { skip: !DOCKER }, () => {
  beforeEach(() => {
    cleanState();
  });

  test("fail-safe fires at threshold and sets its fired marker (no re-fire next tick)", () => {
    hsetLastTick({ reason: "eligibility-unreachable", class: "fail-safe", at: String(T0), latency_ms: "" });
    seedSince("fail-safe", T0); // streak began at T0
    const r1 = runBlock({ HYDRA_WATCHDOG_LAUNCH_FAILSAFE_SECONDS: "2", HYDRA_WATCHDOG_LAUNCH_NOW_MS: String(T0 + 5_000) });
    assert.equal(r1.status, 0, `expected exit 0, got ${r1.status}; stderr=${r1.stderr}`);
    assert.match(warnLines(r1.stdout), /signal 'fail-safe' sustained 5000ms >= 2000ms/);
    assert.equal(getFired("fail-safe"), true, "fired marker must be set once threshold crossed");
    assert.equal(getSince("fail-safe"), String(T0), "since-anchor must be unchanged (SET NX)");

    // Second tick at the same now: fired marker already present → no re-fire.
    const r2 = runBlock({ HYDRA_WATCHDOG_LAUNCH_FAILSAFE_SECONDS: "2", HYDRA_WATCHDOG_LAUNCH_NOW_MS: String(T0 + 5_000) });
    assert.equal(r2.status, 0, `second tick should exit 0; stderr=${r2.stderr}`);
    assert.equal(warnLines(r2.stdout), "", "must NOT re-fire within the same streak");
  });

  test("fail-safe does NOT fire under threshold", () => {
    hsetLastTick({ reason: "eligibility-unreachable", class: "fail-safe", at: String(T0), latency_ms: "" });
    seedSince("fail-safe", T0);
    const r = runBlock({ HYDRA_WATCHDOG_LAUNCH_FAILSAFE_SECONDS: "60", HYDRA_WATCHDOG_LAUNCH_NOW_MS: String(T0 + 5_000) });
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.equal(warnLines(r.stdout), "", "must not fire under threshold");
    assert.equal(getFired("fail-safe"), false, "no fired marker when under threshold");
  });

  test("fail-safe streak resets on any verdict-reached (healthy) tick — stateless recovery", () => {
    hsetLastTick({ reason: "eligibility-unreachable", class: "fail-safe", at: String(T0), latency_ms: "" });
    seedSince("fail-safe", T0);
    // First bring it to a fired state.
    runBlock({ HYDRA_WATCHDOG_LAUNCH_FAILSAFE_SECONDS: "2", HYDRA_WATCHDOG_LAUNCH_NOW_MS: String(T0 + 5_000) });
    assert.equal(getFired("fail-safe"), true, "precondition: fail-safe fired");
    // A healthy reason (eligible-launch) clears BOTH since and fired.
    cleanState();
    hsetLastTick({ reason: "eligible-launch", class: "launch", at: String(T0 + 6_000), latency_ms: "120" });
    const r = runBlock({ HYDRA_WATCHDOG_LAUNCH_FAILSAFE_SECONDS: "2", HYDRA_WATCHDOG_LAUNCH_NOW_MS: String(T0 + 6_000) });
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.equal(getSince("fail-safe"), "", "fail-safe since-anchor cleared on recovery");
    assert.equal(getFired("fail-safe"), false, "fail-safe fired marker cleared on recovery");
  });

  test("meter-dark fires at its own 2h-equivalent threshold and is distinct from fail-safe", () => {
    hsetLastTick({ reason: "meter-unavailable", class: "fail-safe", at: String(T0), latency_ms: "90" });
    seedSince("meter-dark", T0);
    const r = runBlock({
      HYDRA_WATCHDOG_LAUNCH_METER_DARK_SECONDS: "2",
      HYDRA_WATCHDOG_LAUNCH_NOW_MS: String(T0 + 5_000),
    });
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.match(warnLines(r.stdout), /signal 'meter-dark' sustained 5000ms >= 2000ms/);
    // A meter-dark tick must CLEAR the fail-safe streak (distinct signal → not a member).
    assert.equal(getSince("fail-safe"), "", "meter-dark tick must clear fail-safe streak (different root cause)");
  });

  test("quota unification: a single continuous streak across flipped reasons fires once, anchor never resets", () => {
    // Real sequence: seed once, then three ticks with flipped reasons WITHOUT
    // wiping state between them — the watchdog itself must keep the streak.
    seedSince("quota", T0);
    let warnings = 0;
    for (const reason of ["emergency-stop", "weekly-emergency-stop", "session-blocked"]) {
      hsetLastTick({ reason, class: "deliberate-skip", at: String(T0), latency_ms: "100" });
      const r = runBlock({ HYDRA_WATCHDOG_LAUNCH_QUOTA_SECONDS: "2", HYDRA_WATCHDOG_LAUNCH_NOW_MS: String(T0 + 5_000) });
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      warnings += warnLines(r.stdout).split("\n").filter((l) => l.includes("'quota'")).length;
      // The anchor set on tick 1 must survive ticks 2 and 3 unchanged.
      assert.equal(getSince("quota"), String(T0), `quota anchor must not reset on flip to ${reason}`);
    }
    assert.equal(warnings, 1, "exactly one quota WARNING across the continuous flipped-reason streak");
  });

  test("pause (forgotten operator pause) fires at 24h-equivalent threshold", () => {
    hsetLastTick({ reason: "paused", class: "deliberate-skip", at: String(T0), latency_ms: "100" });
    seedSince("pause", T0);
    const r = runBlock({ HYDRA_WATCHDOG_LAUNCH_PAUSE_SECONDS: "2", HYDRA_WATCHDOG_LAUNCH_NOW_MS: String(T0 + 5_000) });
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.match(warnLines(r.stdout), /signal 'pause' sustained 5000ms >= 2000ms/);
  });

  test("class change resets: a fail-safe→pause transition clears the fail-safe streak", () => {
    hsetLastTick({ reason: "eligibility-unreachable", class: "fail-safe", at: String(T0), latency_ms: "" });
    seedSince("fail-safe", T0);
    // Bring fail-safe to a fired state.
    runBlock({ HYDRA_WATCHDOG_LAUNCH_FAILSAFE_SECONDS: "2", HYDRA_WATCHDOG_LAUNCH_NOW_MS: String(T0 + 5_000) });
    assert.equal(getFired("fail-safe"), true, "precondition");
    // Now the reason flips to paused — fail-safe membership goes false.
    hsetLastTick({ reason: "paused", class: "deliberate-skip", at: String(T0 + 6_000), latency_ms: "100" });
    const r = runBlock({
      HYDRA_WATCHDOG_LAUNCH_FAILSAFE_SECONDS: "2",
      HYDRA_WATCHDOG_LAUNCH_PAUSE_SECONDS: "999",
      HYDRA_WATCHDOG_LAUNCH_NOW_MS: String(T0 + 6_000),
    });
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.equal(getSince("fail-safe"), "", "fail-safe streak cleared on class change to pause");
    assert.equal(getFired("fail-safe"), false, "fail-safe fired marker cleared on class change");
    assert.doesNotMatch(warnLines(r.stdout), /'fail-safe'/, "fail-safe must not fire after the class change");
  });

  test("latency fires at its 1h-equivalent breach (independent of reason) and clears when under budget", () => {
    // A healthy reason with a SLOW probe: latency must still fire.
    hsetLastTick({ reason: "allow-false", class: "deliberate-skip", at: String(T0), latency_ms: "2500" });
    seedSince("latency", T0);
    const r = runBlock({
      HYDRA_WATCHDOG_LAUNCH_LATENCY_BUDGET_MS: "1000",
      HYDRA_WATCHDOG_LAUNCH_LATENCY_BREACH_SECONDS: "2",
      HYDRA_WATCHDOG_LAUNCH_NOW_MS: String(T0 + 5_000),
    });
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.match(warnLines(r.stdout), /signal 'latency' sustained 5000ms >= 2000ms/);
    assert.equal(getFired("latency"), true, "latency fired marker set");

    // Under-budget probe clears the latency streak (recovery).
    hsetLastTick({ reason: "allow-false", class: "deliberate-skip", at: String(T0 + 6_000), latency_ms: "500" });
    const r2 = runBlock({
      HYDRA_WATCHDOG_LAUNCH_LATENCY_BUDGET_MS: "1000",
      HYDRA_WATCHDOG_LAUNCH_LATENCY_BREACH_SECONDS: "2",
      HYDRA_WATCHDOG_LAUNCH_NOW_MS: String(T0 + 6_000),
    });
    assert.equal(r2.status, 0, `stderr=${r2.stderr}`);
    assert.equal(getSince("latency"), "", "latency since-anchor cleared when probe back under budget");
    assert.equal(getFired("latency"), false, "latency fired marker cleared on recovery");
  });

  test("INV-5: absent latency_ms clears the latency streak (probe never reached)", () => {
    hsetLastTick({ reason: "allow-false", class: "deliberate-skip", at: String(T0), latency_ms: "2500" });
    seedSince("latency", T0);
    runBlock({
      HYDRA_WATCHDOG_LAUNCH_LATENCY_BUDGET_MS: "1000",
      HYDRA_WATCHDOG_LAUNCH_LATENCY_BREACH_SECONDS: "2",
      HYDRA_WATCHDOG_LAUNCH_NOW_MS: String(T0 + 5_000),
    });
    assert.equal(getSince("latency"), String(T0), "precondition: latency streak active");
    // Now a tick whose probe never completed (curl-missing has no latency_ms) → latency clears.
    hsetLastTick({ reason: "curl-missing", class: "fail-safe", at: String(T0 + 6_000), latency_ms: "" });
    const r = runBlock({
      HYDRA_WATCHDOG_LAUNCH_LATENCY_BUDGET_MS: "1000",
      HYDRA_WATCHDOG_LAUNCH_LATENCY_BREACH_SECONDS: "2",
      HYDRA_WATCHDOG_LAUNCH_NOW_MS: String(T0 + 6_000),
    });
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.equal(getSince("latency"), "", "absent latency_ms must clear the latency streak");
  });

  test("latency is a LEADING indicator: fires strictly before the 2h fail-safe streak", () => {
    // reason = eligibility-unparseable: fail-safe signal AND a completed slow probe.
    // Latency breach 2s, fail-safe 4s, now = T0+3s → latency (3>=2) fires, fail-safe (3<4) does not.
    hsetLastTick({ reason: "eligibility-unparseable", class: "fail-safe", at: String(T0), latency_ms: "2500" });
    seedSince("fail-safe", T0);
    seedSince("latency", T0);
    const r = runBlock({
      HYDRA_WATCHDOG_LAUNCH_FAILSAFE_SECONDS: "4",
      HYDRA_WATCHDOG_LAUNCH_LATENCY_BUDGET_MS: "1000",
      HYDRA_WATCHDOG_LAUNCH_LATENCY_BREACH_SECONDS: "2",
      HYDRA_WATCHDOG_LAUNCH_NOW_MS: String(T0 + 3_000),
    });
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    const w = warnLines(r.stdout);
    assert.match(w, /'latency'/, "latency must fire as the leading indicator");
    assert.doesNotMatch(w, /'fail-safe'/, "fail-safe must NOT have fired yet (it lags)");
    assert.equal(getFired("latency"), true);
    assert.equal(getFired("fail-safe"), false);
  });

  test("thresholds are injectable: a tiny override fires where the default would not", () => {
    hsetLastTick({ reason: "paused", class: "deliberate-skip", at: String(T0), latency_ms: "100" });
    seedSince("pause", T0);
    // Default pause threshold is 24h; with only a 5s elapsed, the default would
    // never fire. Inject 2s and it must.
    const r = runBlock({ HYDRA_WATCHDOG_LAUNCH_PAUSE_SECONDS: "2", HYDRA_WATCHDOG_LAUNCH_NOW_MS: String(T0 + 5_000) });
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.match(warnLines(r.stdout), /signal 'pause' sustained 5000ms >= 2000ms/);
  });

  test("INV-10: never throws / never non-zero on a read failure (unreachable redis leaves state untouched)", () => {
    hsetLastTick({ reason: "eligibility-unreachable", class: "fail-safe", at: String(T0), latency_ms: "" });
    seedSince("fail-safe", T0);
    // Point the block at an unreachable redis → HGETALL fails → empty reason path.
    const r = spawnSync(
      "bash",
      ["-c", `set -euo pipefail; source '${BLOCK}'; run_launch_flow`],
      {
        env: {
          ...process.env,
          HYDRA_REDIS_HOST: "127.0.0.1",
          HYDRA_REDIS_PORT: "1", // nothing listening
          HYDRA_WATCHDOG_LAUNCH_FAILSAFE_SECONDS: "2",
          HYDRA_WATCHDOG_LAUNCH_NOW_MS: String(T0 + 5_000),
          PATH: process.env.PATH ?? "",
        },
        encoding: "utf-8",
        timeout: WATCHDOG_TIMEOUT_MS,
      },
    );
    assertNotTimedOut(r, "INV-10 unreachable-redis run_launch_flow");
    assert.equal(r.status ?? -1, 0, `read failure must not abort (set -e); stderr=${r.stderr}`);
    const out = (r.stdout ?? "").split("\n").filter((l) => l.includes("hydra-launch-flow-watchdog:")).join("\n");
    assert.match(out, /WARN no pace-gate last-tick record/, "read failure must log a distinguishable WARN");
    // Crucially: the in-progress streak the docker side seeded must be untouched.
    assert.equal(getSince("fail-safe"), String(T0), "a read failure must NOT clear an in-progress streak");
    assert.equal(getFired("fail-safe"), false, "a read failure must NOT fire");
  });

  test("INV-10: absent last-tick key (no tick ever recorded) logs WARN, exits 0, no mutation", () => {
    // cleanState already DELed the last-tick key in beforeEach.
    const r = runBlock({ HYDRA_WATCHDOG_LAUNCH_NOW_MS: String(T0), HYDRA_WATCHDOG_LAUNCH_FAILSAFE_SECONDS: "2" });
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    const out = r.stdout.split("\n").filter((l) => l.includes("hydra-launch-flow-watchdog:")).join("\n");
    assert.match(out, /WARN no pace-gate last-tick record/);
    for (const s of SIGNALS) {
      assert.equal(getSince(s), "", `no anchor mutated for ${s} on absent tick`);
      assert.equal(getFired(s), false, `no fired marker set for ${s} on absent tick`);
    }
  });
});

// =============================================================================
// src/redis/launch-flow.ts — typed-read seam (INV-11). Uses the TS connection
// (REDIS_URL), so it runs wherever the node:test harness has Redis, with no
// dependency on the docker container.
// =============================================================================

describe("src/redis/launch-flow.ts — typed launch-flow read seam (issue #3847, INV-11)", () => {
  // Use the latency signal (never written by the docker-gated behavioural
  // cases' DB-0 traffic; the TS connection is a different DB via REDIS_URL).
  const sig = "latency" as const;

  beforeEach(async () => {
    const r = getRedisConnection();
    await r.del(SINCE(sig), FIRED(sig));
  });

  test("getLaunchFlowSince / isLaunchFlowFired return null/false on an absent streak", async () => {
    assert.equal(await getLaunchFlowSince(sig), null);
    assert.equal(await isLaunchFlowFired(sig), false);
  });

  test("getLaunchFlowSince reads an epoch-ms written under the TS-owned key; non-numeric coerces to null", async () => {
    const r = getRedisConnection();
    await r.set(launchFlowSinceKey(sig), String(T0));
    assert.equal(await getLaunchFlowSince(sig), T0);
    await r.set(launchFlowSinceKey(sig), "not-a-number");
    assert.equal(await getLaunchFlowSince(sig), null, "a corrupt value must coerce to null, never throw");
  });

  test("isLaunchFlowFired reflects the fired marker; clearLaunchFlowStreak removes both", async () => {
    const r = getRedisConnection();
    await r.set(launchFlowFiredKey(sig), "1");
    await r.set(launchFlowSinceKey(sig), String(T0));
    assert.equal(await isLaunchFlowFired(sig), true);
    await clearLaunchFlowStreak(sig);
    assert.equal(await isLaunchFlowFired(sig), false);
    assert.equal(await getLaunchFlowSince(sig), null);
  });
});

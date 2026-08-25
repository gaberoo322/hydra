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
 *   INV-9  no Orchestrator alerting HTTP surface (superseded by #3848: the
 *          block now DELIVERS — see test/launch-flow-delivery.test.mts; the
 *          surviving constraint is "never POST to the Orchestrator's own
 *          alert API", not "no telegram").
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
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

import {
  type WatchdogLaunchSignal,
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
import { STREAMS } from "../src/event-bus-stream-keys.ts";
import {
  WATCHDOG_SPAWN_TIMEOUT_MS,
  WATCHDOG_REDIS_TIMEOUT_MS,
  throwIfTimedOut,
  assertSpawnOk,
  describeExitStatus,
} from "./_helpers/watchdog-timeouts.mts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const WATCHDOG = join(REPO_ROOT, "scripts", "hydra-watchdog.sh");

const SIGNALS = ["fail-safe", "meter-dark", "quota", "pause", "latency"] as const;

// ---------------------------------------------------------------------------
// PER-RUN KEY NAMESPACE — the fix for the #4072 flake.
//
// These behavioural cases seed a streak anchor, run the block, and assert the
// exact resulting value. They talk to the docker `hydra-redis-1` container on
// DB 0 — and `run_launch_flow` hardcodes `LF_KEY_PREFIX` /
// `LAST_TICK_KEY` as bash locals with no `-n <db>` selector, so DB 0 is the
// ONLY keyspace it can use. On the dev host and on the self-hosted CI runner
// (the same box, `gabenuc`) the REAL hydra-watchdog.timer fires every 2
// minutes and runs that same block against those same keys. Observed live:
//
//   12:53:23  launch-flow signal 'quota' streak 0ms …  (reason=weekly-emergency-stop)
//   12:55:28  launch-flow tick processed (reason=eligible-launch)
//   12:57:35  launch-flow tick processed (reason=session-blocked)
//
// so a production tick landing mid-case rewrites or DELs the fixture the case
// just seeded. That is the whole flake: the suite passes in ~16s alone (one
// chance in eight of overlapping a tick) and fails inside an ~11-minute full
// run, with a DIFFERENT random subtest subset each time — whichever cases were
// in flight when the tick landed. It is NOT a timeout; generous ceilings were
// measured and the failures persisted.
//
// The interference ran BOTH ways, which is the more serious half: `cleanState`
// used to DEL the production `hydra:autopilot:pace-gate:last-tick`, and the
// live watchdog then logged `WARN no pace-gate last-tick record` — a test run
// was blinding real monitoring for as long as it took the pace gate to write
// that key again.
//
// Namespacing per run removes both directions without touching the script
// (out of scope per #4072) and without serialising against a systemd timer.
// The extracted block is rewritten onto this namespace in `before()`; the
// structural/drift cases keep reading the REAL script source, so the
// production literals stay pinned exactly as before.
const RUN_NS = `hydra:test:launch-flow-${process.pid}-${randomUUID().slice(0, 8)}`;
const TEST_LF_PREFIX = `${RUN_NS}:launch-flow`;
const TEST_LAST_TICK_KEY = `${RUN_NS}:pace-gate:last-tick`;

// Per-run in-band notify-stream override (issue #4182 — this file is
// DETECTION-only and asserts nothing about delivery, but #3848 (gamma) made
// `track_signal` call `deliver_signal` unconditionally at the fired
// absent->present transition, so every fired-transition case here XADDs a
// real entry unless the stream is rebound. Namespaced under RUN_NS so the
// existing sweepOrphanNamespaces() / cleanState() machinery (which already
// matches "hydra:test:launch-flow-*") reaps it for free — see runBlock()
// below, which bakes this into every invocation, mirroring the envWith()
// pattern in test/launch-flow-delivery.test.mts:459.
const TEST_NOTIFY_STREAM = `${RUN_NS}:notifications`;

const SINCE = (s: string) => `${TEST_LF_PREFIX}:since:${s}`;
const FIRED = (s: string) => `${TEST_LF_PREFIX}:fired:${s}`;

/** Fixed deterministic clock for threshold maths (epoch-ms). */
const T0 = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// Redis helpers (docker exec → DB 0, the watchdog's default target). Mirror the
// test/autopilot-hooks.test.mts gating contract.
// ---------------------------------------------------------------------------

function dockerRedisAvailable(): boolean {
  const r = spawnSync("docker", ["exec", "hydra-redis-1", "redis-cli", "PING"], {
    encoding: "utf-8",
    timeout: WATCHDOG_REDIS_TIMEOUT_MS,
  });
  return (r.stdout ?? "").trim() === "PONG";
}

const DOCKER = dockerRedisAvailable();

/**
 * Run one `docker exec … redis-cli` round-trip, or THROW (issue #4135).
 *
 * Every Redis helper below routes through here. Previously each called
 * `spawnSync` and dropped the result on the floor: a seeding `HSET` that never
 * ran returned `void` exactly like one that succeeded, and a `GET` whose child
 * was killed returned `""` — indistinguishable from a genuinely-empty key.
 * The next assertion then measured an unseeded fixture and failed as though
 * the WATCHDOG had changed behaviour, which is #4135's intermittent INV-5 red:
 * loaded CI runner only, never a quiet laptop, same tree either way.
 *
 * `assertSpawnOk` covers timeout, spawn error (EAGAIN under fork pressure),
 * killing signal and non-zero `redis-cli` exit. The distinction it preserves
 * is the whole point: "the box could not run docker" must never be reported as
 * "the invariant is broken".
 */
function redisCli(args: string[], what: string): string {
  const r = spawnSync("docker", ["exec", "hydra-redis-1", "redis-cli", "--raw", ...args], {
    encoding: "utf-8",
    timeout: WATCHDOG_REDIS_TIMEOUT_MS,
  });
  assertSpawnOk(r, WATCHDOG_REDIS_TIMEOUT_MS, what);
  return (r.stdout ?? "").trim();
}

function drc(args: string[]): string {
  return redisCli(args, `redis-cli ${args[0]}`);
}

/** Wipe the last-tick record and ALL ten launch-flow keys for a clean slate. */
function cleanState(): void {
  const keys = [TEST_LAST_TICK_KEY];
  for (const s of SIGNALS) keys.push(SINCE(s), FIRED(s));
  redisCli(["DEL", ...keys], "cleanState DEL");
  // Namespaced notify-stream reset (issue #4182) — a per-run key, not one of
  // the ten launch-flow signal keys, so it needs its own DEL. DEL on a stream
  // key is fine (same command family XADD/XRANGE/XLEN all operate on).
  redisCli(["DEL", TEST_NOTIFY_STREAM], "cleanState DEL notify-stream");
}

function hsetLastTick(fields: Record<string, string>): void {
  const args = ["HSET", TEST_LAST_TICK_KEY];
  for (const [k, v] of Object.entries(fields)) args.push(k, v);
  redisCli(args, `hsetLastTick HSET (${Object.keys(fields).join(",")})`);
}

/** Pre-seed a signal's since-anchor (stands in for "the streak began long ago"). */
function seedSince(signal: string, ms: number): void {
  redisCli(["SET", SINCE(signal), String(ms), "NX"], `seedSince SET ${signal}`);
}

/**
 * The pid embedded in a per-run namespace, or null if the key is not shaped
 * like one. `RUN_NS` is `hydra:test:launch-flow-<pid>-<uuid8>`, so the pid is
 * the segment between the fixed prefix and the first `-` after it.
 */
function runNsPid(key: string): number | null {
  const m = /^hydra:test:launch-flow-(\d+)-[0-9a-f]{8}(?::|$)/.exec(key);
  if (m === null) return null;
  const pid = Number(m[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Is this namespace owned by a process that is STILL RUNNING?
 *
 * The sweep below exists to collect namespaces whose owner died before its
 * `after()` could run. Before #4135 it collected every namespace that was not
 * this run's — which includes the namespaces of runs that are alive and
 * mid-assertion. Two suite runs sharing a Redis DB therefore deleted each
 * other's fixtures, and the victim failed on whichever case happened to be in
 * flight. That is precisely the reported symptom: same tree, different
 * outcome, and a DIFFERENT subtest each time.
 *
 * Sharing a DB is not exotic. `scripts/test/redis-db-launch.mjs` derives the
 * index from the WORKTREE PATH ("Same worktree -> same DB"), so any two runs
 * out of one checkout collide by design — which is what a second full-suite
 * workflow on the same self-hosted runner used to do on every PR until #4133
 * deleted it.
 *
 * `/proc/<pid>` is the liveness probe rather than `pgrep -f`, whose `-f` form
 * matches the CALLER's own command line and would report every namespace as
 * live (the trap documented in CLAUDE.md). Pid reuse can only make a dead
 * run look alive, which skips a delete — the safe direction for hygiene that
 * is explicitly best-effort.
 */
function isRunNamespaceLive(key: string): boolean {
  const pid = runNsPid(key);
  if (pid === null) return false;
  if (pid === process.pid) return true;
  return existsSync(`/proc/${pid}`);
}

/**
 * Delete leftover `hydra:test:launch-flow-*` keys from earlier runs.
 *
 * `after()` cleans up precisely, but `--test-force-exit` can tear the process
 * down before it runs, and these keys live in production's DB 0 (the only
 * keyspace the block can address). SCAN — never KEYS — because DB 0 is the live
 * orchestrator's database and a blocking full-keyspace walk there is not a cost
 * a test gets to impose. Bounded: one pass, and failures are ignored, since
 * this is opportunistic hygiene rather than a precondition of any assertion.
 *
 * Since #4135 `drc` THROWS when the `docker exec` does not complete cleanly.
 * That is right for every other caller — a dropped seed or an unreadable key
 * must never be mistaken for a behaviour change — but wrong here, where a
 * failure genuinely does not matter. Hence the one deliberate catch in this
 * file: hygiene stays best-effort, everything load-bearing stays loud.
 */
function sweepOrphanNamespaces(): void {
  try {
    let cursor = "0";
    for (let i = 0; i < 64; i++) {
      const out = drc(["SCAN", cursor, "MATCH", "hydra:test:launch-flow-*", "COUNT", "500"]);
      const lines = out.split("\n").filter((l) => l !== "");
      if (lines.length === 0) return;
      cursor = lines[0];
      const keys = lines.slice(1).filter((k) => !k.startsWith(RUN_NS) && !isRunNamespaceLive(k));
      if (keys.length > 0) drc(["DEL", ...keys]);
      if (cursor === "0") return;
    }
  } catch (err) {
    /* intentional: opportunistic cross-run hygiene, never a precondition. */
    console.error(`[watchdog-launch-flow] orphan-namespace sweep skipped: ${String(err)}`);
  }
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
  if (DOCKER) sweepOrphanNamespaces();
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

  // Rebind the extracted COPY onto this run's private namespace so a
  // concurrent production watchdog tick cannot touch our fixtures (and we
  // cannot touch its). Only the temp copy is rewritten — the structural cases
  // below still read the real script, so the production literals stay pinned.
  //
  // Asserted, not best-effort: if the script renames these literals, a silent
  // no-op replace would put the behavioural cases straight back onto the shared
  // production keys and the flake would return looking like a fresh mystery.
  // Fail loudly here instead.
  const namespaced = body
    .split(`"${PACE_GATE_LAST_TICK_KEY}"`)
    .join(`"${TEST_LAST_TICK_KEY}"`)
    .split(`"${LAUNCH_FLOW_KEY_PREFIX}"`)
    .join(`"${TEST_LF_PREFIX}"`)
    // Issue #3868: rebind the GLM drainer heartbeat literal too. This file's
    // behavioural cases never seed the namespaced heartbeat, so the block's
    // glm-sterile membership check short-circuits on "heartbeat absent" and
    // NEVER reaches its gh calls — without this rebind, a fresh PRODUCTION
    // drainer heartbeat on the host would make every behavioural case here
    // shell out to the real GitHub API.
    .split(`"hydra:glm:drainer:active"`)
    .join(`"${RUN_NS}:glm-drainer-active"`);
  assert.ok(
    namespaced.includes(`"${TEST_LAST_TICK_KEY}"`),
    `failed to rebind LAST_TICK_KEY: the block no longer contains the literal "${PACE_GATE_LAST_TICK_KEY}". ` +
      `Without this rebinding the behavioural cases race the live hydra-watchdog.timer (#4072).`,
  );
  assert.ok(
    namespaced.includes(`"${RUN_NS}:glm-drainer-active"`),
    'failed to rebind the GLM drainer heartbeat key: the block no longer contains the literal "hydra:glm:drainer:active" (issue #3868). ' +
      "Without this rebinding the behavioural cases read the live production heartbeat and can shell out to the real GitHub API.",
  );
  assert.ok(
    namespaced.includes(`"${TEST_LF_PREFIX}"`),
    `failed to rebind LF_KEY_PREFIX: the block no longer contains the literal "${LAUNCH_FLOW_KEY_PREFIX}". ` +
      `Without this rebinding the behavioural cases race the live hydra-watchdog.timer (#4072).`,
  );
  assert.ok(
    !namespaced.includes(`"${LAUNCH_FLOW_KEY_PREFIX}"`),
    "the production launch-flow prefix must not survive anywhere in the rebound block",
  );
  writeFileSync(BLOCK, namespaced);
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
    // HYDRA_WATCHDOG_LAUNCH_NOTIFY_STREAM is baked in here — unconditionally,
    // for every call site in this file — rather than threaded through each of
    // the ~15 individual runBlock({...}) call sites (issue #4182). This file
    // is DETECTION-only and never asserts on delivery, but #3848 wired
    // track_signal to call deliver_signal unconditionally at the fired
    // absent->present transition, so an un-rebound stream means every
    // fired-transition case here XADDs a REAL entry onto the production
    // hydra:notifications stream — confirmed live: 36 false operator alerts
    // in one day, all bearing this file's fixture thresholds/durations. A
    // caller may still override via its own `env` (last-spread wins), mirroring
    // the envWith() precedent in test/launch-flow-delivery.test.mts:459.
    //
    // HYDRA_REDIS_DB is pinned to "0" for the same reason (issue #4183): this
    // suite's own seed/read helpers (hsetLastTick, seedSince, drc, cleanState)
    // are hardcoded to db 0 with no `-n` selector — that IS db 0, the
    // watchdog's default target, per the file-header contract above.
    // scripts/test/redis-db-launch.mjs now exports HYDRA_REDIS_DB into this
    // whole node:test process's env (so a bash-shelled test inherits the
    // run's isolation automatically), so an unpinned `...process.env` here
    // would silently redirect rc_write/rc_read to the launcher's derived
    // per-run DB while every seed/assertion in this suite kept reading/
    // writing db 0 — rc_read would find nothing, every case would degrade to
    // the "no pace-gate last-tick record" branch. The dedicated #4183 describe
    // below exercises DB-selection itself; this suite deliberately keeps
    // testing against db 0.
    env: {
      ...process.env,
      HYDRA_REDIS_HOST: "docker",
      HYDRA_REDIS_DB: "0",
      HYDRA_WATCHDOG_LAUNCH_NOTIFY_STREAM: TEST_NOTIFY_STREAM,
      ...env,
      PATH: process.env.PATH ?? "",
    },
    encoding: "utf-8",
    timeout: WATCHDOG_SPAWN_TIMEOUT_MS,
  });
  throwIfTimedOut(r, WATCHDOG_SPAWN_TIMEOUT_MS, "run_launch_flow block");
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
    // Detection still reads ONLY the hash — the block must never probe the
    // Orchestrator over HTTP. NB #3848 (gamma) deliberately ADDED a `curl`
    // invocation to the block: the out-of-band Telegram DELIVERY call (target
    // api.telegram.org, fired once per streak, not per tick). The forbidden
    // surface is therefore an ORCHESTRATOR-directed curl (localhost / port
    // 4000), not the curl command itself — the pre-#3848 `curl\s`-count-zero
    // assertion pinned the detection-only era and would false-fail gamma.
    assert.equal((block.match(/curl\s[^"\n]*localhost/g) ?? []).length, 0, "must not curl any Orchestrator endpoint (detection reads only the hash; delivery goes to api.telegram.org / the notifications stream)");
    assert.equal((block.match(/curl\s[^"\n]*localhost:4000/g) ?? []).length, 0, "must not curl the Orchestrator HTTP API");
    // The HGETALL references the last-tick key variable, whose literal equals the TS constant.
    assert.ok(block.includes('LAST_TICK_KEY='), "block must define LAST_TICK_KEY");
    const lit = block.match(/LAST_TICK_KEY="([^"]+)"/);
    assert.ok(lit, "LAST_TICK_KEY literal assignment not found");
    assert.equal(lit![1], PACE_GATE_LAST_TICK_KEY, "watchdog LAST_TICK_KEY drifted from PACE_GATE_LAST_TICK_KEY");
  });

  test("INV-9 (#3848 supersession): delivery is wired but never touches the Orchestrator HTTP API for alerting", () => {
    // The #3847 artifact's INV-9 was "DETECTION ONLY — no alerts.ts / telegram
    // / alert POST". Issue #3848 (gamma) deliberately superseded it: the block
    // now DELIVERS at the fired absent→present transition — out-of-band direct
    // Telegram for fail-safe/meter-dark, enveloped XADD onto the notifications
    // stream for quota/latency/pause. The surface constraint that SURVIVES is
    // the one INV-9 actually existed for: the block must never call the
    // Orchestrator's own alerting HTTP surface (a dashboard-alert POST would
    // be written and unreadable in exactly the failure modes this block
    // detects). Full delivery contract: test/launch-flow-delivery.test.mts.
    const src = readFileSync(WATCHDOG, "utf-8");
    const block = src.slice(src.indexOf("run_launch_flow()"), src.indexOf("# Entry point"));
    for (const forbidden of ["alerts.ts", "pushAlert", "POST /api/alerts", "/api/webhooks/sentry"]) {
      assert.ok(!block.includes(forbidden), `launch-flow block must not reference ${forbidden} (no Orchestrator alerting surface)`);
    }
    // And the delivery hook itself must exist exactly at the fired transition
    // (the #3848 contract): one deliver_signal call inside track_signal.
    assert.equal((block.match(/deliver_signal "\$sig"/g) ?? []).length, 1,
      "track_signal must deliver exactly once, at the fired absent→present transition");
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
// The seeding-spawn guard itself (#4135). Runs unconditionally — no docker.
// =============================================================================

describe("watchdog Redis seeding never fails silently (issue #4135)", () => {
  // #4135's INV-5 red was not a watchdog bug: a seeding `docker exec … HSET`
  // that died under CI load returned void, the fixture was never written, and
  // the following assertion measured an unseeded key. These cases pin the four
  // ways that spawn can die, so the guard cannot regress back to silence.

  test("a timed-out seed throws, and says TIMEOUT rather than blaming behaviour", () => {
    const timedOut = { error: Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" }), signal: "SIGTERM" as const, status: null, stdout: "", stderr: "" };
    assert.throws(
      () => assertSpawnOk(timedOut, WATCHDOG_REDIS_TIMEOUT_MS, "hsetLastTick HSET"),
      (err: Error) => {
        assert.match(err.message, /hsetLastTick HSET/);
        assert.match(err.message, /TIMEOUT, not an assertion failure/);
        return true;
      },
    );
  });

  test("a spawn error that is NOT a timeout still throws — EAGAIN under fork pressure", () => {
    // The likelier failure on a runner executing four jobs at once: the child
    // never starts at all. `throwIfTimedOut` alone returns quietly here, which
    // is exactly the hole this guard closes.
    const eagain = { error: Object.assign(new Error("spawn EAGAIN"), { code: "EAGAIN" }), signal: null, status: null, stdout: "", stderr: "" };
    assert.doesNotThrow(() => throwIfTimedOut(eagain, WATCHDOG_REDIS_TIMEOUT_MS, "x"));
    assert.throws(
      () => assertSpawnOk(eagain, WATCHDOG_REDIS_TIMEOUT_MS, "seedSince SET latency"),
      (err: Error) => {
        assert.match(err.message, /seedSince SET latency/);
        assert.match(err.message, /EAGAIN/);
        assert.match(err.message, /never written/);
        return true;
      },
    );
  });

  test("a killed seed throws", () => {
    assert.throws(
      () => assertSpawnOk({ signal: "SIGKILL", status: null, stdout: "", stderr: "" }, WATCHDOG_REDIS_TIMEOUT_MS, "cleanState DEL"),
      /killed by SIGKILL/,
    );
  });

  test("a non-zero redis-cli exit throws — the command did not succeed", () => {
    assert.throws(
      () => assertSpawnOk({ status: 1, signal: null, stdout: "", stderr: "Could not connect" }, WATCHDOG_REDIS_TIMEOUT_MS, "hsetLastTick HSET"),
      (err: Error) => {
        assert.match(err.message, /exited 1/);
        assert.match(err.message, /Could not connect/);
        return true;
      },
    );
  });

  test("a clean run does not throw", () => {
    assert.doesNotThrow(() =>
      assertSpawnOk({ status: 0, signal: null, stdout: "OK", stderr: "" }, WATCHDOG_REDIS_TIMEOUT_MS, "seedSince SET quota"),
    );
  });

  test("a 128+N exit is reported as a signal death, not a bare number", () => {
    // The concrete cost this repays: a #4135 reproduction under load failed
    // with `141 !== 0` and an EMPTY stderr, which says nothing at all. 141 is
    // 128 + 13 — some command in the block died of SIGPIPE. Naming that in the
    // assertion is the difference between a one-line read and an hour.
    const msg = describeExitStatus(141);
    assert.match(msg, /128 \+ 13/);
    assert.match(msg, /SIGPIPE/);
    assert.match(msg, /ENVIRONMENT/);
    assert.match(describeExitStatus(137), /SIGKILL/);
    assert.match(describeExitStatus(143), /SIGTERM/);
  });

  test("an ordinary exit code is left alone, and a missing one says so", () => {
    assert.equal(describeExitStatus(1), "1");
    assert.equal(describeExitStatus(0), "0");
    assert.match(describeExitStatus(null), /did not run to completion/);
  });

  test("every Redis helper routes through the guarded round-trip", () => {
    // The defect was per-call-site, so a new unguarded docker spawn
    // reintroduces it. Exactly one may remain outside redisCli:
    // dockerRedisAvailable, the PING probe whose whole job is to fail quietly
    // when there is no container to talk to.
    //
    // The pattern requires the argv array that a REAL call has, so this
    // case's own prose does not count itself — the self-match trap that
    // CLAUDE.md records for `pgrep -f`, and which the first draft of this
    // assertion walked straight into (it reported 4 sites, two of them these
    // very lines).
    const src = readFileSync(join(REPO_ROOT, "test", "watchdog-launch-flow.test.mts"), "utf-8");
    const dockerSpawns = src.match(/spawnSync\(\s*"docker",\s*\[/g) ?? [];
    assert.equal(
      dockerSpawns.length,
      2,
      `expected exactly 2 docker spawn sites (redisCli + the dockerRedisAvailable PING), found ` +
        `${dockerSpawns.length}. A new one must go through redisCli() or it can drop a seed ` +
        `silently and reopen #4135.`,
    );
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
    assert.equal(r.status, 0, `exit ${describeExitStatus(r.status)}; stderr=${r.stderr}`);
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
    assert.equal(r.status, 0, `exit ${describeExitStatus(r.status)}; stderr=${r.stderr}`);
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
    assert.equal(r.status, 0, `exit ${describeExitStatus(r.status)}; stderr=${r.stderr}`);
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
      assert.equal(r.status, 0, `exit ${describeExitStatus(r.status)}; stderr: ${r.stderr}`);
      warnings += warnLines(r.stdout).split("\n").filter((l) => l.includes("'quota'")).length;
      // The anchor set on tick 1 must survive ticks 2 and 3 unchanged.
      assert.equal(getSince("quota"), String(T0), `quota anchor must not reset on flip to ${reason}`);
    }
    assert.equal(warnings, 1, "exactly one quota WARNING across the continuous flipped-reason streak");
  });

  test("issue #4182 regression: a fired-transition tick never XADDs the PRODUCTION notifications stream", () => {
    // Reproduces the exact live incident: 36 real launch:quota_stretch /
    // launch:latency_breach alerts landed on the dashboard from ordinary
    // `npm test` runs, because this file (detection-only) never rebound the
    // in-band delivery stream that #3848 wired `track_signal` to XADD onto
    // unconditionally at the fired absent->present transition. Quota is a
    // representative fired-transition case (matches the live incident's
    // `launch:quota_stretch` alert type exactly, including a 2000ms
    // threshold / 5000ms duration).
    const before = Number(drc(["XLEN", STREAMS.NOTIFICATIONS]));

    hsetLastTick({ reason: "emergency-stop", class: "deliberate-skip", at: String(T0), latency_ms: "100" });
    seedSince("quota", T0);
    const r = runBlock({ HYDRA_WATCHDOG_LAUNCH_QUOTA_SECONDS: "2", HYDRA_WATCHDOG_LAUNCH_NOW_MS: String(T0 + 5_000) });
    assert.equal(r.status, 0, `exit ${describeExitStatus(r.status)}; stderr=${r.stderr}`);
    assert.match(warnLines(r.stdout), /signal 'quota' sustained 5000ms >= 2000ms/, "precondition: this tick fired");

    const after = Number(drc(["XLEN", STREAMS.NOTIFICATIONS]));
    assert.equal(
      after,
      before,
      `a fired-transition tick must not write the PRODUCTION '${STREAMS.NOTIFICATIONS}' stream ` +
        `(XLEN went ${before} -> ${after}); it must land only on the per-run HYDRA_WATCHDOG_LAUNCH_NOTIFY_STREAM override`,
    );

    // And the entry genuinely landed somewhere — on the namespaced stream —
    // so this is proving isolation, not a delivery no-op that would pass
    // vacuously.
    const rebound = Number(drc(["XLEN", TEST_NOTIFY_STREAM]));
    assert.equal(rebound, 1, "the fired transition must deliver exactly one entry onto the rebound test stream");
  });

  test("pause (forgotten operator pause) fires at 24h-equivalent threshold", () => {
    hsetLastTick({ reason: "paused", class: "deliberate-skip", at: String(T0), latency_ms: "100" });
    seedSince("pause", T0);
    const r = runBlock({ HYDRA_WATCHDOG_LAUNCH_PAUSE_SECONDS: "2", HYDRA_WATCHDOG_LAUNCH_NOW_MS: String(T0 + 5_000) });
    assert.equal(r.status, 0, `exit ${describeExitStatus(r.status)}; stderr=${r.stderr}`);
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
    assert.equal(r.status, 0, `exit ${describeExitStatus(r.status)}; stderr=${r.stderr}`);
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
    assert.equal(r.status, 0, `exit ${describeExitStatus(r.status)}; stderr=${r.stderr}`);
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
    assert.equal(r.status, 0, `exit ${describeExitStatus(r.status)}; stderr=${r.stderr}`);
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
    assert.equal(r.status, 0, `exit ${describeExitStatus(r.status)}; stderr=${r.stderr}`);
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
    assert.equal(r.status, 0, `exit ${describeExitStatus(r.status)}; stderr=${r.stderr}`);
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
        timeout: WATCHDOG_SPAWN_TIMEOUT_MS,
      },
    );
    throwIfTimedOut(r, WATCHDOG_SPAWN_TIMEOUT_MS, "run_launch_flow block (unreachable-redis case)");
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
    assert.equal(r.status, 0, `exit ${describeExitStatus(r.status)}; stderr=${r.stderr}`);
    const out = r.stdout.split("\n").filter((l) => l.includes("hydra-launch-flow-watchdog:")).join("\n");
    assert.match(out, /WARN no pace-gate last-tick record/);
    for (const s of SIGNALS) {
      assert.equal(getSince(s), "", `no anchor mutated for ${s} on absent tick`);
      assert.equal(getFired(s), false, `no fired marker set for ${s} on absent tick`);
    }
  });
});

// =============================================================================
// rc_write/rc_read DB-index selection (issue #4183). Its own top-level describe
// with its own before/beforeEach/after, per this repo's shared-Redis-state
// authoring rule. It sources a SEPARATE extracted-block copy rebound onto its
// OWN key namespace (OWN_NS below) rather than reusing TEST_LAST_TICK_KEY /
// SINCE()/FIRED() from the "## LAUNCH FLOW behaviour" describe above: those
// keys are also written on db 0 by this test's own "falls back to db 0" cases,
// and node's test runner does not guarantee top-level describes in one file
// never overlap in time, so sharing a key namespace with another describe's
// db-0 traffic is a real collision risk, not just a style preference.
// =============================================================================

describe("scripts/hydra-watchdog.sh — HYDRA_REDIS_DB threads through rc_write/rc_read (issue #4183)", { skip: !DOCKER }, () => {
  // A DB this describe owns for its own lifetime — distinct from db 0
  // (production, the fallback-on-invalid/absent-input target) so a leak in
  // either direction is unambiguous.
  const SELECTED_DB = "9";

  // Fully separate key namespace from RUN_NS/TEST_LAST_TICK_KEY/SINCE/FIRED
  // above — this describe never touches those keys, on any DB.
  const OWN_NS = `${RUN_NS}-4183`;
  const OWN_LAST_TICK_KEY = `${OWN_NS}:pace-gate:last-tick`;
  const OWN_LF_PREFIX = `${OWN_NS}:launch-flow`;
  const OWN_SINCE = (s: string) => `${OWN_LF_PREFIX}:since:${s}`;
  const OWN_FIRED = (s: string) => `${OWN_LF_PREFIX}:fired:${s}`;

  const OWN_BLOCK = join(tmpdir(), `hydra-launch-flow-block-4183-${process.pid}.sh`);

  before(() => {
    // Mirrors the top-level before()'s extraction + rebind, but onto this
    // describe's OWN literals instead of TEST_LAST_TICK_KEY/TEST_LF_PREFIX —
    // see the block comment above for why a separate namespace is required.
    const src = readFileSync(WATCHDOG, "utf-8");
    const start = src.indexOf("run_launch_flow()");
    assert.ok(start >= 0, "run_launch_flow() not found in hydra-watchdog.sh");
    const rest = src.slice(start);
    const end = rest.search(/^}/m);
    assert.ok(end >= 0, "run_launch_flow() closing brace not found");
    const body = rest.slice(0, end + 1);
    const namespaced = body
      .split(`"${PACE_GATE_LAST_TICK_KEY}"`)
      .join(`"${OWN_LAST_TICK_KEY}"`)
      .split(`"${LAUNCH_FLOW_KEY_PREFIX}"`)
      .join(`"${OWN_LF_PREFIX}"`);
    assert.ok(
      namespaced.includes(`"${OWN_LAST_TICK_KEY}"`) && namespaced.includes(`"${OWN_LF_PREFIX}"`),
      "failed to rebind this describe's own key literals",
    );
    writeFileSync(OWN_BLOCK, namespaced);
  });

  after(() => {
    try {
      unlinkSync(OWN_BLOCK);
    } catch {
      /* best-effort cleanup */
    }
    cleanBothDbs();
  });

  /** One `docker exec … redis-cli -n <db> …` round-trip against an explicit DB. */
  function drcAt(db: string, args: string[]): string {
    return redisCli(["-n", db, ...args], `redis-cli -n ${db} ${args[0]}`);
  }

  function hsetLastTickAt(db: string, fields: Record<string, string>): void {
    const args = ["HSET", OWN_LAST_TICK_KEY];
    for (const [k, v] of Object.entries(fields)) args.push(k, v);
    drcAt(db, args);
  }

  function existsAt(db: string, key: string): boolean {
    return drcAt(db, ["EXISTS", key]) === "1";
  }

  /** Pre-seed a signal's since-anchor in an explicit DB (stands in for "the streak began at T0"). */
  function seedSinceAt(db: string, signal: string, ms: number): void {
    drcAt(db, ["SET", OWN_SINCE(signal), String(ms), "NX"]);
  }

  function cleanBothDbs(): void {
    const keys = [OWN_LAST_TICK_KEY, OWN_SINCE("fail-safe"), OWN_FIRED("fail-safe")];
    drcAt("0", ["DEL", ...keys]);
    drcAt(SELECTED_DB, ["DEL", ...keys]);
  }

  beforeEach(() => {
    cleanBothDbs();
  });

  /**
   * Source THIS describe's own rebound block and call it once.
   *
   * Unlike runBlock() above, this deliberately does NOT pin HYDRA_REDIS_DB —
   * that is exactly the variable under test here. But scripts/test/
   * redis-db-launch.mjs exports HYDRA_REDIS_DB into the ambient env of this
   * whole node:test process (issue #4183), so a bare `...process.env` would
   * make the "unset HYDRA_REDIS_DB" case not actually be unset — it would
   * inherit the launcher's derived per-run value. Strip it from the base env
   * first so each call site's own `env` (or its absence) is what the child
   * actually observes.
   */
  function runOwnBlock(env: Record<string, string>): { status: number; stdout: string; stderr: string } {
    const baseEnv: Record<string, string | undefined> = { ...process.env };
    delete baseEnv.HYDRA_REDIS_DB;
    const r = spawnSync("bash", ["-c", `set -euo pipefail; source '${OWN_BLOCK}'; run_launch_flow`], {
      env: {
        ...baseEnv,
        HYDRA_REDIS_HOST: "docker",
        HYDRA_WATCHDOG_LAUNCH_NOTIFY_STREAM: `${OWN_NS}:notifications`,
        ...env,
        PATH: process.env.PATH ?? "",
      },
      encoding: "utf-8",
      timeout: WATCHDOG_SPAWN_TIMEOUT_MS,
    });
    throwIfTimedOut(r, WATCHDOG_SPAWN_TIMEOUT_MS, "run_launch_flow block (#4183 own-namespace)");
    return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  test("a bash-side write with HYDRA_REDIS_DB set lands in that DB, never in db 0", () => {
    // Seed the last-tick hash directly in the TARGET db — this is what
    // HYDRA_REDIS_DB=9 makes rc_read visible to. db 0 is left empty, so a tick
    // that mistakenly reads db 0 would see no record at all (a distinguishable
    // failure mode, not a false pass).
    hsetLastTickAt(SELECTED_DB, {
      reason: "eligibility-unreachable",
      class: "fail-safe",
      at: String(T0),
      latency_ms: "",
    });
    seedSinceAt(SELECTED_DB, "fail-safe", T0); // streak began at T0, in the target DB

    const r = runOwnBlock({
      HYDRA_REDIS_DB: SELECTED_DB,
      HYDRA_WATCHDOG_LAUNCH_FAILSAFE_SECONDS: "2",
      HYDRA_WATCHDOG_LAUNCH_NOW_MS: String(T0 + 5_000),
    });
    assert.equal(r.status, 0, `exit ${describeExitStatus(r.status)}; stderr=${r.stderr}`);
    assert.match(
      warnLines(r.stdout),
      /signal 'fail-safe' sustained 5000ms >= 2000ms/,
      "precondition: this tick must fire against the DB-9 seed (proves rc_read honoured HYDRA_REDIS_DB)",
    );

    // The since-anchor + fired marker THIS tick just wrote via rc_write must
    // exist in the selected DB...
    assert.equal(
      existsAt(SELECTED_DB, OWN_FIRED("fail-safe")),
      true,
      "fired marker must land in the HYDRA_REDIS_DB-selected DB",
    );
    assert.equal(
      existsAt(SELECTED_DB, OWN_SINCE("fail-safe")),
      true,
      "since anchor must land in the HYDRA_REDIS_DB-selected DB",
    );
    // ...and must NEVER have leaked into production db 0 — the exact seam
    // #4183 closes (rc_write/rc_read previously hardcoded db 0 with no `-n`).
    assert.equal(
      existsAt("0", OWN_FIRED("fail-safe")),
      false,
      "a bash-side write with HYDRA_REDIS_DB set must never land in db 0",
    );
    assert.equal(
      existsAt("0", OWN_SINCE("fail-safe")),
      false,
      "a bash-side write with HYDRA_REDIS_DB set must never land in db 0",
    );
  });

  test("non-numeric HYDRA_REDIS_DB falls back to db 0 (byte-identical to pre-#4183 behaviour)", () => {
    hsetLastTickAt("0", {
      reason: "eligibility-unreachable",
      class: "fail-safe",
      at: String(T0),
      latency_ms: "",
    });
    seedSinceAt("0", "fail-safe", T0);

    const r = runOwnBlock({
      HYDRA_REDIS_DB: "not-a-number",
      HYDRA_WATCHDOG_LAUNCH_FAILSAFE_SECONDS: "2",
      HYDRA_WATCHDOG_LAUNCH_NOW_MS: String(T0 + 5_000),
    });
    assert.equal(r.status, 0, `exit ${describeExitStatus(r.status)}; stderr=${r.stderr}`);
    assert.match(
      warnLines(r.stdout),
      /signal 'fail-safe' sustained 5000ms >= 2000ms/,
      "a non-numeric HYDRA_REDIS_DB must fall back to db 0, where the seed was written",
    );
    assert.equal(existsAt("0", OWN_FIRED("fail-safe")), true, "fallback DB must be 0 (the documented default)");
  });

  test("unset HYDRA_REDIS_DB defaults to db 0 (production, unchanged from before #4183)", () => {
    hsetLastTickAt("0", {
      reason: "eligibility-unreachable",
      class: "fail-safe",
      at: String(T0),
      latency_ms: "",
    });
    seedSinceAt("0", "fail-safe", T0);

    const r = runOwnBlock({
      HYDRA_WATCHDOG_LAUNCH_FAILSAFE_SECONDS: "2",
      HYDRA_WATCHDOG_LAUNCH_NOW_MS: String(T0 + 5_000),
    });
    assert.equal(r.status, 0, `exit ${describeExitStatus(r.status)}; stderr=${r.stderr}`);
    assert.equal(existsAt("0", OWN_FIRED("fail-safe")), true, "an unset HYDRA_REDIS_DB must default to db 0");
  });
});

// =============================================================================
// src/redis/launch-flow.ts — typed-read seam (INV-11). Uses the TS connection
// (REDIS_URL), so it runs wherever the node:test harness has Redis, with no
// dependency on the docker container.
// =============================================================================

/**
 * Reset the keys the typed-seam cases actually operate on.
 *
 * These cases go through the PRODUCTION key builders — `launchFlowSinceKey` /
 * `launchFlowFiredKey`, i.e. `hydra:autopilot:launch-flow:*`. Until #4135 the
 * `beforeEach` deleted `SINCE()`/`FIRED()` instead: the per-run
 * `hydra:test:launch-flow-*` namespace the BASH cases use. Those two share no
 * key, so the reset was a silent no-op and every case here inherited whatever
 * the previous case — or a previous RUN — happened to leave behind.
 *
 * That is what made "returns null on an absent streak" fail with
 * `actual: 1700000000000`: T0 is this file's own fixed clock, written by the
 * very next case in the same suite. The assertion was right; the reset it
 * relied on had never run.
 */
async function resetSeamState(sig: WatchdogLaunchSignal): Promise<void> {
  const r = getRedisConnection();
  await r.del(launchFlowSinceKey(sig), launchFlowFiredKey(sig));
}

describe("src/redis/launch-flow.ts — typed launch-flow read seam (issue #3847, INV-11)", () => {
  // Use the latency signal (never written by the docker-gated behavioural
  // cases' DB-0 traffic; the TS connection is a different DB via REDIS_URL).
  const sig = "latency" as const;

  beforeEach(async () => {
    await resetSeamState(sig);
  });

  after(async () => {
    // Leave nothing behind: these are PRODUCTION-shaped key names, so a
    // leftover value is indistinguishable from real state to the next run
    // that lands on this DB.
    await resetSeamState(sig);
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

// =============================================================================
// Cross-run isolation (issue #4135).
//
// The reported symptom was "same tree, different outcome, and a DIFFERENT
// subtest each time" — the signature of shared state, not of a logic error in
// any one case. Measured: two concurrent runs of THIS FILE out of one worktree
// go red in ~1 run in 5 (4 of 20), while 14 sequential runs under a load
// average of 31-55 stayed green. Load was never the variable; a second
// concurrent run was.
//
// Its own top-level suite with its own lifecycle rather than a child of a
// sibling — a nested case would inherit that sibling's teardown timing.
// =============================================================================
describe("cross-run isolation: one run must not delete another's fixtures (issue #4135)", () => {
  const OTHER = "quota" as const;

  after(async () => {
    await resetSeamState(OTHER);
  });

  test("runNsPid parses the owning pid, and rejects anything not shaped like a run namespace", () => {
    assert.equal(runNsPid(`hydra:test:launch-flow-4242-0badc0de:launch-flow:since:latency`), 4242);
    assert.equal(runNsPid(`hydra:test:launch-flow-4242-0badc0de`), 4242);
    // Not ours: the production keyspace must never be mistaken for a namespace
    // this sweep is entitled to collect.
    assert.equal(runNsPid(launchFlowSinceKey("latency")), null);
    assert.equal(runNsPid("hydra:test:launch-flow-notapid-0badc0de:x"), null);
    assert.equal(runNsPid("hydra:test:launch-flow-4242-SHORT:x"), null);
  });

  test("a LIVE run's namespace is never swept — this is the regression", () => {
    // This process is by definition alive, so its own namespace and any other
    // live pid's must both be protected.
    assert.equal(isRunNamespaceLive(`${RUN_NS}:launch-flow:since:latency`), true);
    assert.equal(isRunNamespaceLive(`hydra:test:launch-flow-${process.pid}-0badc0de:x`), true);
  });

  test("a dead run's namespace is still collectable, and a non-namespace key is left alone", () => {
    // 2^22 is above the default pid_max (4194304 is the ceiling, and this is
    // not a pid any live process can hold on this host); if it somehow were,
    // the sweep would merely skip one delete.
    const deadPid = 4_194_303;
    assert.equal(existsSync(`/proc/${deadPid}`), false, "precondition: chosen pid must not be live");
    assert.equal(isRunNamespaceLive(`hydra:test:launch-flow-${deadPid}-0badc0de:x`), false);
    // A key that is not a per-run namespace at all is not "live" — it is
    // simply not this sweep's business, and the RUN_NS guard already excludes
    // it from the delete list.
    assert.equal(isRunNamespaceLive(launchFlowSinceKey("latency")), false);
  });

  test("resetSeamState clears the PRODUCTION-builder keys the seam cases assert on", async () => {
    // The bug this pins: the reset used to target the per-run test namespace
    // while every assertion read the production builders, so it cleared
    // nothing. Assert against the builders directly — if the reset ever drifts
    // back onto a different keyspace, this fails.
    const r = getRedisConnection();
    await r.set(launchFlowSinceKey(OTHER), String(T0));
    await r.set(launchFlowFiredKey(OTHER), "1");
    assert.equal(await getLaunchFlowSince(OTHER), T0, "precondition: the streak must actually be seeded");
    assert.equal(await isLaunchFlowFired(OTHER), true, "precondition: the fired marker must actually be seeded");

    await resetSeamState(OTHER);

    assert.equal(await getLaunchFlowSince(OTHER), null, "resetSeamState must clear the since anchor it is asked to clear");
    assert.equal(await isLaunchFlowFired(OTHER), false, "resetSeamState must clear the fired marker it is asked to clear");
  });

  test("clearing one signal's streak does not disturb another's", async () => {
    // The seam suite pins `latency`; this suite pins `quota`. If a reset were
    // ever written to wipe the whole prefix, these two would silently start
    // racing each other inside a single run.
    const r = getRedisConnection();
    await r.set(launchFlowSinceKey(OTHER), String(T0));
    await r.set(launchFlowSinceKey("latency"), String(T0 + 1));
    await resetSeamState(OTHER);
    assert.equal(await getLaunchFlowSince(OTHER), null);
    assert.equal(await getLaunchFlowSince("latency"), T0 + 1, "resetting one signal must not touch another");
    await resetSeamState("latency");
  });
});

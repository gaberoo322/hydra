/**
 * Regression test for issue #3848 (gamma, epic #3844) — the DELIVERY half of
 * the watchdog's ## LAUNCH FLOW block in scripts/hydra-watchdog.sh, plus the
 * TypeScript grammar it publishes onto.
 *
 * #3847 (beta) made the block DETECT five sustained signals and log a WARNING
 * at the fired-marker absent→present transition. Detection without a delivery
 * surface is indistinguishable from no detection — map #3807 measured the
 * wiring-liveness dark alarm had NEVER fired and the stagnation alert had no
 * consumer at all. This file pins the gamma contract, mirroring the
 * gate-approved design-concept artifact for issue-3848:
 *
 *   Surface routing (derived from whether the Orchestrator is provably up in
 *   that signal's failure mode — DEFECTIVE AND FULLY BLOCKING ⇒ out-of-band):
 *     fail-safe, meter-dark → OUT-OF-BAND: direct bash curl POST to the
 *         Telegram Bot API; depends on NO Orchestrator HTTP endpoint.
 *     quota, latency        → IN-BAND: enveloped XADD onto the notifications
 *         stream (the on-wire shape EventBus.publish constructs); surfaces as
 *         a dashboard alert (ALERT_TYPES) PLUS a digest line
 *         (CRITICAL_EVENT_TYPES immediate bypass).
 *     pause                 → IN-BAND, DIGEST LINE ONLY: same XADD, but its
 *         type is NEVER in ALERT_TYPES — a deliberate overnight pause must
 *         not leave a lingering unread dashboard alert.
 *
 *   Delivery fires at the EXACT fired absent→present transition inside
 *   track_signal — reusing the #3847 fired/since keys as the sole dedup state
 *   (zero new Redis keys). Un-suppression is recurrence-after-recovery, never
 *   acknowledgement.
 *
 *   An absent TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID logs a distinguishable
 *   WARN naming the missing var and never fails the run. No delivery path can
 *   throw out of the block or change its exit code.
 *
 * Behavioural cases are gated on the docker `hydra-redis-1` container (the
 * same contract as test/watchdog-launch-flow.test.mts). Two isolation
 * mechanisms, both inherited from that file's #4072 lesson:
 *   - the extracted block COPY is rebound onto a per-run key namespace, so a
 *     live production watchdog tick can rewrite neither our fixtures nor
 *     itself be disturbed;
 *   - in-band delivery is pointed at a per-run NOTIFY STREAM via the block's
 *     own HYDRA_WATCHDOG_LAUNCH_NOTIFY_STREAM hook, so a behavioural case can
 *     NEVER write a real event onto the PRODUCTION hydra:notifications stream
 *     (the live consumer would push a real dashboard alert + Telegram line).
 * The Telegram curl is intercepted with a PATH-shim `curl` stub that records
 * its arguments — no network, no token.
 */

import test, { describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

import { STREAMS } from "../src/event-bus-stream-keys.ts";
import { NOTIFICATION_EVENT_TYPES as E } from "../src/event-bus-vocabulary.ts";
import {
  ALERT_TYPES,
  formatAlertMessage,
} from "../src/notification/alert-grammar.ts";
import { CRITICAL_EVENT_TYPES } from "../src/digest.ts";
import {
  PACE_GATE_LAST_TICK_KEY,
  LAUNCH_FLOW_KEY_PREFIX,
} from "../src/redis/launch-flow.ts";
import {
  GLM_DRAINER_ACTIVE_KEY,
  GLM_DRAINER_HEARTBEAT_STALE_MS,
} from "../src/redis/autopilot.ts";
import {
  WATCHDOG_SPAWN_TIMEOUT_MS,
  WATCHDOG_REDIS_TIMEOUT_MS,
  throwIfTimedOut,
} from "./_helpers/watchdog-timeouts.mts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const WATCHDOG = join(REPO_ROOT, "scripts", "hydra-watchdog.sh");

const SIGNALS = ["fail-safe", "meter-dark", "quota", "pause", "latency", "glm-sterile"] as const;

// Per-run key namespace (see file header + test/watchdog-launch-flow.test.mts
// #4072 for why nothing here may touch the shared production keys).
const RUN_NS = `hydra:test:launch-flow-delivery-${process.pid}-${randomUUID().slice(0, 8)}`;
const TEST_LF_PREFIX = `${RUN_NS}:launch-flow`;
const TEST_LAST_TICK_KEY = `${RUN_NS}:pace-gate:last-tick`;
const TEST_NOTIFY_STREAM = `${RUN_NS}:notifications`;

const SINCE = (s: string) => `${TEST_LF_PREFIX}:since:${s}`;
const FIRED = (s: string) => `${TEST_LF_PREFIX}:fired:${s}`;

// Issue #3868: the GLM drainer heartbeat key, rebound onto this run's
// namespace by the extraction below so behavioural cases can seed a
// fresh/stale heartbeat without ever touching the PRODUCTION
// hydra:glm:drainer:active key (which gates the live Opus lane partition).
const TEST_GLM_HB_KEY = `${RUN_NS}:glm-drainer-active`;

/** Fixed deterministic clock for threshold maths (epoch-ms). */
const T0 = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// Redis helpers (docker exec → DB 0, the watchdog's default target).
// Every call below is bare `redis-cli` with no `-n` selector, so they all
// target db 0. The two spawn sites that source run_launch_flow therefore
// pin HYDRA_REDIS_DB="0" to keep the block's reads on the same DB (#4183).
// ---------------------------------------------------------------------------

function dockerRedisAvailable(): boolean {
  const r = spawnSync("docker", ["exec", "hydra-redis-1", "redis-cli", "PING"], {
    encoding: "utf-8",
    timeout: WATCHDOG_REDIS_TIMEOUT_MS,
  });
  return (r.stdout ?? "").trim() === "PONG";
}

const DOCKER = dockerRedisAvailable();

function drc(args: string[]): string {
  const r = spawnSync("docker", ["exec", "hydra-redis-1", "redis-cli", "--raw", ...args], {
    encoding: "utf-8",
    timeout: WATCHDOG_REDIS_TIMEOUT_MS,
  });
  return (r.stdout ?? "").trim();
}

function cleanState(): void {
  const keys = [TEST_LAST_TICK_KEY, TEST_GLM_HB_KEY];
  for (const s of SIGNALS) keys.push(SINCE(s), FIRED(s));
  spawnSync("docker", ["exec", "hydra-redis-1", "redis-cli", "--raw", "DEL", ...keys], {
    encoding: "utf-8",
    timeout: WATCHDOG_REDIS_TIMEOUT_MS,
  });
  drc(["DEL", TEST_NOTIFY_STREAM]);
}

function hsetLastTick(fields: Record<string, string>): void {
  const args = ["HSET", TEST_LAST_TICK_KEY];
  for (const [k, v] of Object.entries(fields)) args.push(k, v);
  spawnSync("docker", ["exec", "hydra-redis-1", "redis-cli", "--raw", ...args], {
    encoding: "utf-8",
    timeout: WATCHDOG_REDIS_TIMEOUT_MS,
  });
}

function seedSince(signal: string, ms: number): void {
  spawnSync(
    "docker",
    ["exec", "hydra-redis-1", "redis-cli", "--raw", "SET", SINCE(signal), String(ms), "NX"],
    { encoding: "utf-8", timeout: WATCHDOG_REDIS_TIMEOUT_MS },
  );
}

function getFired(signal: string): boolean {
  return drc(["EXISTS", FIRED(signal)]) === "1";
}

/** One XADD'd in-band entry off the namespaced notify stream, fields folded.
 *
 * XRANGE --raw emits one flat line per token: entry-id, then the six
 * field/value pairs in the order the watchdog XADDs them (id, type, source,
 * timestamp, correlationId, payload — the EventBus.publish envelope). The
 * payload is single-line JSON by construction (printf, no embedded newlines),
 * so a strict positional walk is exact.
 */
function notifyEntriesSimple(): { fields: Record<string, string> }[] {
  const out = drc(["XRANGE", TEST_NOTIFY_STREAM, "-", "+"]);
  if (out === "") return [];
  const lines = out.split("\n");
  const FIELD_NAMES = ["id", "type", "source", "timestamp", "correlationId", "payload"];
  const entries: { fields: Record<string, string> }[] = [];
  let i = 0;
  while (i < lines.length) {
    // Skip the entry-id line, then read the six field/value pairs.
    i += 1;
    const fields: Record<string, string> = {};
    for (const name of FIELD_NAMES) {
      assert.equal(lines[i], name, `expected envelope field '${name}' at line ${i}: ${JSON.stringify(lines)}`);
      fields[name] = lines[i + 1];
      i += 2;
    }
    entries.push({ fields });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Extract run_launch_flow() into a temp file (mirrors
// test/watchdog-launch-flow.test.mts), rebound onto this run's namespace.
// ---------------------------------------------------------------------------

const BLOCK = join(tmpdir(), `hydra-launch-flow-delivery-block-${process.pid}.sh`);

before(() => {
  const src = readFileSync(WATCHDOG, "utf-8");
  const start = src.indexOf("run_launch_flow()");
  assert.ok(start >= 0, "run_launch_flow() not found in hydra-watchdog.sh");
  const after = src.slice(start);
  const end = after.search(/^}/m);
  assert.ok(end >= 0, "run_launch_flow() closing brace not found");
  const body = after.slice(0, end + 1);
  assert.ok(body.includes("track_signal"), "extracted block missing track_signal");
  assert.ok(body.includes("deliver_signal"), "extracted block missing deliver_signal (issue #3848 delivery hook)");

  const namespaced = body
    .split(`"${PACE_GATE_LAST_TICK_KEY}"`)
    .join(`"${TEST_LAST_TICK_KEY}"`)
    .split(`"${LAUNCH_FLOW_KEY_PREFIX}"`)
    .join(`"${TEST_LF_PREFIX}"`)
    // Issue #3868: rebind the GLM drainer heartbeat literal too, so the
    // glm-sterile behavioural cases seed THIS run's key, never the production
    // hydra:glm:drainer:active. Splitting on the TS-owned constant doubles as
    // a drift-guard: if the bash literal ever diverges from
    // src/redis/autopilot.ts's GLM_DRAINER_ACTIVE_KEY the assertion below
    // fails loudly instead of silently leaving the production key in place.
    .split(`"${GLM_DRAINER_ACTIVE_KEY}"`)
    .join(`"${TEST_GLM_HB_KEY}"`);
  assert.ok(
    namespaced.includes(`"${TEST_LAST_TICK_KEY}"`),
    "failed to rebind LAST_TICK_KEY onto the test namespace",
  );
  assert.ok(
    namespaced.includes(`"${TEST_LF_PREFIX}"`),
    "failed to rebind LF_KEY_PREFIX onto the test namespace",
  );
  assert.ok(
    namespaced.includes(`"${TEST_GLM_HB_KEY}"`),
    `failed to rebind the GLM drainer heartbeat key: the bash block no longer contains the literal "${GLM_DRAINER_ACTIVE_KEY}" (issue #3868) — either the watchdog literal drifted from src/redis/autopilot.ts's GLM_DRAINER_ACTIVE_KEY or the membership block was removed`,
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

// ---------------------------------------------------------------------------
// curl PATH-shim — records its argv, never touches the network.
// ---------------------------------------------------------------------------

const SHIM_DIR = join(tmpdir(), `hydra-launch-flow-curl-shim-${process.pid}`);
const CURL_LOG = join(SHIM_DIR, "curl-calls.log");
const CURL_SHIM = join(SHIM_DIR, "curl");

function writeCurlShim(exitCode: number): void {
  mkdirSync(SHIM_DIR, { recursive: true });
  // One invocation = one log line: the watchdog's --data-urlencode text= value
  // is a MULTI-LINE message, so a naive `printf '%s\n' "$*"` would write ~5
  // lines per single curl call and every call-count assertion would overcount.
  writeFileSync(CURL_SHIM, [
    "#!/usr/bin/env bash",
    `printf '%s' "$*" | tr '\\n' '~' >> '${CURL_LOG}'`,
    `printf '\\n' >> '${CURL_LOG}'`,
    `exit ${exitCode}`,
    "",
  ].join("\n"));
  spawnSync("chmod", ["+x", CURL_SHIM]);
}

function curlCalls(): string[] {
  try {
    return readFileSync(CURL_LOG, "utf-8").split("\n").filter((l) => l !== "");
  } catch {
    return [];
  }
}

/** Source run_launch_flow under prod flags and call it once.
 *
 * NB: unlike test/watchdog-launch-flow.test.mts, PATH is NOT force-restored
 * after the env spread — every caller's env must be able to prepend the curl
 * shim dir to PATH (the out-of-band interception depends on it).
 */
function runBlock(env: Record<string, string>): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("bash", ["-c", `set -euo pipefail; source '${BLOCK}'; run_launch_flow`], {
    // HYDRA_REDIS_DB is pinned to "0" (issue #4183), matching the identical
    // pin in test/watchdog-launch-flow.test.mts. This suite's seed/read
    // helpers (drc, cleanState, hsetLastTick, seedSince) shell bare
    // `redis-cli` with no `-n` selector — that IS db 0, the watchdog's
    // default target. scripts/test/redis-db-launch.mjs now exports
    // HYDRA_REDIS_DB into this whole node:test process's env, so an unpinned
    // `...process.env` would redirect rc_write/rc_read to the launcher's
    // derived per-run DB while every seed and assertion here kept using
    // db 0 — rc_read would find nothing and every case would degrade to the
    // "no pace-gate last-tick record" branch. DB selection itself is covered
    // by the dedicated #4183 describe in test/watchdog-launch-flow.test.mts.
    // A caller may still override via its own `env` (last-spread wins).
    env: { ...process.env, HYDRA_REDIS_HOST: "docker", HYDRA_REDIS_DB: "0", ...env },
    encoding: "utf-8",
    timeout: WATCHDOG_SPAWN_TIMEOUT_MS,
  });
  throwIfTimedOut(r, WATCHDOG_SPAWN_TIMEOUT_MS, "run_launch_flow delivery block");
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function lfLines(stdout: string): string {
  return stdout
    .split("\n")
    .filter((l) => l.includes("hydra-launch-flow-watchdog:"))
    .join("\n");
}

// =============================================================================
// Structural / drift-guard cases — run unconditionally (no Redis needed).
// =============================================================================

describe("issue #3848 — TypeScript delivery grammar", () => {
  test("three launch-flow event types exist in the vocabulary", () => {
    assert.equal(E.LAUNCH_QUOTA_STRETCH, "launch:quota_stretch");
    assert.equal(E.LAUNCH_LATENCY_BREACH, "launch:latency_breach");
    assert.equal(E.LAUNCH_PAUSE_FORGOTTEN, "launch:pause_forgotten");
  });

  test("quota and latency are in ALERT_TYPES; pause is NOT (digest line only)", () => {
    assert.ok(ALERT_TYPES.has(E.LAUNCH_QUOTA_STRETCH), "quota stretch must raise a dashboard alert");
    assert.ok(ALERT_TYPES.has(E.LAUNCH_LATENCY_BREACH), "latency breach must raise a dashboard alert");
    assert.ok(
      !ALERT_TYPES.has(E.LAUNCH_PAUSE_FORGOTTEN),
      "a forgotten pause must NEVER raise a dashboard alert (alarm-fatigue guard)",
    );
  });

  test("all three are in CRITICAL_EVENT_TYPES (immediate digest-surfaced line)", () => {
    for (const t of [E.LAUNCH_QUOTA_STRETCH, E.LAUNCH_LATENCY_BREACH, E.LAUNCH_PAUSE_FORGOTTEN]) {
      assert.ok(CRITICAL_EVENT_TYPES.includes(t), `${t} must bypass the batched digest`);
    }
  });

  test("formatAlertMessage renders the two alert-worthy signals", () => {
    const quota = formatAlertMessage({
      type: E.LAUNCH_QUOTA_STRETCH,
      payload: { signal: "quota", reason: "session-blocked", durationMs: 6 * 3_600_000, thresholdMs: 4 * 3_600_000 },
    });
    assert.match(quota, /Launch quota stretch/);
    assert.match(quota, /session-blocked/);
    assert.match(quota, /6h/);
    assert.match(quota, /4h/);

    const latency = formatAlertMessage({
      type: E.LAUNCH_LATENCY_BREACH,
      payload: { signal: "latency", reason: "eligible-launch", durationMs: 90 * 60_000, thresholdMs: 60 * 60_000 },
    });
    assert.match(latency, /Launch latency breach/);
    assert.match(latency, /1\.5h/);
  });
});

describe("scripts/hydra-watchdog.sh — delivery structure (issue #3848)", () => {
  function blockSource(): string {
    const src = readFileSync(WATCHDOG, "utf-8");
    return src.slice(src.indexOf("run_launch_flow()"), src.indexOf("# Entry point"));
  }

  /** Code-only view: comment lines stripped, so "never references X" checks
   * match CODE, not the explanatory comments around it (which legitimately
   * mention the other path's signal names when explaining the routing). */
  function codeOnly(s: string): string {
    return s
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
  }

  test("bash script parses under set -euo pipefail", () => {
    const syntax = spawnSync("bash", ["-n", WATCHDOG], { encoding: "utf-8" });
    assert.equal(syntax.status, 0, `watchdog bash -n failed: ${syntax.stderr}`);
  });

  test("in-band event-type literals drift-guard the TS vocabulary", () => {
    const block = blockSource();
    for (const [sig, member] of [
      ["quota", E.LAUNCH_QUOTA_STRETCH],
      ["latency", E.LAUNCH_LATENCY_BREACH],
      ["pause", E.LAUNCH_PAUSE_FORGOTTEN],
    ] as const) {
      assert.ok(
        block.includes(member),
        `bash deliver_in_band must publish '${member}' for signal '${sig}'`,
      );
    }
  });

  test("NOTIFY_STREAM default drift-guards STREAMS.NOTIFICATIONS", () => {
    const block = blockSource();
    assert.ok(
      block.includes(`:-${STREAMS.NOTIFICATIONS}}`),
      `the in-band delivery default must be the TS-owned stream key '${STREAMS.NOTIFICATIONS}'`,
    );
  });

  test("delivery fires ONLY at the fired absent→present transition inside track_signal", () => {
    const block = blockSource();
    assert.equal(
      (block.match(/deliver_signal "\$sig"/g) ?? []).length,
      1,
      "exactly one deliver_signal call site (inside track_signal's fire branch)",
    );
    const callIdx = block.indexOf('deliver_signal "$sig"');
    const firedIdx = block.indexOf('rc_write SET "$fired_key" 1');
    assert.ok(
      firedIdx >= 0 && callIdx > firedIdx,
      "the fired marker must be set BEFORE delivering (dedup holds even if delivery fails)",
    );
    // Zero NEW Redis keys: delivery introduces no key writes beyond since/fired.
    assert.ok(!/rc_write (SET|HSET|LPUSH|RPUSH|SADD|ZADD) .*(delivered|acked|notified)/.test(block),
      "no new delivered/acked marker keys (the #3847 fired/since pair is the sole dedup state)");
  });

  test("surface routing: fail-safe/meter-dark go out-of-band, the rest in-band", () => {
    const block = blockSource();
    assert.match(block, /fail-safe\|meter-dark\)/, "deliver_signal must route fail-safe|meter-dark out-of-band");
    const inBand = codeOnly(block.slice(
      block.indexOf("deliver_in_band() {"),
      block.indexOf("deliver_signal() {"),
    ));
    for (const sig of ["quota", "latency", "pause"]) {
      assert.ok(inBand.includes(sig), `deliver_in_band must handle '${sig}'`);
    }
    assert.ok(!inBand.includes("fail-safe"), "out-of-band signals must NOT take the in-band path");
  });

  test("out-of-band path is a direct Telegram curl and never XADDs", () => {
    const block = blockSource();
    const oob = codeOnly(block.slice(
      block.indexOf("deliver_out_of_band() {"),
      block.indexOf("deliver_in_band() {"),
    ));
    assert.match(oob, /api\.telegram\.org\/bot\$\{TELEGRAM_BOT_TOKEN\}\/sendMessage/, "direct Bot API POST");
    assert.match(oob, /--data-urlencode "chat_id=\$\{TELEGRAM_CHAT_ID\}"/, "chat_id from TELEGRAM_CHAT_ID");
    assert.equal((oob.match(/XADD/g) ?? []).length, 0, "out-of-band must not write the notifications stream");
    assert.ok(!oob.includes("localhost"), "out-of-band must not depend on any Orchestrator HTTP endpoint");
  });

  test("in-band path is an enveloped XADD and never curls", () => {
    const block = blockSource();
    const inb = codeOnly(block.slice(
      block.indexOf("deliver_in_band() {"),
      block.indexOf("deliver_signal() {"),
    ));
    assert.match(inb, /rc_write XADD "\$NOTIFY_STREAM" '\*'/, "enveloped XADD onto the notify stream");
    for (const field of ["id", "type", "source", "timestamp", "correlationId", "payload"]) {
      assert.ok(new RegExp(`\\b${field}\\b `).test(inb), `envelope must carry the '${field}' field`);
    }
    assert.equal((inb.match(/curl\s/g) ?? []).length, 0, "in-band must not curl");
  });

  test("missing-credential handling names both env vars distinguishably", () => {
    const block = blockSource();
    const oob = block.slice(
      block.indexOf("deliver_out_of_band()"),
      block.indexOf("deliver_in_band()"),
    );
    for (const varName of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]) {
      assert.ok(oob.includes(varName), `the absent-credential WARN must name ${varName}`);
    }
    assert.match(oob, /WARN launch-flow out-of-band delivery for '\$sig' SKIPPED/, "distinguishable WARN prefix");
  });
});

// =============================================================================
// Behavioural cases — gated on the docker redis container (CI runners + dev).
// =============================================================================

describe("scripts/hydra-watchdog.sh — delivery behaviour (issue #3848)", { skip: !DOCKER }, () => {
  beforeEach(() => {
    cleanState();
    try {
      unlinkSync(CURL_LOG);
    } catch {
      /* absent log is fine */
    }
    writeCurlShim(0);
  });

  after(() => {
    try {
      rmSync(SHIM_DIR, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  /** Standard env: creds present, PATH-shimmed curl, namespaced notify stream. */
  const CREDS = {
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_CHAT_ID: "test-chat",
  };

  function envWith(over: Record<string, string>): Record<string, string> {
    return {
      ...CREDS,
      HYDRA_WATCHDOG_LAUNCH_NOTIFY_STREAM: TEST_NOTIFY_STREAM,
      PATH: `${SHIM_DIR}:${process.env.PATH ?? ""}`,
      ...over,
    };
  }

  test("fail-safe delivers out-of-band via a direct Telegram curl at the fire tick", () => {
    hsetLastTick({ reason: "eligibility-unreachable", class: "fail-safe", at: String(T0), latency_ms: "" });
    seedSince("fail-safe", T0);
    const r = runBlock(envWith({
      HYDRA_WATCHDOG_LAUNCH_FAILSAFE_SECONDS: "2",
      HYDRA_WATCHDOG_LAUNCH_NOW_MS: String(T0 + 5_000),
    }));
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
    const calls = curlCalls();
    assert.equal(calls.length, 1, `exactly one curl invocation, got ${calls.length}`);
    assert.match(calls[0], /api\.telegram\.org\/bottest-token\/sendMessage/, "direct Bot API endpoint with the token");
    assert.match(calls[0], /chat_id=test-chat/, "chat_id from TELEGRAM_CHAT_ID");
    assert.match(calls[0], /signal: fail-safe/, "message names the signal");
    assert.match(calls[0], /sustained: 5000ms >= 2000ms/, "message carries the streak maths");
    // Out-of-band signals must NOT appear on the notify stream.
    assert.equal(notifyEntriesSimple().length, 0, "fail-safe must not write the notifications stream");
    // Second tick: no re-delivery within the same streak.
    const r2 = runBlock(envWith({
      HYDRA_WATCHDOG_LAUNCH_FAILSAFE_SECONDS: "2",
      HYDRA_WATCHDOG_LAUNCH_NOW_MS: String(T0 + 6_000),
    }));
    assert.equal(r2.status, 0);
    assert.equal(curlCalls().length, 1, "fired marker suppresses re-alarm for the streak's duration");
  });

  test("meter-dark also delivers out-of-band (infrastructure-is-broken character)", () => {
    hsetLastTick({ reason: "meter-unavailable", class: "fail-safe", at: String(T0), latency_ms: "90" });
    seedSince("meter-dark", T0);
    const r = runBlock(envWith({
      HYDRA_WATCHDOG_LAUNCH_METER_DARK_SECONDS: "2",
      HYDRA_WATCHDOG_LAUNCH_NOW_MS: String(T0 + 5_000),
    }));
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    const calls = curlCalls();
    assert.equal(calls.length, 1);
    assert.match(calls[0], /signal: meter-dark/);
    assert.equal(notifyEntriesSimple().length, 0);
  });

  test("missing TELEGRAM_BOT_TOKEN: distinguishable WARN naming it, run still succeeds", () => {
    hsetLastTick({ reason: "curl-missing", class: "fail-safe", at: String(T0), latency_ms: "" });
    seedSince("fail-safe", T0);
    const r = runBlock(envWith({
      TELEGRAM_BOT_TOKEN: "",
      HYDRA_WATCHDOG_LAUNCH_FAILSAFE_SECONDS: "2",
      HYDRA_WATCHDOG_LAUNCH_NOW_MS: String(T0 + 5_000),
    }));
    assert.equal(r.status, 0, `the run must not fail on an unconfigured credential; stderr=${r.stderr}`);
    assert.match(
      lfLines(r.stdout),
      /WARN launch-flow out-of-band delivery for 'fail-safe' SKIPPED — missing Telegram config: TELEGRAM_BOT_TOKEN/,
      "the WARN must name the missing var",
    );
    assert.equal(curlCalls().length, 0, "no curl attempted without the token");
    assert.equal(getFired("fail-safe"), true, "detection still fires — unconfigured ≠ undetected");
  });

  test("missing TELEGRAM_CHAT_ID only: WARN names exactly TELEGRAM_CHAT_ID", () => {
    hsetLastTick({ reason: "eligibility-unreachable", class: "fail-safe", at: String(T0), latency_ms: "" });
    seedSince("fail-safe", T0);
    const r = runBlock(envWith({
      TELEGRAM_CHAT_ID: "",
      HYDRA_WATCHDOG_LAUNCH_FAILSAFE_SECONDS: "2",
      HYDRA_WATCHDOG_LAUNCH_NOW_MS: String(T0 + 5_000),
    }));
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    const warn = lfLines(r.stdout);
    assert.match(warn, /missing Telegram config: TELEGRAM_CHAT_ID/);
    assert.doesNotMatch(warn, /TELEGRAM_BOT_TOKEN/, "a present credential must not be named as missing");
    assert.equal(curlCalls().length, 0);
  });

  test("both credentials missing: WARN names both", () => {
    hsetLastTick({ reason: "eligibility-unreachable", class: "fail-safe", at: String(T0), latency_ms: "" });
    seedSince("fail-safe", T0);
    const r = runBlock(envWith({
      TELEGRAM_BOT_TOKEN: "",
      TELEGRAM_CHAT_ID: "",
      HYDRA_WATCHDOG_LAUNCH_FAILSAFE_SECONDS: "2",
      HYDRA_WATCHDOG_LAUNCH_NOW_MS: String(T0 + 5_000),
    }));
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.match(lfLines(r.stdout), /missing Telegram config: TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID/);
  });

  test("a failing Telegram send never fails the block; the fired marker still holds", () => {
    writeCurlShim(1);
    hsetLastTick({ reason: "eligibility-unreachable", class: "fail-safe", at: String(T0), latency_ms: "" });
    seedSince("fail-safe", T0);
    const r = runBlock(envWith({
      HYDRA_WATCHDOG_LAUNCH_FAILSAFE_SECONDS: "2",
      HYDRA_WATCHDOG_LAUNCH_NOW_MS: String(T0 + 5_000),
    }));
    assert.equal(r.status, 0, `a curl non-zero must not change the block's exit code; stderr=${r.stderr}`);
    assert.match(lfLines(r.stdout), /WARN launch-flow out-of-band Telegram send FAILED for 'fail-safe'/,
      "a failed send is distinguishable from a skipped one");
    assert.equal(getFired("fail-safe"), true, "dedup state survives a failed delivery");
  });

  test("quota delivers in-band: one enveloped entry with the TS-owned type", () => {
    hsetLastTick({ reason: "session-blocked", class: "deliberate-skip", at: String(T0), latency_ms: "100" });
    seedSince("quota", T0);
    const r = runBlock(envWith({
      HYDRA_WATCHDOG_LAUNCH_QUOTA_SECONDS: "2",
      HYDRA_WATCHDOG_LAUNCH_NOW_MS: String(T0 + 5_000),
    }));
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.equal(curlCalls().length, 0, "in-band signals must not take the Telegram curl path");
    const entries = notifyEntriesSimple();
    assert.equal(entries.length, 1, "exactly one XADD per streak");
    const f = entries[0].fields;
    assert.equal(f.type, E.LAUNCH_QUOTA_STRETCH);
    assert.equal(f.source, "watchdog-launch-flow");
    assert.ok(f.id.startsWith("launch-flow-"), `id field must be an envelope id, got '${f.id}'`);
    assert.match(f.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, "ISO timestamp");
    assert.equal(f.correlationId, "launch-flow-quota");
    const payload = JSON.parse(f.payload);
    assert.equal(payload.signal, "quota");
    assert.equal(payload.reason, "session-blocked");
    assert.equal(payload.durationMs, 5000);
    assert.equal(payload.thresholdMs, 2000);
  });

  test("latency delivers in-band with launch:latency_breach", () => {
    hsetLastTick({ reason: "allow-false", class: "deliberate-skip", at: String(T0), latency_ms: "2500" });
    seedSince("latency", T0);
    const r = runBlock(envWith({
      HYDRA_WATCHDOG_LAUNCH_LATENCY_BUDGET_MS: "1000",
      HYDRA_WATCHDOG_LAUNCH_LATENCY_BREACH_SECONDS: "2",
      HYDRA_WATCHDOG_LAUNCH_NOW_MS: String(T0 + 5_000),
    }));
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    const entries = notifyEntriesSimple();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].fields.type, E.LAUNCH_LATENCY_BREACH);
    // In-band needs no Telegram credential: this run still had CREDS set, so
    // the meaningful no-credential case is asserted for pause below.
  });

  test("pause delivers in-band with launch:pause_forgotten and needs NO Telegram credential", () => {
    hsetLastTick({ reason: "paused", class: "deliberate-skip", at: String(T0), latency_ms: "100" });
    seedSince("pause", T0);
    const r = runBlock(envWith({
      TELEGRAM_BOT_TOKEN: "",
      TELEGRAM_CHAT_ID: "",
      HYDRA_WATCHDOG_LAUNCH_PAUSE_SECONDS: "2",
      HYDRA_WATCHDOG_LAUNCH_NOW_MS: String(T0 + 5_000),
    }));
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    const entries = notifyEntriesSimple();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].fields.type, E.LAUNCH_PAUSE_FORGOTTEN);
    assert.equal(curlCalls().length, 0, "pause never pushes (digest line only)");
  });

  test("un-suppression is recurrence: recovery clears fired, a fresh streak re-delivers", () => {
    // Streak 1: fire + deliver.
    hsetLastTick({ reason: "paused", class: "deliberate-skip", at: String(T0), latency_ms: "100" });
    seedSince("pause", T0);
    runBlock(envWith({
      HYDRA_WATCHDOG_LAUNCH_PAUSE_SECONDS: "2",
      HYDRA_WATCHDOG_LAUNCH_NOW_MS: String(T0 + 5_000),
    }));
    assert.equal(getFired("pause"), true, "precondition: first streak fired");
    assert.equal(notifyEntriesSimple().length, 1);

    // Recovery: a healthy tick DELs since+fired (stateless, never ack-gated).
    hsetLastTick({ reason: "eligible-launch", class: "launch", at: String(T0 + 6_000), latency_ms: "120" });
    runBlock(envWith({
      HYDRA_WATCHDOG_LAUNCH_NOW_MS: String(T0 + 6_000),
    }));
    assert.equal(getFired("pause"), false, "recovery clears the fired marker");

    // Streak 2: re-cross the threshold → delivers AGAIN.
    hsetLastTick({ reason: "paused", class: "deliberate-skip", at: String(T0 + 7_000), latency_ms: "100" });
    seedSince("pause", T0 + 7_000);
    const r = runBlock(envWith({
      HYDRA_WATCHDOG_LAUNCH_PAUSE_SECONDS: "2",
      HYDRA_WATCHDOG_LAUNCH_NOW_MS: String(T0 + 20_000),
    }));
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.equal(getFired("pause"), true, "second streak re-fires");
    const entries = notifyEntriesSimple();
    assert.equal(entries.length, 2, "recurrence after recovery delivers again");
    assert.equal(entries[1].fields.type, E.LAUNCH_PAUSE_FORGOTTEN);
  });

  test("no delivery before threshold or after a read failure", () => {
    // Under threshold: streak active, no crossing → nothing delivered.
    hsetLastTick({ reason: "session-blocked", class: "deliberate-skip", at: String(T0), latency_ms: "100" });
    seedSince("quota", T0);
    runBlock(envWith({
      HYDRA_WATCHDOG_LAUNCH_QUOTA_SECONDS: "60",
      HYDRA_WATCHDOG_LAUNCH_NOW_MS: String(T0 + 5_000),
    }));
    assert.equal(notifyEntriesSimple().length, 0, "under threshold → no delivery");
    assert.equal(curlCalls().length, 0);

    // Read failure (unreachable redis): no mutation, no delivery, exit 0.
    const r = spawnSync(
      "bash",
      ["-c", `set -euo pipefail; source '${BLOCK}'; run_launch_flow`],
      {
        env: {
          ...process.env,
          HYDRA_REDIS_HOST: "127.0.0.1",
          HYDRA_REDIS_PORT: "1", // nothing listening
          // Pinned for the same reason as runBlock() above (#4183). The host
          // is unreachable so the DB is never selected, but leaving it
          // unpinned would leave the ambient per-run value here as a latent
          // trap the moment this case ever points at a live Redis.
          HYDRA_REDIS_DB: "0",
          HYDRA_WATCHDOG_LAUNCH_NOW_MS: String(T0 + 5_000),
          PATH: `${SHIM_DIR}:${process.env.PATH ?? ""}`,
          ...CREDS,
        },
        encoding: "utf-8",
        timeout: WATCHDOG_SPAWN_TIMEOUT_MS,
      },
    );
    throwIfTimedOut(r, WATCHDOG_SPAWN_TIMEOUT_MS, "run_launch_flow delivery block (unreachable-redis case)");
    assert.equal(r.status ?? -1, 0, `read failure must not abort (set -e); stderr=${r.stderr}`);
    assert.equal(curlCalls().length, 0, "no out-of-band delivery on a read failure");
  });
});

// =============================================================================
// Issue #3868 — glm-sterile: the live-but-sterile GLM drainer signal.
//
// Detection contract (operator-rewritten spec, 2026-08-19): membership is the
// AND of (1) fresh hydra:glm:drainer:active heartbeat, (2) at least one open
// glm-eligible + ready-for-agent issue net of glm-withhold (work to drain —
// distinguishes STERILE from IDLE), (3) zero drainer PRs — the shared #4048
// OR-predicate (glm-authored label OR worktree-agent-glm-* head branch) —
// created in the trailing window (default 6h). Delivery rides the existing
// deliver_signal/track_signal layer IN-BAND (no new Redis keys, no second
// alarm path); a failed gh query leaves the streak state UNTOUCHED.
// =============================================================================

describe("issue #3868 — glm-sterile structural / drift guards", () => {
  function blockSource(): string {
    const src = readFileSync(WATCHDOG, "utf-8");
    return src.slice(src.indexOf("run_launch_flow()"), src.indexOf("# Entry point"));
  }
  /** Comment lines stripped, so "never references X" checks match CODE. */
  function codeOnly(s: string): string {
    return s
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
  }

  test("TS grammar: glm:drainer_sterile is an alert type AND an immediate digest line", () => {
    assert.equal(E.GLM_DRAINER_STERILE, "glm:drainer_sterile");
    assert.ok(ALERT_TYPES.has(E.GLM_DRAINER_STERILE), "a sterile drainer must raise a dashboard alert");
    assert.ok(
      CRITICAL_EVENT_TYPES.includes(E.GLM_DRAINER_STERILE),
      "a sterile drainer must bypass the batched digest (board starvation is per-hour damage)",
    );
    const msg = formatAlertMessage({
      type: E.GLM_DRAINER_STERILE,
      payload: { signal: "glm-sterile", reason: "eligible-launch", durationMs: 2 * 3_600_000, thresholdMs: 3_600_000 },
    });
    assert.match(msg, /GLM drainer sterile/);
    assert.match(msg, /2h/);
    assert.match(msg, /1h/);
  });

  test("bash publishes the TS-owned type and routes glm-sterile in-band", () => {
    const block = blockSource();
    assert.ok(
      block.includes(E.GLM_DRAINER_STERILE),
      "deliver_in_band must publish the TS-owned 'glm:drainer_sterile' literal",
    );
    const inBand = codeOnly(block.slice(
      block.indexOf("deliver_in_band() {"),
      block.indexOf("deliver_signal() {"),
    ));
    assert.ok(inBand.includes("glm-sterile"), "deliver_in_band must handle 'glm-sterile'");
    const oob = codeOnly(block.slice(
      block.indexOf("deliver_out_of_band() {"),
      block.indexOf("deliver_in_band() {"),
    ));
    assert.ok(!oob.includes("glm-sterile"), "glm-sterile must NOT take the out-of-band Telegram path");
  });

  test("drainer-PR predicate is byte-identical to glm-beachhead-report.sh's (shared #4048 predicate)", () => {
    const beach = readFileSync(join(REPO_ROOT, "scripts", "glm-beachhead-report.sh"), "utf-8");
    const wd = readFileSync(WATCHDOG, "utf-8");
    const re = /GLM_PR_MATCH_JQ='([^']+)'/;
    const beachLit = beach.match(re);
    const wdLit = wd.match(re);
    assert.ok(beachLit, "glm-beachhead-report.sh no longer defines GLM_PR_MATCH_JQ");
    assert.ok(wdLit, "hydra-watchdog.sh must define GLM_PR_MATCH_JQ (the shared drainer-PR predicate)");
    assert.equal(
      wdLit![1],
      beachLit![1],
      "the watchdog's drainer-PR predicate drifted from glm-beachhead-report.sh — the alarm and the beachhead report would disagree about what a drainer PR is (issue #4048)",
    );
    // The --arg bindings must supply the beachhead's own label/prefix values.
    const label = beach.match(/GLM_LABEL_AUTHORED="([^"]+)"/)![1];
    const prefix = beach.match(/GLM_DRAINER_BRANCH_PREFIX="([^"]+)"/)![1];
    assert.ok(wd.includes(`--arg label "${label}"`), `watchdog must bind --arg label "${label}"`);
    assert.ok(wd.includes(`--arg prefix "${prefix}"`), `watchdog must bind --arg prefix "${prefix}"`);
  });

  test("heartbeat freshness window mirrors src/redis/autopilot.ts's GLM_DRAINER_HEARTBEAT_STALE_MS", () => {
    assert.ok(
      blockSource().includes(`local GLM_HEARTBEAT_STALE_MS=${GLM_DRAINER_HEARTBEAT_STALE_MS}`),
      `the bash staleness window must equal GLM_DRAINER_HEARTBEAT_STALE_MS (${GLM_DRAINER_HEARTBEAT_STALE_MS}ms) — a drift here makes the alarm and the #3754 partition disagree about "live"`,
    );
  });

  test("track_signal for glm-sterile is guarded by glm_sterile_known (failed query never extends or clears)", () => {
    const block = codeOnly(blockSource());
    const guardIdx = block.indexOf('if [[ "$glm_sterile_known" == "1" ]]');
    const callIdx = block.indexOf("track_signal glm-sterile");
    assert.ok(guardIdx >= 0, "the glm_sterile_known guard must exist");
    assert.ok(callIdx > guardIdx, "track_signal glm-sterile must sit inside the known-inputs guard");
  });

  test("playbook documents the two stop levers (paused vs pace-gate.timer) in one subsection", () => {
    const play = readFileSync(join(REPO_ROOT, "docs", "operator-playbooks", "hydra-autopilot.md"), "utf-8");
    const h = play.indexOf("### Stopping the autopilot: the two levers");
    assert.ok(h >= 0, "playbook subsection '### Stopping the autopilot: the two levers' is missing");
    const tail = play.slice(h);
    const nextIdx = tail.slice(4).search(/\n#{2,3} /);
    const section = nextIdx >= 0 ? tail.slice(0, nextIdx + 4) : tail;
    assert.ok(section.includes("api/autopilot/paused"), "subsection must name the total-stop lever (POST /api/autopilot/paused)");
    assert.ok(section.includes("hydra-pace-gate.timer"), "subsection must name the Claude-only stop lever (hydra-pace-gate.timer)");
  });
});

describe("issue #3868 — glm-sterile behaviour (stubbed gh)", { skip: !DOCKER }, () => {
  const GH_LOG = join(SHIM_DIR, "gh-calls.log");
  const GH_SHIM = join(SHIM_DIR, "gh");
  const ISSUES_FIXTURE = join(SHIM_DIR, "gh-issues.json");
  const PULLS_FIXTURE = join(SHIM_DIR, "gh-pulls.json");

  /** PATH-shim `gh` — serves canned REST fixtures, applies any --jq via real
   * jq, records every invocation, never touches the network. GH_STUB_EXIT=N
   * simulates a gh failure (rate limit / 503 / auth). */
  function writeGhShim(): void {
    mkdirSync(SHIM_DIR, { recursive: true });
    writeFileSync(GH_SHIM, [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> '${GH_LOG}'`,
      'if [[ "${GH_STUB_EXIT:-0}" != "0" ]]; then exit "${GH_STUB_EXIT}"; fi',
      'jqprog=""; path=""; expect_jq=0',
      'for a in "$@"; do',
      '  if [[ "$expect_jq" == "1" ]]; then jqprog="$a"; expect_jq=0; continue; fi',
      '  if [[ "$a" == "--jq" ]]; then expect_jq=1; continue; fi',
      '  if [[ "$a" == repos/* ]]; then path="$a"; fi',
      "done",
      'case "$path" in',
      `  *"/issues"*) src='${ISSUES_FIXTURE}' ;;`,
      `  *"/pulls"*)  src='${PULLS_FIXTURE}' ;;`,
      '  *) echo "[]"; exit 0 ;;',
      "esac",
      'if [[ -n "$jqprog" ]]; then jq "$jqprog" < "$src"; else cat "$src"; fi',
      "",
    ].join("\n"));
    spawnSync("chmod", ["+x", GH_SHIM]);
  }

  function ghCalls(): string[] {
    try {
      return readFileSync(GH_LOG, "utf-8").split("\n").filter((l) => l !== "");
    } catch {
      return [];
    }
  }

  /** REST created_at without fractional seconds (jq's fromdateiso8601 rejects them). */
  const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

  const ELIGIBLE_ISSUES = JSON.stringify([
    { number: 9001, labels: [{ name: "glm-eligible" }, { name: "ready-for-agent" }] },
  ]);
  // A queue that must count as EMPTY: a glm-withhold row (the drainer's own
  // defense-in-depth exclusion) plus a PR-typed row (REST /issues lists PRs
  // too). If either exclusion regresses, the queue reads non-empty and the
  // idle quiet-case below fails against the broken detector.
  const EMPTY_QUEUE_ISSUES = JSON.stringify([
    { number: 9003, labels: [{ name: "glm-eligible" }, { name: "ready-for-agent" }, { name: "glm-withhold" }] },
    { number: 9004, labels: [{ name: "glm-eligible" }, { name: "ready-for-agent" }], pull_request: { url: "stub" } },
  ]);

  const PULLS_NONE_RECENT = JSON.stringify([
    // A drainer PR OUTSIDE the 6h window and a recent NON-drainer PR: zero
    // drainer PRs in-window, so a live+queued drainer reads STERILE.
    { labels: [{ name: "glm-authored" }], head: { ref: "worktree-agent-glm-1-100" }, created_at: iso(T0 - 10 * 3_600_000) },
    { labels: [], head: { ref: "worktree-agent-0abc12-x" }, created_at: iso(T0 - 10 * 60_000) },
  ]);
  const PULLS_RECENT_LABELED = JSON.stringify([
    { labels: [{ name: "glm-authored" }], head: { ref: "issue-42-fix" }, created_at: iso(T0 - 30 * 60_000) },
  ]);
  const PULLS_RECENT_BRANCH_ONLY = JSON.stringify([
    // No glm-authored label (the #3900 lost-label case) — the branch-prefix
    // FALLBACK of the shared OR-predicate must still count it.
    { labels: [], head: { ref: "worktree-agent-glm-77-999" }, created_at: iso(T0 - 30 * 60_000) },
  ]);

  function seedHeartbeat(ms: number): void {
    drc(["SET", TEST_GLM_HB_KEY, String(ms)]);
  }

  /** Env: creds present, curl+gh PATH shims, namespaced stream, fresh-fire
   * defaults (2s sustain threshold, now = T0+5s, healthy pace-gate tick). */
  function glmEnv(over: Record<string, string> = {}): Record<string, string> {
    return {
      TELEGRAM_BOT_TOKEN: "test-token",
      TELEGRAM_CHAT_ID: "test-chat",
      HYDRA_WATCHDOG_LAUNCH_NOTIFY_STREAM: TEST_NOTIFY_STREAM,
      PATH: `${SHIM_DIR}:${process.env.PATH ?? ""}`,
      HYDRA_WATCHDOG_LAUNCH_GLM_STERILE_SECONDS: "2",
      HYDRA_WATCHDOG_LAUNCH_NOW_MS: String(T0 + 5_000),
      ...over,
    };
  }

  beforeEach(() => {
    cleanState();
    for (const f of [CURL_LOG, GH_LOG]) {
      try {
        unlinkSync(f);
      } catch {
        /* absent log is fine */
      }
    }
    writeCurlShim(0);
    writeGhShim();
    writeFileSync(ISSUES_FIXTURE, ELIGIBLE_ISSUES);
    writeFileSync(PULLS_FIXTURE, PULLS_NONE_RECENT);
    // Healthy pace-gate tick so none of the five reason-derived signals fire —
    // any XADD observed below is attributable to glm-sterile alone.
    hsetLastTick({ reason: "eligible-launch", class: "launch", at: String(T0), latency_ms: "100" });
  });

  after(() => {
    try {
      rmSync(SHIM_DIR, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  test("fires: fresh heartbeat + queued work + zero drainer PRs in window → one in-band event, deduped", () => {
    seedHeartbeat(T0);
    seedSince("glm-sterile", T0);
    const r = runBlock(glmEnv());
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
    assert.match(
      lfLines(r.stdout),
      /WARNING LAUNCH FLOW — signal 'glm-sterile' sustained 5000ms >= 2000ms/,
      "the sustained streak must fire the WARNING",
    );
    assert.equal(getFired("glm-sterile"), true, "fired marker set");
    assert.ok(ghCalls().length >= 2, "both the queue and the PR-window gh queries must have run");
    assert.equal(curlCalls().length, 0, "glm-sterile is in-band only — never the Telegram curl path");
    const entries = notifyEntriesSimple();
    assert.equal(entries.length, 1, "exactly one XADD per streak");
    const f = entries[0].fields;
    assert.equal(f.type, E.GLM_DRAINER_STERILE);
    assert.equal(f.source, "watchdog-launch-flow");
    assert.equal(f.correlationId, "launch-flow-glm-sterile");
    const payload = JSON.parse(f.payload);
    assert.equal(payload.signal, "glm-sterile");
    assert.equal(payload.durationMs, 5000);
    assert.equal(payload.thresholdMs, 2000);
    // Second tick within the same streak: fired marker suppresses re-delivery.
    const r2 = runBlock(glmEnv({ HYDRA_WATCHDOG_LAUNCH_NOW_MS: String(T0 + 6_000) }));
    assert.equal(r2.status, 0);
    assert.equal(notifyEntriesSimple().length, 1, "no re-delivery within the same streak");
  });

  test("quiet (a): a recent drainer PR by LABEL clears membership and the streak", () => {
    seedHeartbeat(T0);
    seedSince("glm-sterile", T0);
    writeFileSync(PULLS_FIXTURE, PULLS_RECENT_LABELED);
    const r = runBlock(glmEnv());
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.doesNotMatch(lfLines(r.stdout), /signal 'glm-sterile' sustained/, "must not fire while drainer PRs exist in the window");
    assert.equal(getFired("glm-sterile"), false);
    assert.equal(drc(["GET", SINCE("glm-sterile")]), "", "membership false must clear the since anchor (stateless recovery)");
    assert.equal(notifyEntriesSimple().length, 0, "no delivery");
  });

  test("quiet (a'): a branch-prefix-only drainer PR (lost label, #3900) also counts — OR-predicate fallback", () => {
    seedHeartbeat(T0);
    seedSince("glm-sterile", T0);
    writeFileSync(PULLS_FIXTURE, PULLS_RECENT_BRANCH_ONLY);
    const r = runBlock(glmEnv());
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.doesNotMatch(lfLines(r.stdout), /signal 'glm-sterile' sustained/, "the branch-prefix fallback must count as drainer output");
    assert.equal(getFired("glm-sterile"), false);
    assert.equal(notifyEntriesSimple().length, 0);
  });

  test("quiet (b): stale heartbeat — the 'down' case is board-state's, so no alarm and NO gh calls", () => {
    seedHeartbeat(T0 - (GLM_DRAINER_HEARTBEAT_STALE_MS + 60_000));
    seedSince("glm-sterile", T0);
    const r = runBlock(glmEnv());
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.doesNotMatch(lfLines(r.stdout), /signal 'glm-sterile' sustained/);
    assert.equal(getFired("glm-sterile"), false);
    assert.equal(notifyEntriesSimple().length, 0);
    assert.equal(ghCalls().length, 0, "a non-fresh heartbeat must short-circuit BEFORE any gh query");
  });

  test("quiet (c): empty eligible queue (withheld + PR-typed rows) — idle is never sterile", () => {
    // Zero drainer PRs in the window AND a fresh heartbeat: a detector that
    // omitted the queue check WOULD fire here. Ours must stay quiet.
    seedHeartbeat(T0);
    writeFileSync(ISSUES_FIXTURE, EMPTY_QUEUE_ISSUES);
    const r = runBlock(glmEnv());
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.doesNotMatch(lfLines(r.stdout), /signal 'glm-sterile' sustained/, "an idle drainer (nothing to drain) must never alarm");
    assert.equal(getFired("glm-sterile"), false);
    assert.equal(notifyEntriesSimple().length, 0);
  });

  test("a failed gh query leaves the streak state untouched (never extends, never clears)", () => {
    seedHeartbeat(T0);
    seedSince("glm-sterile", T0);
    const r = runBlock(glmEnv({ GH_STUB_EXIT: "1" }));
    assert.equal(r.status, 0, `a gh failure must not fail the block; stderr=${r.stderr}`);
    assert.match(
      lfLines(r.stdout),
      /WARN glm-sterile queue query failed/,
      "a failed query must be loudly distinguishable from a quiet no-alarm tick",
    );
    assert.equal(drc(["GET", SINCE("glm-sterile")]), String(T0), "an in-progress streak must survive a gh failure");
    assert.equal(getFired("glm-sterile"), false, "a gh failure must never fire");
    assert.equal(notifyEntriesSimple().length, 0);
  });
});

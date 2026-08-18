/**
 * Regression test for issue #3868 — the ## GLM DRAINER ZERO-THROUGHPUT block
 * in scripts/hydra-watchdog.sh (`run_glm_zero_throughput`).
 *
 * Background (observed 2026-08-05, autopilot run 2bcba309): the GLM
 * dev-drainer's heartbeat (`hydra:glm:drainer:active`, #3689/#3754) stayed
 * FRESH while its final step (#3863 — `gh pr create`) failed on every
 * attempt, so it authored ~40 min per issue on z.ai's own quota, shipped
 * nothing, and the affected issues were invisible to both the GLM and Opus
 * lanes. No alarm fired: the existing watchdog machinery checks LIVENESS
 * (heartbeat freshness), never THROUGHPUT (is the live process producing
 * PRs?). `run_glm_zero_throughput` closes that gap by reading the drainer's
 * own journal log (`hydra-glm-drainer.service`, already emitted by
 * scripts/glm/drainer-loop.sh — no changes to that file) and alarming when
 * the last N (default 3) consecutive claim attempts (`picked issue #<n>`)
 * each lack a matching success line (`issue #<n>: PR opened`), while the
 * heartbeat is fresh.
 *
 * Three states the block must tell apart:
 *   down             — heartbeat stale/absent → skip, no alarm (handled by
 *                       the existing #3754 liveness gate elsewhere).
 *   no work queued   — heartbeat fresh, fewer than N claim attempts in the
 *                       lookback window → skip, no alarm.
 *   live-but-sterile — heartbeat fresh AND the last N claim attempts are all
 *                       PR-less → ALARM (WARNING GLM ZERO-THROUGHPUT).
 *
 * This test exercises `run_glm_zero_throughput` IN ISOLATION by extracting
 * it out of the script into a temp file (mirrors
 * test/watchdog-launch-flow.test.mts) so behavioural cases can source it
 * under `set -euo pipefail` without execing the whole script (no
 * service-liveness / autopilot-wedge / deploy-drift upstream checks to
 * fake). The extracted copy's heartbeat KEY LITERAL is rebound onto a
 * per-run namespace before sourcing — the production key
 * (`hydra:glm:drainer:active`) is live infrastructure a concurrent
 * production watchdog tick reads and writes, so a test must never touch it
 * directly (same #4072 hazard the launch-flow test documents at length).
 * `journalctl` is faked via the documented `HYDRA_JOURNALCTL_BIN` override,
 * mirroring the `HYDRA_GH_BIN` / `HYDRA_DOCKER_BIN` fake-binary convention in
 * test/watchdog-pending-work.test.mts.
 */

import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdtempSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

import { GLM_DRAINER_ACTIVE_KEY, GLM_DRAINER_HEARTBEAT_STALE_MS } from "../src/redis/autopilot.ts";
import {
  WATCHDOG_SPAWN_TIMEOUT_MS,
  WATCHDOG_REDIS_TIMEOUT_MS,
  throwIfTimedOut,
  assertSpawnOk,
} from "./_helpers/watchdog-timeouts.mts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const WATCHDOG = join(REPO_ROOT, "scripts", "hydra-watchdog.sh");

// ---------------------------------------------------------------------------
// Per-run heartbeat key namespace — same rationale as watchdog-launch-flow's
// RUN_NS: a concurrent production hydra-watchdog.timer tick must never
// observe (or be observed by) this suite's fixtures.
// ---------------------------------------------------------------------------
const RUN_NS = `hydra:test:glm-zero-throughput-${process.pid}-${randomUUID().slice(0, 8)}`;
const TEST_HEARTBEAT_KEY = `${RUN_NS}:active`;

function dockerRedisAvailable(): boolean {
  const r = spawnSync("docker", ["exec", "hydra-redis-1", "redis-cli", "PING"], {
    encoding: "utf-8",
    timeout: WATCHDOG_REDIS_TIMEOUT_MS,
  });
  return (r.stdout ?? "").trim() === "PONG";
}

const DOCKER = dockerRedisAvailable();

function redisCli(args: string[], what: string): string {
  const r = spawnSync("docker", ["exec", "hydra-redis-1", "redis-cli", "--raw", ...args], {
    encoding: "utf-8",
    timeout: WATCHDOG_REDIS_TIMEOUT_MS,
  });
  assertSpawnOk(r, WATCHDOG_REDIS_TIMEOUT_MS, what);
  return (r.stdout ?? "").trim();
}

function seedHeartbeat(ms: number): void {
  redisCli(["SET", TEST_HEARTBEAT_KEY, String(ms)], "seedHeartbeat SET");
}

function clearHeartbeat(): void {
  redisCli(["DEL", TEST_HEARTBEAT_KEY], "clearHeartbeat DEL");
}

// ---------------------------------------------------------------------------
// Extract run_glm_zero_throughput() into a temp file, rebinding the
// production heartbeat-key literal onto TEST_HEARTBEAT_KEY.
// ---------------------------------------------------------------------------
const BLOCK = join(tmpdir(), `hydra-glm-zero-throughput-block-${process.pid}.sh`);

before(() => {
  const src = readFileSync(WATCHDOG, "utf-8");
  const start = src.indexOf("run_glm_zero_throughput()");
  assert.ok(start >= 0, "run_glm_zero_throughput() not found in hydra-watchdog.sh");
  const after_ = src.slice(start);
  const end = after_.search(/^}/m);
  assert.ok(end >= 0, "run_glm_zero_throughput() closing brace not found");
  const body = after_.slice(0, end + 1);
  assert.ok(body.includes("picked issue #"), "extracted block missing the claim-attempt log pattern");

  const namespaced = body.split(`"${GLM_DRAINER_ACTIVE_KEY}"`).join(`"${TEST_HEARTBEAT_KEY}"`);
  assert.ok(
    namespaced.includes(`"${TEST_HEARTBEAT_KEY}"`),
    `failed to rebind HEARTBEAT_KEY: the block no longer contains the literal "${GLM_DRAINER_ACTIVE_KEY}". ` +
      `Without this rebinding the behavioural cases would read/race the LIVE production heartbeat key.`,
  );
  assert.ok(
    !namespaced.includes(`"${GLM_DRAINER_ACTIVE_KEY}"`),
    "the production heartbeat key must not survive anywhere in the rebound block",
  );
  writeFileSync(BLOCK, namespaced);
});

after(() => {
  try {
    if (DOCKER) clearHeartbeat();
    unlinkSync(BLOCK);
  } catch {
    /* best-effort cleanup */
  }
});

interface RunOpts {
  env?: Record<string, string>;
  journalLines?: string[]; // lines the fake journalctl prints (one echo per line)
  journalExit?: number; // fake journalctl exit code (default 0)
  noJournalBin?: boolean; // omit HYDRA_JOURNALCTL_BIN entirely (falls back to real `journalctl`, expected absent/failing in this sandbox)
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Source the extracted block, write a fake journalctl, call run_glm_zero_throughput once. */
function runBlock(opts: RunOpts = {}): RunResult {
  const binDir = mkdtempSync(join(tmpdir(), "wd-glm-zt-bin-"));
  const journalFake = join(binDir, "journalctl");
  const lines = opts.journalLines ?? [];
  const body = lines.map((l) => `echo ${JSON.stringify(l)}`).join("\n");
  writeFileSync(journalFake, `#!/usr/bin/env bash\n${body}\nexit ${opts.journalExit ?? 0}\n`);
  chmodSync(journalFake, 0o755);

  const env: Record<string, string> = {
    ...process.env,
    HYDRA_REDIS_HOST: "docker",
    ...(opts.noJournalBin ? {} : { HYDRA_JOURNALCTL_BIN: journalFake }),
    ...opts.env,
  };

  try {
    const r = spawnSync("bash", ["-c", `set -euo pipefail; source '${BLOCK}'; run_glm_zero_throughput`], {
      env,
      encoding: "utf-8",
      timeout: WATCHDOG_SPAWN_TIMEOUT_MS,
    });
    throwIfTimedOut(r, WATCHDOG_SPAWN_TIMEOUT_MS, "run_glm_zero_throughput block");
    return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
}

const PICKED_NO_PR = (n: number) => [
  `hydra-glm-drainer: picked issue #${n}`,
  `hydra-glm-drainer: PR creation failed for issue #${n} -- releasing claim`,
];
const PICKED_WITH_PR = (n: number) => [
  `hydra-glm-drainer: picked issue #${n}`,
  `hydra-glm-drainer: issue #${n}: PR opened (branch=worktree-agent-glm-${n}-1), advanced to needs-qa, daily cap incremented`,
];

const T0 = 1_700_000_000_000;

// =============================================================================
// Structural / drift-guard cases — run unconditionally (no Redis needed).
// =============================================================================

describe("scripts/hydra-watchdog.sh — ## GLM DRAINER ZERO-THROUGHPUT structure (issue #3868)", () => {
  test("watchdog script exists and is executable", () => {
    assert.ok(existsSync(WATCHDOG), "watchdog script missing");
    const mode = spawnSync("stat", ["-c", "%a", WATCHDOG], { encoding: "utf-8" }).stdout.trim();
    assert.match(mode, /^[7][0-9]{2}$/, `watchdog not executable (mode=${mode})`);
  });

  test("run_glm_zero_throughput is wired into the entry-point call list, inside the sourcing guard", () => {
    const src = readFileSync(WATCHDOG, "utf-8");
    const defIdx = src.indexOf("run_glm_zero_throughput()");
    assert.ok(defIdx >= 0, "run_glm_zero_throughput() definition not found");
    const entryIdx = src.indexOf("# Entry point");
    assert.ok(entryIdx > defIdx, "entry-point comment must follow the block definition");
    const entry = src.slice(entryIdx);
    assert.match(entry, /^\s*run_glm_zero_throughput$/m, "run_glm_zero_throughput must be called in the entry list");
    const guardIdx = entry.indexOf('if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then');
    assert.ok(guardIdx >= 0, "entry list must be wrapped in the sourcing guard");
    assert.match(
      entry.slice(guardIdx),
      /^\s*run_glm_zero_throughput$/m,
      "run_glm_zero_throughput must be called inside the sourcing guard, not before it",
    );
  });

  test("heartbeat key literal matches src/redis/autopilot.ts's GLM_DRAINER_ACTIVE_KEY (no drift)", () => {
    const src = readFileSync(WATCHDOG, "utf-8");
    const block = src.slice(src.indexOf("run_glm_zero_throughput()"), src.indexOf("# Entry point"));
    const lit = block.match(/HEARTBEAT_KEY="([^"]+)"/);
    assert.ok(lit, "HEARTBEAT_KEY literal assignment not found");
    assert.equal(lit![1], GLM_DRAINER_ACTIVE_KEY, "watchdog HEARTBEAT_KEY drifted from GLM_DRAINER_ACTIVE_KEY");
  });

  test("default staleness threshold matches src/redis/autopilot.ts's GLM_DRAINER_HEARTBEAT_STALE_MS (no drift)", () => {
    const src = readFileSync(WATCHDOG, "utf-8");
    const block = src.slice(src.indexOf("run_glm_zero_throughput()"), src.indexOf("# Entry point"));
    const lit = block.match(/STALE_MS="\$\{HYDRA_WATCHDOG_GLM_HEARTBEAT_STALE_MS:-(\d+)\}"/);
    assert.ok(lit, "STALE_MS default literal not found");
    assert.equal(
      Number(lit![1]),
      GLM_DRAINER_HEARTBEAT_STALE_MS,
      "watchdog default STALE_MS drifted from GLM_DRAINER_HEARTBEAT_STALE_MS",
    );
  });

  test("DETECTION ONLY — no alerts.ts / telegram / alert POST in the block", () => {
    const src = readFileSync(WATCHDOG, "utf-8");
    const block = src.slice(src.indexOf("run_glm_zero_throughput()"), src.indexOf("# Entry point"));
    for (const forbidden of ["alerts.ts", "telegram", "Telegram", "sendAlert", "POST /api/alerts"]) {
      assert.ok(!block.includes(forbidden), `block must not reference ${forbidden} (detection only)`);
    }
  });

  test("block never executes drainer-loop.sh (out of scope on #3868 — reads existing log lines only)", () => {
    const src = readFileSync(WATCHDOG, "utf-8");
    const block = src.slice(src.indexOf("run_glm_zero_throughput()"), src.indexOf("# Entry point"));
    // Prose comments legitimately name drainer-loop.sh (it's what emits the log
    // lines this block reads) — the invariant is no EXECUTION of it, e.g. no
    // `bash .../drainer-loop.sh` or `drainer-loop.sh` on a command line.
    assert.doesNotMatch(
      block,
      /(?:bash|sh|\.\/)\s*["']?[^\s"']*drainer-loop\.sh/,
      "block must not shell out to drainer-loop.sh",
    );
  });

  test("fail-safe: source parses under set -euo pipefail without executing", () => {
    const syntax = spawnSync("bash", ["-n", WATCHDOG], { encoding: "utf-8" });
    assert.equal(syntax.status, 0, `watchdog bash -n failed: ${syntax.stderr}`);
    const src = spawnSync("bash", ["-c", `set -euo pipefail; source '${BLOCK}'; true`], { encoding: "utf-8" });
    assert.equal(src.status, 0, `sourcing run_glm_zero_throughput under set -euo pipefail failed: ${src.stderr}`);
  });
});

// =============================================================================
// Behavioural cases — gated on the docker redis container (heartbeat GET).
// =============================================================================

describe("scripts/hydra-watchdog.sh — ## GLM DRAINER ZERO-THROUGHPUT behaviour (issue #3868)", { skip: !DOCKER }, () => {
  test("live-but-sterile: fresh heartbeat + last 3 consecutive claim attempts all PR-less → ALARM", () => {
    seedHeartbeat(T0);
    const journalLines = [...PICKED_NO_PR(101), ...PICKED_NO_PR(102), ...PICKED_NO_PR(103)];
    const r = runBlock({
      journalLines,
      env: { HYDRA_WATCHDOG_GLM_NOW_MS: String(T0 + 5_000), HYDRA_WATCHDOG_GLM_ZERO_THROUGHPUT_N: "3" },
    });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
    assert.match(r.stdout, /WARNING GLM ZERO-THROUGHPUT/, `expected the alarm line, got: ${r.stdout}`);
    assert.match(r.stdout, /issues: 101 102 103/, `expected the three sterile issue numbers, got: ${r.stdout}`);
    assert.match(r.stdout, /LIVE but STERILE/);
  });

  test("healthy: at least one PR among the last 3 claim attempts → no alarm", () => {
    seedHeartbeat(T0);
    const journalLines = [...PICKED_NO_PR(201), ...PICKED_WITH_PR(202), ...PICKED_NO_PR(203)];
    const r = runBlock({
      journalLines,
      env: { HYDRA_WATCHDOG_GLM_NOW_MS: String(T0 + 5_000), HYDRA_WATCHDOG_GLM_ZERO_THROUGHPUT_N: "3" },
    });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
    assert.doesNotMatch(r.stdout, /WARNING GLM ZERO-THROUGHPUT/, `must not alarm, got: ${r.stdout}`);
    assert.match(r.stdout, /healthy, no alarm/);
  });

  test("live-but-sterile persists even with an older PR outside the last-N window (streak is the LAST N attempts)", () => {
    seedHeartbeat(T0);
    // Issue 301 got a PR, but 302/303/304 (the last 3) did not — must still alarm.
    const journalLines = [...PICKED_WITH_PR(301), ...PICKED_NO_PR(302), ...PICKED_NO_PR(303), ...PICKED_NO_PR(304)];
    const r = runBlock({
      journalLines,
      env: { HYDRA_WATCHDOG_GLM_NOW_MS: String(T0 + 5_000), HYDRA_WATCHDOG_GLM_ZERO_THROUGHPUT_N: "3" },
    });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
    assert.match(r.stdout, /WARNING GLM ZERO-THROUGHPUT/, `expected the alarm line, got: ${r.stdout}`);
    assert.match(r.stdout, /issues: 302 303 304/);
  });

  test("down (stale heartbeat): sterile-looking log but stale heartbeat → skip, no alarm", () => {
    seedHeartbeat(T0);
    const journalLines = [...PICKED_NO_PR(401), ...PICKED_NO_PR(402), ...PICKED_NO_PR(403)];
    const r = runBlock({
      journalLines,
      env: {
        HYDRA_WATCHDOG_GLM_NOW_MS: String(T0 + 5_000),
        HYDRA_WATCHDOG_GLM_ZERO_THROUGHPUT_N: "3",
        HYDRA_WATCHDOG_GLM_HEARTBEAT_STALE_MS: "100", // age (5000ms) > 100ms → stale
      },
    });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
    assert.doesNotMatch(r.stdout, /WARNING GLM ZERO-THROUGHPUT/, `stale heartbeat must never alarm, got: ${r.stdout}`);
    assert.match(r.stdout, /STALE/, `expected a STALE skip message, got: ${r.stdout}`);
    assert.match(r.stdout, /presumed down, not sterile/);
  });

  test("down (absent heartbeat): sterile-looking log but no heartbeat at all → skip, no alarm", () => {
    clearHeartbeat();
    const journalLines = [...PICKED_NO_PR(501), ...PICKED_NO_PR(502), ...PICKED_NO_PR(503)];
    const r = runBlock({
      journalLines,
      env: { HYDRA_WATCHDOG_GLM_NOW_MS: String(T0 + 5_000), HYDRA_WATCHDOG_GLM_ZERO_THROUGHPUT_N: "3" },
    });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
    assert.doesNotMatch(r.stdout, /WARNING GLM ZERO-THROUGHPUT/, `absent heartbeat must never alarm, got: ${r.stdout}`);
    assert.match(r.stdout, /presumed down, not sterile/);
  });

  test("no work queued: fresh heartbeat + fewer than N claim attempts in the window → skip, no alarm", () => {
    seedHeartbeat(T0);
    const journalLines = [...PICKED_NO_PR(601)]; // only 1 attempt, N=3
    const r = runBlock({
      journalLines,
      env: { HYDRA_WATCHDOG_GLM_NOW_MS: String(T0 + 5_000), HYDRA_WATCHDOG_GLM_ZERO_THROUGHPUT_N: "3" },
    });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
    assert.doesNotMatch(r.stdout, /WARNING GLM ZERO-THROUGHPUT/, `too few attempts must never alarm, got: ${r.stdout}`);
    assert.match(r.stdout, /not enough data/);
  });

  test("no work queued: fresh heartbeat + a fully idle window (zero claim attempts) → skip, no alarm", () => {
    seedHeartbeat(T0);
    const journalLines = ["hydra-glm-drainer: no glm-eligible + ready-for-agent issue with an approved design concept — idle"];
    const r = runBlock({
      journalLines,
      env: { HYDRA_WATCHDOG_GLM_NOW_MS: String(T0 + 5_000), HYDRA_WATCHDOG_GLM_ZERO_THROUGHPUT_N: "3" },
    });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
    assert.doesNotMatch(r.stdout, /WARNING GLM ZERO-THROUGHPUT/, `idle window must never alarm, got: ${r.stdout}`);
    assert.match(r.stdout, /not enough data/);
  });

  test("journalctl read failure: fresh heartbeat but the journal read fails → skip, no alarm, distinguishable WARN", () => {
    seedHeartbeat(T0);
    const r = runBlock({
      journalLines: [],
      journalExit: 1,
      env: { HYDRA_WATCHDOG_GLM_NOW_MS: String(T0 + 5_000), HYDRA_WATCHDOG_GLM_ZERO_THROUGHPUT_N: "3" },
    });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
    assert.doesNotMatch(r.stdout, /WARNING GLM ZERO-THROUGHPUT/, `a failed journal read must never alarm, got: ${r.stdout}`);
    assert.match(r.stdout, /WARN journalctl read failed/);
  });

  test("threshold is injectable: N=1 fires on a single sterile attempt where N=3 (default) would not", () => {
    seedHeartbeat(T0);
    const journalLines = [...PICKED_NO_PR(701)];
    const r = runBlock({
      journalLines,
      env: { HYDRA_WATCHDOG_GLM_NOW_MS: String(T0 + 5_000), HYDRA_WATCHDOG_GLM_ZERO_THROUGHPUT_N: "1" },
    });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
    assert.match(r.stdout, /WARNING GLM ZERO-THROUGHPUT/, `expected the alarm line with N=1, got: ${r.stdout}`);
    assert.match(r.stdout, /issues: 701/);
  });
});

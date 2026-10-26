/**
 * Regression tests for the consolidated watchdog:
 *
 *   1. the AUTOPILOT WEDGE check (issue #508, ported to TypeScript in #5095) —
 *      pure decideWedge + runWedge over an in-memory fake of the typed ports
 *      (src/watchdog/ports.ts). No PATH-shimmed binaries, no env test hooks, no
 *      source-text slicing, and the fake's sleep resolves immediately so the
 *      30 s SIGKILL grace is never waited.
 *   2. the SERVICE LIVENESS block's boot-window guards (issue #4415) — second
 *      top-level describe at the end of this file, still driving
 *      scripts/hydra-watchdog.sh under PATH-shimmed stubs (slice 2 ports it).
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  WATCHDOG_SPAWN_TIMEOUT_MS,
  throwIfTimedOut,
} from "./_helpers/watchdog-timeouts.mts";
import { decideWedge, runWedge, type WedgeConfig } from "../src/watchdog/wedge.ts";
import { parseStatePid, type WedgeDeps, type WedgeState } from "../src/watchdog/ports.ts";
import {
  STALLED_DISPATCH_AGE_S,
  WATCHDOG_KILL_GRACE_S,
  WATCHDOG_WEDGE_KILL_THRESHOLD_S,
  WEDGE_AGE_THRESHOLD_S,
  staleThresholdsJson,
} from "../src/autopilot/stale-thresholds.ts";
import { signalPid } from "../src/process-probe.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const WATCHDOG = join(REPO_ROOT, "scripts", "hydra-watchdog.sh");
const WATCHDOG_CLI = join(REPO_ROOT, "scripts", "hydra-watchdog.ts");

interface FakeScript {
  serviceActive?: boolean | null;
  state?: WedgeState;
  /** PID liveness per call: the Nth pidAlive() call returns aliveSeq[N] (last value repeats). */
  aliveSeq?: boolean[];
  heartbeatAgeS?: number | null;
  /** What signal() reports (delivered?). */
  signalOk?: boolean;
}

/** In-memory fake implementing the same ports as production; records every effect. */
function makeFake(script: FakeScript) {
  const NOW = 1_800_000_000;
  const signals: Array<{ pid: number; sig: string }> = [];
  const sleeps: number[] = [];
  const lines: string[] = [];
  let aliveCalls = 0;
  const deps: WedgeDeps = {
    host: {
      serviceActive: async () => (script.serviceActive === undefined ? true : script.serviceActive),
      pidAlive: () => {
        const seq = script.aliveSeq ?? [true];
        return seq[Math.min(aliveCalls++, seq.length - 1)];
      },
      signal: (pid, sig) => {
        signals.push({ pid, sig });
        return script.signalOk ?? true;
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
    files: {
      readStatePid: () => script.state ?? { pid: 4242, runId: "test-run" },
      heartbeatEpochS: () => {
        const age = script.heartbeatAgeS === undefined ? 10 : script.heartbeatAgeS;
        return age === null ? null : NOW - age;
      },
    },
    clock: { nowEpochS: () => NOW },
    log: (l) => lines.push(l),
  };
  return { deps, signals, sleeps, lines };
}

const CONFIG: WedgeConfig = {
  unit: "hydra-autopilot.service",
  statePath: "/unused/state.json",
  heartbeatPath: "/unused/heartbeat.txt",
  thresholdS: 1500,
  graceS: 30,
};

describe("watchdog wedge check (decideWedge / runWedge over fake ports)", () => {
  test("service inactive short-circuits FIRST: no signal even with stale heartbeat + live PID", async () => {
    const f = makeFake({ serviceActive: false, heartbeatAgeS: 3600 });
    const v = await runWedge(f.deps, CONFIG);
    assert.equal(v.kind, "service-inactive");
    assert.deepEqual(f.signals, []);
    assert.match(f.lines.join("\n"), /hydra-autopilot-watchdog: service not active/);
  });

  test("service probe failure (null) is fail-open: leave alone, never kill", async () => {
    const f = makeFake({ serviceActive: null, heartbeatAgeS: 3600 });
    const v = await runWedge(f.deps, CONFIG);
    assert.equal(v.kind, "service-inactive");
    assert.deepEqual(f.signals, []);
    assert.match(f.lines.join("\n"), /WARN service state unknown/);
  });

  test("fresh heartbeat + live PID: healthy, no signal", async () => {
    const f = makeFake({ heartbeatAgeS: 10 });
    const v = await runWedge(f.deps, CONFIG);
    assert.equal(v.kind, "healthy");
    assert.deepEqual(f.signals, []);
    assert.match(f.lines.join("\n"), /healthy \(heartbeat 10s ago, PID 4242, run_id=test-run, threshold=1500s\)/);
  });

  test("stale heartbeat + dead PID: leaves alone (bootstrap will recover)", async () => {
    const f = makeFake({ aliveSeq: [false], heartbeatAgeS: 3600 });
    const v = await runWedge(f.deps, CONFIG);
    assert.equal(v.kind, "pid-dead");
    assert.deepEqual(f.signals, []);
    assert.match(f.lines.join("\n"), /state PID 4242 is dead/);
  });

  test("missing state file and pid-less state leave alone", async () => {
    const missing = await runWedge(makeFake({ state: "missing" }).deps, CONFIG);
    assert.equal(missing.kind, "no-state");
    const noPid = await runWedge(makeFake({ state: "no-pid" }).deps, CONFIG);
    assert.equal(noPid.kind, "no-pid");
  });

  test("heartbeat missing is a WARN, not a kill trigger", async () => {
    const f = makeFake({ heartbeatAgeS: null });
    const v = await runWedge(f.deps, CONFIG);
    assert.equal(v.kind, "heartbeat-missing");
    assert.deepEqual(f.signals, []);
    assert.match(f.lines.join("\n"), /WARN heartbeat file missing/);
  });

  test("negative heartbeat age (clock skew) leaves alone", async () => {
    const f = makeFake({ heartbeatAgeS: -5 });
    const v = await runWedge(f.deps, CONFIG);
    assert.equal(v.kind, "clock-skew");
    assert.deepEqual(f.signals, []);
    assert.match(f.lines.join("\n"), /negative heartbeat age/);
  });

  test("age exactly at the threshold is wedged (strict < for healthy)", () => {
    const v = decideWedge({
      serviceActive: true,
      state: { pid: 1, runId: "r" },
      pidAlive: true,
      heartbeatAgeS: 1500,
      thresholdS: 1500,
    });
    assert.equal(v.kind, "wedged");
  });

  test("stale + live PID + active service: SIGTERM, full grace, then SIGKILL when still alive", async () => {
    // pidAlive calls: #1 gather (alive), #2 after-grace (still alive)
    const f = makeFake({ aliveSeq: [true, true], heartbeatAgeS: 1800 });
    const v = await runWedge(f.deps, CONFIG);
    assert.equal(v.kind, "wedged");
    assert.deepEqual(f.signals, [
      { pid: 4242, sig: "SIGTERM" },
      { pid: 4242, sig: "SIGKILL" },
    ]);
    assert.deepEqual(f.sleeps, [30_000]);
    const out = f.lines.join("\n");
    assert.match(out, /STALE — heartbeat 1800s ago \(> 1500s\), PID 4242 alive \(run_id=test-run\) — sending SIGTERM/);
    assert.match(out, /grace expired \(30s\)/);
  });

  test("PID exited during grace: SIGTERM only, no SIGKILL", async () => {
    const f = makeFake({ aliveSeq: [true, false], heartbeatAgeS: 1800 });
    await runWedge(f.deps, CONFIG);
    assert.deepEqual(f.signals, [{ pid: 4242, sig: "SIGTERM" }]);
    assert.match(f.lines.join("\n"), /PID 4242 exited cleanly after SIGTERM/);
  });

  test("a failed SIGTERM is logged and the grace/escalation still proceeds", async () => {
    const f = makeFake({ aliveSeq: [true, false], heartbeatAgeS: 1800, signalOk: false });
    await runWedge(f.deps, CONFIG);
    assert.match(f.lines.join("\n"), /kill -TERM 4242 failed/);
  });

  test("parseStatePid maps state.json shapes to WedgeState", () => {
    assert.deepEqual(parseStatePid('{"pid": 77, "run_id": "abc"}'), { pid: 77, runId: "abc" });
    assert.deepEqual(parseStatePid('{"pid": 77}'), { pid: 77, runId: "unknown" });
    assert.equal(parseStatePid('{"pid": 0}'), "no-pid");
    assert.equal(parseStatePid("{}"), "no-pid");
    assert.equal(parseStatePid("not json"), "no-pid");
  });

  test("signalPid refuses invalid pids and reports ESRCH as false without throwing", () => {
    assert.equal(signalPid(0, "SIGTERM"), false);
    assert.equal(signalPid(Number.NaN, "SIGKILL"), false);
    assert.equal(signalPid(2_000_000_000, "SIGTERM"), false);
  });

  test("threshold values are unchanged and the CLI `thresholds` subcommand prints the module", () => {
    assert.equal(WATCHDOG_WEDGE_KILL_THRESHOLD_S, 1500);
    assert.equal(WATCHDOG_KILL_GRACE_S, 30);
    assert.equal(WEDGE_AGE_THRESHOLD_S, 600);
    assert.equal(STALLED_DISPATCH_AGE_S, 900);
    const r = spawnSync("node", ["--no-warnings", "--experimental-strip-types", WATCHDOG_CLI, "thresholds"], {
      encoding: "utf-8",
      timeout: WATCHDOG_SPAWN_TIMEOUT_MS,
    });
    throwIfTimedOut(r, WATCHDOG_SPAWN_TIMEOUT_MS, "watchdog CLI thresholds");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), staleThresholdsJson());
  });
});

// =============================================================================
// SERVICE LIVENESS — boot-window guards (issue #4415)
// =============================================================================
//
// The 2-minute watchdog tick can land inside the orchestrator's boot window:
// systemd reports "Started" before Express listens (~1-4s, longer under load
// and behind the ExecStartPre tsc compile), so Check 1 reads an empty /health
// and restarts the service a SECOND time mid-boot. That second restart breaks
// deploy.sh's post-restart health gate — a red deploy job on a healthy prod,
// no semver tag (the 50eda03b incident). The fix adds two guards to
// run_service_liveness, and the cases below pin exactly the issue's
// acceptance-criteria trio plus the fail-open/probe-release invariants:
//
//   (a) fresh start (activation age < grace)          -> NO restart, reason
//       logged — even with /health unreachable
//   (b) deploy lock held                              -> NO restart, reason
//       logged — even with an old service + dead /health
//   (c) old + unhealthy                               -> restart as today
//   (d) WATCHDOG_STARTUP_GRACE_SECONDS=0              -> the grace guard is
//       a knob, not an unconditional skip
//   (e) unreadable ActiveEnterTimestampMonotonic      -> fail OPEN (checks
//       proceed) — a recovery mechanism must not disarm itself on a read
//       failure
//   (f) old + healthy                                 -> the normal path is
//       intact, and the deploy-lock probe does not LEAK the lock
//
// Isolation: unlike the wedge describe above (env hooks only), these cases
// PATH-SHIM systemctl / curl / docker with stub binaries and call ONLY
// run_service_liveness — sourced via the script's BASH_SOURCE guard, the
// same idiom as test/watchdog-pending-work.test.mts. `flock`, `python3`,
// `date`, and `awk` are the REAL binaries: the deploy-lock cases exercise
// genuine flock contention on a per-test lock file, and HYDRA_DEPLOY_LOCK is
// ALWAYS rebound so no case ever probes (or creates) the live
// /tmp/hydra-deploy.lock while a real deploy holds it.

/** systemctl stub — driven by STUB_LOG / STUB_ACTIVE_AGE_S / STUB_SHOW_RAW. */
const SYSTEMCTL_STUB = `#!/usr/bin/env bash
# Test stub for systemctl (issue #4415 boot-window guard tests).
args="$*"
if [[ "\$args" == *"is-active"* ]]; then
  if [[ "\$args" == *"hydra-orchestrator.service"* ]]; then
    exit 0   # the orchestrator unit is "active"
  fi
  exit 3     # every other unit (e.g. the tunnel) reports inactive
fi
if [[ "\$args" == *"is-failed"* ]]; then
  exit 1     # no failed units
fi
if [[ "\$args" == *"show"* ]]; then
  if [[ -n "\${STUB_SHOW_RAW+x}" ]]; then
    printf '%s\\n' "\$STUB_SHOW_RAW"
    exit 0
  fi
  # ActiveEnterTimestampMonotonic for a service that became active
  # STUB_ACTIVE_AGE_S seconds ago (systemd monotonic clock, microseconds).
  now_us="\$(awk '{printf "%d", \$1 * 1000000}' /proc/uptime)"
  age="\${STUB_ACTIVE_AGE_S:-3600}"
  echo "\$((now_us - age * 1000000))"
  exit 0
fi
if [[ "\$args" == *"restart"* ]]; then
  printf 'systemctl-restart: %s\\n' "\$args" >>"\${STUB_LOG:?STUB_LOG not set}"
  exit 0
fi
exit 0
`;

/** docker stub — the Redis container always answers Check 0's ping (logged). */
const DOCKER_STUB = `#!/usr/bin/env bash
printf 'docker-ping: %s\\n' "\$*" >>"\${STUB_LOG:?STUB_LOG not set}"
echo PONG
`;

/** curl stub — canned bodies per URL; /api/health driven by STUB_HEALTH_MODE. */
const CURL_STUB = `#!/usr/bin/env bash
args="\$*"
case "\$args" in
  *"/api/health"*)
    case "\${STUB_HEALTH_MODE:-ok}" in
      fail) exit 7 ;;   # connection refused
      *) echo '{"status":"ok","redis":true,"uptime":1000}'; exit 0 ;;
    esac
    ;;
  *"/api/scheduler/status"*)
    printf '{"running":true,"lastTickAt":"%s"}\\n' "\$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
    exit 0
    ;;
  *"/api/cycle/status"*)
    echo '{"status":"idle"}'
    exit 0
    ;;
esac
exit 0
`;

interface LivenessHarness {
  dir: string;
  bin: string;
  log: string;
  lockFile: string;
}

/** Fresh per-test stub bin dir, invocation log, and (free) deploy lock file. */
function makeLivenessHarness(): LivenessHarness {
  const dir = mkdtempSync(join(tmpdir(), "watchdog-liveness-stub-"));
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "systemctl"), SYSTEMCTL_STUB);
  writeFileSync(join(bin, "docker"), DOCKER_STUB);
  writeFileSync(join(bin, "curl"), CURL_STUB);
  chmodSync(join(bin, "systemctl"), 0o755);
  chmodSync(join(bin, "docker"), 0o755);
  chmodSync(join(bin, "curl"), 0o755);
  return { dir, bin, log: join(dir, "systemctl.log"), lockFile: join(dir, "deploy.lock") };
}

interface LivenessResult {
  status: number;
  stdout: string;
  stderr: string;
  /** Every `systemctl ... restart ...` the block issued, from the stub's log. */
  restarts: string[];
  /** Every Check-0 `docker exec ... ping` the block issued, from the stub's log. */
  dockerPings: string[];
}

/**
 * Source the watchdog (the BASH_SOURCE guard keeps every block's dispatch
 * inert) and run ONLY run_service_liveness with the stub bin prepended to
 * PATH. The echo marker distinguishes a clean block return from a set -e
 * abort inside the sourced script.
 */
function runServiceLiveness(h: LivenessHarness, env: Record<string, string>): LivenessResult {
  const driver = [
    `source ${JSON.stringify(WATCHDOG)}`,
    "run_service_liveness",
    'echo "BLOCK_RC=$?"',
  ].join("\n");
  const r = spawnSync("bash", ["-c", driver], {
    env: {
      ...process.env,
      // ALWAYS rebind the deploy lock away from the live /tmp/hydra-deploy.lock
      // — a concurrent real deploy on the shared host must not flip a case.
      HYDRA_DEPLOY_LOCK: h.lockFile,
      STUB_LOG: h.log,
      ...env,
      PATH: `${h.bin}:${process.env.PATH ?? ""}`,
    },
    encoding: "utf-8",
    timeout: WATCHDOG_SPAWN_TIMEOUT_MS,
  });
  throwIfTimedOut(r, WATCHDOG_SPAWN_TIMEOUT_MS, "watchdog service-liveness block");
  const logged = existsSync(h.log)
    ? readFileSync(h.log, "utf-8").split("\n").filter((l) => l.trim().length > 0)
    : [];
  const restarts = logged.filter((l) => l.startsWith("systemctl-restart:"));
  const dockerPings = logged.filter((l) => l.startsWith("docker-ping:"));
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "", restarts, dockerPings };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Hold the deploy lock from a background process (real flock) until killed.
 * Resolves only once a non-blocking probe provably FAILS — i.e. the holder
 * actually owns the lock — so the subsequent watchdog run cannot race the
 * acquisition.
 */
async function holdDeployLock(lockFile: string): Promise<ChildProcess> {
  const holder = spawn(
    "bash",
    ["-c", `exec 9>>${JSON.stringify(lockFile)}; flock 9; sleep 60`],
    { stdio: "ignore" },
  );
  const deadline = Date.now() + 10_000;
  for (;;) {
    const probe = spawnSync("bash", ["-c", `flock -n ${JSON.stringify(lockFile)} true`], {
      encoding: "utf-8",
      timeout: WATCHDOG_SPAWN_TIMEOUT_MS,
    });
    if (probe.status !== 0) return holder; // probe blocked -> holder owns it
    if (holder.exitCode !== null) {
      throw new Error(`deploy-lock holder exited early (code ${holder.exitCode})`);
    }
    if (Date.now() > deadline) {
      holder.kill("SIGKILL");
      throw new Error("deploy-lock holder never acquired the lock within 10s");
    }
    await sleep(50);
  }
}

describe("scripts/hydra-watchdog.sh — SERVICE LIVENESS boot-window guards (issue #4415)", () => {
  test("(a) fresh start within grace: NO restart even with /health unreachable, reason logged", () => {
    const h = makeLivenessHarness();
    try {
      // Exactly the 50eda03b race shape: the tick fires seconds after
      // "Started", while Express is not yet listening.
      const r = runServiceLiveness(h, { STUB_ACTIVE_AGE_S: "5", STUB_HEALTH_MODE: "fail" });

      assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
      assert.match(r.stdout, /BLOCK_RC=0/, `block must return cleanly, got: ${r.stdout}`);
      assert.deepEqual(r.restarts, [], `must NOT restart a fresh service, got: ${r.restarts.join("; ")}`);
      assert.match(
        r.stdout,
        /service started 5s ago \(< 60s grace\)/,
        `expected fresh-start grace log line, got: ${r.stdout}`,
      );
      assert.match(r.stdout, /skipping liveness restart this tick/, `expected skip-reason tail, got: ${r.stdout}`);
      // The guard must short-circuit BEFORE Check 1 — no unreachable/restart
      // diagnostics may appear for a booting service.
      assert.doesNotMatch(r.stdout, /unreachable|restarting/, `boot window must not be judged unhealthy, got: ${r.stdout}`);
      // ...but AFTER Check 0 (the artifact's placement invariant): a Redis
      // outage is a genuine incident and must not wait out a grace window.
      assert.ok(r.dockerPings.length > 0, "Check 0's docker ping must still run ahead of the boot-window guards");
    } finally {
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  test("(b) deploy lock held: NO restart even for an old service with /health unreachable, reason logged", async () => {
    const h = makeLivenessHarness();
    let holder: ChildProcess | null = null;
    try {
      holder = await holdDeployLock(h.lockFile);
      // Old service (3600s >> grace) whose /health is down — without the
      // lock guard this is a textbook restart; the deploy makes it a skip.
      const r = runServiceLiveness(h, { STUB_ACTIVE_AGE_S: "3600", STUB_HEALTH_MODE: "fail" });

      assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
      assert.match(r.stdout, /BLOCK_RC=0/, `block must return cleanly, got: ${r.stdout}`);
      assert.deepEqual(r.restarts, [], `must NOT restart during a deploy, got: ${r.restarts.join("; ")}`);
      assert.match(
        r.stdout,
        /deploy in progress \([^)]* held\) — skipping liveness restart this tick/,
        `expected deploy-in-progress log line, got: ${r.stdout}`,
      );
      assert.doesNotMatch(r.stdout, /unreachable|restarting/, `deploy window must not be judged unhealthy, got: ${r.stdout}`);
      // Check 0 still ran ahead of the guard (Redis outage != deploy).
      assert.ok(r.dockerPings.length > 0, "Check 0's docker ping must still run ahead of the boot-window guards");
    } finally {
      holder?.kill("SIGKILL");
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  test("(c) old + unhealthy: restart fires exactly once, as before #4415", () => {
    const h = makeLivenessHarness();
    try {
      const r = runServiceLiveness(h, { STUB_ACTIVE_AGE_S: "3600", STUB_HEALTH_MODE: "fail" });

      assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
      assert.match(r.stdout, /BLOCK_RC=0/, `block must return cleanly, got: ${r.stdout}`);
      assert.equal(r.restarts.length, 1, `expected exactly one restart, got: ${r.restarts.join("; ")}`);
      assert.match(r.restarts[0]!, /restart hydra-orchestrator\.service/, `restart must target the orchestrator, got: ${r.restarts[0]}`);
      assert.match(r.stdout, /unreachable — restarting hydra-orchestrator\.service/, `expected Check-1 unreachable diagnostic, got: ${r.stdout}`);
    } finally {
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  test("HYDRA_WATCHDOG_STARTUP_GRACE_SECONDS=0 disarms the grace guard — a fresh-but-unhealthy service is restarted", () => {
    const h = makeLivenessHarness();
    try {
      const r = runServiceLiveness(h, {
        STUB_ACTIVE_AGE_S: "5",
        STUB_HEALTH_MODE: "fail",
        HYDRA_WATCHDOG_STARTUP_GRACE_SECONDS: "0",
      });

      assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
      assert.equal(r.restarts.length, 1, `grace=0 must let the restart fire, got: ${r.restarts.join("; ")}`);
      assert.doesNotMatch(r.stdout, /skipping liveness restart/, `grace=0 must not skip, got: ${r.stdout}`);
    } finally {
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  test("unreadable ActiveEnterTimestampMonotonic fails OPEN — checks proceed and the restart still fires", () => {
    const h = makeLivenessHarness();
    try {
      const r = runServiceLiveness(h, {
        STUB_ACTIVE_AGE_S: "3600",
        STUB_HEALTH_MODE: "fail",
        STUB_SHOW_RAW: "ActiveEnterTimestampMonotonic=(garbage)",
      });

      assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
      assert.match(
        r.stdout,
        /WARN could not determine hydra-orchestrator\.service activation age/,
        `expected the fail-open WARN, got: ${r.stdout}`,
      );
      assert.match(r.stdout, /proceeding with liveness checks/, `expected proceed-line, got: ${r.stdout}`);
      assert.equal(r.restarts.length, 1, `a read failure must not disarm recovery, got: ${r.restarts.join("; ")}`);
    } finally {
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  test("old + healthy: normal path intact (healthy line, no restart) and the deploy-lock probe does not LEAK the lock", () => {
    const h = makeLivenessHarness();
    try {
      const r = runServiceLiveness(h, { STUB_ACTIVE_AGE_S: "3600", STUB_HEALTH_MODE: "ok" });

      assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
      assert.deepEqual(r.restarts, [], `a healthy service must not be restarted, got: ${r.restarts.join("; ")}`);
      assert.match(r.stdout, /healthy \(/, `expected the healthy summary line, got: ${r.stdout}`);

      // The lock probe acquires-and-releases inside a subshell: the watchdog
      // must never HOLD the deploy lock (a held lock would block the next
      // real deploy for its whole tick). Prove the lock is free right after
      // the block ran.
      const probe = spawnSync("bash", ["-c", `flock -n ${JSON.stringify(h.lockFile)} true`], {
        encoding: "utf-8",
        timeout: WATCHDOG_SPAWN_TIMEOUT_MS,
      });
      assert.equal(probe.status, 0, `deploy lock must be free after a watchdog tick, got exit ${probe.status}`);
    } finally {
      rmSync(h.dir, { recursive: true, force: true });
    }
  });
});

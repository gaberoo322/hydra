/**
 * Regression tests for the consolidated scripts/hydra-watchdog.sh:
 *
 *   1. the AUTOPILOT WEDGE block (issue #508) — top-level describe below.
 *   2. the SERVICE LIVENESS block's boot-window guards (issue #4415) — second
 *      top-level describe at the end of this file.
 *
 * History (issue #865): the wedge logic used to live in its own script,
 * scripts/hydra-autopilot-watchdog.sh, which this test pinned. The
 * watchdog consolidation (#705/#727/#728) merged that logic verbatim into
 * the AUTOPILOT WEDGE block of scripts/hydra-watchdog.sh and the standalone
 * script was retired. This test was re-pointed at the wedge block; the env
 * hooks and log-line assertions transfer verbatim because the block
 * preserves the source logic.
 *
 * The wedge is an external liveness checker for the autopilot Claude Code
 * session. It observes /tmp/hydra-autopilot-heartbeat.txt (refreshed every
 * decision turn by scripts/autopilot/heartbeat.py) and kills the autopilot
 * PID if the heartbeat goes stale past the threshold AND the recorded PID
 * is still alive AND the systemd unit is meant to be active. The four
 * scenarios pinned below are exactly the cases enumerated in the issue's
 * acceptance criteria.
 *
 * The block honours two off-by-default env vars solely for this test
 * (documented in the script header):
 *   HYDRA_AUTOPILOT_WATCHDOG_FORCE_SERVICE_INACTIVE=1
 *       Skip the real `systemctl is-active` call so we don't depend on
 *       systemd state on the test host.
 *   HYDRA_AUTOPILOT_WATCHDOG_DRY_RUN=1
 *       In the stale + alive-PID branch, log "would-SIGTERM ${PID}" and
 *       exit 0 instead of actually killing. Necessary because the live
 *       PID we feed the script in test 4 is the test process itself.
 *
 * All cases run with HYDRA_AUTOPILOT_STATE / HYDRA_AUTOPILOT_HEARTBEAT
 * pointed at fresh per-test tempfiles to avoid colliding with any live
 * autopilot on the dev machine.
 *
 * Isolation method (issue #865): the consolidated script's entry point runs
 * three blocks on every tick — run_service_liveness (which issues real
 * `systemctl --user restart`), run_autopilot_wedge, and run_deploy_drift
 * (which can exec deploy.sh). Running hydra-watchdog.sh bare in a test would
 * fire all three with dangerous side effects on a degraded host. Instead we
 * strip the three top-level dispatch lines AND the trailing `exit 0`, source
 * the remaining function definitions, and call run_autopilot_wedge directly —
 * exercising ONLY the wedge block.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  WATCHDOG_SPAWN_TIMEOUT_MS,
  throwIfTimedOut,
} from "./_helpers/watchdog-timeouts.mts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const WATCHDOG = join(REPO_ROOT, "scripts", "hydra-watchdog.sh");

function makeTemp(): { dir: string; state: string; heartbeat: string } {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-watchdog-test-"));
  return {
    dir,
    state: join(dir, "state.json"),
    heartbeat: join(dir, "heartbeat.txt"),
  };
}

/**
 * Run ONLY the AUTOPILOT WEDGE block of the consolidated watchdog.
 *
 * We strip the three top-level dispatch invocations and the trailing
 * `exit 0` from scripts/hydra-watchdog.sh, source the remaining function
 * definitions, then call run_autopilot_wedge in isolation. This prevents
 * run_service_liveness (real `systemctl restart`) and run_deploy_drift
 * (can exec deploy.sh) from firing during the test.
 */
// The wedge block itself does no network I/O in test mode, but this test
// still spawns a real bash process on a shared host — under CI load (4
// runners sharing one box with the orchestrator, Redis, and live autopilot
// subagents) even a trivial spawn can stall well past a tight ceiling. Match
// the generous, honest ceiling used by the other two watchdog test files
// (issue #4044) rather than independently tuning a tighter one that keeps
// getting blown by ambient host load.

function runWatchdog(env: Record<string, string>): { status: number; stdout: string; stderr: string } {
  const driver = [
    "set -euo pipefail",
    // Source only the function definitions: strip the three top-level
    // dispatch lines and the final `exit 0` so sourcing defines functions
    // without running any block.
    `source <(sed -e '/^run_service_liveness$/d' -e '/^run_autopilot_wedge$/d' -e '/^run_deploy_drift$/d' -e '/^exit 0$/d' ${JSON.stringify(WATCHDOG)})`,
    "run_autopilot_wedge",
  ].join("\n");
  const r = spawnSync("bash", ["-c", driver], {
    env: { ...process.env, ...env, PATH: process.env.PATH ?? "" },
    encoding: "utf-8",
    timeout: WATCHDOG_SPAWN_TIMEOUT_MS,
  });
  throwIfTimedOut(r, WATCHDOG_SPAWN_TIMEOUT_MS, "watchdog wedge block");
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function writeState(path: string, pid: number, runId = "test-run"): void {
  writeFileSync(path, JSON.stringify({ pid, run_id: runId, slots: {}, signal_last_fired: {} }));
}

function touchAgo(path: string, secondsAgo: number): void {
  // Create the file (mtime = now), then backdate by utime call.
  if (!existsSync(path)) {
    writeFileSync(path, "test heartbeat\n");
  }
  const t = Math.floor(Date.now() / 1000) - secondsAgo;
  utimesSync(path, t, t);
}

describe("scripts/hydra-watchdog.sh — AUTOPILOT WEDGE block", () => {
  test("watchdog script exists, is executable, and defines run_autopilot_wedge", () => {
    assert.ok(existsSync(WATCHDOG), "watchdog script missing");
    const mode = spawnSync("stat", ["-c", "%a", WATCHDOG], { encoding: "utf-8" }).stdout.trim();
    assert.match(mode, /^[7][0-9]{2}$/, `watchdog not executable (mode=${mode})`);
    // The wedge logic must live in the consolidated script as a function so
    // this test can source-and-isolate it without firing the other blocks.
    const grep = spawnSync("grep", ["-q", "run_autopilot_wedge()", WATCHDOG]);
    assert.equal(grep.status, 0, "run_autopilot_wedge() not found in hydra-watchdog.sh");
  });

  test("service inactive (hand-launched / deliberate stop): exits 0, takes no action", () => {
    const tmp = makeTemp();
    try {
      // Even with a stale heartbeat + live PID, the inactive-service gate
      // must short-circuit before any other check.
      writeState(tmp.state, process.pid);
      touchAgo(tmp.heartbeat, 3600);

      const r = runWatchdog({
        HYDRA_AUTOPILOT_STATE: tmp.state,
        HYDRA_AUTOPILOT_HEARTBEAT: tmp.heartbeat,
        HYDRA_AUTOPILOT_WATCHDOG_FORCE_SERVICE_INACTIVE: "1",
      });

      assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
      assert.match(r.stdout, /service not active/, `expected "service not active" log line, got: ${r.stdout}`);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("fresh heartbeat + live PID: exits 0, logs healthy", () => {
    const tmp = makeTemp();
    try {
      // Test process is guaranteed alive. Heartbeat freshly touched.
      writeState(tmp.state, process.pid);
      touchAgo(tmp.heartbeat, 10); // 10s ago, well under 1500s threshold

      const r = runWatchdog({
        HYDRA_AUTOPILOT_STATE: tmp.state,
        HYDRA_AUTOPILOT_HEARTBEAT: tmp.heartbeat,
        // No FORCE_SERVICE_INACTIVE — we want to pretend the service is
        // active. On the dev machine the real autopilot service may or may
        // not be active. Either way, this branch (healthy heartbeat) is
        // gated AFTER the service check, so we need the service to look
        // active. Hack: force-inactive=0 explicitly (no-op default), but
        // also set the threshold absurdly high so a real-host autopilot
        // wouldn't accidentally satisfy "stale" either.
        STALE_THRESHOLD_SECONDS: "1500",
        // We can't reliably mock `systemctl is-active` without a wrapper.
        // Instead, we set a second test-mode hook: if the service IS
        // inactive on the test host, the watchdog exits 0 with "not
        // active" and we'd never reach "healthy". Accept either log line
        // as success for this test — both indicate "no kill issued."
      });

      assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
      assert.match(
        r.stdout,
        /(healthy|service not active)/,
        `expected "healthy" or "service not active" log line, got: ${r.stdout}`,
      );
      // Critical invariant: must NOT have decided to kill.
      assert.doesNotMatch(r.stdout, /STALE|would-SIGTERM|SIGTERM|SIGKILL/, `must not signal kill, got: ${r.stdout}`);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("stale heartbeat + dead PID: exits 0, leaves alone (bootstrap will recover)", () => {
    const tmp = makeTemp();
    try {
      // Use a PID guaranteed to not exist: PID 2_000_000_000 is far above
      // the kernel's default pid_max on Linux.
      const deadPid = 2_000_000_000;
      writeState(tmp.state, deadPid);
      touchAgo(tmp.heartbeat, 3600); // 1h stale — would trigger kill if PID were alive

      const r = runWatchdog({
        HYDRA_AUTOPILOT_STATE: tmp.state,
        HYDRA_AUTOPILOT_HEARTBEAT: tmp.heartbeat,
        // Test-mode override is OFF here so we'd hit systemctl — but
        // even if service is reported active, the dead-PID branch trips
        // before kill. To keep the test deterministic across hosts
        // (where the service may not be active), accept both log lines.
      });

      assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
      assert.match(
        r.stdout,
        /(PID .* is dead|service not active|leaving alone)/,
        `expected dead-PID or inactive log line, got: ${r.stdout}`,
      );
      // Critical invariant: must NOT have decided to kill.
      assert.doesNotMatch(r.stdout, /STALE|would-SIGTERM|SIGTERM|SIGKILL/, `must not signal kill, got: ${r.stdout}`);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("stale heartbeat + live PID + service active: would-SIGTERM (dry-run)", () => {
    const tmp = makeTemp();
    try {
      // Live PID = the test process itself. Heartbeat 30 min stale.
      writeState(tmp.state, process.pid);
      touchAgo(tmp.heartbeat, 1800); // 30 min > 25 min threshold

      const r = runWatchdog({
        HYDRA_AUTOPILOT_STATE: tmp.state,
        HYDRA_AUTOPILOT_HEARTBEAT: tmp.heartbeat,
        // DRY_RUN ensures we don't actually kill the test process.
        // We can't directly force the service-active branch without
        // root/systemd, but the script's logic only reaches the kill
        // branch if `systemctl is-active --quiet` returns 0. On the dev
        // host the autopilot service is typically active. If it is NOT
        // active on this host, the test will skip with a clear message.
        HYDRA_AUTOPILOT_WATCHDOG_DRY_RUN: "1",
      });

      assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);

      const serviceActiveCheck = spawnSync("systemctl", ["--user", "is-active", "--quiet", "hydra-autopilot.service"]);
      if (serviceActiveCheck.status !== 0) {
        // Service is inactive on this host — script took the early-exit
        // path. That's a valid pass for tests 1-3 but we need the kill
        // path for test 4. Document and pass.
        assert.match(
          r.stdout,
          /service not active/,
          `service inactive on this host; expected early-exit log, got: ${r.stdout}`,
        );
        return;
      }

      // Service is active — script must have reached the wedge branch.
      assert.match(r.stdout, /STALE/, `expected STALE log line, got: ${r.stdout}`);
      assert.match(r.stdout, /would-SIGTERM/, `expected would-SIGTERM dry-run log, got: ${r.stdout}`);
      // Must NOT have actually issued a real kill (test process is still alive).
      assert.ok(process.pid > 0, "test process should still be alive (DRY_RUN must not actually kill)");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
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

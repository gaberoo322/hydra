/**
 * Regression tests for the consolidated watchdog:
 *
 *   1. the AUTOPILOT WEDGE check (issue #508, ported to TypeScript in #5095) —
 *      pure decideWedge + runWedge over an in-memory fake of the typed ports
 *      (src/watchdog/ports.ts). No PATH-shimmed binaries, no env test hooks, no
 *      source-text slicing, and the fake's sleep resolves immediately so the
 *      30 s SIGKILL grace is never waited.
 *   2. the SERVICE LIVENESS check (issue #5096, ported from bash; boot-window
 *      guards #4415) — same shape: pure decide predicates + runLiveness over a
 *      fake. The remaining bash describes only drive hydra-watchdog.sh's
 *      entry-point guard and run_watchdog_cli.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  WATCHDOG_SPAWN_TIMEOUT_MS,
  throwIfTimedOut,
} from "./_helpers/watchdog-timeouts.mts";
import { RESTART_TIMEOUT_MS } from "../src/host-probe/probe.ts";
import { decideWedge, runWedge, type WedgeConfig } from "../src/watchdog/wedge.ts";
import {
  createProductionWedgeDeps,
  parseStatePid,
  probeTunnel,
  readPendingWork,
  readHeartbeatMtimeEpoch,
  type LivenessDeps,
  type WedgeDeps,
  type WedgeState,
} from "../src/watchdog/ports.ts";
import {
  WATCHDOG_STARTUP_GRACE_S,
  decidePendingWork,
  parseStartupGraceS,
  runLiveness,
  type DeliberateStopRead,
  type HealthRead,
  type LivenessConfig,
  type PendingWorkRead,
  type SchedulerRead,
} from "../src/watchdog/liveness.ts";
import { isSchedulerTickStale, schedulerTickAgeS } from "../src/health/tick-liveness.ts";
import {
  SCHEDULER_TICK_STALE_S,
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

  test("heartbeat age comes from file mtime, not an in-file epoch token (SIGKILL gate)", () => {
    const dir = mkdtempSync(join(tmpdir(), "hydra-5095-hb-"));
    try {
      const hb = join(dir, "heartbeat.txt");
      // Token claims a very old epoch; mtime is "now". The bash block read mtime.
      writeFileSync(hb, "epoch=1000000000\n");
      const mtimeS = 1_800_000_000;
      utimesSync(hb, mtimeS, mtimeS);
      assert.equal(readHeartbeatMtimeEpoch(hb), mtimeS);
      const deps = createProductionWedgeDeps(() => {});
      assert.equal(deps.files.heartbeatEpochS(hb), mtimeS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing heartbeat file still reads as null (sibling shape: WARN, never kill)", () => {
    assert.equal(readHeartbeatMtimeEpoch(join(tmpdir(), "hydra-5095-no-such-heartbeat.txt")), null);
    const f = makeFake({ heartbeatAgeS: null });
    return runWedge(f.deps, CONFIG).then((v) => {
      assert.equal(v.kind, "heartbeat-missing");
      assert.deepEqual(f.signals, []);
    });
  });

  test("os-heartbeat.ts declares no threshold and does not import stale-thresholds", () => {
    const src = readFileSync(join(REPO_ROOT, "src", "autopilot", "os-heartbeat.ts"), "utf-8");
    assert.doesNotMatch(src, /stale-thresholds/);
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
// SERVICE LIVENESS (issue #5096, ported from the bash block; boot-window
// guards #4415, pending-work #3794, deliberate-stop #388) — pure predicates +
// runLiveness over an in-memory fake of the typed ports. No bash slicing, no
// PATH shims; the fake records every effect in order.
// =============================================================================

interface LivenessScript {
  serviceActive?: boolean | null;
  tunnelActive?: boolean;
  /** Ping per call: Nth ping() returns pingSeq[N] (last value repeats). */
  pingSeq?: boolean[];
  activationAgeS?: number | null;
  deployLockHeld?: boolean | null;
  health?: HealthRead;
  scheduler?: SchedulerRead;
  deliberateStop?: DeliberateStopRead;
  pendingWork?: PendingWorkRead;
  tunnelReachable?: boolean;
  nowMs?: number;
}

const L_NOW = Date.parse("2026-10-28T12:00:00.000Z");
const HEALTH_OK: HealthRead = { ok: true, status: "ok", redis: true, uptimeS: 3600, cycleRunning: false };
const tickAgo = (s: number): string => new Date(L_NOW - s * 1000).toISOString();
const SCHED_FRESH: SchedulerRead = { ok: true, running: true, lastTickAt: tickAgo(60) };

function makeLivenessFake(script: LivenessScript) {
  const effects: string[] = [];
  const lines: string[] = [];
  const calls = { pendingWork: 0, deployLock: 0, tunnelProbe: 0, deliberateStop: 0 };
  let pings = 0;
  const deps: LivenessDeps = {
    host: {
      serviceActive: async (unit) =>
        unit === "hydra-tunnel.service"
          ? (script.tunnelActive ?? false)
          : script.serviceActive === undefined
            ? true
            : script.serviceActive,
      activationAgeS: async () => (script.activationAgeS === undefined ? 3600 : script.activationAgeS),
      deployLockHeld: async () => {
        calls.deployLock++;
        return script.deployLockHeld === undefined ? false : script.deployLockHeld;
      },
      restartService: async (unit) => {
        effects.push(`restart:${unit}`);
        return true;
      },
      sleep: async () => {},
    },
    http: {
      health: async () => script.health ?? HEALTH_OK,
      schedulerStatus: async () => script.scheduler ?? SCHED_FRESH,
      startScheduler: async () => {
        effects.push("start-scheduler");
        return true;
      },
      tunnelReachable: async () => {
        calls.tunnelProbe++;
        return script.tunnelReachable ?? true;
      },
    },
    redis: {
      ping: async () => {
        const seq = script.pingSeq ?? [true];
        return seq[Math.min(pings++, seq.length - 1)];
      },
      deliberateStop: async () => {
        calls.deliberateStop++;
        return script.deliberateStop ?? "absent";
      },
      close: () => {},
    },
    work: {
      pendingWork: async () => {
        calls.pendingWork++;
        return script.pendingWork ?? { ok: true, total: 0 };
      },
    },
    clock: { nowMs: () => script.nowMs ?? L_NOW },
    log: (l) => lines.push(l),
  };
  return { deps, effects, lines, calls };
}

const LIVENESS_CONFIG: LivenessConfig = {
  unit: "hydra-orchestrator.service",
  dockerUnit: "hydra-docker.service",
  tunnelUnit: "hydra-tunnel.service",
  startupGraceS: 60,
  deployLockPath: "/tmp/hydra-deploy.lock",
  tunnelUrl: "https://example.invalid/api/health",
  tickStaleS: SCHEDULER_TICK_STALE_S,
};

async function liveness(script: LivenessScript, config: Partial<LivenessConfig> = {}) {
  const fake = makeLivenessFake(script);
  const verdict = await runLiveness(fake.deps, { ...LIVENESS_CONFIG, ...config });
  return { verdict, ...fake };
}

describe("watchdog liveness boot-window guards (issue #4415) over fake ports", () => {
  test("(a) fresh start within grace: NO restart even with /health unreachable, reason logged", async () => {
    const r = await liveness({ activationAgeS: 10, health: { ok: false } });
    assert.equal(r.verdict.kind, "boot-grace");
    assert.deepEqual(r.effects, []);
    assert.match(r.lines.join("\n"), /service started 10s ago \(< 60s grace\) — skipping liveness restart this tick/);
    assert.match(r.lines[0], /^hydra-orchestrator-watchdog: /);
  });

  test("(b) deploy lock held: NO restart even for an old service with /health unreachable", async () => {
    const r = await liveness({ deployLockHeld: true, health: { ok: false } });
    assert.equal(r.verdict.kind, "deploy-lock");
    assert.deepEqual(r.effects, []);
    assert.match(r.lines.join("\n"), /deploy in progress \(.*held\) — skipping liveness restart this tick/);
  });

  test("(c) old + unhealthy: restart fires exactly once", async () => {
    const r = await liveness({ health: { ok: false } });
    assert.equal(r.verdict.kind, "health-unreachable");
    assert.deepEqual(r.effects, ["restart:hydra-orchestrator.service"]);
    assert.match(r.lines.join("\n"), /\/api\/health unreachable — restarting/);
  });

  test("grace=0 disarms the guard: a fresh-but-unhealthy service is restarted", async () => {
    const r = await liveness({ activationAgeS: 0, health: { ok: false } }, { startupGraceS: 0 });
    assert.deepEqual(r.effects, ["restart:hydra-orchestrator.service"]);
  });

  test("parseStartupGraceS: non-numeric falls back to 60, 0 is honoured", () => {
    assert.equal(parseStartupGraceS(undefined), WATCHDOG_STARTUP_GRACE_S);
    assert.equal(parseStartupGraceS("abc"), 60);
    assert.equal(parseStartupGraceS("0"), 0);
    assert.equal(parseStartupGraceS("15"), 15);
  });

  test("unreadable activation age fails OPEN: WARN logged, checks proceed, restart still fires", async () => {
    const r = await liveness({ activationAgeS: null, health: { ok: false } });
    assert.equal(r.verdict.kind, "health-unreachable");
    assert.deepEqual(r.effects, ["restart:hydra-orchestrator.service"]);
    assert.match(r.lines.join("\n"), /WARN could not determine .* activation age — proceeding with liveness checks/);
  });

  test("unreadable deploy-lock probe fails OPEN (treated as NOT held)", async () => {
    const r = await liveness({ deployLockHeld: null, health: { ok: false } });
    assert.equal(r.verdict.kind, "health-unreachable");
  });

  test("old + healthy: healthy line names lastTickAt, no restart", async () => {
    const r = await liveness({});
    assert.equal(r.verdict.kind, "healthy");
    assert.deepEqual(r.effects, []);
    assert.match(r.lines.join("\n"), /healthy \(lastTickAt 60s ago, cycle=idle, redis=ok\)/);
    assert.doesNotMatch(r.lines.join("\n"), /lastCycleAt/);
  });
});

describe("watchdog liveness verdicts (decideLiveness / runLiveness over fake ports)", () => {
  test("service inactive: nothing to do, no effect", async () => {
    const r = await liveness({ serviceActive: false });
    assert.equal(r.verdict.kind, "service-inactive");
    assert.deepEqual(r.effects, []);
    assert.match(r.lines.join("\n"), /is not active; nothing to do/);
  });

  test("Redis down then recovered: docker restarted first, then the orchestrator", async () => {
    const r = await liveness({ pingSeq: [false, true] });
    assert.equal(r.verdict.kind, "redis-down");
    assert.deepEqual(r.effects, ["restart:hydra-docker.service", "restart:hydra-orchestrator.service"]);
    assert.match(r.lines.join("\n"), /Redis container not responding \(got: FAILED\) — restarting hydra-docker.service/);
    assert.match(r.lines.join("\n"), /Docker containers recovered — restarting orchestrator/);
  });

  test("Redis down and NOT recovered: docker restart only, manual-intervention line", async () => {
    const r = await liveness({ pingSeq: [false, false] });
    assert.deepEqual(r.effects, ["restart:hydra-docker.service"]);
    assert.match(r.lines.join("\n"), /Docker recovery FAILED — manual intervention needed/);
  });

  test("Redis check runs BEFORE the boot-window guards (a fresh start with Redis down still recovers)", async () => {
    const r = await liveness({ pingSeq: [false, false], activationAgeS: 1 });
    assert.equal(r.verdict.kind, "redis-down");
  });

  test("health not ok / redis=false each restart exactly once", async () => {
    const a = await liveness({ health: { ok: true, status: "degraded", redis: true, uptimeS: 900, cycleRunning: false } });
    assert.equal(a.verdict.kind, "health-not-ok");
    assert.deepEqual(a.effects, ["restart:hydra-orchestrator.service"]);
    assert.match(a.lines.join("\n"), /\/health returned status='degraded' \(not 'ok'\) — restarting/);
    const b = await liveness({ health: { ok: true, status: "ok", redis: false, uptimeS: 900, cycleRunning: false } });
    assert.equal(b.verdict.kind, "health-redis-false");
    assert.deepEqual(b.effects, ["restart:hydra-orchestrator.service"]);
  });

  test("scheduler status unreachable restarts the service", async () => {
    const r = await liveness({ scheduler: { ok: false } });
    assert.equal(r.verdict.kind, "sched-unreachable");
    assert.deepEqual(r.effects, ["restart:hydra-orchestrator.service"]);
  });

  test("deliberate stop (marker present): leave alone, work is never read", async () => {
    const r = await liveness({ scheduler: { ok: true, running: false, lastTickAt: null }, deliberateStop: "present" });
    assert.equal(r.verdict.kind, "sched-deliberate-stop");
    assert.deepEqual(r.effects, []);
    assert.equal(r.calls.pendingWork, 0);
  });

  test("deliberate stop 'unreadable' means leave alone (fail-open direction is NO restart)", async () => {
    const r = await liveness({ scheduler: { ok: true, running: false, lastTickAt: null }, deliberateStop: "unreadable" });
    assert.equal(r.verdict.kind, "sched-deliberate-stop");
    assert.deepEqual(r.effects, []);
    assert.equal(r.calls.pendingWork, 0);
  });

  test("stopped scheduler inside the startup window: leave alone, work not read", async () => {
    const r = await liveness({
      scheduler: { ok: true, running: false, lastTickAt: null },
      health: { ok: true, status: "ok", redis: true, uptimeS: 120, cycleRunning: false },
    });
    assert.equal(r.verdict.kind, "sched-stopped-startup-window");
    assert.deepEqual(r.effects, []);
    assert.equal(r.calls.pendingWork, 0);
    assert.match(r.lines.join("\n"), /scheduler not yet running \(startup window, uptime 120s\); leaving alone/);
  });

  test("pending work three-way: work>0 starts the scheduler, 0 leaves alone, read failed starts it (fail-safe)", async () => {
    const stopped: LivenessScript = { scheduler: { ok: true, running: false, lastTickAt: null } };
    const withWork = await liveness({ ...stopped, pendingWork: { ok: true, total: 4 } });
    assert.deepEqual(withWork.effects, ["start-scheduler"]);
    assert.match(withWork.lines.join("\n"), /scheduler stopped but 4 items waiting .* restarting scheduler via API/);
    const none = await liveness({ ...stopped, pendingWork: { ok: true, total: 0 } });
    assert.deepEqual(none.effects, []);
    assert.match(none.lines.join("\n"), /scheduler stopped, no work pending \(board\+queue=0\); leaving alone/);
    const failed = await liveness({ ...stopped, pendingWork: { ok: false } });
    assert.deepEqual(failed.effects, ["start-scheduler"]);
    assert.match(failed.lines.join("\n"), /work-signal read FAILED — cannot prove no work pending/);
  });

  test("decidePendingWork: a failed read is never 'no work' (issue #3794 hard rule)", () => {
    assert.equal(decidePendingWork({ ok: false }).kind, "sched-stopped-restart");
    assert.equal(decidePendingWork({ ok: true, total: 0 }).kind, "sched-stopped-no-work");
    assert.equal(decidePendingWork({ ok: true, total: 1 }).kind, "sched-stopped-restart");
  });

  test("running scheduler with null lastTickAt: fresh restart, leave alone", async () => {
    const r = await liveness({ scheduler: { ok: true, running: true, lastTickAt: null } });
    assert.equal(r.verdict.kind, "tick-null");
    assert.deepEqual(r.effects, []);
  });

  test("stale tick + cycle in progress: leave alone", async () => {
    const r = await liveness({
      scheduler: { ok: true, running: true, lastTickAt: tickAgo(2000) },
      health: { ok: true, status: "ok", redis: true, uptimeS: 3600, cycleRunning: true },
    });
    assert.equal(r.verdict.kind, "cycle-running");
    assert.deepEqual(r.effects, []);
  });

  test("unparseable lastTickAt and negative age are left alone", async () => {
    const bad = await liveness({ scheduler: { ok: true, running: true, lastTickAt: "not-a-date" } });
    assert.equal(bad.verdict.kind, "tick-unparseable");
    assert.match(bad.lines.join("\n"), /could not parse lastTickAt='not-a-date'/);
    const skew = await liveness({ scheduler: { ok: true, running: true, lastTickAt: tickAgo(-120) } });
    assert.equal(skew.verdict.kind, "clock-skew");
    assert.deepEqual([...bad.effects, ...skew.effects], []);
  });

  test("stale tick (> 900s) with no cycle: restarts the orchestrator once; exactly 900s is NOT stale", async () => {
    const stale = await liveness({ scheduler: { ok: true, running: true, lastTickAt: tickAgo(901) } });
    assert.equal(stale.verdict.kind, "stale");
    assert.deepEqual(stale.effects, ["restart:hydra-orchestrator.service"]);
    assert.match(stale.lines.join("\n"), /STALE — lastTickAt was 901s ago \(> 900s\) and no cycle in progress/);
    const edge = await liveness({ scheduler: { ok: true, running: true, lastTickAt: tickAgo(900) } });
    assert.equal(edge.verdict.kind, "healthy");
  });

  test("tunnel three-way runs ONLY on healthy: inactive / ok / unreachable -> restart", async () => {
    const inactive = await liveness({ tunnelActive: false });
    assert.deepEqual(inactive.effects, []);
    assert.equal(inactive.calls.tunnelProbe, 0);
    const ok = await liveness({ tunnelActive: true, tunnelReachable: true });
    assert.deepEqual(ok.effects, []);
    assert.equal(ok.calls.tunnelProbe, 1);
    const down = await liveness({ tunnelActive: true, tunnelReachable: false });
    assert.deepEqual(down.effects, ["restart:hydra-tunnel.service"]);
    assert.match(down.lines.join("\n"), /tunnel unreachable externally but orchestrator healthy — restarting hydra-tunnel.service/);
    const unhealthy = await liveness({ tunnelActive: true, tunnelReachable: false, health: { ok: false } });
    assert.equal(unhealthy.calls.tunnelProbe, 0);
  });

  test("every leave-alone kind records no effect; every restart kind records exactly one", async () => {
    const leave: LivenessScript[] = [
      { serviceActive: false },
      { activationAgeS: 5 },
      { deployLockHeld: true },
      { scheduler: { ok: true, running: true, lastTickAt: null } },
    ];
    for (const s of leave) assert.deepEqual((await liveness(s)).effects, []);
    const restart: LivenessScript[] = [
      { health: { ok: false } },
      { scheduler: { ok: false } },
      { scheduler: { ok: true, running: true, lastTickAt: tickAgo(5000) } },
    ];
    for (const s of restart) assert.equal((await liveness(s)).effects.length, 1);
  });

  test("the pending-work read has exactly one call site in src/watchdog (never on the hot tick); no child_process", () => {
    const src = readFileSync(join(REPO_ROOT, "src", "watchdog", "liveness.ts"), "utf-8");
    assert.equal((src.match(/work\.pendingWork\(\)/g) ?? []).length, 1);
    assert.ok(!/node:child_process/.test(src), "liveness.ts must not import node:child_process");
    const ports = readFileSync(join(REPO_ROOT, "src", "watchdog", "ports.ts"), "utf-8");
    assert.ok(!/from "node:child_process"/.test(ports), "ports.ts must not import node:child_process");
    const cli = readFileSync(WATCHDOG_CLI, "utf-8");
    assert.ok(!/from "node:child_process"/.test(cli), "the CLI must not import node:child_process");
  });

  test("thresholds JSON carries schedulerTickStaleS and the tick predicate is strict >", () => {
    assert.equal(SCHEDULER_TICK_STALE_S, 900);
    assert.equal(staleThresholdsJson().schedulerTickStaleS, 900);
    assert.equal(isSchedulerTickStale(900, 900), false);
    assert.equal(isSchedulerTickStale(901, 900), true);
    assert.equal(schedulerTickAgeS(null, L_NOW), null);
    assert.equal(schedulerTickAgeS("", L_NOW), null);
    assert.equal(schedulerTickAgeS("garbage", L_NOW), "unparseable");
    assert.equal(schedulerTickAgeS(tickAgo(30), L_NOW), 30);
    assert.equal(schedulerTickAgeS(tickAgo(-30), L_NOW), -30);
  });
});

describe("scripts/hydra-watchdog.sh — entry-point guard and CLI wiring (issue #3794 / #5096)", () => {
  test("sourcing the script does NOT run the tick blocks (entry-point guard)", () => {
    const r = spawnSync("bash", ["-c", `source ${JSON.stringify(WATCHDOG)}`], {
      encoding: "utf-8",
      timeout: WATCHDOG_SPAWN_TIMEOUT_MS,
    });
    throwIfTimedOut(r, WATCHDOG_SPAWN_TIMEOUT_MS, "sourcing hydra-watchdog.sh");
    assert.equal(r.status, 0, `source should exit 0; stderr=${r.stderr}`);
    assert.doesNotMatch(r.stdout, /hydra-(orchestrator|autopilot|deploy-drift)-watchdog:/);
  });

  test("the bash liveness block is deleted; the entry point runs the liveness CLI before the wedge CLI", () => {
    const src = readFileSync(WATCHDOG, "utf-8");
    assert.ok(!/run_service_liveness|read_pending_work/.test(src.replace(/^\s*#.*$/gm, "")), "no bash liveness code remains");
    assert.ok(src.indexOf("  run_liveness_cli\n  run_wedge_cli") > 0, "liveness runs first, then wedge");
    assert.match(src, /run_watchdog_cli liveness "hydra-orchestrator-watchdog:" 300/);
    assert.match(src, /run_watchdog_cli wedge "hydra-autopilot-watchdog:" 90/);
  });

  test("a failing CLI is ONE WARN line and rc 0 (never an aborted tick)", () => {
    const root = mkdtempSync(join(tmpdir(), "liveness-cli-fail-"));
    try {
      const failing = join(root, "node");
      writeFileSync(failing, "#!/bin/sh\nexit 7\n");
      chmodSync(failing, 0o755);
      const r = spawnSync("bash", ["-c", 'set -euo pipefail; source "$1"; run_liveness_cli', "x", WATCHDOG], {
        env: { ...process.env, HYDRA_WATCHDOG_NODE: failing, HYDRA_ROOT: REPO_ROOT },
        encoding: "utf-8",
        timeout: WATCHDOG_SPAWN_TIMEOUT_MS,
      });
      throwIfTimedOut(r, WATCHDOG_SPAWN_TIMEOUT_MS, "run_liveness_cli");
      assert.equal(r.status, 0);
      assert.equal(
        r.stdout.trim(),
        "hydra-orchestrator-watchdog: WARN liveness CLI FAILED (rc=7) — liveness check skipped this tick",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("scripts/hydra-watchdog.sh — run_wedge_cli resolves node without the unit PATH (issue #5095)", () => {
  /** A PATH holding only the coreutils the resolver needs — deliberately NO node. */
  function nodelessPathDir(root: string): string {
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    for (const tool of ["bash", "timeout", "ls", "sort", "tail", "dirname", "env"]) {
      const found = spawnSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf-8" }).stdout.trim();
      if (found) symlinkSync(found, join(bin, tool));
    }
    return bin;
  }

  function runWedgeCli(env: Record<string, string>, path: string): { status: number; stdout: string } {
    const r = spawnSync("bash", ["-c", 'set -euo pipefail; source "$1"; run_wedge_cli', "wedge-cli", WATCHDOG], {
      env: { ...env, PATH: path },
      encoding: "utf-8",
      timeout: WATCHDOG_SPAWN_TIMEOUT_MS,
    });
    throwIfTimedOut(r, WATCHDOG_SPAWN_TIMEOUT_MS, "watchdog run_wedge_cli");
    return { status: r.status ?? -1, stdout: r.stdout ?? "" };
  }

  function fakeNode(path: string): void {
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, '#!/bin/sh\necho "FAKE-NODE-RAN $*"\n');
    chmodSync(path, 0o755);
  }

  test("node absent from PATH: falls back to the newest ~/.nvm node and actually runs the CLI", () => {
    const root = mkdtempSync(join(tmpdir(), "wedge-cli-nvm-"));
    try {
      fakeNode(join(root, "home", ".nvm", "versions", "node", "v20.0.0", "bin", "node"));
      fakeNode(join(root, "home", ".nvm", "versions", "node", "v22.23.1", "bin", "node"));
      const r = runWedgeCli({ HOME: join(root, "home"), HYDRA_ROOT: REPO_ROOT }, nodelessPathDir(root));
      assert.equal(r.status, 0);
      assert.match(r.stdout, /FAKE-NODE-RAN --experimental-strip-types .*scripts\/hydra-watchdog\.ts wedge/);
      assert.doesNotMatch(r.stdout, /WARN/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("HYDRA_WATCHDOG_NODE override wins over the nvm fallback", () => {
    const root = mkdtempSync(join(tmpdir(), "wedge-cli-override-"));
    try {
      fakeNode(join(root, "home", ".nvm", "versions", "node", "v22.23.1", "bin", "node"));
      const pinned = join(root, "pinned", "node");
      fakeNode(pinned);
      const r = runWedgeCli(
        { HOME: join(root, "home"), HYDRA_ROOT: REPO_ROOT, HYDRA_WATCHDOG_NODE: pinned },
        nodelessPathDir(root),
      );
      assert.equal(r.status, 0);
      assert.match(r.stdout, /FAKE-NODE-RAN/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("sibling shape: no node anywhere is still a WARN and rc 0, never a failed tick", () => {
    const root = mkdtempSync(join(tmpdir(), "wedge-cli-none-"));
    try {
      mkdirSync(join(root, "home"), { recursive: true });
      const r = runWedgeCli({ HOME: join(root, "home"), HYDRA_ROOT: REPO_ROOT }, nodelessPathDir(root));
      assert.equal(r.status, 0);
      assert.match(r.stdout, /WARN node not found/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("watchdog liveness production adapters (issue #5096 QA round 1)", () => {
  const rows = (labels: string[], n: number) =>
    ({ kind: "ok", data: Array.from({ length: n }, (_, i) => ({ number: i + 1, labels: labels.map((name) => ({ name })) })) }) as const;
  const fakeGithub = (byLabel: Record<string, unknown>) => ({
    async openIssueLabelsWithLabel(label: string, limit: number) {
      assert.equal(limit, 100);
      return byLabel[label] as never;
    },
  });

  test("pendingWork reads each label separately, so >100 unrelated open issues cannot hide actionable work", async () => {
    const seen: string[] = [];
    const gh = {
      async openIssueLabelsWithLabel(label: string) {
        seen.push(label);
        return (label === "needs-triage" ? rows(["needs-triage"], 2) : { kind: "ok", data: [] }) as never;
      },
    };
    const r = await readPendingWork({ github: gh, readQueue: async () => 1, log: () => {} });
    assert.deepEqual(seen.sort(), ["needs-research", "needs-triage", "ready-for-agent"]);
    assert.deepEqual(r, { ok: true, total: 3 });
  });

  test("pendingWork: a failed per-label read is ok:false, never zero work", async () => {
    const r = await readPendingWork({
      github: fakeGithub({ "ready-for-agent": { kind: "empty" }, "needs-research": { kind: "ok", data: [] }, "needs-triage": { kind: "ok", data: [] } }),
      readQueue: async () => 0,
      log: () => {},
    });
    assert.deepEqual(r, { ok: false });
  });

  test("pendingWork sibling: a healthy all-empty board is ok with total 0", async () => {
    const empty = { kind: "ok", data: [] };
    const r = await readPendingWork({
      github: fakeGithub({ "ready-for-agent": empty, "needs-research": empty, "needs-triage": empty }),
      readQueue: async () => 0,
      log: () => {},
    });
    assert.deepEqual(r, { ok: true, total: 0 });
  });

  test("probeTunnel: any HTTP response (5xx, 403, 302) is reachable", async () => {
    for (const status of [500, 403, 302, 200]) {
      const f = (async () => new Response(null, { status })) as unknown as typeof fetch;
      assert.equal(await probeTunnel("http://x", f), true, `status ${status}`);
    }
  });

  test("probeTunnel: a transport error rejects (caller maps it to unreachable)", async () => {
    const f = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await assert.rejects(probeTunnel("http://x", f));
  });
});

describe("liveness CLI wrapper budget nests the restart cap (#5096 QA round 2)", () => {
  const sh = readFileSync(resolve(import.meta.dirname, "../scripts/hydra-watchdog.sh"), "utf8");
  const wrapperS = (name: string): number => {
    const m = sh.match(new RegExp(`run_${name}_cli\\(\\) \\{ run_watchdog_cli ${name} "[^"]+" (\\d+);`));
    assert.ok(m, `run_${name}_cli not found`);
    return Number(m[1]);
  };

  test("liveness wrapper exceeds two restarts + 5s settle (redis-down worst case)", () => {
    assert.ok(wrapperS("liveness") * 1000 > 2 * RESTART_TIMEOUT_MS + 5_000 + 10_000);
  });

  test("sibling: wedge wrapper stays 90s", () => {
    assert.equal(wrapperS("wedge"), 90);
  });

  test("no src/health file mentions the retired lastCycleAt identifier", () => {
    const out = spawnSync("grep", ["-rn", "lastCycleAt", resolve(import.meta.dirname, "../src/health")], { encoding: "utf8" });
    assert.equal(out.stdout.trim(), "");
  });
});

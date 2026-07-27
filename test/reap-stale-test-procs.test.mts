/**
 * Regression tests for scripts/reap-stale-test-procs.sh (issue #3730).
 *
 * Background — the P1 incident. The reaper's help text promised a spare for
 * "any current systemd-managed hydra-* unit", but `has_live_hydra_ancestor()`
 * only pattern-matched ancestor COMMAND LINES. A systemd service's ancestor is
 * the systemd manager and its own cmd is arbitrary (`npm exec next start
 * --port 3333`), so the promised spare never fired — every run logged
 * `spared=0` — and the hourly `--apply` timer SIGKILLed the production Target
 * web server (hydra-betting-web.service) 23 times in 24 hours.
 *
 * The fix is a systemd-SUPERVISION spare, checked before the age filter. Note
 * it is deliberately NOT "is a member of a .service cgroup": every process an
 * autopilot Claude session spawns inherits the `hydra-autopilot.service`
 * cgroup, including exactly the leaked tsx grandchildren issue #226 exists to
 * reap, so a membership test would neuter the reaper. A process is spared only
 * when it IS its cgroup unit's MainPID or a still-live descendant of it.
 *
 * These tests drive the real script end to end through its three fixture seams
 * (`HYDRA_REAP_PROC_ROOT`, `HYDRA_REAP_PS_SNAPSHOT`, `HYDRA_REAP_UNIT_MAINPID`)
 * so BOTH directions are pinned — spare the supervised service, still kill the
 * genuinely leaked tsx — without spawning or killing a single real process.
 * Every run passes `--dry-run`, and every fixture pid is above the kernel's
 * pid_max ceiling so it can never collide with a live process on the host.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPT_PATH = join(REPO_ROOT, "scripts/reap-stale-test-procs.sh");

/**
 * Fixture pids sit above the kernel pid_max ceiling (default 4194304), so
 * `ps -p <pid>` is guaranteed to return nothing: the ancestor walks resolve to
 * "no living ancestor", which is precisely the leaked-process condition, and no
 * assertion can ever be perturbed by a real process on the host.
 */
const PID_WEB = 9000001; // hydra-betting-web.service MainPID — must be spared
const PID_LEAK_NO_UNIT = 9000002; // leaked tsx, no service cgroup — must die
const PID_LEAK_IN_UNIT = 9000003; // leaked tsx inside a service cgroup — must die
const PID_YOUNG = 9000004; // below --max-age — neither spared nor killed
const PID_MANAGER_SLICE = 9000005; // sits directly in user@<uid>.service

/**
 * A leaked process has been reparented to init, so its ppid is 1. Ancestry is
 * read from the ps snapshot (issue #3732), so `ppid` is now a load-bearing
 * fixture field rather than something the walk discovers from the live host.
 */
const PID_INIT = 1;

const USER_SLICE = "/user.slice/user-1000.slice/user@1000.service/app.slice";

type ProcFixture = {
  /**
   * `pid|ppid|pgid|age_seconds|cmd` record fed to the script's ps seam.
   *
   * `ppid` joined the record in issue #3732: the reaper now resolves ancestry,
   * process-group membership and descendants from this one snapshot instead of
   * forking `ps -p` per level, which is what makes a synthetic CI-runner
   * process tree expressible as a fixture at all.
   */
  record: string;
  /** pid whose /proc/<pid>/cgroup file the fixture creates. */
  pid: number;
  /** contents of that cgroup file, or null to omit the file entirely. */
  cgroup: string | null;
};

type ReaperRun = {
  stdout: string;
  staleLines: string[];
  /** `PLAN pid=… plan=… targets=…` lines — the script's declared blast radius. */
  planLines: string[];
  summary: string;
  /**
   * Kill targets recorded by the HYDRA_REAP_KILL_SINK seam (issue #3732).
   * `-N` is a process-group target, a bare number is a single pid. Empty on a
   * dry run, which is itself an assertion worth making.
   */
  killTargets: string[];
};

type ReaperOpts = {
  /** Run with --apply instead of --dry-run, recording targets in the kill sink. */
  apply?: boolean;
  /** Pids the script must treat as already exited at kill time. */
  vanished?: number[];
};

/**
 * Materialise a fixture /proc tree + snapshot files, run the real script under
 * --dry-run, and return its output. Cleans up the temp dir before returning.
 *
 * Passing `unitMainPids: null` leaves HYDRA_REAP_UNIT_MAINPID UNSET, so the
 * script consults the REAL `systemctl`. That is how the systemd-query-failure
 * path is exercised for real (issue #3730 QA: every test previously drove the
 * fixture branch, which is exactly why the fail-open bug got through) — combine
 * it with a broken D-Bus address in `extraEnv`.
 */
function runReaper(
  procs: ProcFixture[],
  unitMainPids: Record<string, number> | null,
  extraArgs: string[] = [],
  extraEnv: Record<string, string> = {},
  opts: ReaperOpts = {},
): ReaperRun {
  const dir = mkdtempSync(join(tmpdir(), "hydra-reap-fixture-"));
  try {
    const procRoot = join(dir, "proc");
    for (const p of procs) {
      if (p.cgroup === null) continue;
      const pidDir = join(procRoot, String(p.pid));
      mkdirSync(pidDir, { recursive: true });
      writeFileSync(join(pidDir, "cgroup"), `${p.cgroup}\n`);
    }
    mkdirSync(procRoot, { recursive: true });

    const snapshotPath = join(dir, "ps-snapshot");
    writeFileSync(snapshotPath, procs.map((p) => p.record).join("\n") + "\n");

    const killSinkPath = join(dir, "kill-sink");
    writeFileSync(killSinkPath, "");

    const env: Record<string, string | undefined> = {
      ...process.env,
      HYDRA_REAP_PROC_ROOT: procRoot,
      HYDRA_REAP_PS_SNAPSHOT: snapshotPath,
      // Always seamed, never conditional: a dry run must record ZERO targets,
      // and that is only assertable if the sink is armed on every run.
      HYDRA_REAP_KILL_SINK: killSinkPath,
      HYDRA_REAP_VANISHED_PIDS: (opts.vanished ?? []).join(","),
      ...extraEnv,
    };
    if (unitMainPids === null) {
      delete env.HYDRA_REAP_UNIT_MAINPID;
    } else {
      const mainPidPath = join(dir, "unit-mainpids");
      writeFileSync(
        mainPidPath,
        Object.entries(unitMainPids)
          .map(([unit, pid]) => `${unit}\t${pid}`)
          .join("\n") + "\n",
      );
      env.HYDRA_REAP_UNIT_MAINPID = mainPidPath;
    }

    const mode = opts.apply ? "--apply" : "--dry-run";
    const res = spawnSync("bash", [SCRIPT_PATH, mode, ...extraArgs], {
      encoding: "utf-8",
      env,
    });
    assert.equal(res.status, 0, `script must always exit 0; stderr: ${res.stderr}`);
    const stdout = res.stdout ?? "";
    const staleLines = stdout.split("\n").filter((l) => l.includes("STALE pid="));
    const planLines = stdout.split("\n").filter((l) => l.includes("PLAN pid="));
    const summary = stdout.split("\n").find((l) => l.includes("considered=")) ?? "";
    assert.ok(summary, `expected a summary line; got: ${stdout}`);
    const killTargets = readFileSync(killSinkPath, "utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    return { stdout, staleLines, planLines, summary, killTargets };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Pull a `key=value` count out of the summary line. */
function summaryCount(summary: string, key: string): number {
  const m = summary.match(new RegExp(`${key}=(\\d+)`));
  assert.ok(m, `summary must report ${key}=; got: ${summary}`);
  return Number(m![1]);
}

const webServerProc: ProcFixture = {
  // Age 388s is deliberately BELOW the 30-minute --max-age: a spare that only
  // fired after the age filter would leave this counted as below-age, not
  // spared. This is the ordering pin.
  record: `${PID_WEB}|${PID_INIT}|${PID_WEB}|388|npm exec next start --port 3333`,
  pid: PID_WEB,
  cgroup: `0::${USER_SLICE}/hydra-betting-web.service`,
};

const leakedTsxNoUnitProc: ProcFixture = {
  record: `${PID_LEAK_NO_UNIT}|${PID_INIT}|${PID_LEAK_NO_UNIT}|7200|node /home/gabe/hydra/node_modules/.bin/tsx watch src/index.ts`,
  pid: PID_LEAK_NO_UNIT,
  // An interactive-session scope, not a service: nothing supervises this.
  cgroup: "0::/user.slice/user-1000.slice/user@1000.service/session-3.scope",
};

const leakedTsxInUnitProc: ProcFixture = {
  record: `${PID_LEAK_IN_UNIT}|${PID_INIT}|${PID_LEAK_IN_UNIT}|7200|node /home/gabe/hydra/node_modules/.bin/tsx src/mutate.ts`,
  pid: PID_LEAK_IN_UNIT,
  // Inherited the autopilot service cgroup at fork and kept it after being
  // reparented to init — the exact issue-#226 leak shape.
  cgroup: `0::${USER_SLICE}/hydra-autopilot.service`,
};

describe("scripts/reap-stale-test-procs.sh — systemd-supervision spare (issue #3730)", () => {
  test("spares a service's MainPID and names the unit, regardless of age", () => {
    const run = runReaper([webServerProc], {
      "hydra-betting-web.service": PID_WEB,
    });

    assert.ok(
      !run.stdout.includes(`STALE pid=${PID_WEB}`),
      `the production web server must never be listed STALE; got: ${run.stdout}`,
    );
    assert.match(
      run.stdout,
      new RegExp(`SPARE pid=${PID_WEB} unit=hydra-betting-web\\.service reason=systemd-mainpid`),
      "the spare must be logged with the unit that supervises the pid",
    );
    assert.equal(summaryCount(run.summary, "spared"), 1, "summary must report it spared");
    assert.equal(summaryCount(run.summary, "would-kill"), 0);
    // The pid is younger than --max-age, so if the supervision check ran AFTER
    // the age filter this would land in below-age with spared=0.
    assert.equal(
      summaryCount(run.summary, "below-age"),
      0,
      "the supervision spare must be checked BEFORE the age filter",
    );
  });

  test("still kills a genuinely leaked tsx with no service cgroup (does not regress #226)", () => {
    const run = runReaper([leakedTsxNoUnitProc], {});

    assert.equal(run.staleLines.length, 1, `expected exactly one STALE line; got: ${run.stdout}`);
    assert.match(run.staleLines[0], new RegExp(`STALE pid=${PID_LEAK_NO_UNIT}`));
    assert.equal(summaryCount(run.summary, "spared"), 0);
    assert.equal(summaryCount(run.summary, "would-kill"), 1);
  });

  test("service-cgroup MEMBERSHIP alone does not spare — a leaked tsx in the autopilot cgroup is still reaped", () => {
    // This is the case that makes the naive "spare any .service cgroup member"
    // fix wrong: the leak inherited hydra-autopilot.service's cgroup, but the
    // unit's MainPID is the Claude session, which is not this pid and not an
    // ancestor of it (its parents are gone).
    const run = runReaper([leakedTsxInUnitProc], {
      "hydra-autopilot.service": 9000099,
    });

    assert.equal(
      run.staleLines.length,
      1,
      `a leaked process inside a service cgroup must still be reaped; got: ${run.stdout}`,
    );
    assert.match(run.staleLines[0], new RegExp(`STALE pid=${PID_LEAK_IN_UNIT}`));
    assert.equal(summaryCount(run.summary, "spared"), 0);
    assert.equal(summaryCount(run.summary, "would-kill"), 1);
  });

  test("the per-user systemd manager (user@<uid>.service) is never treated as a supervisor", () => {
    // The manager's MainPID is an ancestor of essentially everything in the
    // session, so honouring it as a supervisor would spare every leak on the
    // host. Even when the fixture names it explicitly, it must not spare.
    const run = runReaper(
      [
        {
          record: `${PID_MANAGER_SLICE}|${PID_INIT}|${PID_MANAGER_SLICE}|7200|npm exec some-leaked-tool`,
          pid: PID_MANAGER_SLICE,
          cgroup: "0::/user.slice/user-1000.slice/user@1000.service",
        },
      ],
      { "user@1000.service": PID_MANAGER_SLICE },
    );

    assert.equal(run.staleLines.length, 1, `got: ${run.stdout}`);
    assert.match(run.staleLines[0], new RegExp(`STALE pid=${PID_MANAGER_SLICE}`));
    assert.equal(summaryCount(run.summary, "spared"), 0);
  });
});

describe("scripts/reap-stale-test-procs.sh — systemd query failure fails SAFE (issue #3730 QA)", () => {
  /**
   * A broken D-Bus session makes the REAL `systemctl --user show` exit 1. The
   * original code wrote `systemctl ... 2>/dev/null || true`, collapsing "the
   * query failed" into "this pid is not a MainPID", so the reaper fell through
   * and SIGKILLed the production web server again — silently, through a brand
   * new trigger. These tests pass `unitMainPids: null` so the genuine systemctl
   * call runs, and break the bus exactly as the QA repro did.
   */
  const BROKEN_BUS = {
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent",
    XDG_RUNTIME_DIR: "/nonexistent",
  };

  test("spares a service-cgroup process when the MainPID query itself fails", () => {
    const run = runReaper([webServerProc], null, ["--max-age", "0"], BROKEN_BUS);

    assert.ok(
      !run.stdout.includes(`STALE pid=${PID_WEB}`),
      `a process must never be killed on an UNRESOLVABLE supervision query; got: ${run.stdout}`,
    );
    assert.equal(summaryCount(run.summary, "would-kill"), 0);
    assert.equal(summaryCount(run.summary, "spared"), 1);
  });

  test("logs a loud WARN naming the pid and unit when the query fails", () => {
    const run = runReaper([webServerProc], null, ["--max-age", "0"], BROKEN_BUS);

    assert.match(
      run.stdout,
      new RegExp(
        `WARN pid=${PID_WEB} unit=hydra-betting-web\\.service reason=systemd-query-failed action=spared-on-unknown`,
      ),
      "the failure must never be silent (CLAUDE.md fail-loud convention)",
    );
    assert.match(
      run.stdout,
      /WARN degraded sweep — 1 process\(es\) spared because the systemd MainPID query failed/,
      "the summary must carry an operator-visible degraded-sweep warning",
    );
  });

  test("counts a spared-on-unknown separately from a confirmed-MainPID spare", () => {
    const degraded = runReaper([webServerProc], null, ["--max-age", "0"], BROKEN_BUS);
    assert.equal(
      summaryCount(degraded.summary, "spared-unknown"),
      1,
      "a degraded sweep must be distinguishable from a healthy one in the summary",
    );

    // The healthy path resolves the MainPID, so nothing is 'unknown'.
    const healthy = runReaper([webServerProc], { "hydra-betting-web.service": PID_WEB });
    assert.equal(
      summaryCount(healthy.summary, "spared-unknown"),
      0,
      "a confirmed-MainPID spare must not inflate the degraded counter",
    );
    assert.equal(summaryCount(healthy.summary, "spared"), 1);
  });

  test("a dead bus does NOT make the reaper a no-op — a leak with no service cgroup is still reaped", () => {
    // The fail-safe must not become a blanket amnesty: a process outside any
    // *.service cgroup never consults systemd at all, so the issue-#226 leak
    // class is still reaped while the bus is down.
    const run = runReaper([leakedTsxNoUnitProc], null, ["--max-age", "0"], BROKEN_BUS);

    assert.equal(run.staleLines.length, 1, `got: ${run.stdout}`);
    assert.match(run.staleLines[0], new RegExp(`STALE pid=${PID_LEAK_NO_UNIT}`));
    assert.equal(summaryCount(run.summary, "spared"), 0);
    assert.equal(summaryCount(run.summary, "spared-unknown"), 0);
    assert.equal(summaryCount(run.summary, "would-kill"), 1);
  });
});

describe("scripts/reap-stale-test-procs.sh — dry-run would-kill arithmetic (issue #3730)", () => {
  test("would-kill equals the number of STALE lines printed, not considered-minus-spared", () => {
    // The old summary computed `would-kill=$((considered - spared))`, but
    // `considered` counts every pattern match BEFORE the age filter, so a quiet
    // dry run reported would-kill=9 while printing zero STALE lines.
    const youngProc: ProcFixture = {
      record: `${PID_YOUNG}|${PID_INIT}|${PID_YOUNG}|60|node /home/gabe/hydra/node_modules/.bin/tsx src/index.ts`,
      pid: PID_YOUNG,
      cgroup: "0::/user.slice/user-1000.slice/user@1000.service/session-3.scope",
    };
    const run = runReaper(
      [webServerProc, youngProc, leakedTsxNoUnitProc, leakedTsxInUnitProc],
      { "hydra-betting-web.service": PID_WEB, "hydra-autopilot.service": 9000099 },
    );

    const considered = summaryCount(run.summary, "considered");
    const spared = summaryCount(run.summary, "spared");
    const wouldKill = summaryCount(run.summary, "would-kill");

    assert.equal(considered, 4, "all four fixtures match the target patterns");
    assert.equal(spared, 1, "only the supervised web server is spared");
    assert.equal(summaryCount(run.summary, "below-age"), 1, "the young tsx is below-age");
    assert.equal(run.staleLines.length, 2, `expected two STALE lines; got: ${run.stdout}`);
    assert.equal(
      wouldKill,
      run.staleLines.length,
      "would-kill must equal the STALE line count (issue #3730)",
    );
    assert.notEqual(
      wouldKill,
      considered - spared,
      "the old considered-minus-spared arithmetic overstated would-kill and must not be restored",
    );
  });

  test("a sweep with nothing to do reports would-kill=0", () => {
    const run = runReaper([webServerProc], { "hydra-betting-web.service": PID_WEB });
    assert.equal(run.staleLines.length, 0);
    assert.equal(summaryCount(run.summary, "would-kill"), 0);
  });
});

/**
 * A synthetic GitHub Actions self-hosted runner process tree (issue #3732).
 *
 * Every runner on the host is a user-scope unit whose MainPID is also its
 * session and process-group leader, so EVERY process in a CI job inherits
 * pgid = the runner's session leader. That is the whole hazard: a leaked test
 * process is correctly identified as unsupervised (its parents are dead) but
 * still carries pgid 1289, so `kill -KILL -- -1289` takes out Runner.Listener,
 * Runner.Worker and every sibling — which can cancel a `deploy` job and leave
 * prod silently behind master with no alarm.
 *
 * This is also the first fixture in the file able to express a LIVE ancestor
 * chain at all. Every pid still sits above pid_max, but ancestry is now read
 * from the snapshot's ppid column rather than from `ps -p` against the live
 * host, so `spare:<unit>:descendant` finally has coverage.
 */
const PID_RUNNER_LEADER = 9000010; // /bin/bash run.sh — unit MainPID == pgid == sid
const PID_RUNNER_HELPER = 9000011; // run-helper.sh
const PID_RUNNER_LISTENER = 9000012; // Runner.Listener
const PID_RUNNER_WORKER = 9000013; // Runner.Worker
const PID_CI_NPM = 9000014; // npm exec inside the job — a live runner descendant
const PID_CI_LEAK = 9000015; // orphaned node --test — the candidate that must die
const PID_CI_LEAK_CHILD = 9000016; // its live esbuild child — must die WITH it

const RUNNER_UNIT = "github-actions-runner-2.service";
const RUNNER_CGROUP = `0::${USER_SLICE}/${RUNNER_UNIT}`;

function runnerProc(pid: number, ppid: number, age: number, cmd: string): ProcFixture {
  return {
    record: `${pid}|${ppid}|${PID_RUNNER_LEADER}|${age}|${cmd}`,
    pid,
    cgroup: RUNNER_CGROUP,
  };
}

/** The runner's own control plane — none of it may ever be signalled. */
const runnerControlPlane: ProcFixture[] = [
  runnerProc(PID_RUNNER_LEADER, PID_INIT, 400000, "/bin/bash /home/gabe/actions-runner-2/run.sh"),
  runnerProc(
    PID_RUNNER_HELPER,
    PID_RUNNER_LEADER,
    400000,
    "/bin/bash /home/gabe/actions-runner-2/run-helper.sh",
  ),
  runnerProc(
    PID_RUNNER_LISTENER,
    PID_RUNNER_HELPER,
    400000,
    "/home/gabe/actions-runner-2/bin/Runner.Listener run",
  ),
  runnerProc(
    PID_RUNNER_WORKER,
    PID_RUNNER_LISTENER,
    3600,
    "/home/gabe/actions-runner-2/bin.2.336.0/Runner.Worker spawnclient 161 164",
  ),
];

/**
 * The leaked test process: matches a target pattern, is old enough, and has
 * been reparented to init so no spare predicate rescues it. Its pgid is still
 * the runner's session leader — pre-#3732 that meant `kill -KILL -- -9000010`.
 */
const ciLeakProc = runnerProc(
  PID_CI_LEAK,
  PID_INIT,
  7200,
  "/usr/bin/node --experimental-strip-types --test test/aggregator-service-strip.test.mts",
);

const runnerMainPids = { [RUNNER_UNIT]: PID_RUNNER_LEADER };

describe("scripts/reap-stale-test-procs.sh — a CI runner's process group is never group-killed (issue #3732)", () => {
  test("refuses the group-kill when the pgid leader is a runner's supervised MainPID", () => {
    const run = runReaper([...runnerControlPlane, ciLeakProc], runnerMainPids);

    // The leak is still identified — this fix must not become a blanket amnesty.
    assert.equal(run.staleLines.length, 1, `expected the leak to stay STALE; got: ${run.stdout}`);
    assert.match(run.staleLines[0], new RegExp(`STALE pid=${PID_CI_LEAK} pgid=${PID_RUNNER_LEADER}`));

    // ...but its blast radius must NOT be the runner's session.
    assert.equal(run.planLines.length, 1, `got: ${run.stdout}`);
    assert.match(
      run.planLines[0],
      new RegExp(`PLAN pid=${PID_CI_LEAK} plan=descendants targets=${PID_CI_LEAK}$`),
      "the kill plan must be the candidate itself, never the runner's process group",
    );
    assert.doesNotMatch(
      run.stdout,
      new RegExp(`targets=-${PID_RUNNER_LEADER}`),
      "SIGKILLing -9000010 would take out Runner.Listener, Runner.Worker and every sibling",
    );
  });

  test("names the blocking runner process and its spare reason in a loud WARN", () => {
    const run = runReaper([...runnerControlPlane, ciLeakProc], runnerMainPids);

    assert.match(
      run.stdout,
      new RegExp(
        `WARN pid=${PID_CI_LEAK} pgid=${PID_RUNNER_LEADER} reason=group-contains-spared-member ` +
          `blocker-pid=${PID_RUNNER_LEADER} blocker-reason=${RUNNER_UNIT.replace(/\./g, "\\.")}:main ` +
          `action=downgraded-to-candidate-plus-descendants`,
      ),
      "a downgrade must name WHICH member blocked it and WHY (CLAUDE.md fail-loud)",
    );
    assert.equal(summaryCount(run.summary, "downgraded"), 1, "the summary must count downgrades");
    assert.match(
      run.stdout,
      /WARN 1 group-kill\(s\) downgraded because the process group contained a supervised or otherwise spared member/,
      "the operator-visible tail warning must fire",
    );
  });

  test("--apply signals the candidate and its live descendants, never the runner group", () => {
    // The downgrade must not collapse to a BARE single pid: issue #226 is about
    // orphaned esbuild grandchildren, which is the capability group-kill provides.
    const leakChild = runnerProc(
      PID_CI_LEAK_CHILD,
      PID_CI_LEAK,
      7100,
      "/home/gabe/hydra/node_modules/@esbuild/linux-x64/bin/esbuild --service=0.21.5",
    );
    const run = runReaper(
      [...runnerControlPlane, ciLeakProc, leakChild],
      runnerMainPids,
      [],
      {},
      { apply: true },
    );

    assert.ok(
      !run.killTargets.includes(`-${PID_RUNNER_LEADER}`),
      `the runner's process group must never be signalled; targets: ${run.killTargets.join(",")}`,
    );
    for (const survivor of [
      PID_RUNNER_LEADER,
      PID_RUNNER_HELPER,
      PID_RUNNER_LISTENER,
      PID_RUNNER_WORKER,
    ]) {
      assert.ok(
        !run.killTargets.includes(String(survivor)),
        `runner control-plane pid ${survivor} must never be signalled`,
      );
    }
    assert.ok(
      run.killTargets.includes(String(PID_CI_LEAK)),
      "the leaked candidate itself must still be killed (#226 non-regression)",
    );
    assert.ok(
      run.killTargets.includes(String(PID_CI_LEAK_CHILD)),
      "the orphan-prone esbuild descendant must be killed too — a bare single-pid kill would leak it",
    );
  });

  test("a live descendant of the runner's MainPID is spared outright, before the age filter", () => {
    // First coverage in this file for the `<unit>:descendant` branch: the npm
    // process is four levels below the runner's MainPID, resolvable only because
    // ancestry now comes from the snapshot's ppid column.
    const ciNpm = runnerProc(PID_CI_NPM, PID_RUNNER_WORKER, 7200, "npm exec vitest run");
    const run = runReaper([...runnerControlPlane, ciNpm], runnerMainPids);

    assert.equal(run.staleLines.length, 0, `a supervised descendant must never be STALE; got: ${run.stdout}`);
    assert.equal(summaryCount(run.summary, "spared"), 1);
    assert.equal(summaryCount(run.summary, "below-age"), 0, "the spare must precede the age filter");
    assert.equal(summaryCount(run.summary, "would-kill"), 0);
  });
});

describe("scripts/reap-stale-test-procs.sh — group-kill is preserved when nothing is spared (#226)", () => {
  /**
   * The other direction. A real leak group legitimately contains non-matching
   * `sh -c` wrappers; refusing to group-kill on those would neuter the reaper
   * on exactly the leaks it exists to collect.
   */
  const LEAK_LEADER = 9000020;
  const LEAK_ESBUILD = 9000021;
  const LEAK_WRAPPER = 9000022;
  const ORPHAN_SCOPE = "0::/user.slice/user-1000.slice/user@1000.service/session-3.scope";

  const leakGroup: ProcFixture[] = [
    {
      record: `${LEAK_LEADER}|${PID_INIT}|${LEAK_LEADER}|7200|/opt/proj/node_modules/.bin/tsx watch app.ts`,
      pid: LEAK_LEADER,
      cgroup: ORPHAN_SCOPE,
    },
    {
      record: `${LEAK_ESBUILD}|${LEAK_LEADER}|${LEAK_LEADER}|7200|/opt/proj/node_modules/@esbuild/linux-x64/bin/esbuild --service=0.21.5`,
      pid: LEAK_ESBUILD,
      cgroup: ORPHAN_SCOPE,
    },
    {
      record: `${LEAK_WRAPPER}|${PID_INIT}|${LEAK_LEADER}|7200|sh -c run-the-thing`,
      pid: LEAK_WRAPPER,
      cgroup: ORPHAN_SCOPE,
    },
  ];

  test("still group-kills a leak group whose only siblings are unsupervised wrappers", () => {
    const run = runReaper(leakGroup, {});

    assert.equal(summaryCount(run.summary, "downgraded"), 0, "nothing here is worth sparing");
    assert.ok(
      run.planLines.every((l) => l.includes(`plan=group targets=-${LEAK_LEADER}`)),
      `every candidate must keep the full group blast radius; got: ${run.stdout}`,
    );
  });

  test("--apply sends exactly one process-group SIGKILL for the leak group", () => {
    const run = runReaper(leakGroup, {}, [], {}, { apply: true });

    assert.deepEqual(
      [...new Set(run.killTargets)],
      [`-${LEAK_LEADER}`],
      `the group target is the whole point of #226; got: ${run.killTargets.join(",")}`,
    );
  });

  test("a dry run signals nothing at all", () => {
    const run = runReaper(leakGroup, {});
    assert.deepEqual(run.killTargets, [], "--dry-run must never reach the kill path");
  });
});

describe("scripts/reap-stale-test-procs.sh — a vanished candidate is a no-op, never a kill (issue #3732)", () => {
  /**
   * The measured root cause of the reported incident. `node:test` spawns one
   * short-lived child per test file, so 1-3 pattern-matching pids per 150ms
   * window appear in the snapshot and are gone milliseconds later. Both spare
   * predicates fail closed on a missing process, so the exited child was
   * classified STALE and its STALE snapshot pgid — the runner's session — was
   * group-killed on behalf of a process that no longer existed.
   */
  test("skips a candidate that exited during the sweep and never group-kills its recorded pgid", () => {
    const run = runReaper([...runnerControlPlane, ciLeakProc], runnerMainPids, [], {}, {
      vanished: [PID_CI_LEAK],
    });

    assert.equal(run.staleLines.length, 0, `a gone process must not be reported STALE; got: ${run.stdout}`);
    assert.equal(run.planLines.length, 0, "a gone process gets no kill plan");
    assert.equal(summaryCount(run.summary, "vanished"), 1, "the skip must be counted, not silent");
    assert.equal(summaryCount(run.summary, "would-kill"), 0);
    assert.match(
      run.stdout,
      new RegExp(`VANISHED pid=${PID_CI_LEAK} pgid=${PID_RUNNER_LEADER}`),
      "the skip must be logged with the pgid that was NOT killed",
    );
  });

  test("--apply signals nothing for a vanished candidate", () => {
    const run = runReaper([...runnerControlPlane, ciLeakProc], runnerMainPids, [], {}, {
      apply: true,
      vanished: [PID_CI_LEAK],
    });

    assert.deepEqual(
      run.killTargets,
      [],
      `nothing may be signalled on behalf of an exited pid; got: ${run.killTargets.join(",")}`,
    );
  });

  test("a vanished descendant is dropped from the downgraded kill plan", () => {
    const leakChild = runnerProc(
      PID_CI_LEAK_CHILD,
      PID_CI_LEAK,
      7100,
      "/opt/proj/node_modules/@esbuild/linux-x64/bin/esbuild --service=0.21.5",
    );
    const run = runReaper([...runnerControlPlane, ciLeakProc, leakChild], runnerMainPids, [], {}, {
      vanished: [PID_CI_LEAK_CHILD],
    });

    const plan = run.planLines.find((l) => l.includes(`PLAN pid=${PID_CI_LEAK} `));
    assert.ok(plan, `expected a plan for the leak; got: ${run.stdout}`);
    assert.match(
      plan!,
      new RegExp(`targets=${PID_CI_LEAK}$`),
      "a descendant that already exited must not appear as a kill target",
    );
  });
});

describe("scripts/reap-stale-test-procs.sh — help text matches the implementation (issue #3730)", () => {
  function help(): string {
    const res = spawnSync("bash", [SCRIPT_PATH, "--help"], { encoding: "utf-8" });
    assert.equal(res.status, 0);
    return res.stdout ?? "";
  }

  test("documents the MainPID supervision rule that is actually implemented", () => {
    const text = help();
    assert.match(text, /MainPID/, "the help must describe the implemented supervision rule");
    assert.match(
      text,
      /cgroup/i,
      "the help must say the unit is resolved from the process cgroup",
    );
  });

  test("no longer promises the unimplemented hydra-* unit guard", () => {
    // The stale promise ("or any current systemd-managed hydra-* unit") is what
    // made the incident invisible: the documented guard did not exist, and the
    // narrow hydra-* form would still have killed context7.service.
    const text = help();
    assert.doesNotMatch(
      text,
      /systemd-managed\s+hydra-\*\s+unit/,
      "the help must not re-promise the hydra-*-only guard (issue #3730)",
    );
  });

  test("documents the fail-safe when the MainPID query itself fails", () => {
    const text = help();
    assert.match(
      text,
      /query itself FAILS/,
      "the help must document that an unresolvable supervision query spares the process",
    );
    assert.match(text, /spared-unknown/, "the help must name the degraded-sweep counter");
  });

  test("states that service-cgroup membership alone never spares a process", () => {
    const text = help();
    assert.match(
      text,
      /membership/i,
      "the help must warn that cgroup membership alone is not a spare (issue #226 non-regression)",
    );
  });

  test("documents the kill-plan guard that refuses to group-kill a spared member's group", () => {
    const text = help();
    assert.match(
      text,
      /KILL PLAN/,
      "the help must document that a group-kill can be refused (issue #3732)",
    );
    assert.match(
      text,
      /process GROUP/,
      "the help must say sparing a process does not spare its process group",
    );
    assert.match(
      text,
      /descendants/,
      "the help must name the fallback blast radius (candidate + live descendants)",
    );
  });
});

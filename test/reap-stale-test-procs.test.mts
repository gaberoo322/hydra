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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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

const USER_SLICE = "/user.slice/user-1000.slice/user@1000.service/app.slice";

type ProcFixture = {
  /** `pid|pgid|age_seconds|cmd` record fed to the script's ps seam. */
  record: string;
  /** pid whose /proc/<pid>/cgroup file the fixture creates. */
  pid: number;
  /** contents of that cgroup file, or null to omit the file entirely. */
  cgroup: string | null;
};

type ReaperRun = { stdout: string; staleLines: string[]; summary: string };

/**
 * Materialise a fixture /proc tree + snapshot files, run the real script under
 * --dry-run, and return its output. Cleans up the temp dir before returning.
 */
function runReaper(
  procs: ProcFixture[],
  unitMainPids: Record<string, number>,
  extraArgs: string[] = [],
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

    const mainPidPath = join(dir, "unit-mainpids");
    writeFileSync(
      mainPidPath,
      Object.entries(unitMainPids)
        .map(([unit, pid]) => `${unit}\t${pid}`)
        .join("\n") + "\n",
    );

    const res = spawnSync("bash", [SCRIPT_PATH, "--dry-run", ...extraArgs], {
      encoding: "utf-8",
      env: {
        ...process.env,
        HYDRA_REAP_PROC_ROOT: procRoot,
        HYDRA_REAP_PS_SNAPSHOT: snapshotPath,
        HYDRA_REAP_UNIT_MAINPID: mainPidPath,
      },
    });
    assert.equal(res.status, 0, `script must always exit 0; stderr: ${res.stderr}`);
    const stdout = res.stdout ?? "";
    const staleLines = stdout.split("\n").filter((l) => l.includes("STALE pid="));
    const summary = stdout.split("\n").find((l) => l.includes("DRY RUN")) ?? "";
    assert.ok(summary, `expected a DRY RUN summary line; got: ${stdout}`);
    return { stdout, staleLines, summary };
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
  record: `${PID_WEB}|${PID_WEB}|388|npm exec next start --port 3333`,
  pid: PID_WEB,
  cgroup: `0::${USER_SLICE}/hydra-betting-web.service`,
};

const leakedTsxNoUnitProc: ProcFixture = {
  record: `${PID_LEAK_NO_UNIT}|${PID_LEAK_NO_UNIT}|7200|node /home/gabe/hydra/node_modules/.bin/tsx watch src/index.ts`,
  pid: PID_LEAK_NO_UNIT,
  // An interactive-session scope, not a service: nothing supervises this.
  cgroup: "0::/user.slice/user-1000.slice/user@1000.service/session-3.scope",
};

const leakedTsxInUnitProc: ProcFixture = {
  record: `${PID_LEAK_IN_UNIT}|${PID_LEAK_IN_UNIT}|7200|node /home/gabe/hydra/node_modules/.bin/tsx src/mutate.ts`,
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
          record: `${PID_MANAGER_SLICE}|${PID_MANAGER_SLICE}|7200|npm exec some-leaked-tool`,
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

describe("scripts/reap-stale-test-procs.sh — dry-run would-kill arithmetic (issue #3730)", () => {
  test("would-kill equals the number of STALE lines printed, not considered-minus-spared", () => {
    // The old summary computed `would-kill=$((considered - spared))`, but
    // `considered` counts every pattern match BEFORE the age filter, so a quiet
    // dry run reported would-kill=9 while printing zero STALE lines.
    const youngProc: ProcFixture = {
      record: `${PID_YOUNG}|${PID_YOUNG}|60|node /home/gabe/hydra/node_modules/.bin/tsx src/index.ts`,
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

  test("states that service-cgroup membership alone never spares a process", () => {
    const text = help();
    assert.match(
      text,
      /membership/i,
      "the help must warn that cgroup membership alone is not a spare (issue #226 non-regression)",
    );
  });
});

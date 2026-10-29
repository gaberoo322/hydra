/**
 * Regression test for issue #939 — the Host-Probe Adapter seam
 * (src/host-probe/). Sibling to test/github-seam.test.mts; same strategy: stub
 * the host-info binaries (df/free/systemctl) with fake bash scripts picked up
 * through HYDRA_DF_BIN / HYDRA_FREE_BIN / HYDRA_SYSTEMCTL_BIN, and assert every
 * accessor returns a discriminated never-throw ProbeResult.
 *
 * Two layers are covered:
 *   1. The PURE parse functions (parseDfOutput / parseFreeOutput) — the columnar
 *      grammar lifted verbatim from the old parseProbes, pinned without spawning.
 *   2. The accessors (readDisk / readMem / readServiceStatus) over a fake binary:
 *      success → { ok:true, data }; missing binary → host-probe-not-installed;
 *      non-zero exit → host-probe-failed; empty/unparseable → host-probe-empty;
 *      timeout → host-probe-timeout + killed.
 */

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, chmod, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseDfOutput,
  parseFreeOutput,
  readDisk,
  readMem,
  readServiceStatus,
  readServiceActiveEnterMonotonicUs,
  parseMonotonicUs,
  probeFileLockFree,
  restartService,
  isProbeFailure,
  isProbeOk,
} from "../src/host-probe/probe.ts";
import { classifyProbeFailure, type RawProbeResult } from "../src/host-probe/exec.ts";

// ---- Pure parse grammar (no spawn) ----------------------------------------

describe("host-probe parse grammar (issue #939)", () => {
  test("parseDfOutput parses `df -B1 --output=avail,size,pcent /` columns", () => {
    // avail / size / pcent on the last data row. 10GiB avail, 100GiB total, 87%.
    const stdout = "Avail        Size Use%\n" + `${10 * 1073741824} ${100 * 1073741824} 87%\n`;
    assert.deepEqual(parseDfOutput(stdout), {
      availableGb: 10,
      totalGb: 100,
      usedPercent: 87,
    });
  });

  test("parseDfOutput returns null on no data row", () => {
    assert.equal(parseDfOutput(""), null);
    assert.equal(parseDfOutput("   \n  "), null);
  });

  test("parseFreeOutput parses the `Mem:` row of `free -b` (col1 total, col6 available)", () => {
    // total=col1, available=col6. 32GiB total, 8GiB available → 75% used.
    const total = 32 * 1073741824;
    const avail = 8 * 1073741824;
    const stdout =
      "               total        used        free      shared  buff/cache   available\n" +
      `Mem:    ${total} 100 200 300 400 ${avail}\n` +
      `Swap:   0 0 0\n`;
    assert.deepEqual(parseFreeOutput(stdout), {
      totalGb: 32,
      availableGb: 8,
      usedPercent: 75,
    });
  });

  test("parseFreeOutput returns null when there is no Mem: row", () => {
    assert.equal(parseFreeOutput("Swap: 0 0 0\n"), null);
  });
});

// ---- classifyProbeFailure (pure) ------------------------------------------

describe("classifyProbeFailure (issue #939)", () => {
  const raw = (over: Partial<RawProbeResult>): RawProbeResult => ({
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    ...over,
  });

  test("ENOENT → host-probe-not-installed", () => {
    assert.equal(classifyProbeFailure(raw({ spawnErrorCode: "ENOENT", exitCode: -1 })), "host-probe-not-installed");
  });
  test("timeout → host-probe-timeout", () => {
    assert.equal(classifyProbeFailure(raw({ timedOut: true, exitCode: -1 })), "host-probe-timeout");
  });
  test("non-zero exit → host-probe-failed", () => {
    assert.equal(classifyProbeFailure(raw({ exitCode: 1, stderr: "boom" })), "host-probe-failed");
  });
});

// ---- Accessors over a fake binary -----------------------------------------

let workDir: string;
let fakeBinPath: string;

let origDf: string | undefined;
let origFree: string | undefined;
let origSystemctl: string | undefined;

/**
 * A fake host binary dispatching on FAKE_SCENARIO:
 *   df-ok       → df columnar output, exit 0
 *   free-ok     → free Mem: row, exit 0
 *   sysd-active → "active", exit 0
 *   sysd-failed → "failed", exit 3   (systemctl is-active exits non-zero off-active)
 *   empty       → no stdout, exit 0
 *   fail        → stderr, exit 1
 *   slow        → sleep, then exit 0  (drives the timeout path)
 */
async function writeFakeBin(path: string) {
  const total = 32 * 1073741824;
  const avail = 8 * 1073741824;
  const diskAvail = 10 * 1073741824;
  const diskSize = 100 * 1073741824;
  const body = `#!/usr/bin/env bash
set -u
SCENARIO=\${FAKE_SCENARIO:-df-ok}
case "$SCENARIO" in
  df-ok)       printf 'Avail Size Use%%\\n${diskAvail} ${diskSize} 42%%\\n'; exit 0 ;;
  free-ok)     printf 'x\\nMem: ${total} 1 1 1 1 ${avail}\\n'; exit 0 ;;
  sysd-active) echo "active"; exit 0 ;;
  sysd-failed) echo "failed"; exit 3 ;;
  empty)       exit 0 ;;
  fail)        echo "boom" >&2; exit 1 ;;
  slow)        sleep 5; echo "late"; exit 0 ;;
  *)           exit 0 ;;
esac
`;
  await writeFile(path, body, "utf-8");
  await chmod(path, 0o755);
}

describe("Host-Probe Adapter accessors (issue #939)", () => {
  before(async () => {
    workDir = await mkdtemp(join(tmpdir(), "hydra-host-probe-"));
    fakeBinPath = join(workDir, "fake-bin");
    await writeFakeBin(fakeBinPath);
    origDf = process.env.HYDRA_DF_BIN;
    origFree = process.env.HYDRA_FREE_BIN;
    origSystemctl = process.env.HYDRA_SYSTEMCTL_BIN;
    process.env.HYDRA_DF_BIN = fakeBinPath;
    process.env.HYDRA_FREE_BIN = fakeBinPath;
    process.env.HYDRA_SYSTEMCTL_BIN = fakeBinPath;
  });

  beforeEach(() => {
    delete process.env.FAKE_SCENARIO;
  });

  after(async () => {
    if (origDf === undefined) delete process.env.HYDRA_DF_BIN;
    else process.env.HYDRA_DF_BIN = origDf;
    if (origFree === undefined) delete process.env.HYDRA_FREE_BIN;
    else process.env.HYDRA_FREE_BIN = origFree;
    if (origSystemctl === undefined) delete process.env.HYDRA_SYSTEMCTL_BIN;
    else process.env.HYDRA_SYSTEMCTL_BIN = origSystemctl;
    await rm(workDir, { recursive: true, force: true });
  });

  test("readDisk success → ok:true with parsed DiskUsage", async () => {
    process.env.FAKE_SCENARIO = "df-ok";
    const r = await readDisk();
    assert.equal(isProbeOk(r), true);
    if (isProbeOk(r)) {
      assert.deepEqual(r.data, { availableGb: 10, totalGb: 100, usedPercent: 42 });
    }
  });

  test("readMem success → ok:true with parsed MemUsage", async () => {
    process.env.FAKE_SCENARIO = "free-ok";
    const r = await readMem();
    assert.equal(isProbeOk(r), true);
    if (isProbeOk(r)) {
      assert.deepEqual(r.data, { totalGb: 32, availableGb: 8, usedPercent: 75 });
    }
  });

  test("readServiceStatus returns the state word on exit 0 (active)", async () => {
    process.env.FAKE_SCENARIO = "sysd-active";
    const r = await readServiceStatus("hydra-orchestrator.service");
    assert.equal(isProbeOk(r), true);
    if (isProbeOk(r)) assert.equal(r.data, "active");
  });

  test("readServiceStatus returns the state word even on NON-zero exit (failed)", async () => {
    // systemctl is-active exits non-zero for non-active units but prints the
    // state word — that word is the signal, so this is the success arm.
    process.env.FAKE_SCENARIO = "sysd-failed";
    const r = await readServiceStatus("hydra-watchdog.timer");
    assert.equal(isProbeOk(r), true);
    if (isProbeOk(r)) assert.equal(r.data, "failed");
  });

  test("readDisk on a missing binary → host-probe-not-installed (never throws)", async () => {
    const prev = process.env.HYDRA_DF_BIN;
    process.env.HYDRA_DF_BIN = join(workDir, "does-not-exist-xyz");
    try {
      const r = await readDisk();
      assert.equal(isProbeFailure(r), true);
      if (isProbeFailure(r)) assert.equal(r.code, "host-probe-not-installed");
    } finally {
      process.env.HYDRA_DF_BIN = prev;
    }
  });

  test("readMem on a non-zero exit → host-probe-failed", async () => {
    process.env.FAKE_SCENARIO = "fail";
    const r = await readMem();
    assert.equal(isProbeFailure(r), true);
    if (isProbeFailure(r)) assert.equal(r.code, "host-probe-failed");
  });

  test("readDisk on empty-but-clean output → host-probe-empty", async () => {
    process.env.FAKE_SCENARIO = "empty";
    const r = await readDisk();
    assert.equal(isProbeFailure(r), true);
    if (isProbeFailure(r)) assert.equal(r.code, "host-probe-empty");
  });

  test("readDisk on a slow binary → host-probe-timeout (never throws)", async () => {
    // The timeout timer fires at `timeout` ms, marks the probe timed-out, and
    // SIGTERMs the child — mirroring the GitHub CLI Adapter's timeout arm. We
    // assert the discriminated code, not wall-clock latency: a `sleep`
    // grandchild can outlive the bash SIGTERM, so the promise's RESOLUTION
    // latency is not the contract — the never-throw `host-probe-timeout` is.
    process.env.FAKE_SCENARIO = "slow";
    const r = await readDisk({ timeout: 150 });
    assert.equal(isProbeFailure(r), true);
    if (isProbeFailure(r)) assert.equal(r.code, "host-probe-timeout");
  });
});

describe("Host-Probe Adapter watchdog accessors (issue #5096)", () => {
  let dir: string;
  let fake: string;
  let argvLog: string;
  const saved: Record<string, string | undefined> = {};

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "hydra-host-probe-wd-"));
    fake = join(dir, "fake-bin");
    argvLog = join(dir, "argv.log");
    // Records its argv, then behaves per FAKE_SCENARIO.
    await writeFile(
      fake,
      `#!/usr/bin/env bash
echo "$*" >> "${argvLog}"
case "$FAKE_SCENARIO" in
  mono-ok) echo 123456789 ;;
  mono-bad) echo "n/a" ;;
  exit1) exit 1 ;;
  exit2) exit 2 ;;
  *) exit 0 ;;
esac
`,
      "utf-8",
    );
    await chmod(fake, 0o755);
    for (const k of ["HYDRA_SYSTEMCTL_BIN", "HYDRA_FLOCK_BIN"]) saved[k] = process.env[k];
    process.env.HYDRA_SYSTEMCTL_BIN = fake;
    process.env.HYDRA_FLOCK_BIN = fake;
  });

  beforeEach(async () => {
    delete process.env.FAKE_SCENARIO;
    await writeFile(argvLog, "", "utf-8");
  });

  after(async () => {
    for (const k of ["HYDRA_SYSTEMCTL_BIN", "HYDRA_FLOCK_BIN"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    delete process.env.FAKE_SCENARIO;
    await rm(dir, { recursive: true, force: true });
  });

  test("parseMonotonicUs accepts digits only", () => {
    assert.equal(parseMonotonicUs("123456789\n"), 123456789);
    assert.equal(parseMonotonicUs("n/a"), null);
    assert.equal(parseMonotonicUs(""), null);
  });

  test("readServiceActiveEnterMonotonicUs parses the value and uses the show argv", async () => {
    process.env.FAKE_SCENARIO = "mono-ok";
    const r = await readServiceActiveEnterMonotonicUs("hydra-orchestrator.service");
    assert.equal(isProbeOk(r), true);
    if (isProbeOk(r)) assert.equal(r.data, 123456789);
    assert.equal(
      (await readFile(argvLog, "utf-8")).trim(),
      "--user show -p ActiveEnterTimestampMonotonic --value hydra-orchestrator.service",
    );
  });

  test("readServiceActiveEnterMonotonicUs maps non-numeric output to host-probe-empty", async () => {
    process.env.FAKE_SCENARIO = "mono-bad";
    const r = await readServiceActiveEnterMonotonicUs("u.service");
    assert.equal(isProbeFailure(r), true);
    if (isProbeFailure(r)) assert.equal(r.code, "host-probe-empty");
  });

  test("probeFileLockFree maps exit codes: 0 -> free, 1 -> held, other -> failed; argv never holds the lock", async () => {
    process.env.FAKE_SCENARIO = "ok";
    const free = await probeFileLockFree("/tmp/x.lock");
    assert.deepEqual(free, { ok: true, data: { held: false } });
    process.env.FAKE_SCENARIO = "exit1";
    const held = await probeFileLockFree("/tmp/x.lock");
    assert.deepEqual(held, { ok: true, data: { held: true } });
    process.env.FAKE_SCENARIO = "exit2";
    const bad = await probeFileLockFree("/tmp/x.lock");
    assert.equal(isProbeFailure(bad), true);
    // `flock -n <path> true`: the lock is released the instant the throwaway child exits.
    for (const line of (await readFile(argvLog, "utf-8")).trim().split("\n")) {
      assert.equal(line, "-n /tmp/x.lock true");
    }
  });

  test("probeFileLockFree on a missing binary fails with host-probe-not-installed (never throws)", async () => {
    process.env.HYDRA_FLOCK_BIN = join(dir, "does-not-exist");
    try {
      const r = await probeFileLockFree("/tmp/x.lock");
      assert.equal(isProbeFailure(r), true);
      if (isProbeFailure(r)) assert.equal(r.code, "host-probe-not-installed");
    } finally {
      process.env.HYDRA_FLOCK_BIN = fake;
    }
  });

  test("restartService runs `systemctl --user restart <unit>` and reports failure on non-zero exit", async () => {
    process.env.FAKE_SCENARIO = "ok";
    const ok = await restartService("hydra-docker.service");
    assert.deepEqual(ok, { ok: true, data: true });
    assert.equal((await readFile(argvLog, "utf-8")).trim(), "--user restart hydra-docker.service");
    process.env.FAKE_SCENARIO = "exit1";
    const bad = await restartService("hydra-docker.service");
    assert.equal(isProbeFailure(bad), true);
    if (isProbeFailure(bad)) assert.equal(bad.code, "host-probe-failed");
  });
});

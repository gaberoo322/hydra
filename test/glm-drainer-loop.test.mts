/**
 * Whole-script smoke tests for the GLM dev-drainer launcher
 * (scripts/glm/drainer-loop.sh — issue #3689, ADR-0032; collapsed to flock +
 * `run_driver tick` by issue #4688, ADR-0040 Decision 1).
 *
 * Since the tick moved to TypeScript, this file keeps ONLY what is still
 * bash — the #4679 survivors:
 *   D4   flock concurrency (the lock-held heartbeat path)
 *   D10  systemd unit shape
 *   D11  no dispatch cost-join record, by construction
 *   D12  `run_driver` invokes the committed driver file with the exact argv
 *   plus ONE dry-run tick with REAL node on PATH proving `main()` resolves the
 *   driver's whole import graph end to end.
 *
 * Everything else lives in the per-phase TS tests: the kill-switch / cap /
 * quota groups in test/glm-gate.test.mts, the RESUME paragraph and scope
 * extraction in test/glm-prompt.test.mts, the claim-release / salvage ladder
 * in test/glm-finish.test.mts, and the tick composition in
 * test/glm-drainer-driver.test.mts.
 */

import { test, describe, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { clearAutopilotPaused, setAutopilotPaused } from "../src/redis/autopilot-pause.ts";
import { closeRedisConnections } from "../src/redis/connection.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DRAINER_LOOP = join(REPO_ROOT, "scripts", "glm", "drainer-loop.sh");

function runDrainerLoop(
  extraEnv: Record<string, string> = {},
): Promise<{ status: number; combined: string }> {
  return new Promise((resolve, reject) => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-drainer-test-"));
    const child = spawn("bash", [DRAINER_LOOP], {
      env: {
        ...process.env,
        HYDRA_GLM_DRAINER_DRY_RUN: "1",
        HYDRA_GLM_DRAINER_LOCKFILE: join(tmp, "lock"),
        HYDRA_GLM_DRAINER_CAP_DIR: tmp,
        HYDRA_GLM_DRAINER_DAILY_CAP: "5",
        ...extraEnv,
      },
    });
    let combined = "";
    child.stdout.on("data", (d) => { combined += d.toString(); });
    child.stderr.on("data", (d) => { combined += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      rmSync(tmp, { recursive: true, force: true });
      resolve({ status: code ?? -1, combined });
    });
  });
}

/**
 * Sources drainer-loop.sh (never runs main() — see the script's own
 * `[[ "${BASH_SOURCE[0]}" == "${0}" ]]` guard) and runs `snippet` in the SAME
 * bash process so it can call the script's functions directly.
 */
function runShellSnippet(
  extraEnv: Record<string, string>,
  snippet: string,
): Promise<{ status: number; combined: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "bash",
      ["-c", `set -uo pipefail; source "$DRAINER_LOOP_PATH"; ${snippet}`],
      { env: { ...process.env, DRAINER_LOOP_PATH: DRAINER_LOOP, ...extraEnv } },
    );
    let combined = "";
    child.stdout.on("data", (d) => { combined += d.toString(); });
    child.stderr.on("data", (d) => { combined += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ status: code ?? -1, combined }));
  });
}

describe("scripts/glm/drainer-loop.sh — flock concurrency=1 (ADR-0032 invariant 5, issue #3689)", () => {
  test("a held lock is detected as blocked and STILL refreshes the heartbeat (2026-07-27 AMENDMENTS #3)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-drainer-flock-test-"));
    const lockfile = join(tmp, "lock");
    // Hold the lock from a separate process for the duration of the test;
    // killed in the `finally` block below.
    const holder = spawn("bash", ["-c", `exec 9>"${lockfile}"; flock 9; sleep 30`]);
    try {
      // Give the holder a moment to actually acquire the lock before racing it.
      await new Promise((r) => setTimeout(r, 300));
      const r = await runDrainerLoop({ HYDRA_GLM_DRAINER_LOCKFILE: lockfile, HYDRA_GLM_DRAINER_CAP_DIR: tmp });
      assert.equal(r.status, 0);
      assert.match(r.combined, /flock blocked/);
      assert.match(r.combined, /would-heartbeat \(reason=blocked, DRY_RUN=1\)/);
      // The blocked branch exits BEFORE the tick — it never reaches the gate.
      assert.doesNotMatch(r.combined, /would-heartbeat \(reason=able/);
    } finally {
      holder.kill("SIGKILL");
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("no held lock => acquires cleanly and proceeds past the flock step", async () => {
    const r = await runDrainerLoop();
    assert.doesNotMatch(r.combined, /flock blocked/);
  });
});

describe("scripts/glm/drainer-loop.sh — systemd units mirror the pace-gate shape (issue #3689)", () => {
  test("the .service is Type=oneshot with a WorkingDirectory and journal logging, like hydra-pace-gate.service", () => {
    const svc = readFileSync(join(REPO_ROOT, "scripts", "systemd", "hydra-glm-drainer.service"), "utf8");
    assert.match(svc, /Type=oneshot/);
    assert.match(svc, /WorkingDirectory=%h\/hydra/);
    assert.match(svc, /ExecStart=.*drainer-loop\.sh/);
    assert.match(svc, /StandardOutput=journal/);
    assert.match(svc, /StandardError=journal/);
  });

  test("the .timer fires ~15 min with jitter and Persistent=true, like hydra-pace-gate.timer", () => {
    const timer = readFileSync(join(REPO_ROOT, "scripts", "systemd", "hydra-glm-drainer.timer"), "utf8");
    assert.match(timer, /OnUnitActiveSec=15min/);
    assert.match(timer, /Persistent=true/);
    assert.match(timer, /RandomizedDelaySec=/);
    assert.match(timer, /Unit=hydra-glm-drainer\.service/);
    assert.match(timer, /WantedBy=timers\.target/);
  });
});

describe("scripts/glm/drainer-loop.sh — never produces a dispatch cost-join record, by construction (issue #4126 INV-6)", () => {
  test("the script never references reap.py or the dispatch-cost-join write path", () => {
    // The join write (`_post_dispatch_cost_join` in scripts/autopilot/reap.py)
    // is fired ONLY from reap.py's `run_completion`. The GLM drainer is a
    // wholly separate lane (ADR-0032): it never sources, execs, or shells out
    // to reap.py, so a GLM-authored dev_orch run structurally cannot reach
    // that write path.
    const source = readFileSync(DRAINER_LOOP, "utf8");
    assert.doesNotMatch(source, /reap\.py/, "drainer-loop.sh must never reference reap.py");
    assert.doesNotMatch(source, /dispatch-cost/, "drainer-loop.sh must never reference the dispatch-cost write path");
  });
});

describe("scripts/glm/drainer-loop.sh — run_driver() invokes the COMMITTED driver file (issue #4371)", () => {
  test("run_driver invokes the exact argv against the committed scripts/glm/drainer-driver.ts, and never writes a /tmp driver file", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-drainer-rundriver-"));
    try {
      const binDir = join(tmp, "bin");
      mkdirSync(binDir);
      // Fake `node` on PATH echoes its own argv so the snippet can assert the
      // exact invocation without spawning a real node process.
      writeFileSync(join(binDir, "node"), `#!/usr/bin/env bash\necho "NODE_ARGV:$*"\nexit 0\n`, { mode: 0o755 });
      const r = await runShellSnippet(
        { PATH: `${binDir}:${process.env.PATH}`, TMPDIR: tmp },
        `run_driver preflight /fake/changed-files.txt; echo "SNIPPET_EXIT:$?"`,
      );
      assert.match(r.combined, /SNIPPET_EXIT:0/, `expected run_driver to exit 0:\n${r.combined}`);
      assert.match(
        r.combined,
        new RegExp(
          `NODE_ARGV:--experimental-strip-types ${REPO_ROOT}/scripts/glm/drainer-driver\\.ts preflight /fake/changed-files\\.txt`,
        ),
        `expected the exact committed-driver argv:\n${r.combined}`,
      );
      assert.equal(
        existsSync(join(tmp, "hydra-glm-drainer-driver.mts")),
        false,
        "run_driver must never (re)write a /tmp driver file",
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// The one whole-script tick: REAL node on PATH, so `main()` -> `run_driver
// tick` resolves the driver's entire import graph (gate, pick, finish, prompt,
// the github seams). The operator pause is read from the per-run test DB. The
// group owns its own before/after lifecycle and clears the flag.
describe("scripts/glm/drainer-loop.sh — one dry-run tick end to end through real node (issue #4688)", () => {
  beforeEach(async () => {
    await clearAutopilotPaused();
  });
  after(async () => {
    await clearAutopilotPaused();
    closeRedisConnections();
  });

  test("paused flag set => the tick exits 0 and journals the operator-paused skip (no heartbeat)", async () => {
    await setAutopilotPaused();
    const r = await runDrainerLoop();
    assert.equal(r.status, 0, `expected exit 0:\n${r.combined}`);
    assert.match(r.combined, /hydra-glm-drainer: operator paused — skip \(no heartbeat/);
    assert.doesNotMatch(r.combined, /would-heartbeat/);
    assert.doesNotMatch(r.combined, /tick driver faulted/);
    // stdout carries the one `{gate,pick,finish}` JSON line.
    assert.match(r.combined, /\{"gate":\{"able":false,"reason":"paused"\},"pick":null,"finish":null\}/);
  });
});

describe("scripts/glm/drainer-loop.sh — the operator off switch (src/glm/disabled.ts)", () => {
  test("sentinel present: exits 0 before flock and the tick, writing no heartbeat", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-drainer-disabled-test-"));
    try {
      const sentinel = join(tmp, "disabled");
      writeFileSync(sentinel, "");
      const r = await runDrainerLoop({ HYDRA_GLM_DISABLED_FILE: sentinel });
      assert.equal(r.status, 0);
      assert.match(r.combined, /lane disabled by operator \(sentinel .*disabled present\) — skip \(no heartbeat\)/);
      assert.doesNotMatch(r.combined, /heartbeat written|would-heartbeat|flock blocked/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("sentinel absent: the tick runs as usual", async () => {
    const r = await runDrainerLoop({ HYDRA_GLM_DISABLED_FILE: "/nonexistent/glm-disabled" });
    assert.doesNotMatch(r.combined, /lane disabled by operator/);
  });
});

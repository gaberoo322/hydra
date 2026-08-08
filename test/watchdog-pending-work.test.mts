/**
 * Regression test for issue #3794 — the scheduler-recovery work-pending signal
 * in scripts/hydra-watchdog.sh.
 *
 * Background: the watchdog decided whether to restart a self-stopped scheduler
 * by polling the retired /api/backlog HTTP surface (deleted by #3439 / PR #3455,
 * ADR-0031; it now 404s). The `curl .../api/backlog || echo "0"` guard swallowed
 * the 404, so queue_depth was permanently 0 — the "is there work waiting?"
 * test saw only hydra:anchors:work-queue and was blind to the GitHub board that
 * actually holds the work. With the Redis work-queue empty (as it is now), the
 * watchdog concluded "no work pending; leaving alone" and NEVER restarted the
 * scheduler — the recovery path disarmed in exactly the state it exists to
 * recover from.
 *
 * The fix (read_pending_work) reads REAL signals — the orchestrator GitHub board
 * (gaberoo322/hydra) via REST `gh issue list`, plus the Redis work-queue — and
 * follows a HARD RULE: a monitoring script must never treat "I could not read
 * it" as "there is none" (acceptance criterion 2). On any read failure it logs a
 * loud WARN and the caller biases toward the restart.
 *
 * This test exercises read_pending_work IN ISOLATION by sourcing the script
 * (the entry point is guarded so sourcing only DEFINES the functions and does
 * not run the service-liveness / autopilot-wedge / deploy-drift blocks — that
 * avoids faking the six docker/HTTP/systemd upstream checks the service-liveness
 * block makes before it reaches the work-pending decision). Fake gh/docker
 * binaries are supplied via the HYDRA_GH_BIN / HYDRA_DOCKER_BIN hooks the
 * function documents, mirroring the HYDRA_*_BIN override pattern in
 * test/host-probe.test.mts.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const WATCHDOG = join(REPO_ROOT, "scripts", "hydra-watchdog.sh");

interface HelperOpts {
  ghStdout?: string; // stdout the fake `gh` prints per `issue list` call
  ghExit?: number; // fake `gh` exit code (default 0)
  dockerStdout?: string; // stdout the fake `docker` prints for the LLEN read
  dockerExit?: number; // fake `docker` exit code (default 0)
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Source the watchdog and invoke read_pending_work with fake gh/docker binaries.
 * Returns the captured stdout (which carries the "RESULT count=N failed=M" line
 * plus any WARN lines the function emits) so the caller can assert on both.
 */
function runHelper(opts: HelperOpts = {}): RunResult {
  const binDir = mkdtempSync(join(tmpdir(), "wd-pw-bin-"));
  const ghFake = join(binDir, "gh");
  const dockerFake = join(binDir, "docker");
  // Fakes ignore their args; they only emit the canned stdout + exit code.
  writeFileSync(
    ghFake,
    `#!/usr/bin/env bash\nprintf '%s' ${JSON.stringify(opts.ghStdout ?? "")}\nexit ${opts.ghExit ?? 0}\n`,
  );
  writeFileSync(
    dockerFake,
    `#!/usr/bin/env bash\nprintf '%s' ${JSON.stringify(opts.dockerStdout ?? "")}\nexit ${opts.dockerExit ?? 0}\n`,
  );
  chmodSync(ghFake, 0o755);
  chmodSync(dockerFake, 0o755);

  // The harness declares the two nameref targets, calls the helper, and prints
  // a parseable RESULT line. `set +e` is belt-and-braces (the sourced script
  // re-applies `set -euo pipefail`, but the helper handles every internal
  // failure via `|| { ...; return 0; }` so errexit never aborts the harness).
  const harness = [
    `set +e`,
    `source ${JSON.stringify(WATCHDOG)}`,
    `declare -i count=0 failed=0`,
    `read_pending_work count failed`,
    `echo "RESULT count=$count failed=$failed"`,
  ].join("\n");

  try {
    const r = spawnSync("bash", ["-c", harness], {
      env: {
        ...process.env,
        HYDRA_GH_BIN: ghFake,
        HYDRA_DOCKER_BIN: dockerFake,
      },
      encoding: "utf-8",
      timeout: 20_000,
    });
    return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
}

/** Parse the "RESULT count=N failed=M" line out of the helper stdout. */
function parseResult(stdout: string): { count: number; failed: number } {
  const m = stdout.match(/RESULT count=(-?\d+) failed=(-?\d+)/);
  assert.ok(m, `no RESULT line in helper stdout: ${stdout}`);
  return { count: Number(m[1]), failed: Number(m[2]) };
}

describe("scripts/hydra-watchdog.sh — read_pending_work (issue #3794)", () => {
  test("watchdog script exists and is executable", () => {
    assert.ok(existsSync(WATCHDOG), "watchdog script missing");
    const mode = spawnSync("stat", ["-c", "%a", WATCHDOG], { encoding: "utf-8" }).stdout.trim();
    assert.match(mode, /^[7][0-9]{2}$/, `watchdog not executable (mode=${mode})`);
  });

  test("sourcing the script does NOT run the tick blocks (entry-point guard)", () => {
    // If the guard regressed, sourcing would execute run_service_liveness et al.
    // and print their log lines (which hit real docker/HTTP on the host).
    const r = spawnSync("bash", ["-c", `source ${JSON.stringify(WATCHDOG)}`], {
      encoding: "utf-8",
      timeout: 10_000,
    });
    assert.equal(r.status, 0, `source should exit 0; stderr=${r.stderr}`);
    assert.doesNotMatch(
      r.stdout,
      /hydra-(orchestrator|autopilot|deploy-drift)-watchdog:/,
      `sourcing must not run the tick blocks, but got stdout: ${r.stdout}`,
    );
  });

  test("board has work (3 labels) + work-queue has work: count>0, no failure", () => {
    // gh returns 1 per label call (3 labels) -> board_total=3; docker returns 2.
    const r = runHelper({ ghStdout: "1", dockerStdout: "2" });
    assert.equal(r.status, 0, `helper exited non-zero; stderr=${r.stderr}`);
    const { count, failed } = parseResult(r.stdout);
    assert.equal(failed, 0, "no read failure expected");
    assert.equal(count, 5, "expected 3 (board) + 2 (queue) = 5");
    assert.doesNotMatch(r.stdout, /WARN/, `no WARN expected on a clean read, got: ${r.stdout}`);
  });

  test("no work anywhere (board=0, queue=0): count=0, no failure, no WARN", () => {
    const r = runHelper({ ghStdout: "0", dockerStdout: "0" });
    assert.equal(r.status, 0, `helper exited non-zero; stderr=${r.stderr}`);
    const { count, failed } = parseResult(r.stdout);
    assert.equal(failed, 0);
    assert.equal(count, 0);
    assert.doesNotMatch(r.stdout, /WARN/, `no WARN expected when cleanly empty, got: ${r.stdout}`);
  });

  test("board read FAILURE (gh non-zero): failed=1 + loud WARN (never silent 0)", () => {
    // The exact bug: a 404/errored read must NOT degrade silently to 0.
    const r = runHelper({ ghExit: 1, dockerStdout: "0" });
    assert.equal(r.status, 0, `helper exited non-zero; stderr=${r.stderr}`);
    const { count, failed } = parseResult(r.stdout);
    assert.equal(failed, 1, "a failed board read MUST set failed=1");
    assert.equal(count, 0, "count is 0 on failure (the caller restarts on failed, not on count)");
    assert.match(
      r.stdout,
      /WARN board read FAILED.*cannot prove no work pending/,
      `expected a loud board-read WARN, got: ${r.stdout}`,
    );
  });

  test("board read returns non-integer: failed=1 + loud WARN", () => {
    const r = runHelper({ ghStdout: "not-a-number", dockerStdout: "0" });
    assert.equal(r.status, 0, `helper exited non-zero; stderr=${r.stderr}`);
    const { count, failed } = parseResult(r.stdout);
    assert.equal(failed, 1);
    assert.equal(count, 0);
    assert.match(
      r.stdout,
      /WARN board read.*returned non-integer.*cannot prove no work pending/,
      `expected a non-integer WARN, got: ${r.stdout}`,
    );
  });

  test("work-queue read FAILURE (docker non-zero): failed=1 + loud WARN", () => {
    // Board reads cleanly (0 across labels) but the queue read errors.
    const r = runHelper({ ghStdout: "0", dockerExit: 1 });
    assert.equal(r.status, 0, `helper exited non-zero; stderr=${r.stderr}`);
    const { count, failed } = parseResult(r.stdout);
    assert.equal(failed, 1, "a failed queue read MUST set failed=1");
    assert.equal(count, 0);
    assert.match(
      r.stdout,
      /WARN work-queue read FAILED.*cannot prove no work pending/,
      `expected a loud queue-read WARN, got: ${r.stdout}`,
    );
  });

  test("work-queue read returns non-integer: failed=1 + loud WARN", () => {
    const r = runHelper({ ghStdout: "0", dockerStdout: "PONG" });
    assert.equal(r.status, 0, `helper exited non-zero; stderr=${r.stderr}`);
    const { count, failed } = parseResult(r.stdout);
    assert.equal(failed, 1);
    assert.equal(count, 0);
    assert.match(r.stdout, /WARN work-queue read returned non-integer/, `expected WARN, got: ${r.stdout}`);
  });

  test("static: no live call to the retired /api/backlog URL (acceptance criterion 3)", () => {
    const src = readFileSync(WATCHDOG, "utf-8");
    assert.doesNotMatch(
      src,
      /http:\/\/localhost:4000\/api\/backlog/,
      "the retired /api/backlog URL must not appear as a live call in the watchdog",
    );
  });

  test("static: caller biases toward restart on a failed read (acceptance criterion 2)", () => {
    const src = readFileSync(WATCHDOG, "utf-8");
    // The leave-alone branch is gated on a clean read (work_read_failed == 0);
    // the failed-read branch restarts via the API (fail-safe), proving a failed
    // signal never disarms recovery.
    assert.match(src, /work_read_failed == 0 && total_work == 0/, "leave-alone must require a clean read");
    assert.match(src, /restarting scheduler via API \(fail-safe\)/, "failed-read must restart (fail-safe)");
  });

  test("static: the work read is invoked at exactly one (gated) site — not on the hot tick", () => {
    const src = readFileSync(WATCHDOG, "utf-8");
    // read_pending_work is defined once (definition line `read_pending_work() {`)
    // and invoked once. The invocation literal below must appear exactly once so
    // the rate-limit-sensitive gh board read stays confined to the low-frequency
    // recovery branch (design-concept invariant INV-4).
    const invocations = src.match(/read_pending_work total_work work_read_failed/g) ?? [];
    assert.equal(invocations.length, 1, "read_pending_work must be invoked at exactly one site");
  });
});

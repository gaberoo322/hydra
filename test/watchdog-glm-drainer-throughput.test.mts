/**
 * Regression test for issue #3868 — the ## GLM DRAINER THROUGHPUT block in
 * scripts/hydra-watchdog.sh (`run_glm_drainer_throughput`).
 *
 * Background: ADR-0032's GLM partition makes the drainer heartbeat
 * (`hydra:glm:drainer:active`) load-bearing for the whole board — while it is
 * fresh, every `glm-eligible` `ready-for-agent` issue is excluded from the
 * Opus `dev_orch` lane (#3754). Observed 2026-08-05 (run 2bcba309): the
 * drainer was LIVE (fresh heartbeat, claims proceeding) but broken at its
 * final step (#3863 — `gh pr create` failed on every attempt), so it authored
 * ~40 min per issue on z.ai, shipped nothing, and the affected issues were
 * invisible to BOTH lanes — no alarm fired, because the pre-existing
 * liveness check only answers "is the heartbeat fresh?", not "is the drainer
 * doing useful work?".
 *
 * This block distinguishes three conditions that all look like "a quiet
 * drainer, no alarm" from outside:
 *   1. DOWN            — heartbeat stale/absent. Must NOT alarm here (#3754
 *                         already owns this condition).
 *   2. NO WORK QUEUED   — heartbeat fresh, zero claim attempts. Must NOT
 *                         alarm (the streak never grows).
 *   3. LIVE BUT STERILE — heartbeat fresh AND >= N consecutive claim attempts
 *                         with no intervening PR-opened line. MUST alarm.
 *
 * The block honours off-by-default injection hooks (documented in the script
 * header), mirroring the ## AUTOPILOT WEDGE / ## DEPLOY DRIFT blocks'
 * direct-value-injection style rather than ## LAUNCH FLOW's live-Redis style,
 * so every case here is a pure function of its inputs with zero docker/
 * systemd dependency:
 *   HYDRA_WATCHDOG_GLM_DRAINER_LOG_FILE    Synthetic log file (in place of a
 *                                          real journalctl read).
 *   HYDRA_WATCHDOG_GLM_HEARTBEAT_MS        Injected heartbeat epoch-ms.
 *   HYDRA_WATCHDOG_GLM_NOW_MS              Injected `now` epoch-ms.
 *   HYDRA_WATCHDOG_GLM_HEARTBEAT_STALE_MS  Staleness window override.
 *   HYDRA_WATCHDOG_GLM_ZERO_THROUGHPUT_N   Consecutive-claims threshold.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WATCHDOG_SPAWN_TIMEOUT_MS, throwIfTimedOut } from "./_helpers/watchdog-timeouts.mts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const WATCHDOG = join(REPO_ROOT, "scripts", "hydra-watchdog.sh");

const NOW_MS = 1_800_000_000_000;

function runWatchdog(env: Record<string, string>): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(WATCHDOG, [], {
    env: {
      ...process.env,
      // Force the autopilot-wedge block to early-exit so this test doesn't
      // depend on the autopilot service / heartbeat state on the host.
      HYDRA_AUTOPILOT_WATCHDOG_FORCE_SERVICE_INACTIVE: "1",
      HYDRA_WATCHDOG_GLM_NOW_MS: String(NOW_MS),
      ...env,
      PATH: process.env.PATH ?? "",
    },
    encoding: "utf-8",
    timeout: WATCHDOG_SPAWN_TIMEOUT_MS,
  });
  throwIfTimedOut(r, WATCHDOG_SPAWN_TIMEOUT_MS, "watchdog script");
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Extract only this block's log lines for focused assertions. */
function throughputLines(stdout: string): string {
  return stdout
    .split("\n")
    .filter((l) => l.includes("hydra-glm-drainer-throughput-watchdog:"))
    .join("\n");
}

function makeLogFile(dir: string, lines: string[]): string {
  const path = join(dir, "drainer.log");
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "watchdog-glm-throughput-test-"));
}

/** N ticks that each claim an issue and never open a PR. */
function sterileLines(n: number): string[] {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    const issue = 4200 + i;
    lines.push(`hydra-glm-drainer: picked issue #${issue}`);
    lines.push(`hydra-glm-drainer: claiming issue #${issue}`);
    lines.push(`hydra-glm-drainer: preflight BLOCKED for issue #${issue}: {"ok":false}`);
  }
  return lines;
}

describe("scripts/hydra-watchdog.sh — ## GLM DRAINER THROUGHPUT block (issue #3868)", () => {
  test("watchdog script exists and is executable", () => {
    assert.ok(existsSync(WATCHDOG), "watchdog script missing");
    const mode = spawnSync("stat", ["-c", "%a", WATCHDOG], { encoding: "utf-8" }).stdout.trim();
    assert.match(mode, /^[7][0-9]{2}$/, `watchdog not executable (mode=${mode})`);
  });

  test("live but sterile: fresh heartbeat + 3 consecutive claims with zero PRs -> WARNING", () => {
    const dir = makeTmpDir();
    try {
      const logFile = makeLogFile(dir, sterileLines(3));
      const r = runWatchdog({
        HYDRA_WATCHDOG_GLM_HEARTBEAT_MS: String(NOW_MS - 60_000), // 1 min old — fresh
        HYDRA_WATCHDOG_GLM_DRAINER_LOG_FILE: logFile,
      });
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
      const lines = throughputLines(r.stdout);
      assert.match(lines, /WARNING ZERO-THROUGHPUT/, `expected zero-throughput warning, got: ${lines}`);
      assert.match(lines, /3 consecutive claim attempt\(s\)/, `expected streak=3 in the log, got: ${lines}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("just below threshold: 2 consecutive claims with zero PRs -> quiet (healthy)", () => {
    const dir = makeTmpDir();
    try {
      const logFile = makeLogFile(dir, sterileLines(2));
      const r = runWatchdog({
        HYDRA_WATCHDOG_GLM_HEARTBEAT_MS: String(NOW_MS - 60_000),
        HYDRA_WATCHDOG_GLM_DRAINER_LOG_FILE: logFile,
      });
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
      const lines = throughputLines(r.stdout);
      assert.doesNotMatch(lines, /WARNING ZERO-THROUGHPUT/, `must stay quiet below threshold, got: ${lines}`);
      assert.match(lines, /healthy/, `expected a healthy line, got: ${lines}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("PRs being created: 3 claims each followed by a PR-opened line -> quiet (streak resets)", () => {
    const dir = makeTmpDir();
    try {
      const lines: string[] = [];
      for (let i = 0; i < 3; i++) {
        const issue = 4300 + i;
        lines.push(`hydra-glm-drainer: picked issue #${issue}`);
        lines.push(
          `hydra-glm-drainer: issue #${issue}: PR opened (branch=worktree-agent-glm-${issue}-1), advanced to needs-qa, daily cap incremented`,
        );
      }
      const logFile = makeLogFile(dir, lines);
      const r = runWatchdog({
        HYDRA_WATCHDOG_GLM_HEARTBEAT_MS: String(NOW_MS - 60_000),
        HYDRA_WATCHDOG_GLM_DRAINER_LOG_FILE: logFile,
      });
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
      const stdoutLines = throughputLines(r.stdout);
      assert.doesNotMatch(
        stdoutLines,
        /WARNING ZERO-THROUGHPUT/,
        `must stay quiet when PRs are being created, got: ${stdoutLines}`,
      );
      assert.match(stdoutLines, /0 consecutive claim/, `expected streak reset to 0, got: ${stdoutLines}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("adopted PR (#3900 collision) also resets the streak, not just a fresh create", () => {
    const dir = makeTmpDir();
    try {
      const lines: string[] = [
        `hydra-glm-drainer: picked issue #4400`,
        `hydra-glm-drainer: WARN gh pr create failed for issue #4400 branch=worktree-agent-glm-4400-1: some error — checking gh pr list before treating this as a genuine failure`,
        `hydra-glm-drainer: ANOMALY issue #4400: gh pr create failed but PR #9001 (https://example/pr/9001) already exists for branch=worktree-agent-glm-4400-1 — adopting it instead of releasing the claim (see issue #3900)`,
        `hydra-glm-drainer: issue #4400: PR opened (branch=worktree-agent-glm-4400-1), advanced to needs-qa, daily cap incremented`,
        // Two more sterile claims afterward — should count only these two, not the adopted one.
        `hydra-glm-drainer: picked issue #4401`,
        `hydra-glm-drainer: picked issue #4402`,
      ];
      const logFile = makeLogFile(dir, lines);
      const r = runWatchdog({
        HYDRA_WATCHDOG_GLM_HEARTBEAT_MS: String(NOW_MS - 60_000),
        HYDRA_WATCHDOG_GLM_DRAINER_LOG_FILE: logFile,
      });
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
      const stdoutLines = throughputLines(r.stdout);
      assert.doesNotMatch(stdoutLines, /WARNING ZERO-THROUGHPUT/, `2 < threshold 3, must stay quiet, got: ${stdoutLines}`);
      assert.match(stdoutLines, /2 consecutive claim/, `expected streak=2 (post-adopt claims only), got: ${stdoutLines}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no work queued: fresh heartbeat, only idle/paused lines, zero claim attempts -> quiet", () => {
    const dir = makeTmpDir();
    try {
      const lines = [
        "hydra-glm-drainer: no glm-eligible + ready-for-agent issue with an approved design concept — idle",
        "hydra-glm-drainer: no glm-eligible + ready-for-agent issue with an approved design concept — idle",
        "hydra-glm-drainer: no glm-eligible + ready-for-agent issue with an approved design concept — idle",
      ];
      const logFile = makeLogFile(dir, lines);
      const r = runWatchdog({
        HYDRA_WATCHDOG_GLM_HEARTBEAT_MS: String(NOW_MS - 60_000),
        HYDRA_WATCHDOG_GLM_DRAINER_LOG_FILE: logFile,
      });
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
      const stdoutLines = throughputLines(r.stdout);
      assert.doesNotMatch(
        stdoutLines,
        /WARNING ZERO-THROUGHPUT/,
        `no work queued must not read as sterile, got: ${stdoutLines}`,
      );
      assert.match(stdoutLines, /0 consecutive claim/, `expected streak=0 (no claims at all), got: ${stdoutLines}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("heartbeat STALE: even with a sterile log, stays quiet (down is a separate condition)", () => {
    const dir = makeTmpDir();
    try {
      const logFile = makeLogFile(dir, sterileLines(5));
      const r = runWatchdog({
        // 46 minutes old > the 45-min default staleness window.
        HYDRA_WATCHDOG_GLM_HEARTBEAT_MS: String(NOW_MS - 46 * 60 * 1000),
        HYDRA_WATCHDOG_GLM_DRAINER_LOG_FILE: logFile,
      });
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
      const stdoutLines = throughputLines(r.stdout);
      assert.doesNotMatch(stdoutLines, /WARNING ZERO-THROUGHPUT/, `stale heartbeat must not alarm, got: ${stdoutLines}`);
      assert.match(stdoutLines, /heartbeat stale/, `expected a stale-heartbeat skip line, got: ${stdoutLines}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("heartbeat ABSENT: stays quiet (down/#3754 territory, not sterile)", () => {
    const dir = makeTmpDir();
    try {
      const logFile = makeLogFile(dir, sterileLines(5));
      const r = runWatchdog({
        HYDRA_WATCHDOG_GLM_HEARTBEAT_MS: "", // explicitly empty -> simulates an absent key
        HYDRA_WATCHDOG_GLM_DRAINER_LOG_FILE: logFile,
      });
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
      const stdoutLines = throughputLines(r.stdout);
      assert.doesNotMatch(stdoutLines, /WARNING ZERO-THROUGHPUT/, `absent heartbeat must not alarm, got: ${stdoutLines}`);
      assert.match(stdoutLines, /heartbeat absent\/unreadable/, `expected an absent-heartbeat skip line, got: ${stdoutLines}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("custom threshold via HYDRA_WATCHDOG_GLM_ZERO_THROUGHPUT_N", () => {
    const dir = makeTmpDir();
    try {
      const logFile = makeLogFile(dir, sterileLines(2));
      const r = runWatchdog({
        HYDRA_WATCHDOG_GLM_HEARTBEAT_MS: String(NOW_MS - 60_000),
        HYDRA_WATCHDOG_GLM_DRAINER_LOG_FILE: logFile,
        HYDRA_WATCHDOG_GLM_ZERO_THROUGHPUT_N: "2",
      });
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
      const stdoutLines = throughputLines(r.stdout);
      assert.match(stdoutLines, /WARNING ZERO-THROUGHPUT/, `2 claims should trip a threshold of 2, got: ${stdoutLines}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing log file: WARN + exit 0, never alarms", () => {
    const dir = makeTmpDir();
    try {
      const r = runWatchdog({
        HYDRA_WATCHDOG_GLM_HEARTBEAT_MS: String(NOW_MS - 60_000),
        HYDRA_WATCHDOG_GLM_DRAINER_LOG_FILE: join(dir, "does-not-exist.log"),
      });
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
      const stdoutLines = throughputLines(r.stdout);
      assert.doesNotMatch(stdoutLines, /WARNING ZERO-THROUGHPUT/, `unreadable log must not alarm, got: ${stdoutLines}`);
      assert.match(stdoutLines, /WARN log file not found/, `expected a WARN line, got: ${stdoutLines}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

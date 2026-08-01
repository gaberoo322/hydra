/**
 * test/glm-drainer-loop.test.mts — regression coverage for the GLM dev-drainer
 * loop's gating logic (scripts/glm/drainer-loop.sh, issue #3689, ADR-0032 as
 * amended by #3753).
 *
 * These cases pin the loop's admission order — kill-switch (operator `paused`
 * ONLY) -> daily cap -> heartbeat refresh (BEFORE the flock attempt) -> flock
 * (concurrency=1) — using the same fixture-server + env-override technique as
 * test/pace-gate-allow.test.mts: an HTTP fixture stands in for
 * GET /api/autopilot/paused, HYDRA_GLM_DRAINER_HEARTBEAT_CMD substitutes a
 * marker-writing stub for the real Redis-backed heartbeat write, and
 * HYDRA_GLM_DRAINER_DRY_RUN=1 stops the script right after the flock is
 * acquired — so every case here exercises real gating logic without any live
 * `gh`/`claude` process.
 *
 * Pure shell test: no Redis, no gh, no claude. The heartbeat WRITE accessor
 * itself (`setGlmDrainerHeartbeat`) is covered separately in
 * test/autopilot-board.test.mts, alongside the existing liveness-read tests
 * for the same Redis key.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";

const DRAINER_LOOP = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "glm",
  "drainer-loop.sh",
);

/** Serve a fixed `{ paused }` JSON on an ephemeral port; resolve with url+close. */
function pausedServer(payload: unknown): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(payload));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as any;
      resolve({
        url: `http://127.0.0.1:${addr.port}/api/autopilot/paused`,
        close: () => server.close(),
      });
    });
  });
}

/**
 * Write a no-args heartbeat stub script that appends "hb" to `markerPath`.
 * The loop expands HYDRA_GLM_DRAINER_HEARTBEAT_CMD unquoted (word-split, no
 * quote re-parsing — mirrors HYDRA_PACE_GATE_EXEC_CMD in pace-gate.sh), so
 * the override must be a single space-free token: a script path, not an
 * inline `bash -c "..."` one-liner (embedded quotes would themselves be
 * word-split apart).
 */
function writeHeartbeatStub(workDir: string, markerPath: string): string {
  const stubPath = join(workDir, "heartbeat-stub.sh");
  writeFileSync(stubPath, `#!/usr/bin/env bash\necho hb >> "${markerPath}"\n`);
  chmodSync(stubPath, 0o755);
  return stubPath;
}

function runDrainerLoop(
  pausedUrl: string,
  extraEnv: Record<string, string>,
  markerPath: string,
  lockPath: string,
  capDir: string,
): Promise<{ status: number; stdout: string }> {
  const stubPath = writeHeartbeatStub(capDir, markerPath);
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [DRAINER_LOOP], {
      env: {
        ...process.env,
        HYDRA_GLM_DRAINER_PAUSED_URL: pausedUrl,
        HYDRA_GLM_DRAINER_LOCK: lockPath,
        HYDRA_GLM_DRAINER_CAP_DIR: capDir,
        HYDRA_GLM_DRAINER_HEARTBEAT_CMD: stubPath,
        HYDRA_GLM_DRAINER_DRY_RUN: "1",
        ...extraEnv,
      },
    });
    let stdout = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stdout += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ status: code ?? -1, stdout }));
  });
}

/** Count heartbeat-marker lines written so far (0 if the file doesn't exist). */
function heartbeatCount(markerPath: string): number {
  if (!existsSync(markerPath)) return 0;
  return readFileSync(markerPath, "utf8").split("\n").filter((l) => l === "hb").length;
}

describe("drainer-loop.sh admission gating (issue #3689, ADR-0032)", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "hydra-glm-drainer-test-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  test("operator paused:true => skip, heartbeat NOT refreshed", async () => {
    const marker = join(workDir, "heartbeat.marker");
    const lock = join(workDir, "drainer.lock");
    const srv = await pausedServer({ paused: true });
    try {
      const r = await runDrainerLoop(srv.url, {}, marker, lock, workDir);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /operator paused — skip/);
      assert.doesNotMatch(r.stdout, /would-author/);
      assert.equal(heartbeatCount(marker), 0);
    } finally {
      srv.close();
    }
  });

  test("pause endpoint unreachable => fail safe, skip, heartbeat NOT refreshed", async () => {
    const marker = join(workDir, "heartbeat.marker");
    const lock = join(workDir, "drainer.lock");
    // Deliberately bogus URL — nothing listens there.
    const r = await runDrainerLoop(
      "http://127.0.0.1:1/api/autopilot/paused",
      {},
      marker,
      lock,
      workDir,
    );
    assert.equal(r.status, 0);
    assert.match(r.stdout, /failing safe/);
    assert.doesNotMatch(r.stdout, /would-author/);
    assert.equal(heartbeatCount(marker), 0);
  });

  test("daily cap reached => skip, heartbeat NOT refreshed", async () => {
    const marker = join(workDir, "heartbeat.marker");
    const lock = join(workDir, "drainer.lock");
    const srv = await pausedServer({ paused: false });
    try {
      const today = new Date().toISOString().slice(0, 10);
      const capFile = join(workDir, `hydra-glm-drainer-daily-${today}.count`);
      writeFileSync(capFile, "5");
      const r = await runDrainerLoop(
        srv.url,
        { HYDRA_GLM_DRAINER_DAILY_CAP: "5" },
        marker,
        lock,
        workDir,
      );
      assert.equal(r.status, 0);
      assert.match(r.stdout, /daily cap reached \(5\/5\)/);
      assert.doesNotMatch(r.stdout, /would-author/);
      assert.equal(heartbeatCount(marker), 0);
    } finally {
      srv.close();
    }
  });

  test("eligible tick: heartbeat refreshed BEFORE flock, then DRY_RUN would-author", async () => {
    const marker = join(workDir, "heartbeat.marker");
    const lock = join(workDir, "drainer.lock");
    const srv = await pausedServer({ paused: false });
    try {
      const r = await runDrainerLoop(srv.url, {}, marker, lock, workDir);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /heartbeat refreshed/);
      assert.match(r.stdout, /would-author/);
      assert.equal(heartbeatCount(marker), 1);
    } finally {
      srv.close();
    }
  });

  test("lock already held by another tick => still refreshes heartbeat, then skips (no would-author)", async () => {
    const marker = join(workDir, "heartbeat.marker");
    const lock = join(workDir, "drainer.lock");
    const srv = await pausedServer({ paused: false });
    // Hold the lock externally for the duration of this case, simulating
    // another tick's authoring run still in flight.
    const bgHolder = spawn("bash", [
      "-c",
      `exec 8>"${lock}"; flock 8; sleep 3`,
    ]);
    // Give the background holder a brief moment to actually take the lock
    // before the drainer loop attempts it.
    await new Promise((r) => setTimeout(r, 300));

    try {
      const r = await runDrainerLoop(srv.url, {}, marker, lock, workDir);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /heartbeat refreshed/);
      assert.match(r.stdout, /another tick holds the lock/);
      assert.doesNotMatch(r.stdout, /would-author/);
      assert.equal(heartbeatCount(marker), 1);
    } finally {
      srv.close();
      bgHolder.kill();
    }
  });
});

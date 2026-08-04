/**
 * Regression tests for the GLM dev-drainer loop's control flow (issue #3689,
 * ADR-0032 as amended by #3753/#3758).
 *
 * Mirrors `test/pace-gate-allow.test.mts`'s technique: spawn the real shell
 * script under `HYDRA_GLM_DRAINER_DRY_RUN=1` (every mutating/network action
 * logs "would-<action>" to stderr and no-ops instead of executing — see the
 * script's own header) against a fixture HTTP server for the one live call
 * this suite needs to control (`GET /api/autopilot/paused`), and assert on
 * the combined stdout+stderr transcript. This drives the pure gating logic —
 * flock / operator-paused-only / daily-cap / heartbeat-only-when-able —
 * with no gh/git/claude/Redis dependency.
 *
 * What this suite does NOT attempt to cover end-to-end (deliberately, same
 * boundary `pace-gate-allow.test.mts` draws around its own script): issue
 * selection, worktree creation, the claude authoring spawn, and PR creation
 * all shell out to `gh`/`git`/the generated Node driver in production and are
 * exercised structurally via code review + the manual DRY_RUN smoke test this
 * PR's author ran against the live repo (see the PR description) rather than
 * mocked line-by-line here — `hydra-dev-parent-flow.md`'s own worktree-spawn
 * logic (the closest analogue) carries no automated test either, for the same
 * reason: it is orchestration glue over already-covered primitives
 * (`src/glm/drainer-runner.ts`, `src/redis/autopilot.ts`, `recover-stale.sh`).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const DRAINER_LOOP = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "glm",
  "drainer-loop.sh",
);

/** Serve a fixed `{paused: bool}` JSON on an ephemeral port. */
function pausedServer(paused: boolean | null): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      if (paused === null) {
        // Malformed body — exercises the "unparseable" fail-safe arm.
        res.end("not json");
        return;
      }
      res.end(JSON.stringify({ paused }));
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

function runDrainerLoop(
  pausedUrl: string,
  extraEnv: Record<string, string> = {},
): Promise<{ status: number; combined: string }> {
  return new Promise((resolve, reject) => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-drainer-test-"));
    const child = spawn("bash", [DRAINER_LOOP], {
      env: {
        ...process.env,
        HYDRA_GLM_DRAINER_DRY_RUN: "1",
        HYDRA_GLM_DRAINER_PAUSED_URL: pausedUrl,
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

describe("scripts/glm/drainer-loop.sh — kill-switch honors ONLY operator paused (ADR-0032 Decision 6, issue #3689)", () => {
  test("paused:true => skip, no heartbeat", async () => {
    const srv = await pausedServer(true);
    try {
      const r = await runDrainerLoop(srv.url);
      assert.equal(r.status, 0);
      assert.match(r.combined, /operator paused — skip \(no heartbeat/);
      assert.doesNotMatch(r.combined, /would-heartbeat/);
    } finally {
      srv.close();
    }
  });

  test("paused:false => proceeds past the kill-switch (heartbeat attempted)", async () => {
    const srv = await pausedServer(false);
    try {
      const r = await runDrainerLoop(srv.url);
      assert.equal(r.status, 0);
      assert.doesNotMatch(r.combined, /operator paused — skip/);
      assert.match(r.combined, /would-heartbeat \(reason=able/);
    } finally {
      srv.close();
    }
  });

  test("unreachable pause endpoint => fails safe (treated as paused, no heartbeat)", async () => {
    // Port 1 is never listening — connection refused, deterministic.
    const r = await runDrainerLoop("http://127.0.0.1:1/api/autopilot/paused");
    assert.equal(r.status, 0);
    assert.match(r.combined, /pause endpoint unreachable/);
    assert.match(r.combined, /operator paused — skip \(no heartbeat/);
    assert.doesNotMatch(r.combined, /would-heartbeat/);
  });

  test("unparseable pause response => fails safe (treated as paused, no heartbeat)", async () => {
    const srv = await pausedServer(null);
    try {
      const r = await runDrainerLoop(srv.url);
      assert.equal(r.status, 0);
      assert.match(r.combined, /pause response unparseable/);
      assert.match(r.combined, /operator paused — skip \(no heartbeat/);
      assert.doesNotMatch(r.combined, /would-heartbeat/);
    } finally {
      srv.close();
    }
  });

  test("paused:false is NOT misread as unparseable (jq `//` false-is-falsy trap, mirrors pace-gate #1790)", async () => {
    // Regression pin: `.paused // "parse-error"` would collapse a legitimate
    // `false` into the parse-error branch (jq's `//` treats `false` as
    // falsy). The fix uses bare `.paused` + strict string matching, exactly
    // like pace-gate.sh's own `.allow` fix. This test would have failed
    // against the buggy version (it would have hit the "unparseable" log
    // line and skipped instead of proceeding).
    const srv = await pausedServer(false);
    try {
      const r = await runDrainerLoop(srv.url);
      assert.doesNotMatch(r.combined, /pause response unparseable/);
    } finally {
      srv.close();
    }
  });

  test("Anthropic-shaped fields in the response body are irrelevant — only .paused is read", async () => {
    // A server that ALSO carries Anthropic emergencyStop-shaped noise must
    // not influence the verdict — this endpoint (GET /api/autopilot/paused)
    // only ever returns {paused, since?} in production, but a hostile/buggy
    // fixture proves the script reads no other field.
    const server = http.createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ paused: false, emergencyStop: true, weeklyEmergencyStop: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as any;
    const url = `http://127.0.0.1:${addr.port}/api/autopilot/paused`;
    try {
      const r = await runDrainerLoop(url);
      assert.doesNotMatch(r.combined, /operator paused — skip/);
      assert.match(r.combined, /would-heartbeat \(reason=able/);
    } finally {
      server.close();
    }
  });
});

describe("scripts/glm/drainer-loop.sh — daily PR cap (issue #3689)", () => {
  test("cap not yet reached => proceeds (heartbeat attempted)", async () => {
    const srv = await pausedServer(false);
    try {
      const r = await runDrainerLoop(srv.url, { HYDRA_GLM_DRAINER_DAILY_CAP: "5" });
      assert.doesNotMatch(r.combined, /daily PR cap reached/);
      assert.match(r.combined, /would-heartbeat \(reason=able/);
    } finally {
      srv.close();
    }
  });

  test("cap already at the limit => skip, no heartbeat", async () => {
    const srv = await pausedServer(false);
    const tmp = mkdtempSync(join(tmpdir(), "glm-drainer-cap-test-"));
    try {
      const today = new Date().toISOString().slice(0, 10);
      writeFileSync(join(tmp, `hydra-glm-drainer-daily-cap-${today}`), "3");
      const r = await new Promise<{ status: number; combined: string }>((resolve, reject) => {
        const child = spawn("bash", [DRAINER_LOOP], {
          env: {
            ...process.env,
            HYDRA_GLM_DRAINER_DRY_RUN: "1",
            HYDRA_GLM_DRAINER_PAUSED_URL: srv.url,
            HYDRA_GLM_DRAINER_LOCKFILE: join(tmp, "lock"),
            HYDRA_GLM_DRAINER_CAP_DIR: tmp,
            HYDRA_GLM_DRAINER_DAILY_CAP: "3",
          },
        });
        let combined = "";
        child.stdout.on("data", (d) => { combined += d.toString(); });
        child.stderr.on("data", (d) => { combined += d.toString(); });
        child.on("error", reject);
        child.on("close", (code) => resolve({ status: code ?? -1, combined }));
      });
      assert.equal(r.status, 0);
      assert.match(r.combined, /daily PR cap reached \(3\/3\)/);
      assert.doesNotMatch(r.combined, /would-heartbeat/);
    } finally {
      srv.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("scripts/glm/drainer-loop.sh — flock concurrency=1 (ADR-0032 invariant 5, issue #3689)", () => {
  test("a held lock is detected as blocked and STILL refreshes the heartbeat (2026-07-27 AMENDMENTS #3)", async () => {
    const srv = await pausedServer(false);
    const tmp = mkdtempSync(join(tmpdir(), "glm-drainer-flock-test-"));
    const lockfile = join(tmp, "lock");
    // Hold the lock from a separate process for the duration of the test —
    // `flock <fd>` with no command blocks until the fd is closed or the
    // process exits; killed in the `finally` block below.
    const holder = spawn("bash", ["-c", `exec 9>"${lockfile}"; flock 9; sleep 30`]);
    try {
      // Give the holder a moment to actually acquire the lock before racing it.
      await new Promise((r) => setTimeout(r, 300));
      const r = await runDrainerLoop(srv.url, { HYDRA_GLM_DRAINER_LOCKFILE: lockfile, HYDRA_GLM_DRAINER_CAP_DIR: tmp });
      assert.equal(r.status, 0);
      assert.match(r.combined, /flock blocked/);
      assert.match(r.combined, /would-heartbeat \(reason=blocked/);
      // The blocked branch must exit BEFORE the paused/cap gating — it never
      // even reaches those checks (the still-running "other tick" already
      // passed them when IT started).
      assert.doesNotMatch(r.combined, /would-heartbeat \(reason=able/);
    } finally {
      holder.kill("SIGKILL");
      rmSync(tmp, { recursive: true, force: true });
      srv.close();
    }
  });

  test("no held lock => acquires cleanly and proceeds past the flock step", async () => {
    const srv = await pausedServer(false);
    try {
      const r = await runDrainerLoop(srv.url);
      assert.doesNotMatch(r.combined, /flock blocked/);
    } finally {
      srv.close();
    }
  });
});

describe("scripts/glm/drainer-loop.sh — systemd units mirror the pace-gate shape (issue #3689)", () => {
  test("the .service is Type=oneshot with a WorkingDirectory and journal logging, like hydra-pace-gate.service", async () => {
    const fs = await import("node:fs");
    const svc = fs.readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "systemd", "hydra-glm-drainer.service"),
      "utf8",
    );
    assert.match(svc, /Type=oneshot/);
    assert.match(svc, /WorkingDirectory=%h\/hydra/);
    assert.match(svc, /ExecStart=.*drainer-loop\.sh/);
    assert.match(svc, /StandardOutput=journal/);
    assert.match(svc, /StandardError=journal/);
  });

  test("the .timer fires ~15 min with jitter and Persistent=true, like hydra-pace-gate.timer", async () => {
    const fs = await import("node:fs");
    const timer = fs.readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "systemd", "hydra-glm-drainer.timer"),
      "utf8",
    );
    assert.match(timer, /OnUnitActiveSec=15min/);
    assert.match(timer, /Persistent=true/);
    assert.match(timer, /RandomizedDelaySec=/);
    assert.match(timer, /Unit=hydra-glm-drainer\.service/);
    assert.match(timer, /WantedBy=timers\.target/);
  });
});

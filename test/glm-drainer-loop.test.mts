/**
 * Regression tests for the GLM dev-drainer loop's control flow (issue #3689,
 * ADR-0032 as amended by #3753/#3758).
 *
 * Mirrors `test/pace-gate-allow.test.mts`'s technique: spawn the real shell
 * script under `HYDRA_GLM_DRAINER_DRY_RUN=1` (every mutating/network action
 * logs "would-<action>" to stderr and no-ops instead of executing — see the
 * script's own header) and assert on the combined stdout+stderr transcript.
 * D1–D4 drive the flock step and the REAL `gate` driver mode (issue #4682):
 * the operator pause is read from Redis — the per-run test DB, set via
 * setAutopilotPaused()/clearAutopilotPaused() — replacing the old fixture
 * HTTP pause server. The gate's decision core and effect rules are also
 * unit-tested as typed tables over fake deps in test/glm-gate.test.mts.
 *
 * Since the finish phase moved to TypeScript (src/glm/finish.ts, issue
 * #4685), the post-author arms, the salvage ladder, the z.ai quota block,
 * the per-issue timeout cap, and the open-PR adopt-on-collision fallback
 * (issue #3900) are unit-tested over fake deps in test/glm-finish.test.mts
 * — the #4337/#4273/#3900 bash groups this suite used to carry were deleted
 * in that same PR. What stays here is what is still bash: the whole-script
 * DRY_RUN control flow below (kill-switch, cap, quota skip, flock, systemd
 * units, the run_driver bridge) plus ONE sourced-snippet compose_prompt
 * case — the RESUME paragraph the resumed session reads is the one
 * attempt-level contract that did not move (the authoring prompt is
 * composed BEFORE the author runs, so it cannot ride the finish phase's
 * deps). Still deliberately uncovered here: the real `claude` spawn itself,
 * pinned at the `src/glm/` seam by test/glm-drainer-runner.test.mts and
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

const DRAINER_LOOP = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "glm",
  "drainer-loop.sh",
);

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
 * `[[ "${BASH_SOURCE[0]}" == "${0}" ]]` guard) and then runs `snippet`
 * (typically a single function call) in the SAME bash process, so the
 * snippet can call the script's functions directly. Used below to unit-test
 * `run_driver()` against a fake `node` on PATH and `compose_prompt()`'s
 * RESUME paragraph, without spawning the full DRY_RUN control flow tested by
 * the whole-script groups (the finish-phase functions this technique used to
 * drive were ported to src/glm/finish.ts, with their coverage in
 * test/glm-finish.test.mts).
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

// D1–D3 drive the REAL `gate` driver mode through the whole script. The
// driver child inherits REDIS_URL from redis-db-launch, so it reads the
// per-run test DB's pause flag; each group owns its own before/beforeEach/
// after lifecycle and clears the flag (never piggybacking on a sibling's
// teardown). The curl/jq-specific D1 cases (unreachable endpoint, unparseable
// body, jq `//` trap, Anthropic-shaped fields) moved to runGate unit cases in
// test/glm-gate.test.mts with the HTTP pause read they exercised (#4682).

describe("scripts/glm/drainer-loop.sh — kill-switch honors ONLY operator paused (ADR-0032 Decision 6, issue #3689)", () => {
  beforeEach(async () => {
    await clearAutopilotPaused();
  });
  after(async () => {
    await clearAutopilotPaused();
    closeRedisConnections();
  });

  test("paused:true => skip, no heartbeat", async () => {
    await setAutopilotPaused();
    const r = await runDrainerLoop();
    assert.equal(r.status, 0);
    assert.match(r.combined, /operator paused — skip \(no heartbeat/);
    assert.doesNotMatch(r.combined, /would-heartbeat/);
  });

  test("paused:false => proceeds past the kill-switch (heartbeat attempted)", async () => {
    const r = await runDrainerLoop();
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.combined, /operator paused — skip/);
    assert.match(r.combined, /would-heartbeat \(reason=able/);
  });
});

describe("scripts/glm/drainer-loop.sh — daily PR cap (issue #3689)", () => {
  beforeEach(async () => {
    await clearAutopilotPaused();
  });
  after(async () => {
    closeRedisConnections();
  });

  test("cap not yet reached => proceeds (heartbeat attempted)", async () => {
    const r = await runDrainerLoop({ HYDRA_GLM_DRAINER_DAILY_CAP: "5" });
    assert.doesNotMatch(r.combined, /daily PR cap reached/);
    assert.match(r.combined, /would-heartbeat \(reason=able/);
  });

  test("cap already at the limit => skip, no heartbeat", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-drainer-cap-test-"));
    try {
      const today = new Date().toISOString().slice(0, 10);
      writeFileSync(join(tmp, `hydra-glm-drainer-daily-cap-${today}`), "3");
      const r = await runDrainerLoop({
        HYDRA_GLM_DRAINER_CAP_DIR: tmp,
        HYDRA_GLM_DRAINER_DAILY_CAP: "3",
      });
      assert.equal(r.status, 0);
      assert.match(r.combined, /daily PR cap reached \(3\/3\)/);
      assert.doesNotMatch(r.combined, /would-heartbeat/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("scripts/glm/drainer-loop.sh — z.ai quota block is a third pre-heartbeat skip (issue #4273)", () => {
  beforeEach(async () => {
    await clearAutopilotPaused();
  });
  after(async () => {
    closeRedisConnections();
  });

  test("active (future-instant) block file => skip before heartbeat, no heartbeat attempted", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-drainer-quota-block-test-"));
    try {
      const futureEpoch = Math.floor(Date.now() / 1000) + 1000;
      writeFileSync(join(tmp, "hydra-glm-drainer-quota-blocked-until"), String(futureEpoch));
      const r = await runDrainerLoop({ HYDRA_GLM_DRAINER_CAP_DIR: tmp });
      assert.equal(r.status, 0);
      assert.match(r.combined, /quota block active .* — skip \(no heartbeat\)/);
      assert.doesNotMatch(r.combined, /would-heartbeat \(reason=able/);
      assert.equal(
        existsSync(join(tmp, "hydra-glm-drainer-quota-blocked-until")),
        true,
        "an active block file must not be deleted",
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("expired (past-instant) block file => proceeds normally and the stale file is removed", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-drainer-quota-block-test-"));
    try {
      const pastEpoch = Math.floor(Date.now() / 1000) - 1000;
      writeFileSync(join(tmp, "hydra-glm-drainer-quota-blocked-until"), String(pastEpoch));
      const r = await runDrainerLoop({ HYDRA_GLM_DRAINER_CAP_DIR: tmp });
      assert.equal(r.status, 0);
      assert.doesNotMatch(r.combined, /quota block active/);
      assert.match(r.combined, /would-heartbeat \(reason=able/);
      assert.equal(
        existsSync(join(tmp, "hydra-glm-drainer-quota-blocked-until")),
        false,
        "an expired block file must be deleted on read",
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("no block file => proceeds normally (the common case)", async () => {
    const r = await runDrainerLoop();
    assert.doesNotMatch(r.combined, /quota block active/);
    assert.match(r.combined, /would-heartbeat \(reason=able/);
  });
});

describe("scripts/glm/drainer-loop.sh — flock concurrency=1 (ADR-0032 invariant 5, issue #3689)", () => {
  test("a held lock is detected as blocked and STILL refreshes the heartbeat (2026-07-27 AMENDMENTS #3)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-drainer-flock-test-"));
    const lockfile = join(tmp, "lock");
    // Hold the lock from a separate process for the duration of the test —
    // `flock <fd>` with no command blocks until the fd is closed or the
    // process exits; killed in the `finally` block below.
    const holder = spawn("bash", ["-c", `exec 9>"${lockfile}"; flock 9; sleep 30`]);
    try {
      // Give the holder a moment to actually acquire the lock before racing it.
      await new Promise((r) => setTimeout(r, 300));
      const r = await runDrainerLoop({ HYDRA_GLM_DRAINER_LOCKFILE: lockfile, HYDRA_GLM_DRAINER_CAP_DIR: tmp });
      assert.equal(r.status, 0);
      assert.match(r.combined, /flock blocked/);
      assert.match(r.combined, /would-heartbeat \(reason=blocked/);
      // The blocked branch must exit BEFORE the gate phase — it never
      // even reaches the paused/cap/quota checks (the still-running "other tick" already
      // passed them when IT started).
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

describe("scripts/glm/drainer-loop.sh — never produces a dispatch cost-join record, by construction (issue #4126 INV-6)", () => {
  test("the script never references reap.py or the dispatch-cost-join write path", () => {
    // Issue #4126's join write (`_post_dispatch_cost_join` in
    // scripts/autopilot/reap.py, POSTing to /api/usage/dispatch-cost) is
    // fired ONLY from reap.py's `run_completion` — the SubagentStop hook /
    // reap.py fallback that owns this write path. The GLM drainer is a
    // wholly separate lane (ADR-0032): it never sources, execs, or shells out
    // to reap.py, so a GLM-authored dev_orch run structurally cannot reach
    // this write path — there is no code path connecting the two scripts.
    // This is the intended behavior, not a defect: it's exactly what lets a
    // GLM-arm issue's dev_orch entry read near-zero-Anthropic while its
    // later qa_orch entry (which DOES run through the normal harness) still
    // carries real Anthropic cost, satisfying the epic's "GLM issues must
    // not read as free" acceptance criterion.
    const source = readFileSync(DRAINER_LOOP, "utf8");
    assert.doesNotMatch(
      source,
      /reap\.py/,
      "drainer-loop.sh must never reference reap.py — the two lanes stay structurally disjoint",
    );
    assert.doesNotMatch(
      source,
      /dispatch-cost/,
      "drainer-loop.sh must never reference the /api/usage/dispatch-cost write path directly either",
    );
  });
});

describe("scripts/glm/drainer-loop.sh — run_driver() invokes the COMMITTED driver file, not a regenerated /tmp heredoc (issue #4371)", () => {
  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

  test("run_driver invokes the exact argv against the committed scripts/glm/drainer-driver.ts, and never writes a /tmp driver file", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-drainer-rundriver-"));
    try {
      const binDir = join(tmp, "bin");
      mkdirSync(binDir);
      // Fake `node` on PATH: echoes its own argv verbatim so the snippet can
      // assert the exact invocation run_driver() makes, without actually
      // spawning a real node process (and therefore without touching Redis
      // or claude at all).
      writeFileSync(
        join(binDir, "node"),
        `#!/usr/bin/env bash\necho "NODE_ARGV:$*"\nexit 0\n`,
        { mode: 0o755 },
      );
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
      // The heredoc-generated /tmp driver must no longer be written — the
      // committed file is invoked directly.
      const legacyDriverPath = join(tmp, "hydra-glm-drainer-driver.mts");
      assert.equal(
        existsSync(legacyDriverPath),
        false,
        "run_driver must never (re)write a /tmp driver file",
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("write_node_driver / node_driver_path no longer exist as functions", async () => {
    const r = await runShellSnippet(
      {},
      `declare -F write_node_driver >/dev/null 2>&1; echo "WND_EXIT:$?"; ` +
        `declare -F node_driver_path >/dev/null 2>&1; echo "NDP_EXIT:$?"`,
    );
    assert.match(r.combined, /WND_EXIT:1/, "write_node_driver must no longer be a defined function");
    assert.match(r.combined, /NDP_EXIT:1/, "node_driver_path must no longer be a defined function");
  });

  test("real-process smoke: the committed entrypoint resolves its import graph and exits 1 with the fault prefix on an unknown mode", async () => {
    const driverPath = join(REPO_ROOT, "scripts", "glm", "drainer-driver.ts");
    const result = await new Promise<{ status: number | null; combined: string }>((resolve, reject) => {
      const child = spawn("node", ["--experimental-strip-types", driverPath, "no-such-mode"]);
      let combined = "";
      child.stdout.on("data", (d) => { combined += d.toString(); });
      child.stderr.on("data", (d) => { combined += d.toString(); });
      child.on("error", reject);
      child.on("close", (code) => resolve({ status: code, combined }));
    });
    assert.equal(result.status, 1, `expected exit 1:\n${result.combined}`);
    assert.match(result.combined, /glm-drainer driver threw: unknown mode: no-such-mode/);
  });
});

describe("scripts/glm/drainer-loop.sh — compose_prompt's RESUME paragraph survives the finish port (issue #4337 INV-5, issue #4685)", () => {
  // The finish phase moved to TypeScript (src/glm/finish.ts, unit-tested in
  // test/glm-finish.test.mts), but the PROMPT the resumed session reads is
  // still bash's to compose — it is written before the author runs, so it
  // cannot ride the finish phase's deps. This is the one attempt-level
  // contract that stayed in the script; pin it here.
  test("a resume branch is disclosed with its commit count and the pr-body-first instruction; no resume branch => no RESUME section", async () => {
    const resumed = await runShellSnippet(
      {},
      `compose_prompt 77 "Fixture issue body." "worktree-agent-glm-77-1790000000" "2"`,
    );
    assert.equal(resumed.status, 0, `snippet must succeed:\n${resumed.combined}`);
    assert.match(resumed.combined, /## RESUME — a prior drainer session on this issue was cut off by the timeout/);
    assert.match(
      resumed.combined,
      /after committing and pushing 2 commit\(s\) on this\nvery branch \(worktree-agent-glm-77-1790000000\), and no PR was opened for it/,
    );
    assert.match(resumed.combined, /Write the \.glm-drainer-pr-body\.md file FIRST, before touching code/);

    const fresh = await runShellSnippet(
      {},
      `compose_prompt 77 "Fixture issue body." "" ""`,
    );
    assert.equal(fresh.status, 0, `snippet must succeed:\n${fresh.combined}`);
    assert.doesNotMatch(fresh.combined, /## RESUME/, "a fresh (non-resume) dispatch must not carry the RESUME paragraph");
  });
});


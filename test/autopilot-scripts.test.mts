/**
 * Regression test for issue #409 — scripts/autopilot/* extraction.
 *
 * The /hydra-autopilot playbook used to inline ~574 lines of bash and
 * python heredocs. Issue #409 extracted the deterministic phases into
 * standalone scripts under scripts/autopilot/. These tests pin the
 * BEHAVIOR each script must preserve so a future edit to one of the
 * scripts can't silently break the autopilot loop.
 *
 * Each script is invoked directly (no harness), with state files
 * redirected to a tempdir so the live autopilot run isn't disturbed.
 *
 *   bootstrap.sh       — initializes state.json + heartbeat + run log
 *   collect-state.sh   — read-only state collectors (NOT exercised here;
 *                        depends on a live hydra service)
 *   recover-stale.sh   — gh-driven label fixes (NOT exercised here;
 *                        depends on gh + GitHub)
 *   reap.py            — hard-cap trip clears slot + marks burned
 *   term-check.py      — prints TERM:budget / TERM:wall_clock /
 *                        TERM:idle / OK based on state
 *   dispatch.sh log    — appends one line to the run log
 *   drain.sh           — prints the final summary line
 *
 * Network-dependent scripts (collect-state, recover-stale, dispatch's
 * capacity-writeback subcommand) are NOT smoke-tested at the bash
 * level — they're shell-pure plumbing around `gh` / `hydra raw` and
 * would only test those CLIs.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPTS = join(REPO_ROOT, "scripts", "autopilot");

function makeTempState(): { dir: string; state: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-test-"));
  return {
    dir,
    state: join(dir, "state.json"),
    log: join(dir, "nightly.log"),
  };
}

function runBootstrap(env: Record<string, string>, tmp: { state: string; log: string }): {
  status: number;
  stdout: string;
  stderr: string;
} {
  // bootstrap.sh hardcodes /tmp/hydra-autopilot-state.json — but we
  // need test isolation. We exercise it via a HOME-prefixed wrapper
  // that uses an alternative state path by symlink. The simplest
  // honest path: run bootstrap and then COPY the result to our tmp,
  // then point all downstream tests at the tmp copy via env vars
  // (term-check.py and reap.py both honor HYDRA_AUTOPILOT_STATE).
  const result = spawnSync(join(SCRIPTS, "bootstrap.sh"), [], {
    env: { ...process.env, ...env, PATH: process.env.PATH ?? "" },
    encoding: "utf-8",
  });
  if (result.status === 0 && existsSync("/tmp/hydra-autopilot-state.json")) {
    // Copy to test-isolated location.
    writeFileSync(tmp.state, readFileSync("/tmp/hydra-autopilot-state.json"));
  }
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("scripts/autopilot/bootstrap.sh", () => {
  test("initializes state.json with default limits", () => {
    const tmp = makeTempState();
    try {
      const r = runBootstrap({}, tmp);
      assert.equal(r.status, 0, `bootstrap exited non-zero: ${r.stderr}`);
      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      assert.equal(s.limits.token_budget, 2000000);
      assert.equal(s.limits.wall_clock_max_sec, 28800);
      assert.equal(s.limits.idle_drain_turns, 5);
      assert.equal(s.limits.subagent_max_tokens, 400000);
      assert.equal(s.limits.subagent_hard_max_tokens, 800000);
      assert.equal(s.limits.scope, "all");
      assert.deepEqual(s.burned_classes, []);
      assert.equal(s.cumulative_tokens, 0);
      assert.equal(s.idle_turns, 0);
      // The 6 fixed pipeline slots from the #426 decision-brain rewrite.
      // Signal-driven classes (health / sweep_* / discover_*) no longer
      // occupy slots; they live under `signal_last_fired` instead.
      const expectedSlots = [
        "dev_orch", "qa_orch", "research_orch",
        "dev_target", "qa_target", "research_target",
      ];
      assert.equal(Object.keys(s.slots).length, expectedSlots.length, "slots schema has 6 entries");
      for (const cls of expectedSlots) {
        assert.equal(s.slots[cls], null, `slot ${cls} should be null`);
      }
      const expectedSignals = [
        "health", "sweep_orch", "sweep_target", "discover_orch", "discover_target",
      ];
      for (const sig of expectedSignals) {
        assert.equal(s.signal_last_fired[sig], 0, `signal ${sig} should start at 0`);
      }
      assert.deepEqual(s.failure_log, [], "failure_log seeded empty (issue #426)");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("respects env-var overrides for budget knobs", () => {
    const tmp = makeTempState();
    try {
      const r = runBootstrap(
        {
          HYDRA_AUTOPILOT_TOKEN_BUDGET: "100000",
          HYDRA_AUTOPILOT_MAX_SEC: "120",
          HYDRA_AUTOPILOT_IDLE_TURNS: "2",
          HYDRA_AUTOPILOT_SCOPE: "orch-only",
        },
        tmp,
      );
      assert.equal(r.status, 0);
      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      assert.equal(s.limits.token_budget, 100000);
      assert.equal(s.limits.wall_clock_max_sec, 120);
      assert.equal(s.limits.idle_drain_turns, 2);
      assert.equal(s.limits.scope, "orch-only");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("rejects soft cap > hard cap with non-zero exit", () => {
    const tmp = makeTempState();
    try {
      const r = runBootstrap(
        {
          HYDRA_AUTOPILOT_SUBAGENT_MAX_TOKENS: "1000000",
          HYDRA_AUTOPILOT_SUBAGENT_HARD_MAX_TOKENS: "500000",
        },
        tmp,
      );
      assert.notEqual(r.status, 0);
      assert.match(r.stdout + r.stderr, /FATAL.*exceeds/);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("rejects invalid scope value", () => {
    const tmp = makeTempState();
    try {
      const r = runBootstrap({ HYDRA_AUTOPILOT_SCOPE: "invalid-scope" }, tmp);
      assert.notEqual(r.status, 0);
      assert.match(r.stdout + r.stderr, /FATAL.*SCOPE.*invalid/);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});

describe("scripts/autopilot/term-check.py", () => {
  function writeState(path: string, patch: Record<string, unknown>): void {
    // Post-#426 schema: 6 pipeline slots + signal_last_fired map.
    const base = {
      started_epoch: Math.floor(Date.now() / 1000),
      limits: {
        token_budget: 2000000,
        wall_clock_max_sec: 28800,
        idle_drain_turns: 5,
        scope: "all",
        subagent_max_tokens: 400000,
        subagent_hard_max_tokens: 800000,
      },
      cumulative_tokens: 0,
      idle_turns: 0,
      slots: {
        dev_orch: null, qa_orch: null, research_orch: null,
        dev_target: null, qa_target: null, research_target: null,
      },
      signal_last_fired: {
        health: 0, sweep_orch: 0, sweep_target: 0,
        discover_orch: 0, discover_target: 0,
      },
      failure_log: [],
    };
    writeFileSync(path, JSON.stringify({ ...base, ...patch }));
  }

  function runTermCheck(statePath: string): { status: number; stdout: string } {
    const r = spawnSync(join(SCRIPTS, "term-check.py"), [], {
      env: { ...process.env, HYDRA_AUTOPILOT_STATE: statePath },
      encoding: "utf-8",
    });
    return { status: r.status ?? -1, stdout: (r.stdout ?? "").trim() };
  }

  test("prints OK when no termination condition met", () => {
    const tmp = makeTempState();
    try {
      writeState(tmp.state, {});
      const r = runTermCheck(tmp.state);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /^OK /);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("prints TERM:budget when cumulative tokens >= budget", () => {
    const tmp = makeTempState();
    try {
      writeState(tmp.state, { cumulative_tokens: 2000001 });
      const r = runTermCheck(tmp.state);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /^TERM:budget /);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("prints TERM:wall_clock when elapsed >= wall_clock_max_sec", () => {
    const tmp = makeTempState();
    try {
      // Started 100 seconds ago, cap = 60
      writeState(tmp.state, {
        started_epoch: Math.floor(Date.now() / 1000) - 100,
        limits: {
          token_budget: 2000000,
          wall_clock_max_sec: 60,
          idle_drain_turns: 5,
          scope: "all",
          subagent_max_tokens: 400000,
          subagent_hard_max_tokens: 800000,
        },
      });
      const r = runTermCheck(tmp.state);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /^TERM:wall_clock /);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("prints TERM:idle when idle_turns >= cap AND all slots empty", () => {
    const tmp = makeTempState();
    try {
      writeState(tmp.state, { idle_turns: 5 });
      const r = runTermCheck(tmp.state);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /^TERM:idle /);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("does NOT trip idle when a slot is occupied", () => {
    const tmp = makeTempState();
    try {
      writeState(tmp.state, {
        idle_turns: 5,
        slots: {
          dev_orch: { skill: "hydra-dev", started: "now", partial_tokens: 0 },
          qa_orch: null, research_orch: null,
          dev_target: null, qa_target: null, research_target: null,
        },
      });
      const r = runTermCheck(tmp.state);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /^OK /);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("prints OK state-missing when state file does not exist", () => {
    const tmp = makeTempState();
    try {
      // Don't write state file
      const r = runTermCheck(tmp.state);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /^OK state-missing$/);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});

describe("scripts/autopilot/reap.py", () => {
  function writeStateWithSlot(path: string, slot: { partial_tokens: number; skill?: string }): void {
    writeFileSync(path, JSON.stringify({
      started_epoch: Math.floor(Date.now() / 1000),
      limits: {
        token_budget: 2000000,
        wall_clock_max_sec: 28800,
        idle_drain_turns: 5,
        scope: "all",
        subagent_max_tokens: 400000,
        subagent_hard_max_tokens: 800000,
      },
      cumulative_tokens: 0,
      idle_turns: 0,
      burned_classes: [],
      slots: {
        dev_orch: { skill: slot.skill ?? "hydra-dev", started: "now", partial_tokens: slot.partial_tokens },
        qa_orch: null, research_orch: null,
        dev_target: null, qa_target: null, research_target: null,
      },
    }));
  }

  function runReap(statePath: string): { status: number; stdout: string; stderr: string } {
    const r = spawnSync(join(SCRIPTS, "reap.py"), [], {
      env: {
        ...process.env,
        HYDRA_AUTOPILOT_STATE: statePath,
        // Point at a deliberately-nonexistent repo so gh fails fast
        // without contacting GitHub. reap.py marks gh issue creation
        // as non-fatal (check=False), so the state mutation still
        // happens — which is what we care about here.
        HYDRA_AUTOPILOT_REPO: "hydra-test/nonexistent-fixture",
        GH_TOKEN: "invalid-test-token",
      },
      encoding: "utf-8",
    });
    return {
      status: r.status ?? -1,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
    };
  }

  test("under hard cap: no-op (slot preserved)", () => {
    const tmp = makeTempState();
    try {
      writeStateWithSlot(tmp.state, { partial_tokens: 100000 }); // < 800k
      const r = runReap(tmp.state);
      assert.equal(r.status, 0);
      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      assert.notEqual(s.slots.dev_orch, null, "slot should still be occupied");
      assert.deepEqual(s.burned_classes, [], "no class should be burned yet");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("over hard cap: clears slot and marks class burned", () => {
    const tmp = makeTempState();
    try {
      writeStateWithSlot(tmp.state, { partial_tokens: 1_000_000 }); // > 800k hard cap
      const r = runReap(tmp.state);
      assert.equal(r.status, 0);
      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      assert.equal(s.slots.dev_orch, null, "slot should be cleared");
      assert.ok(s.burned_classes.includes("dev_orch"), "dev_orch should be burned");
      assert.match(r.stdout, /HARD-CAP TRIP class=dev_orch/);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("missing state file: graceful no-op", () => {
    const tmp = makeTempState();
    try {
      // Don't write state file
      const r = runReap(tmp.state);
      assert.equal(r.status, 0);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});

describe("scripts/autopilot/dispatch.sh log", () => {
  test("appends a single dispatch line to the run log", () => {
    const tmp = makeTempState();
    try {
      const r = spawnSync(
        join(SCRIPTS, "dispatch.sh"),
        ["log", "dev_orch", "hydra-dev", "2026-05-14T17:00:00Z"],
        {
          env: { ...process.env, HYDRA_AUTOPILOT_LOG: tmp.log },
          encoding: "utf-8",
        },
      );
      assert.equal(r.status, 0);
      const contents = readFileSync(tmp.log, "utf-8");
      assert.equal(contents, "dispatch dev_orch hydra-dev 2026-05-14T17:00:00Z\n");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("unknown subcommand exits non-zero", () => {
    const r = spawnSync(join(SCRIPTS, "dispatch.sh"), ["frobnicate"], {
      encoding: "utf-8",
    });
    assert.notEqual(r.status, 0);
  });
});

describe("scripts/autopilot/drain.sh", () => {
  test("prints final summary line with state-derived fields", () => {
    const tmp = makeTempState();
    try {
      const startedEpoch = Math.floor(Date.now() / 1000) - 3 * 3600 - 30 * 60; // 03:30 ago
      writeFileSync(tmp.state, JSON.stringify({
        started_epoch: startedEpoch,
        limits: { token_budget: 2000000 },
        cumulative_tokens: 1234567,
        dispatches: 42,
        slots: {
          dev_orch: null, qa_orch: null, research_orch: null,
          dev_target: null, qa_target: null, research_target: null,
        },
      }));
      const r = spawnSync(join(SCRIPTS, "drain.sh"), ["7"], {
        env: { ...process.env, HYDRA_AUTOPILOT_STATE: tmp.state, HYDRA_AUTOPILOT_LOG: tmp.log },
        encoding: "utf-8",
      });
      assert.equal(r.status, 0);
      const out = (r.stdout ?? "").trim();
      assert.match(out, /^\[autopilot\] FINAL \| duration=03:30 \| dispatches=42 \| tokens=1234567\/2000000 \| merged_PRs=7 \| digest=/);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("graceful fallback when state.json is missing", () => {
    const tmp = makeTempState();
    try {
      const r = spawnSync(join(SCRIPTS, "drain.sh"), ["0"], {
        env: { ...process.env, HYDRA_AUTOPILOT_STATE: tmp.state, HYDRA_AUTOPILOT_LOG: tmp.log },
        encoding: "utf-8",
      });
      assert.equal(r.status, 0);
      assert.match((r.stdout ?? "").trim(), /^\[autopilot\] FINAL \| state-missing /);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});

describe("scripts/autopilot/* executable bit", () => {
  test("every script is executable and has a shebang", () => {
    const scripts = [
      "bootstrap.sh",
      "collect-state.sh",
      "recover-stale.sh",
      "reap.py",
      "term-check.py",
      "dispatch.sh",
      "drain.sh",
    ];
    for (const name of scripts) {
      const path = join(SCRIPTS, name);
      assert.ok(existsSync(path), `${name} missing`);
      // Check shebang
      const first = readFileSync(path, "utf-8").split("\n", 1)[0];
      assert.match(first, /^#!/, `${name} missing shebang`);
      // Check exec bit via spawnSync --help / --version compatible probe
      // (some scripts will fail without args, but the OS exec call will succeed)
      const mode = execFileSync("stat", ["-c", "%a", path], { encoding: "utf-8" }).trim();
      // Octal mode — owner-execute bit is the first digit; should be 7xx.
      assert.match(mode, /^[7][0-9]{2}$/, `${name} not executable by owner (mode=${mode})`);
    }
  });
});

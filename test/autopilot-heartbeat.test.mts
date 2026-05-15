/**
 * Regression test for issue #435 — per-turn heartbeat updates.
 *
 * Before #435, `/tmp/hydra-autopilot-heartbeat.txt` was written ONCE by
 * `scripts/autopilot/bootstrap.sh` and never updated. The 2026-05-15
 * silent-wedge incident exposed the gap: a live `claude -p` autopilot
 * process with a 20-min-old heartbeat looked identical to "still
 * working" by `find -mmin` alone. Operators had no <10-min mechanism
 * to distinguish "model is mid-turn" from "model is wedged".
 *
 * The fix: `scripts/autopilot/heartbeat.py` is invoked at Phase 5a of
 * every decision turn (and once at the end of bootstrap). It overwrites
 * the heartbeat file with one structured line that includes the turn
 * counter, dispatch count, token spend, pipeline fill, signal-active
 * count, and the type of the most recent action. File mtime advances
 * on every call so `find -mmin -5` works.
 *
 * The tests below pin five behaviors:
 *   1. bootstrap.sh writes pid + run_id into state.json AND overwrites
 *      the heartbeat with the new per-turn format on Phase 0.
 *   2. heartbeat.py writes a line matching the documented format.
 *   3. Simulating two consecutive turns advances both the file mtime
 *      and the embedded turn=<N> counter — the core acceptance.
 *   4. heartbeat.py degrades gracefully when state.json is missing
 *      (still writes a line so mtime advances; this is the wedge-
 *      detection escape hatch).
 *   5. status.sh exits 0 and surfaces the heartbeat line.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPTS = join(REPO_ROOT, "scripts", "autopilot");
const HEARTBEAT_PY = join(SCRIPTS, "heartbeat.py");
const BOOTSTRAP_SH = join(SCRIPTS, "bootstrap.sh");
const STATUS_SH = join(SCRIPTS, "status.sh");

/**
 * Documented heartbeat line format (issue #435):
 *
 *   <epoch> <pid> <run_id> turn=<N> dispatches=<M> tokens=<K>
 *       pipeline_filled=<F>/6 signal_active=<S>/5 last_action=<type>
 *
 * Anchored against the regex below so a field-order edit breaks the
 * playbook + status.sh awk grep at the same time.
 */
const HEARTBEAT_LINE_RE =
  /^(\d+) (\d+) (\S+) turn=(\d+) dispatches=(\d+) tokens=(\d+) pipeline_filled=(\d+)\/6 signal_active=(\d+)\/5 last_action=(\S+)/;

function makeTmp(): {
  dir: string;
  state: string;
  heartbeat: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-heartbeat-"));
  return {
    dir,
    state: join(dir, "state.json"),
    heartbeat: join(dir, "heartbeat.txt"),
  };
}

function runHeartbeat(
  envOverride: Record<string, string>,
  args: string[] = [],
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("python3", [HEARTBEAT_PY, ...args], {
    env: { ...process.env, ...envOverride, PATH: process.env.PATH ?? "" },
    encoding: "utf-8",
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function writeState(path: string, overrides: Record<string, unknown> = {}): void {
  const base = {
    started: "2026-05-15T00:00:00Z",
    started_epoch: 1747267200,
    pid: 12345,
    run_id: "test-run-abc",
    limits: { token_budget: 1_000_000, scope: "all" },
    cumulative_tokens: 0,
    dispatches: 0,
    turn: 0,
    burned_classes: [],
    reaped_task_ids: [],
    failure_log: [],
    slots: {
      dev_orch: null,
      qa_orch: null,
      research_orch: null,
      dev_target: null,
      qa_target: null,
      research_target: null,
    },
    signal_last_fired: {
      health: 0,
      sweep_orch: 0,
      sweep_target: 0,
      discover_orch: 0,
      discover_target: 0,
    },
  };
  writeFileSync(path, JSON.stringify({ ...base, ...overrides }));
}

describe("scripts/autopilot/heartbeat.py", () => {
  test("writes a line matching the documented format", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, { turn: 7, dispatches: 3, cumulative_tokens: 12345 });
      const r = runHeartbeat({
        HYDRA_AUTOPILOT_STATE: tmp.state,
        HYDRA_AUTOPILOT_HEARTBEAT: tmp.heartbeat,
      }, ["--last-action=dispatch"]);
      assert.equal(r.status, 0, `heartbeat.py exited non-zero: ${r.stderr}`);
      const body = readFileSync(tmp.heartbeat, "utf-8").trim();
      const m = body.match(HEARTBEAT_LINE_RE);
      assert.ok(m, `heartbeat line does not match documented format: ${JSON.stringify(body)}`);
      // Field-by-field assertions on the captured groups.
      assert.equal(m![2], "12345", "pid from state.json");
      assert.equal(m![3], "test-run-abc", "run_id from state.json");
      assert.equal(m![4], "7", "turn from state.json");
      assert.equal(m![5], "3", "dispatches from state.json");
      assert.equal(m![6], "12345", "tokens from state.json");
      assert.equal(m![7], "0", "pipeline_filled = 0 (all slots null)");
      assert.equal(m![8], "0", "signal_active = 0 (all last_fired = 0)");
      assert.equal(m![9], "dispatch", "last_action passed through --last-action");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("counts filled pipeline slots correctly", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          dev_orch: { skill: "hydra-dev", task_id: "t1" },
          qa_orch: { skill: "hydra-qa", task_id: "t2" },
          research_orch: null,
          dev_target: { skill: "hydra-target-build", task_id: "t3" },
          qa_target: null,
          research_target: null,
        },
      });
      const r = runHeartbeat({
        HYDRA_AUTOPILOT_STATE: tmp.state,
        HYDRA_AUTOPILOT_HEARTBEAT: tmp.heartbeat,
      });
      assert.equal(r.status, 0);
      const body = readFileSync(tmp.heartbeat, "utf-8").trim();
      const m = body.match(HEARTBEAT_LINE_RE);
      assert.ok(m);
      assert.equal(m![7], "3", "three slots non-null");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("counts signal_active only for recently fired signals within cooldown", () => {
    const tmp = makeTmp();
    try {
      const now = Math.floor(Date.now() / 1000);
      // sweep_orch cooldown is 900s; fire it 60s ago — should count as active.
      // discover_orch cooldown is 1800s; fire it 2000s ago — cooled, NOT active.
      // health cooldown is 0; fire it 10s ago — active (special-cased: within 60s).
      writeState(tmp.state, {
        signal_last_fired: {
          health: now - 10,
          sweep_orch: now - 60,
          sweep_target: 0,
          discover_orch: now - 2000,
          discover_target: 0,
        },
      });
      const r = runHeartbeat({
        HYDRA_AUTOPILOT_STATE: tmp.state,
        HYDRA_AUTOPILOT_HEARTBEAT: tmp.heartbeat,
      });
      assert.equal(r.status, 0);
      const body = readFileSync(tmp.heartbeat, "utf-8").trim();
      const m = body.match(HEARTBEAT_LINE_RE);
      assert.ok(m);
      assert.equal(m![8], "2", "health + sweep_orch active; discover_orch cooled");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("two consecutive turns advance both mtime and turn= counter (core AC)", () => {
    const tmp = makeTmp();
    try {
      // Turn 1
      writeState(tmp.state, { turn: 1, dispatches: 0 });
      let r = runHeartbeat(
        {
          HYDRA_AUTOPILOT_STATE: tmp.state,
          HYDRA_AUTOPILOT_HEARTBEAT: tmp.heartbeat,
        },
        ["--last-action=wait"],
      );
      assert.equal(r.status, 0, `turn 1 heartbeat failed: ${r.stderr}`);
      const turn1Body = readFileSync(tmp.heartbeat, "utf-8").trim();
      const turn1Mtime = statSync(tmp.heartbeat).mtimeMs;
      assert.match(turn1Body, /turn=1/, "turn 1 body shows turn=1");

      // Backdate the file mtime by 5 seconds so we can prove the next
      // write advances it, without needing a real sleep in CI.
      const past = (turn1Mtime - 5000) / 1000;
      utimesSync(tmp.heartbeat, past, past);
      const backdatedMtime = statSync(tmp.heartbeat).mtimeMs;
      assert.ok(backdatedMtime < turn1Mtime, "mtime was backdated for test");

      // Turn 2
      writeState(tmp.state, { turn: 2, dispatches: 1 });
      r = runHeartbeat(
        {
          HYDRA_AUTOPILOT_STATE: tmp.state,
          HYDRA_AUTOPILOT_HEARTBEAT: tmp.heartbeat,
        },
        ["--last-action=dispatch"],
      );
      assert.equal(r.status, 0, `turn 2 heartbeat failed: ${r.stderr}`);
      const turn2Body = readFileSync(tmp.heartbeat, "utf-8").trim();
      const turn2Mtime = statSync(tmp.heartbeat).mtimeMs;

      assert.match(turn2Body, /turn=2/, "turn 2 body shows turn=2");
      assert.match(turn2Body, /dispatches=1/, "turn 2 body shows dispatches=1");
      assert.match(turn2Body, /last_action=dispatch/, "turn 2 last_action updated");
      assert.ok(
        turn2Mtime > backdatedMtime,
        `turn 2 mtime (${turn2Mtime}) must advance past backdated turn 1 mtime (${backdatedMtime})`,
      );
      assert.notEqual(turn1Body, turn2Body, "heartbeat content changed between turns");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("writes a degraded heartbeat when state.json is missing (mtime still advances)", () => {
    const tmp = makeTmp();
    try {
      // No writeState() call — state.json doesn't exist.
      const r = runHeartbeat({
        HYDRA_AUTOPILOT_STATE: tmp.state,
        HYDRA_AUTOPILOT_HEARTBEAT: tmp.heartbeat,
      });
      // Exit code 1 (degraded, not 0/healthy) but file still written so
      // operator-side `find -mmin` works.
      assert.equal(r.status, 1, "missing state should exit 1 (degraded)");
      assert.ok(existsSync(tmp.heartbeat), "heartbeat file written even when state is missing");
      const body = readFileSync(tmp.heartbeat, "utf-8");
      assert.match(body, /no-state/, "degraded line carries a note");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});

describe("scripts/autopilot/bootstrap.sh — heartbeat integration (issue #435)", () => {
  test("records pid + run_id into state.json", () => {
    // bootstrap.sh hardcodes /tmp/hydra-autopilot-state.json; we let it
    // write there then copy and clean up so the live autopilot isn't
    // disturbed. Same pattern as autopilot-scripts.test.mts.
    const tmp = makeTmp();
    try {
      const r = spawnSync(BOOTSTRAP_SH, [], {
        env: { ...process.env, PATH: process.env.PATH ?? "" },
        encoding: "utf-8",
      });
      assert.equal(r.status, 0, `bootstrap failed: ${r.stderr}`);
      const s = JSON.parse(readFileSync("/tmp/hydra-autopilot-state.json", "utf-8"));
      assert.equal(typeof s.pid, "number", "state.pid is a number");
      assert.ok(s.pid > 0, "state.pid > 0");
      assert.equal(typeof s.run_id, "string", "state.run_id is a string");
      assert.match(s.run_id, /^[0-9a-f-]{36}$/i, "state.run_id is a uuid");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("Phase 0 heartbeat carries the per-turn format with last_action=bootstrap", () => {
    const tmp = makeTmp();
    try {
      const r = spawnSync(BOOTSTRAP_SH, [], {
        env: { ...process.env, PATH: process.env.PATH ?? "" },
        encoding: "utf-8",
      });
      assert.equal(r.status, 0, `bootstrap failed: ${r.stderr}`);
      const body = readFileSync("/tmp/hydra-autopilot-heartbeat.txt", "utf-8").trim();
      const m = body.match(HEARTBEAT_LINE_RE);
      assert.ok(m, `Phase 0 heartbeat is not in per-turn format: ${JSON.stringify(body)}`);
      assert.equal(m![9], "bootstrap", "Phase 0 stamps last_action=bootstrap");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});

describe("scripts/autopilot/status.sh", () => {
  test("exits 0 and surfaces the heartbeat line", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, { turn: 5, dispatches: 2, cumulative_tokens: 5000 });
      // Prime the heartbeat via heartbeat.py so status.sh has something
      // to print.
      const hb = runHeartbeat(
        {
          HYDRA_AUTOPILOT_STATE: tmp.state,
          HYDRA_AUTOPILOT_HEARTBEAT: tmp.heartbeat,
        },
        ["--last-action=dispatch"],
      );
      assert.equal(hb.status, 0);

      const r = spawnSync("bash", [STATUS_SH], {
        env: {
          ...process.env,
          HYDRA_AUTOPILOT_STATE: tmp.state,
          HYDRA_AUTOPILOT_HEARTBEAT: tmp.heartbeat,
          HYDRA_AUTOPILOT_LOG: join(tmp.dir, "log.txt"),
          PATH: process.env.PATH ?? "",
        },
        encoding: "utf-8",
      });
      assert.equal(r.status, 0, `status.sh exited non-zero: ${r.stderr}`);
      assert.match(r.stdout, /heartbeat/, "status output mentions heartbeat section");
      assert.match(r.stdout, /turn=5/, "status output prints the heartbeat line");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});

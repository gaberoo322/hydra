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
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, statSync, utimesSync } from "node:fs";
import { createServer, type Server } from "node:http";
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
  log: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-heartbeat-"));
  return {
    dir,
    state: join(dir, "state.json"),
    heartbeat: join(dir, "heartbeat.txt"),
    log: join(dir, "nightly.log"),
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
      // discover_orch must be UNAMBIGUOUSLY cooled regardless of which
      // SIGNAL_COOLDOWNS source is live. heartbeat.py imports the value from
      // the sibling decide.py when it can (3600s since #959) and falls back to
      // a hard-coded table (1800s) only when that import fails. Firing
      // discover_orch 2000s ago made this test env-dependent: cooled under the
      // 1800 fallback but STILL ACTIVE under the live 3600 value (2000 < 3600),
      // which is exactly why subtest 3 flaked in agent worktrees (issue #1231,
      // observed `3 !== 2`). Fire it 5000s ago instead — older than BOTH the
      // 3600 live and the 1800 fallback cooldown, so it is cooled in every
      // environment.
      // health cooldown is 0; fire it 10s ago — active (special-cased: within 60s).
      writeState(tmp.state, {
        signal_last_fired: {
          health: now - 10,
          sweep_orch: now - 60,
          sweep_target: 0,
          discover_orch: now - 5000,
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

  /**
   * Pins the `(now - ts_i) < cooldown` direction (issue #447 mutation-gate
   * fix). The earlier signal_active test happens to yield count=2 under
   * BOTH the original `<` and the swapped `>` (different signals get
   * counted but the totals coincide). Mutation kept surviving as a
   * result — see issue #447 CI run 25939588265.
   *
   * This scenario picks counts that DIFFER between the two directions:
   *   - sweep_orch fired 100s ago, cooldown 900 → ACTIVE under `<`
   *     (100 < 900), NOT active under `>` (100 > 900 is false)
   *   - sweep_target fired 200s ago, cooldown 900 → ACTIVE under `<`,
   *     NOT active under `>`
   *   - all other signals zeroed
   * Expected total under unmutated code: 2 ; under mutant: 0.
   */
  test("counts cooldown-window membership in the correct direction (kills `<` → `>` mutant)", () => {
    const tmp = makeTmp();
    try {
      const now = Math.floor(Date.now() / 1000);
      writeState(tmp.state, {
        signal_last_fired: {
          health: 0,                  // not fired → not counted
          sweep_orch: now - 100,      // 100 < 900 cooldown → active
          sweep_target: now - 200,    // 200 < 900 cooldown → active
          discover_orch: 0,
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
      assert.equal(
        m![8],
        "2",
        "two non-zero-cooldown signals fired within their windows must count as active",
      );
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

  /**
   * Pins the `--last-action <value>` two-arg form (issue #447 mutation-gate
   * fix). All other tests use `--last-action=<value>` (the `=` form,
   * handled by the .startswith branch at heartbeat.py:207). The
   * two-arg branch lives at line 203:
   *   if arg in ("--last-action", "-a") and i + 1 < len(argv):
   * Under a `<` → `>` mutant, the inequality is never satisfied (i+1
   * is always <= len for a valid invocation) so the arg is dropped
   * and last_action stays at the default "(none)". This test asserts
   * the two-arg form is honored by inspecting the heartbeat line.
   */
  test("accepts `--last-action <value>` (two-arg form) and stamps last_action correctly", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, { turn: 2 });
      const r = runHeartbeat(
        {
          HYDRA_AUTOPILOT_STATE: tmp.state,
          HYDRA_AUTOPILOT_HEARTBEAT: tmp.heartbeat,
        },
        ["--last-action", "dispatch"],
      );
      assert.equal(r.status, 0, `heartbeat.py exited non-zero: ${r.stderr}`);
      const body = readFileSync(tmp.heartbeat, "utf-8").trim();
      const m = body.match(HEARTBEAT_LINE_RE);
      assert.ok(m, `heartbeat line does not match: ${JSON.stringify(body)}`);
      assert.equal(m![9], "dispatch", "two-arg --last-action must populate last_action");
      assert.notEqual(m![9], "(none)", "must not fall back to default");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  /**
   * Mirror with the short form `-a <value>` (same code path as
   * `--last-action <value>`; ensures the `i+1 < len(argv)` guard is
   * exercised under both literal arg names — extra coverage if the
   * `--last-action` test ever changes shape).
   */
  test("accepts `-a <value>` (short two-arg form) and stamps last_action correctly", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, { turn: 2 });
      const r = runHeartbeat(
        {
          HYDRA_AUTOPILOT_STATE: tmp.state,
          HYDRA_AUTOPILOT_HEARTBEAT: tmp.heartbeat,
        },
        ["-a", "wait"],
      );
      assert.equal(r.status, 0, `heartbeat.py exited non-zero: ${r.stderr}`);
      const body = readFileSync(tmp.heartbeat, "utf-8").trim();
      const m = body.match(HEARTBEAT_LINE_RE);
      assert.ok(m);
      assert.equal(m![9], "wait", "short -a form populates last_action");
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

/**
 * Issue #1732 — heartbeat.py post_turn must NOT attribute a stale plan.
 *
 * Before #1732, post_turn joined the live state.json with whatever the
 * default plan path (/tmp/hydra-autopilot-plan.json) held — with no check
 * that the plan belonged to the current run/turn. The autopilot session
 * frequently writes decide output to ad-hoc per-turn filenames
 * (`...-plan-r5t1.json`), leaving the default path holding a previous
 * run's plan; runs ebcfebd2/b2422e61 (2026-06-11) each recorded a turn
 * with a foreign run's `dispatch:dev_target` action, drifting the run's
 * dispatch counters and polluting the retro bundle's idle-streak signal.
 *
 * The fix: decide.py stamps `run_id` + `turn` into the plan JSON, and
 * post_turn posts empty actions with a `plan-stale-skipped: ...` reason
 * whenever the stamp is missing or mismatched. These tests pin the wire
 * contract against a local capture server (async spawn — spawnSync would
 * block the event loop and the server could never answer the POST).
 */
describe("scripts/autopilot/heartbeat.py — stale-plan freshness check (issue #1732)", () => {
  const RUN_ID = "test-run-1732";

  interface Captured { url: string; method: string; body: Record<string, unknown> }

  async function withCaptureServer(
    fn: (baseUrl: string, requests: Captured[]) => Promise<void>,
  ): Promise<void> {
    const requests: Captured[] = [];
    const server: Server = createServer((req, res) => {
      let buf = "";
      req.on("data", (c) => (buf += c));
      req.on("end", () => {
        requests.push({
          url: req.url ?? "",
          method: req.method ?? "",
          body: buf ? JSON.parse(buf) : {},
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      await fn(`http://127.0.0.1:${port}`, requests);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }

  function spawnHeartbeatAsync(
    env: Record<string, string>,
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolveSpawn) => {
      const child = spawn("python3", [HEARTBEAT_PY], {
        env: { ...process.env, ...env, PATH: process.env.PATH ?? "" },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => resolveSpawn({ code, stdout, stderr }));
    });
  }

  /** Run heartbeat.py against a state + plan fixture; return the captured turn POST. */
  async function runWithPlan(
    plan: unknown | null,
    stateOverrides: Record<string, unknown> = {},
  ): Promise<{ requests: Captured[]; stderr: string }> {
    const tmp = makeTmp();
    const planPath = join(tmp.dir, "plan.json");
    let stderrOut = "";
    try {
      writeState(tmp.state, { run_id: RUN_ID, turn: 3, ...stateOverrides });
      if (plan !== null) writeFileSync(planPath, JSON.stringify(plan));
      let captured: Captured[] = [];
      await withCaptureServer(async (baseUrl, requests) => {
        const r = await spawnHeartbeatAsync({
          HYDRA_AUTOPILOT_STATE: tmp.state,
          HYDRA_AUTOPILOT_HEARTBEAT: tmp.heartbeat,
          HYDRA_AUTOPILOT_PLAN: planPath,
          HYDRA_API_BASE: baseUrl,
        });
        assert.equal(r.code, 0, `heartbeat.py exited non-zero: ${r.stderr}`);
        stderrOut = r.stderr;
        captured = requests;
      });
      return { requests: captured, stderr: stderrOut };
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  }

  test("fresh plan (matching run_id + turn stamp) is attributed verbatim", async () => {
    const { requests, stderr } = await runWithPlan({
      actions: [{ type: "dispatch", class: "dev_orch" }],
      reasons: ["ready-for-agent present"],
      run_id: RUN_ID,
      turn: 3,
    });
    assert.equal(requests.length, 1, "exactly one turn POST");
    assert.equal(requests[0].url, "/api/autopilot/turn");
    assert.equal(requests[0].body.run_id, RUN_ID);
    assert.equal(requests[0].body.turn_n, 3);
    assert.deepEqual(
      requests[0].body.actions,
      [{ type: "dispatch", class: "dev_orch" }],
      "fresh plan's actions pass through",
    );
    assert.deepEqual(requests[0].body.reasons, ["ready-for-agent present"]);
    assert.ok(!stderr.includes("stale plan"), "no stale warning for a fresh plan");
  });

  test("foreign run_id stamp → empty actions + plan-stale-skipped reason (core #1732 AC)", async () => {
    const { requests, stderr } = await runWithPlan({
      actions: [{ type: "dispatch", class: "dev_target" }],
      reasons: ["stale reason from a previous run"],
      run_id: "fb6ae849-dead-beef-0000-000000000000",
      turn: 3,
    });
    assert.equal(requests.length, 1, "turn POST still happens (record the turn, not the stale plan)");
    assert.deepEqual(requests[0].body.actions, [], "foreign-run plan actions must NOT be attributed");
    const reasons = requests[0].body.reasons as string[];
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /^plan-stale-skipped: /, "reason carries the stale-skip marker");
    assert.match(reasons[0], /run_id/, "reason names the mismatched field");
    assert.match(stderr, /stale plan skipped/, "skip is logged loud to stderr");
  });

  test("stale turn stamp (same run, ≥2 turns behind) → empty actions + plan-stale-skipped reason", async () => {
    const { requests } = await runWithPlan({
      actions: [{ type: "dispatch", class: "qa_orch" }],
      reasons: ["from turn 1"],
      run_id: RUN_ID,
      turn: 1, // state.turn is 3 — two behind, beyond the #1769 tolerance
    });
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].body.actions, [], "previous turn's plan must NOT be attributed");
    assert.match(
      (requests[0].body.reasons as string[])[0],
      /^plan-stale-skipped: plan turn=1 != state turn=3/,
    );
  });

  /**
   * Issue #1769 — increment-then-heartbeat ordering tolerance.
   *
   * The playbook loop leaves the state.turn increment to the model session
   * and never pins whether it lands before or after the step-5a heartbeat.
   * Run 69442b4c (2026-06-11) hit increment-then-heartbeat every turn, so
   * the strict #1732 equality zeroed turns 2–9's action ledgers while real
   * dispatches were in flight. A same-run plan exactly ONE turn behind is
   * fresh: attribute its actions at turn_n = plan.turn (the turn the
   * decisions were made for — posting at state.turn would shift every
   * action onto the wrong record), and lean on the server's
   * (run_id, turn_n) dedup to no-op the re-POST when the other ordering
   * already recorded that turn.
   */
  test("off-by-one plan (same run, plan.turn = state.turn - 1) → attributed at turn_n = plan.turn (issue #1769)", async () => {
    const { requests, stderr } = await runWithPlan({
      actions: [{ type: "dispatch", class: "dev_orch" }],
      reasons: ["ready-for-agent present"],
      run_id: RUN_ID,
      turn: 2, // state.turn is 3 — session incremented before the heartbeat
    });
    assert.equal(requests.length, 1, "exactly one turn POST");
    assert.equal(requests[0].body.turn_n, 2, "record posts at the PLAN's turn, not the incremented state turn");
    assert.deepEqual(
      requests[0].body.actions,
      [{ type: "dispatch", class: "dev_orch" }],
      "off-by-one plan's actions ARE attributed (the run-wide-blindness fix)",
    );
    const reasons = requests[0].body.reasons as string[];
    assert.equal(reasons[0], "ready-for-agent present", "plan's own reasons pass through first");
    assert.match(
      reasons[reasons.length - 1],
      /^plan-turn-off-by-one: attributed to plan turn=2 \(state turn=3/,
      "an explicit off-by-one note is appended for observability",
    );
    assert.ok(!stderr.includes("stale plan"), "off-by-one is tolerated, not logged as stale");
  });

  test("future plan stamp (plan.turn = state.turn + 1) is still stale (issue #1769 tolerance is one-sided)", async () => {
    const { requests } = await runWithPlan({
      actions: [{ type: "dispatch", class: "dev_target" }],
      reasons: ["from the future"],
      run_id: RUN_ID,
      turn: 4, // state.turn is 3 — a future stamp can't be the increment race
    });
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].body.actions, [], "a future-stamped plan must NOT be attributed");
    assert.match(
      (requests[0].body.reasons as string[])[0],
      /^plan-stale-skipped: plan turn=4 != state turn=3/,
    );
  });

  test("unstamped plan (pre-#1732 shape) → empty actions + plan-stale-skipped reason", async () => {
    const { requests } = await runWithPlan({
      actions: [{ type: "dispatch", class: "dev_target" }],
      reasons: ["unstamped"],
      // no run_id / turn keys — exactly what a stale pre-#1732 file holds
    });
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].body.actions, [], "unverifiable plan must NOT be attributed");
    assert.match(
      (requests[0].body.reasons as string[])[0],
      /^plan-stale-skipped: plan carries no run_id\/turn stamp/,
    );
  });

  test("missing plan file → turn POST with empty actions and NO stale marker (pre-#1732 behaviour)", async () => {
    const { requests, stderr } = await runWithPlan(null);
    assert.equal(requests.length, 1, "turn POST proceeds without a plan file");
    assert.deepEqual(requests[0].body.actions, []);
    assert.deepEqual(requests[0].body.reasons, [], "no plan ≠ stale plan — no skip reason");
    assert.ok(!stderr.includes("stale plan"), "no stale warning when the plan file is simply absent");
  });
});

describe("scripts/autopilot/bootstrap.sh — heartbeat integration (issue #435)", () => {
  /**
   * Helper: invoke bootstrap.sh with HYDRA_AUTOPILOT_STATE/HEARTBEAT/LOG
   * pointing at the temp dir, so each test is isolated from the live
   * /tmp/hydra-autopilot-state.json and skips the live run-start POST.
   */
  function runBootstrap(tmp: { state: string; heartbeat: string; log: string }) {
    return spawnSync(BOOTSTRAP_SH, [], {
      env: {
        ...process.env,
        HYDRA_AUTOPILOT_STATE: tmp.state,
        HYDRA_AUTOPILOT_HEARTBEAT: tmp.heartbeat,
        HYDRA_AUTOPILOT_LOG: tmp.log,
        PATH: process.env.PATH ?? "",
      },
      encoding: "utf-8",
    });
  }

  test("records pid + run_id into state.json", () => {
    const tmp = makeTmp();
    try {
      const r = runBootstrap(tmp);
      assert.equal(r.status, 0, `bootstrap failed: ${r.stderr}`);
      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      assert.equal(typeof s.pid, "number", "state.pid is a number");
      assert.ok(s.pid > 0, "state.pid > 0");
      assert.equal(typeof s.run_id, "string", "state.run_id is a string");
      assert.match(s.run_id, /^[0-9a-f-]{36}$/i, "state.run_id is a uuid");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  /**
   * Pins the file-redirect operator on bootstrap.sh's heartbeat seed
   * write (issue #447 mutation-gate fix):
   *   echo "$(date ...) start pid=${PID} run_id=${RUN_ID}" > "${HEARTBEAT_PATH}"
   * A `swap-comparison` mutant turns the `>` into `<`, which under
   * `set -euo pipefail` attempts to open the heartbeat file as STDIN of
   * `echo`. If the path doesn't exist (clean run), bash errors out
   * before any of the rest of bootstrap can execute and the script
   * exits non-zero. We force the clean-run condition by NOT creating
   * the heartbeat file in our temp dir, then asserting bootstrap exits
   * 0 AND the heartbeat file is non-empty afterwards.
   */
  test("bootstrap's heartbeat seed-write uses `>` (kills `<` mutant on heredoc line)", () => {
    const tmp = makeTmp();
    try {
      // tmp dir is fresh — heartbeat file does not exist, so a `<`-mutant
      // would fail to open it for reading and bootstrap would exit non-zero.
      const r = runBootstrap(tmp);
      assert.equal(
        r.status,
        0,
        `bootstrap exited non-zero (likely a <-mutant on heartbeat seed write): ${r.stderr}`,
      );
      assert.ok(existsSync(tmp.heartbeat), "heartbeat file must be created by bootstrap");
      const body = readFileSync(tmp.heartbeat, "utf-8");
      assert.ok(body.length > 0, "heartbeat file must be non-empty after bootstrap");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("Phase 0 heartbeat carries the per-turn format with last_action=bootstrap", () => {
    const tmp = makeTmp();
    try {
      const r = runBootstrap(tmp);
      assert.equal(r.status, 0, `bootstrap failed: ${r.stderr}`);
      const body = readFileSync(tmp.heartbeat, "utf-8").trim();
      const m = body.match(HEARTBEAT_LINE_RE);
      assert.ok(m, `Phase 0 heartbeat is not in per-turn format: ${JSON.stringify(body)}`);
      assert.equal(m![9], "bootstrap", "Phase 0 stamps last_action=bootstrap");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});

describe("scripts/autopilot/status.sh", () => {
  /**
   * Helper: invoke status.sh against a test-isolated tempdir.
   * Returns the spawnSync result (stdout/stderr/status).
   */
  function runStatus(
    envOverride: Record<string, string>,
  ): { status: number; stdout: string; stderr: string } {
    const r = spawnSync("bash", [STATUS_SH], {
      env: { ...process.env, ...envOverride, PATH: process.env.PATH ?? "" },
      encoding: "utf-8",
    });
    return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

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

      const r = runStatus({
        HYDRA_AUTOPILOT_STATE: tmp.state,
        HYDRA_AUTOPILOT_HEARTBEAT: tmp.heartbeat,
        HYDRA_AUTOPILOT_LOG: join(tmp.dir, "log.txt"),
      });
      assert.equal(r.status, 0, `status.sh exited non-zero: ${r.stderr}`);
      assert.match(r.stdout, /heartbeat/, "status output mentions heartbeat section");
      assert.match(r.stdout, /turn=5/, "status output prints the heartbeat line");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  /**
   * Pins the three section header banners (issue #447 mutation-gate fix).
   *
   * Originals (status.sh lines 38, 64, 75):
   *   echo "=== heartbeat (...) ==="
   *   echo "=== state (...) ==="
   *   echo "=== log tail (...) ==="
   *
   * Without exact-substring assertions, a `swap-comparison` mutant that
   * rewrites the leading `==` to `!=` (yielding "!== heartbeat (...) ===")
   * survives any test that only does `/heartbeat/`-style fuzzy matching.
   * Asserting the exact `=== heartbeat (` prefix kills the mutant
   * because the rewritten line no longer starts that way.
   *
   * The trailing ` ===` is asserted by the prefix presence — if the
   * leading `===` is intact, the format is intact.
   */
  test("prints exact '=== <section> (' banners for all three sections", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, { turn: 9 });
      const hb = runHeartbeat(
        {
          HYDRA_AUTOPILOT_STATE: tmp.state,
          HYDRA_AUTOPILOT_HEARTBEAT: tmp.heartbeat,
        },
        ["--last-action=test"],
      );
      assert.equal(hb.status, 0);
      const logPath = join(tmp.dir, "log.txt");
      writeFileSync(logPath, "log-line-1\nlog-line-2\n");

      const r = runStatus({
        HYDRA_AUTOPILOT_STATE: tmp.state,
        HYDRA_AUTOPILOT_HEARTBEAT: tmp.heartbeat,
        HYDRA_AUTOPILOT_LOG: logPath,
      });
      assert.equal(r.status, 0, `status.sh exited non-zero: ${r.stderr}`);
      // Each banner must start with literal "=== " — kills `!==` mutants
      // on status.sh lines 38, 64, 75 (the three echo banners).
      assert.ok(
        r.stdout.includes(`=== heartbeat (${tmp.heartbeat}) ===`),
        `missing exact heartbeat banner; got: ${r.stdout.slice(0, 200)}`,
      );
      assert.ok(
        r.stdout.includes(`=== state (${tmp.state}) ===`),
        `missing exact state banner; got: ${r.stdout.slice(0, 200)}`,
      );
      assert.ok(
        r.stdout.includes(`=== log tail (${logPath}) ===`),
        `missing exact log-tail banner; got: ${r.stdout.slice(0, 200)}`,
      );
      // Negative assertion: `!== heartbeat` etc. must NOT appear (the
      // mutant form). Belt and braces — the positive includes() above
      // is the primary kill signal, this catches partial-match edges.
      assert.ok(!r.stdout.includes("!== heartbeat"), "mutant banner leaked");
      assert.ok(!r.stdout.includes("!== state"), "mutant state banner leaked");
      assert.ok(!r.stdout.includes("!== log tail"), "mutant log banner leaked");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  /**
   * Pins the wedge-verdict copy (issue #447 mutation-gate fix).
   *
   * Original (status.sh line 56):
   *   echo "!!! WEDGE LIKELY: heartbeat is ${age}s old (> ${THRESHOLD}s) ..."
   *
   * A `swap-comparison` mutant flips the literal `>` inside the
   * parenthetical to `<`, yielding "(< ${THRESHOLD}s)" which is
   * semantically backwards (the heartbeat is OLDER than the threshold,
   * not younger). Operators reading the wedge line need the correct
   * direction. We exercise the wedge path by writing a heartbeat with
   * the CURRENT process pid (so the kill -0 liveness check succeeds),
   * back-dating its mtime, and lowering the threshold so the
   * `age > threshold` condition fires deterministically.
   */
  test("WEDGE LIKELY message uses literal '>' in the age comparison", () => {
    const tmp = makeTmp();
    try {
      // Write a heartbeat whose pid is the current node process pid.
      // status.sh awks $2 of the first line as the pid; that pid must
      // be alive for the wedge branch to take. process.pid is alive by
      // definition while this test runs.
      const pid = process.pid;
      const heartbeatLine =
        `1000 ${pid} test-run-447 turn=1 dispatches=0 tokens=0 ` +
        `pipeline_filled=0/6 signal_active=0/5 last_action=test`;
      writeFileSync(tmp.heartbeat, heartbeatLine + "\n");
      // Back-date the mtime so age > threshold (we pick threshold=1s
      // and date the file to a year ago for an enormous margin).
      const past = Math.floor(Date.now() / 1000) - 31_536_000; // -1y
      utimesSync(tmp.heartbeat, past, past);

      const r = runStatus({
        HYDRA_AUTOPILOT_HEARTBEAT: tmp.heartbeat,
        HYDRA_AUTOPILOT_STATE: tmp.state,
        HYDRA_AUTOPILOT_LOG: join(tmp.dir, "log.txt"),
        WEDGE_THRESHOLD_SEC: "1",
      });
      assert.equal(r.status, 0, `status.sh exited non-zero: ${r.stderr}`);
      assert.match(r.stdout, /WEDGE LIKELY/, "wedge banner fires");
      // The mutant flips `(> ${THRESHOLD}s)` → `(< ${THRESHOLD}s)`.
      // Assert the original direction is present.
      assert.match(
        r.stdout,
        /\(> 1s\) but pid \d+ is still alive\./,
        "wedge message must contain '(> 1s)' (the unmutated direction)",
      );
      // And confirm the mutant form is absent.
      assert.ok(
        !/\(< 1s\)/.test(r.stdout),
        "mutant '(< 1s)' must NOT appear in WEDGE message",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  /**
   * Pins the jq stdout suppression (issue #447 mutation-gate fix).
   *
   * Original (status.sh line 65):
   *   if [ -f "$STATE" ] && command -v jq >/dev/null 2>&1; then
   *
   * A `swap-comparison` mutant turns `>/dev/null` into `</dev/null`,
   * which redirects the command's STDIN rather than discarding its
   * STDOUT. As a result, `command -v jq` (a successful lookup) leaks
   * the resolved binary path (e.g. `/usr/bin/jq`) into the status
   * stdout. We can detect this by asserting that no bare jq path
   * appears in the captured stdout when status.sh is run with a
   * state.json present (which makes the `[ -f $STATE ]` left side of
   * the `&&` true and forces the right side to run).
   */
  test("does not leak the jq binary path into stdout (kills `>` → `<` mutant on jq probe)", (t) => {
    // Skip if jq isn't installed locally — the leak only manifests when
    // command -v jq succeeds. CI / dev machines have jq installed (it
    // is a project pre-req for status.sh to pretty-print at all).
    const probe = spawnSync("command", ["-v", "jq"], { shell: true });
    if (probe.status !== 0) {
      t.skip("jq not installed; mutant cannot be observed");
      return;
    }
    const tmp = makeTmp();
    try {
      writeState(tmp.state, { turn: 3 });
      const hb = runHeartbeat(
        {
          HYDRA_AUTOPILOT_STATE: tmp.state,
          HYDRA_AUTOPILOT_HEARTBEAT: tmp.heartbeat,
        },
        ["--last-action=test"],
      );
      assert.equal(hb.status, 0);

      const r = runStatus({
        HYDRA_AUTOPILOT_STATE: tmp.state,
        HYDRA_AUTOPILOT_HEARTBEAT: tmp.heartbeat,
        HYDRA_AUTOPILOT_LOG: join(tmp.dir, "log.txt"),
      });
      assert.equal(r.status, 0, `status.sh exited non-zero: ${r.stderr}`);
      // jq path leaks look like `/usr/bin/jq` or `/usr/local/bin/jq` on
      // their own line. Assert NO such bare path appears anywhere in
      // stdout (the legitimate stdout content is banner lines, a
      // heartbeat dump, a jq-formatted JSON, and a log tail — none of
      // which contain `/jq` as a path suffix).
      assert.ok(
        !/^\/\S*\/jq\s*$/m.test(r.stdout),
        `jq binary path leaked to stdout (mutant survived): ${JSON.stringify(r.stdout.slice(0, 400))}`,
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});

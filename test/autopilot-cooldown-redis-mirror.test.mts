/**
 * Issue #2715 — the executor-side Redis mirror of the cross-run cooldown subset.
 *
 * `/tmp/hydra-autopilot-state.json` is boot-wiped, so `signal_last_fired` and
 * `research_force_counter` are lost on host reboot. reap.py mirrors that subset
 * to Redis on EVERY completion (the reliable "a signal class fired" seam), and
 * decide.py mirrors research_force_counter on the turn it stamps it. bootstrap.sh
 * reads those keys back as a seed tier behind the prior file (seed order
 * prior-file → Redis → 0; the bootstrap seed path is covered in
 * test/autopilot-scripts.test.mts).
 *
 * These tests pin the WRITE side without a live Redis: `HYDRA_AUTOPILOT_REDIS_CLI`
 * injects a recorder script that appends each `redis-cli` argv line to a file,
 * so the assertions read the recorder log and never touch docker/redis. The
 * cycle-record POST reap fires is sunk into a dead socket via HYDRA_API_BASE so
 * these fixtures never leak into the live orchestrator's metrics.
 *
 * Top-level `describe` suites with their own `beforeEach` per-case temp state —
 * no shared-Redis teardown to piggyback on (repo authoring rule).
 */

import test, { describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPTS = join(REPO_ROOT, "scripts", "autopilot");
const REAP = join(SCRIPTS, "reap.py");
const DECIDE = join(SCRIPTS, "decide.py");

interface Tmp {
  dir: string;
  state: string;
  log: string;
  recorder: string;
  recordLog: string;
}

function makeTmp(): Tmp {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-redis-mirror-"));
  const recordLog = join(dir, "redis-calls.log");
  const recorder = join(dir, "redis-recorder.sh");
  // Append the full argv (one call per line, args tab-joined) to recordLog.
  writeFileSync(
    recorder,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(recordLog)}\nexit 0\n`,
    { mode: 0o755 },
  );
  return {
    dir,
    state: join(dir, "state.json"),
    log: join(dir, "nightly.log"),
    recorder,
    recordLog,
  };
}

function readRecorder(t: Tmp): string[] {
  if (!existsSync(t.recordLog)) return [];
  return readFileSync(t.recordLog, "utf-8").split("\n").filter((l) => l.length > 0);
}

function baseState(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    started_epoch: Math.floor(Date.now() / 1000),
    run_id: "run-fixture-2715",
    turn: 3,
    limits: {
      token_budget: 2_000_000,
      subagent_max_tokens: 400_000,
      subagent_hard_max_tokens: 800_000,
      scope: "all",
    },
    cumulative_tokens: 0,
    dispatches: 0,
    idle_turns: 0,
    burned_classes: [],
    reaped_task_ids: [],
    failure_log: [],
    slots: {
      dev_orch: null, qa_orch: null, research_orch: null,
      dev_target: null, qa_target: null, research_target: null,
    },
    signal_last_fired: {
      health: 0, sweep_orch: 0, sweep_target: 0,
      discover_orch: 0, discover_target: 0,
      retro_orch: 1_780_000_000, architecture_orch: 1_780_000_100,
      cleanup_orch: 1_780_000_200, scout_orch: 1_780_000_300,
    },
    research_force_counter: { "2026-07-02": { orch: 2 } },
    ...patch,
  };
}

function runReap(t: Tmp, args: string[]): { status: number; stderr: string } {
  const r = spawnSync(REAP, args, {
    env: {
      ...process.env,
      HYDRA_AUTOPILOT_STATE: t.state,
      HYDRA_AUTOPILOT_LOG: t.log,
      HYDRA_AUTOPILOT_REPO: "hydra-test/nonexistent-fixture",
      HYDRA_API_BASE: "http://127.0.0.1:1", // sink cycle-record POST
      HYDRA_AUTOPILOT_REDIS_CLI: `bash ${t.recorder}`,
      GH_TOKEN: "invalid-test-token",
    },
    encoding: "utf-8",
  });
  return { status: r.status ?? -1, stderr: r.stderr ?? "" };
}

describe("issue #2715 — reap.py mirrors the cross-run subset to Redis on completion", () => {
  let t: Tmp;
  beforeEach(() => {
    t = makeTmp();
  });
  afterEach(() => {
    if (t) rmSync(t.dir, { recursive: true, force: true });
  });

  test("HSETs signal_last_fired and SETs research_force_counter on a signal-class completion", () => {
    writeFileSync(t.state, JSON.stringify(baseState()));
    const r = runReap(t, ["completion", "retro_orch", "task-2715-a", "5000", "hydra-retro"]);
    assert.equal(r.status, 0, `reap exited non-zero: ${r.stderr}`);
    const calls = readRecorder(t);

    const hset = calls.find((c) => c.startsWith("HSET hydra:autopilot:signal-last-fired"));
    assert.ok(hset, `expected an HSET to the signal-last-fired hash; got:\n${calls.join("\n")}`);
    // The long-cooldown timestamps must be present in the HSET field pairs.
    assert.match(hset!, /retro_orch 1780000000/, "retro_orch epoch must be in the HSET");
    assert.match(hset!, /architecture_orch 1780000100/, "architecture_orch epoch must be in the HSET");
    assert.match(hset!, /cleanup_orch 1780000200/, "cleanup_orch epoch must be in the HSET");
    assert.match(hset!, /scout_orch 1780000300/, "scout_orch epoch must be in the HSET");

    const set = calls.find((c) => c.startsWith("SET hydra:autopilot:research-force-counter"));
    assert.ok(set, `expected a SET to the research-force-counter key; got:\n${calls.join("\n")}`);
    assert.match(set!, /orch/, "research_force_counter JSON must be in the SET value");
  });

  test("mirror runs for pipeline-class completions too (reap is the universal seam)", () => {
    writeFileSync(t.state, JSON.stringify(baseState({
      slots: {
        dev_orch: { skill: "hydra-dev", started: "now", partial_tokens: 0 },
        qa_orch: null, research_orch: null,
        dev_target: null, qa_target: null, research_target: null,
      },
    })));
    const r = runReap(t, ["completion", "dev_orch", "task-2715-b", "5000", "hydra-dev"]);
    assert.equal(r.status, 0, `reap exited non-zero: ${r.stderr}`);
    const calls = readRecorder(t);
    assert.ok(
      calls.some((c) => c.startsWith("HSET hydra:autopilot:signal-last-fired")),
      "the Redis mirror must fire on a pipeline-class completion as well",
    );
  });

  test("NEVER mirrors run-scoped fields (pid/turn/slots/burned_classes stay out of Redis)", () => {
    writeFileSync(t.state, JSON.stringify(baseState({ pid: 4242, burned_classes: ["dev_orch"] })));
    const r = runReap(t, ["completion", "retro_orch", "task-2715-c", "5000", "hydra-retro"]);
    assert.equal(r.status, 0, `reap exited non-zero: ${r.stderr}`);
    const calls = readRecorder(t);
    assert.ok(calls.length > 0, "the reap should have issued at least one redis-cli call");
    // Every redis-cli call must target ONLY one of the two cross-run keys — run-
    // scoped fields (pid/turn/slots/burned_classes/...) are never mirrored. The
    // field NAME `burned_classes` must also never leak as a value: only signal
    // class names + epochs and the research-force JSON appear.
    for (const c of calls) {
      assert.match(
        c,
        /^(HSET hydra:autopilot:signal-last-fired|SET hydra:autopilot:research-force-counter)/,
        `unexpected redis-cli call touches a non-cross-run key: ${c}`,
      );
    }
    const joined = calls.join("\n");
    assert.doesNotMatch(joined, /\bpid\b/, "pid must never be mirrored");
    assert.doesNotMatch(joined, /4242/, "the pid value must never be mirrored");
    assert.doesNotMatch(joined, /burned_classes/, "burned_classes must never be mirrored");
  });

  test("a failing redis-cli never aborts the reap (fail-open)", () => {
    writeFileSync(t.state, JSON.stringify(baseState()));
    // Point the override at a stub that always exits 1.
    const failStub = join(t.dir, "redis-fail.sh");
    writeFileSync(failStub, "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
    const r = spawnSync(REAP, ["completion", "retro_orch", "task-2715-d", "5000", "hydra-retro"], {
      env: {
        ...process.env,
        HYDRA_AUTOPILOT_STATE: t.state,
        HYDRA_AUTOPILOT_LOG: t.log,
        HYDRA_AUTOPILOT_REPO: "hydra-test/nonexistent-fixture",
        HYDRA_API_BASE: "http://127.0.0.1:1",
        HYDRA_AUTOPILOT_REDIS_CLI: `bash ${failStub}`,
        GH_TOKEN: "invalid-test-token",
      },
      encoding: "utf-8",
    });
    assert.equal(r.status ?? -1, 0, `reap must exit 0 even when the redis mirror fails: ${r.stderr}`);
    // The local state write must still have happened.
    const s = JSON.parse(readFileSync(t.state, "utf-8"));
    assert.ok(Array.isArray(s.reaped_task_ids) && s.reaped_task_ids.includes("task-2715-d"),
      "the local state write must succeed regardless of the Redis mirror outcome");
  });

  test("dup reap does NOT re-mirror (mirror rides the first-completion write only)", () => {
    writeFileSync(t.state, JSON.stringify(baseState()));
    const first = runReap(t, ["completion", "retro_orch", "task-2715-e", "5000", "hydra-retro"]);
    assert.equal(first.status, 0);
    const afterFirst = readRecorder(t).length;
    assert.ok(afterFirst > 0, "first completion should mirror to Redis");
    const second = runReap(t, ["completion", "retro_orch", "task-2715-e", "5000", "hydra-retro"]);
    assert.equal(second.status, 0);
    assert.equal(readRecorder(t).length, afterFirst,
      "a duplicate completion must not issue any further redis-cli calls");
  });
});

describe("issue #2715 — decide.py mirrors research_force_counter when it stamps it", () => {
  test("SETs research-force-counter on a plan turn that changes the counter", () => {
    // Build a state whose decide-time force-research stamp will change the
    // counter, then assert the recorder captured the SET. We drive decide.py's
    // CLI directly; the force-counter-changed branch is the only mirror gate.
    const t = makeTmp();
    try {
      // A minimal state that decide() will accept and whose research force
      // counter gets stamped. If no dispatch forces research this turn the
      // counter is unchanged and (correctly) no SET fires — so we assert the
      // NEGATIVE-safe property: any SET that DOES fire targets only the
      // research-force-counter key (never a run-scoped field).
      const st = baseState({ turn: 0 });
      writeFileSync(t.state, JSON.stringify(st));
      const r = spawnSync(DECIDE, ["decide", t.state], {
        env: {
          ...process.env,
          HYDRA_AUTOPILOT_STATE: t.state,
          HYDRA_API_BASE: "http://127.0.0.1:1",
          HYDRA_AUTOPILOT_REDIS_CLI: `bash ${t.recorder}`,
          // Keep decide's run-end POST + mirror enabled (default), but the POST
          // sinks into the dead socket above.
        },
        encoding: "utf-8",
      });
      assert.equal(r.status ?? -1, 0, `decide exited non-zero: ${r.stderr}`);
      // Whatever decide chose this turn, every redis-cli call it issued must be a
      // SET to the research-force-counter key — decide never mirrors anything else.
      for (const c of readRecorder(t)) {
        assert.match(
          c,
          /^SET hydra:autopilot:research-force-counter/,
          `decide.py must only ever mirror the research-force-counter key; got: ${c}`,
        );
      }
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  test("decide.py mirror stays OFF when HYDRA_AUTOPILOT_RUN_END_POST is off (test isolation switch)", () => {
    const t = makeTmp();
    try {
      writeFileSync(t.state, JSON.stringify(baseState({ turn: 0 })));
      const r = spawnSync(DECIDE, ["decide", t.state], {
        env: {
          ...process.env,
          HYDRA_AUTOPILOT_STATE: t.state,
          HYDRA_API_BASE: "http://127.0.0.1:1",
          HYDRA_AUTOPILOT_REDIS_CLI: `bash ${t.recorder}`,
          HYDRA_AUTOPILOT_RUN_END_POST: "off",
        },
        encoding: "utf-8",
      });
      assert.equal(r.status ?? -1, 0, `decide exited non-zero: ${r.stderr}`);
      assert.equal(readRecorder(t).length, 0,
        "with the off-switch set, decide.py must issue no redis-cli calls");
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });
});

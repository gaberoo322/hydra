/**
 * The autopilot Loop's helper scripts (issue #4831):
 *
 *   scripts/autopilot/turn.sh             — Phases 1–4 as ONE command
 *   scripts/autopilot/stamp-slot.py       — the dispatch stamp, read off the plan
 *   scripts/autopilot/qa-verdict-event.sh — the `qa-verdict` event recipe
 *
 * Unattended sessions rewrote these three into an untracked cache 30 times in
 * 14 days (~127k chars of output), with per-session drift: the cached stamp
 * never carried `branch` / `anchor` (why reap.py grew its Redis fallback) and
 * wrote a `signal_tasks` field nothing reads. This file pins the committed
 * scripts' contracts:
 *
 *   turn.sh — against the RECORDED collect fixture (replay mode, so no
 *   collect-state.sh run and no network): state.signals written, plan.turn ==
 *   state.turn, absent events → `[]`, absent candidates → the retired-substrate
 *   shape, the summary lines, exit 0; a missing state → exit 2; an
 *   invariant-rejecting plan → exit 1 with the plan left for inspection.
 *
 *   stamp-slot.py — every field reap.py / decide.py read back is stamped from
 *   the plan action (skill, worktreeBranch → branch/dispatch_id, isolation,
 *   prompt_args.anchor, prompt_args.attempt); a signal class stamps
 *   signal_last_fired only; `dispatches` increments; the run-log line goes
 *   through dispatch.sh; a slot with no planned dispatch → exit 1, state
 *   byte-identical.
 *
 *   qa-verdict-event.sh — its `ci-state` and `qa-verdict-event` marker blocks
 *   equal the playbook recipe's byte-for-byte (the recipe stays the documented
 *   source; test/qa-merge-guard-callsites.test.mts executes it), it sources
 *   the shared checks-fetch fragment instead of copying it (#4757 INV-2), and
 *   with `gh`/`node` unreachable it emits a PENDING event and exits 0.
 *
 * This file references no other scripts/autopilot/ target on purpose — the
 * test-subject sprawl ratchet (test/fixtures/test-subject-baseline.json) must
 * resolve it to one of the three new scripts, never move the decide.py /
 * collect-state.sh / dispatch.sh counts. The scripts are invoked through
 * paths built from a directory constant for the same reason.
 */
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPTS = join(REPO_ROOT, "scripts", "autopilot");
const TURN = join(SCRIPTS, "turn.sh");
const STAMP = join(SCRIPTS, "stamp-slot.py");
const QA_EVENT = join(SCRIPTS, "qa-verdict-event.sh");
const FIXTURE = join(REPO_ROOT, "test", "fixtures", "autopilot-collect-sample.txt");
const PLAYBOOK = join(REPO_ROOT, "docs", "operator-playbooks", "hydra-autopilot.md");

/** A bootstrap-shaped state (every field the live Phase 0 writes that the
 *  scripts read). `turn` 3, every slot empty, generous limits. */
function baseState(): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    started: new Date((now - 600) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    started_epoch: now - 600,
    pid: 4242,
    run_id: "4dfd1dc9-e7ae-4729-af27-ab7fac74ef29",
    turn: 3,
    dispatches: 5,
    cumulative_tokens: 656630,
    idle_turns: 0,
    research_force_counter: 0,
    burned_classes: [],
    failure_log: [],
    reaped_task_ids: [],
    dev_resume_pending: null,
    // The live bootstrap.sh shape (keys term-check.py / decide.py read).
    limits: {
      token_budget: 10_000_000,
      wall_clock_max_sec: 28_800,
      idle_drain_turns: 5,
      context_compaction_turns: 8,
      quota_5h_max_pts: 0,
      quota_week_max_pts: 0,
      scope: "all",
      subagent_max_tokens: 400_000,
      subagent_hard_max_tokens: 800_000,
      unattended: true,
      schema_version: 2,
      daily_spend_cap_usd: 0,
      scout_cost_share: 0.04,
    },
    slots: {
      dev_orch: null,
      qa_orch: null,
      research_orch: null,
      dev_target: null,
      qa_target: null,
      research_target: null,
      design_concept_orch: null,
    },
    signal_last_fired: { health: 0, retro_orch: 1790683820 },
    slot_events_last_id: "1790000000000-0",
    signals: { stale_from_last_turn: true },
    usage_eligibility: { allow: true, reasons: {}, usage: { percentLast5h: 10, percentSinceReset: 20 } },
    quota_baseline: { percent_5h: 10, percent_week: 20, captured_epoch: now - 600, rebased_epoch: null },
  };
}

interface Sandbox {
  dir: string;
  state: string;
  plan: string;
  events: string;
  candidates: string;
  collect: string;
  log: string;
  env: Record<string, string>;
}

function sandbox(state: Record<string, unknown> | null = baseState()): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-turn-"));
  const sb: Sandbox = {
    dir,
    state: join(dir, "state.json"),
    plan: join(dir, "plan.json"),
    events: join(dir, "events.json"),
    candidates: join(dir, "candidates.json"),
    collect: join(dir, "collect.txt"),
    log: join(dir, "nightly.log"),
    env: {},
  };
  sb.env = {
    ...process.env,
    HYDRA_AUTOPILOT_STATE: sb.state,
    HYDRA_AUTOPILOT_PLAN: sb.plan,
    HYDRA_AUTOPILOT_EVENTS: sb.events,
    HYDRA_AUTOPILOT_CANDIDATES: sb.candidates,
    HYDRA_AUTOPILOT_COLLECT_OUT: sb.collect,
    HYDRA_AUTOPILOT_COLLECT_REPLAY: FIXTURE,
    HYDRA_AUTOPILOT_LOG: sb.log,
  } as Record<string, string>;
  if (state) writeFileSync(sb.state, JSON.stringify(state, null, 1) + "\n");
  return sb;
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function runTurn(sb: Sandbox, args: string[] = []) {
  const r = spawnSync("bash", [TURN, ...args], { cwd: sb.dir, env: sb.env, encoding: "utf-8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function runStamp(sb: Sandbox, args: string[]) {
  const r = spawnSync("python3", [STAMP, ...args], { cwd: sb.dir, env: sb.env, encoding: "utf-8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const sandboxes: Sandbox[] = [];
after(() => {
  for (const sb of sandboxes) rmSync(sb.dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
describe("turn.sh — Phases 1–4 as one command (issue #4831)", () => {
  let sb: Sandbox;
  let run: ReturnType<typeof runTurn>;
  let state: any;
  let plan: any;

  before(() => {
    sb = sandbox();
    sandboxes.push(sb);
    run = runTurn(sb);
    state = readJson(sb.state);
    plan = readJson(sb.plan);
  });

  test("exits 0 and reports each phase on stdout", () => {
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /\[turn\] collect: replayed /);
    assert.match(run.stdout, /\[turn\] term-check: OK/);
    assert.match(run.stdout, /\[turn\] OK — plan at /);
  });

  test("the collect output is captured where HYDRA_AUTOPILOT_COLLECT_OUT says", () => {
    assert.equal(readFileSync(sb.collect, "utf-8"), readFileSync(FIXTURE, "utf-8"));
  });

  test("merge-signals.py ran: state.signals is the fixture's derivation and the stale key is gone", () => {
    assert.equal(state.signals.orch_work_available, true);
    assert.equal(state.signals.orch_dev_ready_anchor, "issue-4687");
    assert.equal(state.signals.orch_realm_weekly_share, "0.7904");
    assert.equal("stale_from_last_turn" in state.signals, false);
    assert.equal(state.slot_events_last_id, "1790928212814-0", "the cursor advanced from the fixture's slot_events blob");
  });

  test("decide.py ran once: the plan is stamped with the state's run_id and the bumped turn", () => {
    assert.equal(state.turn, 4, "the decide.py CLI bumps turn exactly once");
    assert.equal(plan.turn, 4);
    assert.equal(plan.run_id, state.run_id);
    assert.ok(Array.isArray(plan.actions) && plan.actions.length > 0, "the fixture board has work");
  });

  test("an absent events.json is `[]` and an absent candidates.json is the retired-substrate shape", () => {
    assert.deepEqual(readJson(sb.events), []);
    assert.deepEqual(readJson(sb.candidates), { candidates: [] });
    assert.match(run.stdout, /\[turn\] events: none/);
  });

  test("the plan summary strips the dispatch sentinel and the usage summary reads the merged blob", () => {
    const lines = run.stdout.split("\n").filter((l) => l.startsWith("{"));
    const summary = lines.map((l) => JSON.parse(l));
    const planLine = summary.find((s) => "actions" in s);
    const usageLine = summary.find((s) => "percentLast5h" in s);
    assert.ok(planLine, "a plan summary line");
    assert.ok(usageLine, "a usage summary line");
    assert.equal(planLine.turn, 4);
    for (const a of planLine.actions) assert.equal("dispatchSentinel" in a, false);
    assert.deepEqual(
      planLine.actions.map((a: any) => a.type),
      plan.actions.map((a: any) => a.type),
    );
    assert.equal(usageLine.allow, true);
    assert.equal(typeof usageLine.percentLast5h, "number");
    assert.deepEqual(usageLine.slots_occupied, []);
  });

  test("an explicit events.json argument is passed through to decide.py", () => {
    const sb2 = sandbox();
    sandboxes.push(sb2);
    const events = join(sb2.dir, "my-events.json");
    writeFileSync(events, "[]\n");
    const r = runTurn(sb2, [events]);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /\[turn\] events: none/);
    assert.equal(existsSync(sb2.events), false, "the default events path is not touched when one is given");
  });

  test("a missing state exits 2 before anything runs", () => {
    const sb2 = sandbox(null);
    sandboxes.push(sb2);
    const r = runTurn(sb2);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no state at .*bootstrap\.sh first/);
    assert.equal(existsSync(sb2.plan), false);
    assert.equal(existsSync(sb2.collect), false);
  });

  test("an unreadable replay file exits 2", () => {
    const sb2 = sandbox();
    sandboxes.push(sb2);
    sb2.env.HYDRA_AUTOPILOT_COLLECT_REPLAY = join(sb2.dir, "nope.txt");
    const r = runTurn(sb2);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /cannot read replay/);
  });

  test("an occupied slot flows through: decide.py skips it (INV-002) and the usage line names it", () => {
    // The fixture board always wants qa_orch (needs_qa 1); with that slot
    // occupied the plan must not dispatch it and the summary must say so.
    const st = baseState();
    (st.slots as any).qa_orch = {
      skill: "hydra-qa",
      task_id: "deadbeefdeadbeef0",
      started_epoch: Math.floor(Date.now() / 1000) - 60,
      branch: "worktree-agent-4dfd1dc9-t2-qa_orch",
    };
    const sb2 = sandbox(st);
    sandboxes.push(sb2);
    const r = runTurn(sb2);
    assert.equal(r.status, 0, r.stderr);
    const usageLine = r.stdout.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)).find((s) => "slots_occupied" in s);
    assert.deepEqual(usageLine.slots_occupied, ["qa_orch"]);
    assert.ok(!readJson(sb2.plan).actions.some((a: any) => a.type === "dispatch" && a.slot === "qa_orch"));
  });

  test("a terminate-worthy state still yields a plan (exit 0) — termination is an ACTION the session executes, not a turn.sh failure", () => {
    const st = baseState();
    st.cumulative_tokens = 10_000_001; // >= limits.token_budget → INV-005 terminate
    const sb2 = sandbox(st);
    sandboxes.push(sb2);
    const r = runTurn(sb2);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\[turn\] term-check: TERM:/);
    const types = readJson(sb2.plan).actions.map((a: any) => a.type);
    assert.ok(types.includes("terminate"), `expected a terminate action, got ${types}`);
  });

  test("a decide.py failure propagates its exit and echoes its stderr; no plan is left to execute", () => {
    const sb2 = sandbox();
    sandboxes.push(sb2);
    writeFileSync(sb2.candidates, "{not json\n");
    const r = runTurn(sb2);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /\[turn\] FATAL: decide\.py exit=\d+/);
    assert.doesNotMatch(r.stdout, /\[turn\] OK/);
  });

  test("the script never writes state.turn itself: a second run bumps by exactly one again", () => {
    const r = runTurn(sb);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readJson(sb.state).turn, 5);
    assert.equal(readJson(sb.plan).turn, 5);
  });
});

// ---------------------------------------------------------------------------
describe("stamp-slot.py — the dispatch stamp read off the plan (issue #4831)", () => {
  const T0 = 1_790_996_464;
  const plan = {
    turn: 4,
    run_id: "4dfd1dc9-e7ae-4729-af27-ab7fac74ef29",
    actions: [
      {
        type: "dispatch",
        slot: "dev_orch",
        skill: "hydra-dev",
        prompt_args: { anchor: "issue-4511", resume: true, attempt: 2, escalate_model: "sonnet" },
        worktreeBranch: "worktree-agent-4dfd1dc9-t4-dev_orch",
        isolation: "worktree",
        dispatchSentinel: "<!-- hydra-dispatch v1 -->",
      },
      {
        type: "dispatch",
        slot: "dev_target",
        skill: "hydra-target-build",
        prompt_args: {},
        worktreeBranch: "worktree-agent-4dfd1dc9-t4-dev_target",
        isolation: "self",
      },
      { type: "dispatch", slot: "sweep_orch", skill: "hydra-sweep", prompt_args: { scope: "orch" } },
      { type: "dispatch", slot: "research_orch", skill: "hydra-research", prompt_args: {} },
      { type: "dispatch", slot: "wayfinder_orch", skill: "hydra-issue-research", prompt_args: { ticket: "issue-4705", ticket_type: "task" } },
      { type: "wait", seconds: 300 },
    ],
  };

  function stampSandbox(): Sandbox {
    const st = baseState();
    st.turn = 4;
    const sb = sandbox(st);
    sandboxes.push(sb);
    writeFileSync(sb.plan, JSON.stringify(plan) + "\n");
    return sb;
  }

  test("a pipeline slot gets every field reap.py / decide.py read back, from the plan action", () => {
    const sb = stampSandbox();
    const r = runStamp(sb, ["dev_orch", "abcdef0123456789a", "sonnet"]);
    assert.equal(r.status, 0, r.stderr);
    const st = readJson(sb.state);
    const slot = st.slots.dev_orch;
    assert.equal(slot.skill, "hydra-dev");
    assert.equal(slot.task_id, "abcdef0123456789a");
    assert.equal(slot.model, "sonnet");
    assert.equal(slot.branch, "worktree-agent-4dfd1dc9-t4-dev_orch");
    assert.equal(slot.worktreeBranch, slot.branch);
    assert.equal(slot.dispatch_id, slot.branch);
    assert.equal(slot.isolation, "worktree");
    assert.equal(slot.anchor, "issue-4511", "a pinned anchor is stamped (reap promotes needs-qa off it)");
    assert.equal(slot.attempt, 2, "the escalation attempt is stamped (#3274 step 2)");
    assert.equal(slot.turn, 4);
    assert.equal(typeof slot.started_epoch, "number");
    assert.ok(Math.abs(slot.started_epoch - Date.now() / 1000) < 120);
    assert.match(slot.started, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(new Date(slot.started).getTime() / 1000, slot.started_epoch);
    assert.equal(st.dispatches, 6);
    assert.equal(st.turn, 4, "never touches turn");
    assert.deepEqual(Object.keys(slot).sort(), [
      "anchor", "attempt", "branch", "dispatch_id", "isolation", "model", "skill",
      "started", "started_epoch", "task_id", "turn", "worktreeBranch",
    ]);
    const out = JSON.parse(r.stdout.trim().split("\n").at(-1)!);
    assert.equal(out.slot, "dev_orch");
    assert.equal(out.dispatches, 6);
    assert.deepEqual(out.record, slot);
  });

  test("a self-isolated class without an anchor stamps isolation=self, attempt 1 and no anchor key", () => {
    const sb = stampSandbox();
    const r = runStamp(sb, ["dev_target", "0000000000000000b", "inherit"]);
    assert.equal(r.status, 0, r.stderr);
    const slot = readJson(sb.state).slots.dev_target;
    assert.equal(slot.isolation, "self");
    assert.equal(slot.attempt, 1);
    assert.equal("anchor" in slot, false);
    assert.equal(slot.model, "inherit");
  });

  test("a signal class stamps signal_last_fired only — no slot, no signal_tasks", () => {
    const sb = stampSandbox();
    const r = runStamp(sb, ["sweep_orch", "0000000000000000c", "sonnet"]);
    assert.equal(r.status, 0, r.stderr);
    const st = readJson(sb.state);
    assert.ok(Math.abs(st.signal_last_fired.sweep_orch - Date.now() / 1000) < 120);
    assert.equal("sweep_orch" in st.slots, false);
    assert.equal("signal_tasks" in st, false, "the cached helper's unread field is not reproduced");
    assert.equal(st.dispatches, 6);
    assert.equal(st.signal_last_fired.retro_orch, 1790683820, "other cooldowns untouched");
  });

  test("a wayfinder_orch task ticket stamps the skill that actually runs (hydra-dev), not the taxonomy default (#4833)", () => {
    const sb = stampSandbox();
    const r = runStamp(sb, ["wayfinder_orch", "0000000000000000f", "inherit"]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split("\n").at(-1)!);
    assert.equal(out.record.skill, "hydra-dev");
    assert.match(readFileSync(sb.log, "utf-8"), /^dispatch wayfinder_orch hydra-dev /m);
  });

  test("a planned pipeline slot with no worktreeBranch synthesises decide.py's branch shape", () => {
    const sb = stampSandbox();
    const r = runStamp(sb, ["research_orch", "0000000000000000d", "opus"]);
    assert.equal(r.status, 0, r.stderr);
    const slot = readJson(sb.state).slots.research_orch;
    assert.equal(slot.branch, "worktree-agent-4dfd1dc9-t4-research_orch");
    assert.equal(slot.isolation, "worktree", "a legacy action without isolation fails safe to worktree");
  });

  test("the run-log line goes through dispatch.sh (honouring HYDRA_AUTOPILOT_LOG)", () => {
    const sb = stampSandbox();
    runStamp(sb, ["dev_orch", "abcdef0123456789a", "sonnet"]);
    runStamp(sb, ["sweep_orch", "0000000000000000c", "sonnet"]);
    const log = readFileSync(sb.log, "utf-8").trim().split("\n");
    assert.equal(log.length, 2);
    assert.match(log[0], /^dispatch dev_orch hydra-dev \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.match(log[1], /^dispatch sweep_orch hydra-sweep /);
  });

  test("a slot the plan did not dispatch → exit 1 and the state is byte-identical", () => {
    const sb = stampSandbox();
    const before = readFileSync(sb.state, "utf-8");
    for (const slot of ["qa_orch", "bogus", "health"]) {
      const r = runStamp(sb, [slot, "0000000000000000e", "opus"]);
      assert.equal(r.status, 1, `${slot}: ${r.stdout}`);
      assert.match(r.stderr, new RegExp(`no dispatch action for slot '${slot}' — nothing written`));
    }
    assert.equal(readFileSync(sb.state, "utf-8"), before);
    assert.equal(existsSync(sb.log), false);
  });

  test("bad arguments / unreadable inputs → exit 2", () => {
    const sb = stampSandbox();
    assert.equal(runStamp(sb, ["dev_orch", "x"]).status, 2);
    assert.equal(runStamp(sb, ["--help"]).status, 2);
    rmSync(sb.plan);
    const r = runStamp(sb, ["dev_orch", "x", "y"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /cannot read state\/plan/);
    writeFileSync(sb.plan, "[1,2]\n");
    assert.match(runStamp(sb, ["dev_orch", "x", "y"]).stderr, /not a JSON object/);
  });

  test("no temp file is left behind", () => {
    const sb = stampSandbox();
    runStamp(sb, ["dev_orch", "abcdef0123456789a", "sonnet"]);
    assert.equal(existsSync(`${sb.state}.stamp-slot.tmp`), false);
  });
});

// ---------------------------------------------------------------------------
describe("qa-verdict-event.sh — the playbook recipe as a script (issue #4831)", () => {
  const script = readFileSync(QA_EVENT, "utf-8");
  const playbook = readFileSync(PLAYBOOK, "utf-8");

  /** The lines between `# >>> name` and `# <<< name` (exclusive). */
  function markerBlock(text: string, name: string): string {
    const lines = text.split("\n");
    const a = lines.findIndex((l) => l.trim() === `# >>> ${name}`);
    const b = lines.findIndex((l) => l.trim() === `# <<< ${name}`);
    assert.ok(a > -1 && b > a, `marker block "${name}" not found`);
    return lines.slice(a + 1, b).join("\n");
  }

  test("its ci-state and qa-verdict-event blocks equal the playbook's byte-for-byte", () => {
    for (const name of ["ci-state", "qa-verdict-event"]) {
      assert.equal(markerBlock(script, name), markerBlock(playbook, name), `${name} block drifted from the playbook recipe`);
    }
  });

  test("it sources the shared checks-fetch fragment rather than copying it (#4757 INV-2)", () => {
    assert.match(script, /^source "\$REPO_ROOT\/docs\/operator-playbooks\/_fragments\/checks-fetch\.md"/m);
    assert.equal(script.includes("# >>> checks-fetch"), false, "no copied fetch body");
    assert.equal(script.includes("REQUIRED_CONTEXTS="), false, "no re-implemented required-contexts read");
    assert.equal(script.includes("isRequired"), false);
  });

  test("the playbook tells the session to run it, and keeps the recipe the test suite executes", () => {
    const section = playbook.slice(playbook.indexOf("### Building `qa-verdict` events"));
    const body = section.slice(0, section.indexOf("\n## "));
    assert.match(body, /bash scripts\/autopilot\/qa-verdict-event\.sh/);
    assert.match(body, /@include _fragments\/checks-fetch\.md/);
  });

  test("with gh and node unreachable it emits a PENDING event (fail-closed) and exits 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-verdict-event-"));
    try {
      const shims = join(dir, "bin");
      mkdirSync(shims);
      for (const name of ["gh", "node"]) {
        writeFileSync(join(shims, name), "#!/bin/sh\nexit 1\n");
        chmodSync(join(shims, name), 0o755);
      }
      const r = spawnSync("bash", [QA_EVENT, "4830", "3"], {
        cwd: dir,
        env: { ...process.env, PATH: `${shims}:${process.env.PATH}` },
        encoding: "utf-8",
      });
      assert.equal(r.status, 0, r.stderr);
      const event = JSON.parse(r.stdout.trim());
      assert.deepEqual(event, {
        type: "qa-verdict",
        pr_number: 4830,
        tier: 3,
        verdict: "PENDING",
        verdict_sha: "unknown",
        head_sha: "",
      });
      assert.match(r.stderr, /WARN: checks-fetch failed/, "the fragment's own failure stays loud");
      assert.match(r.stderr, /\[qa-verdict-event\] pr=4830 tier=3 guard_rc=\d+ .*ci=null/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("argument validation: missing or non-integer PR/TIER → exit 2, nothing on stdout", () => {
    for (const args of [[], ["4830"], ["abc", "3"], ["4830", "T3"]]) {
      const r = spawnSync("bash", [QA_EVENT, ...args], { encoding: "utf-8" });
      assert.equal(r.status, 2, args.join(" "));
      assert.equal(r.stdout, "");
    }
  });
});

// ---------------------------------------------------------------------------
describe("the playbook Loop routes through the scripts (issue #4831)", () => {
  const playbook = readFileSync(PLAYBOOK, "utf-8");
  const loop = playbook.slice(playbook.indexOf("\n## Loop\n"), playbook.indexOf("\n### Building `qa-verdict` events"));

  test("steps 2–4 are one turn.sh command and the stale per-step commands are gone", () => {
    assert.match(loop, /bash scripts\/autopilot\/turn\.sh events\.json/);
    assert.doesNotMatch(loop, /^\d\. \*\*`python3 scripts\/autopilot\/assert_invariants\.py/m, "assert_invariants is no longer a session step");
    assert.doesNotMatch(loop, /^\d\. \*\*`python3 scripts\/autopilot\/decide\.py decide/m, "decide.py is no longer a session step");
  });

  test("the dispatch row stamps the slot with stamp-slot.py after the Agent call", () => {
    const row = playbook.split("\n").find((l) => l.startsWith("| `dispatch` |"));
    assert.ok(row, "dispatch row present");
    assert.match(row!, /python3 scripts\/autopilot\/stamp-slot\.py <slot> <agentId> <model>/);
  });
});

/**
 * scripts/autopilot/merge-signals.py — the Signal wiring table as code
 * (issue #4829).
 *
 * The promotion of collect-state.sh's `key=value` stream into `state.signals`
 * was a playbook TABLE the autopilot session executed by hand every turn,
 * with helper scripts it rewrote or reused from an untracked cache. This file
 * pins the committed script's contract against a RECORDED collect-state
 * output (test/fixtures/autopilot-collect-sample.txt — a real 2026-10-02
 * turn, JSON blobs shortened):
 *
 *   - the derived signal values for every rule shape (board count, kv count,
 *     eq-0, flag, verbatim text with default, optional ref with none → omit,
 *     ISO staleness, health), read off the fixture;
 *   - `.signals` is replaced WHOLESALE — a stale key from the previous turn
 *     does not survive (the run 9ede5aef deep-merge lesson);
 *   - `turn` and every unrelated state field are byte-identical afterwards
 *     (the decide.py CLI owns `turn`, issue #1769);
 *   - the verbatim blobs land on their top-level fields; an unparseable blob
 *     keeps the previous value and says so on stderr; an unreadable
 *     slot_events blob yields `[]` (per-turn consumption, never a replay);
 *   - lines that are neither `key=value` nor the board line are ignored;
 *   - the CLI's exit codes and its one-line JSON summary.
 *
 * The table ↔ script parity (every row has a Rule and vice-versa, leg L4)
 * is asserted in test/decide-signal-classes.test.mts beside L1–L3 (#4519
 * INV-1: the parity legs live there). This file references no other
 * scripts/autopilot/ target on purpose — the test-subject sprawl ratchet
 * (test/fixtures/test-subject-baseline.json) resolves it to merge-signals.py
 * alone, so the decide.py / collect-state.sh counts do not move.
 */
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "autopilot", "merge-signals.py");
const FIXTURE = join(REPO_ROOT, "test", "fixtures", "autopilot-collect-sample.txt");

/** A minimal Phase-0-shaped state: the fields the script must leave alone. */
function baseState(): Record<string, unknown> {
  return {
    started: "2026-10-02T15:49:31Z",
    pid: 4242,
    run_id: "11111111-2222-3333-4444-555555555555",
    turn: 7,
    dispatches: 3,
    cumulative_tokens: 123456,
    limits: { schema_version: 2, scope: "all" },
    slots: { dev_orch: null, qa_orch: { task_id: "abc", skill: "hydra-qa" } },
    signal_last_fired: { health: 0, retro_orch: 1790683820 },
    slot_events_last_id: "1790000000000-0",
    signals: { stale_from_last_turn: true, orch_pending_grill_anchor: "issue-1" },
    usage_eligibility: { allow: false, reasons: { paused: true } },
    dev_target_spend_usd_cycle: 1.5,
  };
}

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "merge-signals-"));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

let counter = 0;
function run(
  collectText: string | null,
  state: Record<string, unknown> | string = baseState(),
  extraArgs: string[] = [],
): { status: number | null; stdout: string; stderr: string; statePath: string; state: Record<string, unknown> } {
  counter += 1;
  const collectPath = join(dir, `collect-${counter}.txt`);
  const statePath = join(dir, `state-${counter}.json`);
  if (collectText !== null) writeFileSync(collectPath, collectText);
  writeFileSync(statePath, typeof state === "string" ? state : JSON.stringify(state));
  const r = spawnSync("python3", [SCRIPT, collectPath, statePath, ...extraArgs], { encoding: "utf-8" });
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(readFileSync(statePath, "utf-8")) as Record<string, unknown>;
  } catch {
    /* intentional: a test asserting the state is untouched on failure reads it separately */
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, statePath, state: parsed };
}

const fixture = readFileSync(FIXTURE, "utf-8");

describe("merge-signals.py — derived signals from a recorded collect-state output (#4829)", () => {
  const r = run(fixture);
  const signals = r.state.signals as Record<string, unknown>;

  test("exits 0 and prints a one-line JSON summary", () => {
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.trim().split("\n");
    assert.equal(lines.length, 1, `expected exactly one stdout line, got: ${r.stdout}`);
    const summary = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(summary.signals_keys, Object.keys(signals).length);
    assert.equal(summary.slot_events, 1);
    assert.equal(summary.slot_events_last_id, "1790928212814-0");
    assert.equal(summary.allow, true);
  });

  test("board-state JSON line → orch board booleans", () => {
    // fixture board line: needs_qa 1, ready_for_agent 12, needs_triage 0, needs_research 0
    assert.equal(signals.orch_work_available, true);
    assert.equal(signals.needs_qa_orch, true);
    assert.equal(signals.needs_triage_orch, false);
    assert.equal(signals.needs_research, false);
  });

  test("kv counts → booleans (gt-0 and eq-0 shapes)", () => {
    // target_ready_for_agent=2, target_needs_qa=1, target_needs_triage=0, work_queue=0, untriaged_orphans=0
    assert.equal(signals.target_board_work_available, true);
    assert.equal(signals.target_board_research_due, false);
    assert.equal(signals.needs_qa_target, true);
    assert.equal(signals.needs_triage_target, false);
    assert.equal(signals.target_work_available, false);
    assert.equal(signals.untriaged_orphans_orch, false);
  });

  test("true/false literals collect-state already resolved → booleans, absent → false", () => {
    assert.equal(signals.arch_board_saturated, true);
    assert.equal(signals.orch_backfill_idle, false);
    assert.equal(signals.target_wip_saturated, false);
    assert.equal(signals.orch_ci_trigger_stale, false);
    assert.equal(signals.retro_run_drillable, false);
    assert.equal(signals.tickets_available, false);
    assert.equal(typeof signals.retro_run_drillable, "boolean", "retro_run_drillable is promoted as a boolean even when false — never omitted (#4342)");
  });

  test("verbatim strings keep their exact value, including empty", () => {
    assert.equal(signals.needs_qa_numbers, "4700");
    assert.equal(signals.orch_prs_glm_red, "4776 4777 4800 4814 4817 4824");
    assert.equal(signals.orch_prs_dirty, "");
    assert.equal(signals.orch_prs_dirty_surface, "");
    assert.equal(signals.orch_needs_triage_items, "");
    assert.equal(signals.target_needs_qa_pr_ref, "https://github.com/gaberoo322/claw-street-bets/pull/235");
    assert.equal(signals.target_needs_qa_pr_head, "feature/aeb984cb-t1-dev_target");
    assert.equal(signals.wayfinder_orch_inflight_global, "0");
    assert.equal(signals.orch_realm_weekly_share, "0.7904", "the share is a verbatim string, never coerced to a number");
  });

  test("optional anchor refs: `none` → key OMITTED, a value → verbatim", () => {
    assert.equal(signals.orch_dev_ready_anchor, "issue-4687");
    assert.equal(signals.orch_glm_red_forward_fix, "issue-4728:4776:worktree-agent-glm-4728-1790729985");
    assert.equal(signals.orch_dev_resume_pick, "issue-4511:4818:dev/4511-decide-selectors-split");
    for (const omitted of [
      "orch_pending_grill_anchor",
      "orch_dirty_forward_fix",
      "target_dev_resume_pick",
      "wayfinder_orch_frontier",
      "tickets_orch_pending_spec",
    ]) {
      assert.equal(omitted in signals, false, `${omitted} is \`none\` in the fixture and must be absent from state.signals`);
    }
  });

  test("counts merged as integers", () => {
    assert.equal(signals.hitl_grill_open, 2);
    assert.equal(signals.scout_alert_eligible_count, 0);
  });

  test("health_fail is false for `health=ok redis=True` with no failed services", () => {
    assert.equal(signals.health_fail, false);
  });

  test("scout_walk_due: a 2026-09-18 walk is stale against today (>7d)", () => {
    assert.equal(signals.scout_walk_due, true);
    assert.equal(signals.scout_board_saturated, true, "54 open enhancements > the cap of 20");
  });

  test("the stale key from the previous turn is gone — .signals was replaced, not merged", () => {
    assert.equal("stale_from_last_turn" in signals, false);
    assert.equal("orch_pending_grill_anchor" in signals, false, "last turn's anchor must not survive a turn whose collect output says none (run 9ede5aef)");
  });

  test("verbatim blobs land on their top-level fields; slot_events unwraps to list + cursor", () => {
    assert.equal((r.state.usage_eligibility as Record<string, unknown>).allow, true, "the previous allow:false must be replaced");
    assert.deepEqual(r.state.emergency_brake, { engaged: false });
    assert.equal((r.state.target_risk_surface as Record<string, unknown>).ok, true);
    assert.ok(Array.isArray(r.state.candidate_exclusions));
    assert.ok((r.state.class_stats as Record<string, unknown>).scoreboard);
    const events = r.state.slot_events as unknown[];
    assert.equal(events.length, 1);
    assert.equal(r.state.slot_events_last_id, "1790928212814-0");
    assert.equal(r.state.scout_spend_usd_today, 0);
  });

  test("turn and every unrelated field are untouched", () => {
    const before = baseState();
    for (const key of ["started", "pid", "run_id", "turn", "dispatches", "cumulative_tokens", "limits", "slots", "signal_last_fired", "dev_target_spend_usd_cycle"]) {
      assert.deepEqual(r.state[key], before[key], `${key} must be byte-identical across a merge`);
    }
  });
});

describe("merge-signals.py — degraded inputs (#4829)", () => {
  test("a line that is neither key=value nor the board line is ignored", () => {
    const r = run("CODEX_IDLE\n0\n\n   \nhealth=ok redis=True\nnot a kv line at all\ntarget_needs_qa=3\n");
    assert.equal(r.status, 0, r.stderr);
    const signals = r.state.signals as Record<string, unknown>;
    assert.equal(signals.needs_qa_target, true);
    assert.equal(signals.health_fail, false);
  });

  test("health=FAIL or failed_services>0 → health_fail; a missing health line does not", () => {
    assert.equal((run("health=FAIL\nfailed_services=0\n").state.signals as Record<string, unknown>).health_fail, true);
    assert.equal((run("health=ok redis=True\nfailed_services=2\n").state.signals as Record<string, unknown>).health_fail, true);
    assert.equal((run("failed_services=0\n").state.signals as Record<string, unknown>).health_fail, false);
  });

  test("an empty collect output still yields every non-optional key (fail-closed booleans, defaults for strings)", () => {
    const r = run("");
    assert.equal(r.status, 0, r.stderr);
    const signals = r.state.signals as Record<string, unknown>;
    assert.equal(signals.orch_work_available, false);
    assert.equal(signals.target_board_research_due, true, "a missing target count reads as 0, which is the board-empty shape");
    assert.equal(signals.scout_walk_due, true, "no walk timestamp → due");
    assert.equal(signals.orch_realm_weekly_share, "unavailable");
    assert.equal("wayfinder_orch_frontier" in signals, false);
    assert.deepEqual(r.state.slot_events, [], "no slot_events blob → no events this turn");
    assert.equal(r.state.slot_events_last_id, "1790000000000-0", "the cursor is never moved without a new last_id");
  });

  test("an unparseable blob keeps the previous state value and says so on stderr", () => {
    const r = run("usage_eligibility_json={not json\nemergency_brake_json={\"engaged\":true}\n");
    assert.equal(r.status, 0);
    assert.deepEqual(r.state.usage_eligibility, { allow: false, reasons: { paused: true } });
    assert.deepEqual(r.state.emergency_brake, { engaged: true });
    assert.match(r.stderr, /usage_eligibility_json unparseable/);
  });

  test("an unparseable slot_events blob yields [] (never a replay of last turn's events) and keeps the cursor", () => {
    const state = { ...baseState(), slot_events: [{ id: "old" }] };
    const r = run("slot_events_json={broken\n", state);
    assert.equal(r.status, 0);
    assert.deepEqual(r.state.slot_events, []);
    assert.equal(r.state.slot_events_last_id, "1790000000000-0");
    assert.match(r.stderr, /slot_events_json unparseable/);
  });

  test("a non-numeric count reads as 0, a non-numeric spend keeps the previous value", () => {
    const state = { ...baseState(), scout_spend_usd_today: 0.42 };
    const r = run("hitl_grill_open=lots\nscout_spend_usd_today=n/a\n", state);
    assert.equal((r.state.signals as Record<string, unknown>).hitl_grill_open, 0);
    assert.equal(r.state.scout_spend_usd_today, 0.42);
    assert.match(r.stderr, /scout_spend_usd_today/);
  });

  test("a board line that is not JSON reads the orch counts as 0 and continues", () => {
    const r = run('{"needs_qa": nope\ntarget_needs_qa=1\n');
    assert.equal(r.status, 0);
    const signals = r.state.signals as Record<string, unknown>;
    assert.equal(signals.orch_work_available, false);
    assert.equal(signals.needs_qa_target, true);
    assert.match(r.stderr, /board-state line unparseable/);
  });
});

describe("merge-signals.py — CLI contract (#4829)", () => {
  test("usage error → exit 2, state untouched", () => {
    const r = spawnSync("python3", [SCRIPT], { encoding: "utf-8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage/);
  });

  test("unreadable collect output → exit 2", () => {
    const r = run(null);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /cannot read collect output/);
  });

  test("unreadable or non-object state → exit 1, file left as it was", () => {
    const r1 = run("a=1\n", "{not json");
    assert.equal(r1.status, 1);
    assert.equal(readFileSync(r1.statePath, "utf-8"), "{not json");
    const r2 = run("a=1\n", "[1,2]");
    assert.equal(r2.status, 1);
    assert.match(r2.stderr, /not a JSON object/);
  });

  test("reads collect output from stdin when the path is `-`", () => {
    const statePath = join(dir, "state-stdin.json");
    writeFileSync(statePath, JSON.stringify(baseState()));
    const r = spawnSync("python3", [SCRIPT, "-", statePath], { encoding: "utf-8", input: "target_needs_qa=1\n" });
    assert.equal(r.status, 0, r.stderr);
    const state = JSON.parse(readFileSync(statePath, "utf-8")) as Record<string, unknown>;
    assert.equal((state.signals as Record<string, unknown>).needs_qa_target, true);
  });

  test("the written state file parses and leaves no temp file behind", () => {
    const r = run(fixture);
    assert.equal(r.status, 0);
    assert.doesNotThrow(() => JSON.parse(readFileSync(r.statePath, "utf-8")));
    assert.throws(() => readFileSync(`${r.statePath}.merge-signals.tmp`), /ENOENT/);
  });
});

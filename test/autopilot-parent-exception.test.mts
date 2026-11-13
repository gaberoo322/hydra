/**
 * Parent-loop residue moved to scripts (issue #5323, ADR-0047 Decision 8).
 *
 *   - Fable instant death: `decide.py` recognises the completion shape (0 tokens,
 *     0 tool uses, < 5s, a Fable-resolved dispatch), replays the identical
 *     recorded dispatch ONCE on opus, and marks the reap `instant_death`.
 *   - `route-prs-to-review` carries the displaced PR list (`pr_numbers`).
 *   - `run_ledger.py parent-exception` journals the five typed causes; `turn.sh`
 *     journals its own (`invariant-reject`, `script-error`) best-effort.
 *   - `reap.py` reports the instant-death notice to the usage tracker.
 */
import test, { describe, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { withTurnSnapshot } from "./_helpers/turn-snapshot-state.mts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPTS = join(REPO_ROOT, "scripts", "autopilot");
const DECIDE = join(SCRIPTS, "decide.py");
const LEDGER = join(SCRIPTS, "run_ledger.py");
const REAP = join(SCRIPTS, "reap.py");
const TURN = join(SCRIPTS, "turn.sh");
const SNAPSHOT_FIXTURE = join(REPO_ROOT, "test", "fixtures", "autopilot-turn-snapshot-sample.json");
const CAUSES = ["invariant-reject", "script-error", "unrouted-refusal", "notes-steer", "defect-filed"];

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "autopilot-parent-exc-"));
  dirs.push(d);
  return d;
}

const BRANCH = "worktree-agent-4dfd1dc9-t3-dev_target";

function baseState(over: Record<string, unknown> = {}): any {
  return {
    started_epoch: Math.floor(Date.now() / 1000),
    run_id: "4dfd1dc9-e7ae-4729-af27-ab7fac74ef29",
    limits: {
      token_budget: 10_000_000, wall_clock_max_sec: 28_800, idle_drain_turns: 5,
      context_compaction_turns: 0, scope: "all", subagent_max_tokens: 400_000, subagent_hard_max_tokens: 800_000,
    },
    cumulative_tokens: 0, dispatches: 0, turn: 3, burned_classes: [], reaped_task_ids: [], failure_log: [],
    slots: {
      dev_orch: null, qa_orch: null, research_orch: null, qa_target: null, research_target: null,
      design_concept_orch: null,
      dev_target: { skill: "hydra-target-build", task_id: "abc123", started: "t0", started_epoch: 1, dispatch_id: BRANCH },
    },
    signal_last_fired: {},
    research_force_counter: {},
    last_dispatch_by_class: {
      dev_target: { turn: 2, skill: "hydra-target-build", prompt_args: { attempt: 1 }, intent: { kind: "TargetFresh", anchor: "issue-9" }, worktreeBranch: BRANCH },
    },
    ...over,
  };
}

function decide(state: any, events: any[]): { plan: any; stateAfter: any } {
  const dir = tmp();
  const s = join(dir, "state.json");
  writeFileSync(s, JSON.stringify(withTurnSnapshot(state)));
  writeFileSync(join(dir, "cands.json"), JSON.stringify(null));
  writeFileSync(join(dir, "events.json"), JSON.stringify(events));
  const r = spawnSync("python3", [DECIDE, "decide", s, join(dir, "cands.json"), join(dir, "events.json")], {
    encoding: "utf-8",
    env: { ...process.env, HYDRA_AUTOPILOT_RUN_END_POST: "off" },
  });
  assert.equal(r.status, 0, r.stderr);
  return { plan: JSON.parse(r.stdout), stateAfter: JSON.parse(readFileSync(s, "utf-8")) };
}

const death = (over: Record<string, unknown> = {}) => ({
  type: "completion", slot: "dev_target", task_id: "abc123", total_tokens: 0, tool_uses: 0, duration_ms: 800,
  notice: "You're out of usage credits. Switch to another model", ...over,
});
const replays = (plan: any) => plan.actions.filter((a: any) => a.type === "dispatch" && a.slot === "dev_target");

describe("decide.py - Fable instant-death replay (#5323)", () => {
  test("replays the identical recorded dispatch once on opus, after the reap, and marks the reap", () => {
    const { plan } = decide(baseState(), [death()]);
    const reap = plan.actions.find((a: any) => a.type === "reap");
    assert.equal(reap.instant_death, true);
    assert.equal(reap.notice, "You're out of usage credits. Switch to another model");
    assert.equal(reap.dispatch_model, "fable");
    const [d] = replays(plan);
    assert.equal(d.skill, "hydra-target-build");
    assert.deepEqual(d.intent, { kind: "TargetFresh", anchor: "issue-9" });
    assert.deepEqual(d.prompt_args, { attempt: 2, escalate_model: "opus", prior_attempt_status: "instant-death" });
    assert.equal(replays(plan).length, 1, "no double dispatch from the pipeline rule");
    assert.ok(plan.actions.indexOf(reap) < plan.actions.indexOf(d), "reap precedes dispatch (INV-006)");
    assert.equal(d.worktreeBranch.length > 0, true);
    assert.notEqual(d.worktreeBranch, BRANCH, "the replay gets a freshly synthesised branch");
  });

  test("a replayed dispatch (prior_attempt_status instant-death) is never replayed again", () => {
    const st = baseState({
      last_dispatch_by_class: { dev_target: { turn: 3, skill: "hydra-target-build", worktreeBranch: BRANCH, prompt_args: { escalate_model: "fable", prior_attempt_status: "instant-death" } } },
    });
    const { plan } = decide(st, [death()]);
    assert.equal(replays(plan).length, 0);
    assert.ok(plan.reasons.includes("instant-death-replay-exhausted:dev_target"), plan.reasons.join());
  });

  for (const [name, ev] of Object.entries({
    "duration at the 5000ms bound": death({ duration_ms: 5000 }),
    "a tool use": death({ tool_uses: 1 }),
    "tokens spent": death({ total_tokens: 12 }),
    "tool_uses missing": (() => { const e: any = death(); delete e.tool_uses; return e; })(),
    "duration non-integer": death({ duration_ms: "800" }),
    "negative duration": death({ duration_ms: -1 }),
  })) {
    test(`not an instant death: ${name}`, () => {
      const { plan } = decide(baseState(), [ev]);
      assert.equal(replays(plan).length, 0);
      assert.equal(plan.actions.find((a: any) => a.type === "reap").instant_death, undefined);
    });
  }

  test("a non-Fable class (dev_orch / sonnet) is not replayed", () => {
    const st = baseState({
      slots: { dev_orch: { skill: "hydra-dev", task_id: "abc123", started: "t0", started_epoch: 1, dispatch_id: BRANCH }, dev_target: null },
      last_dispatch_by_class: { dev_orch: { turn: 2, skill: "hydra-dev", prompt_args: {}, worktreeBranch: BRANCH } },
    });
    const { plan } = decide(st, [death({ slot: "dev_orch" })]);
    assert.equal(plan.actions.filter((a: any) => a.type === "dispatch" && a.slot === "dev_orch").length, 0);
  });

  test("missing record or a dispatch_id/worktreeBranch mismatch -> no replay, named reason", () => {
    const noRecord = decide(baseState({ last_dispatch_by_class: {} }), [death()]);
    assert.equal(replays(noRecord.plan).length, 0);
    assert.ok(noRecord.plan.reasons.includes("instant-death-unjoinable:dev_target"));
    const st = baseState();
    st.slots.dev_target.dispatch_id = "worktree-agent-someone-else";
    const mismatch = decide(st, [death()]);
    assert.equal(replays(mismatch.plan).length, 0);
    assert.ok(mismatch.plan.reasons.includes("instant-death-unjoinable:dev_target"));
  });

  test("a pre-intent (prompt_args-only) dev_target record is unjoinable, never replayed intent-less (#5383)", () => {
    const st = baseState({
      last_dispatch_by_class: {
        dev_target: { turn: 2, skill: "hydra-target-build", prompt_args: { anchor: "issue-9", attempt: 1 }, worktreeBranch: BRANCH },
      },
    });
    const { plan } = decide(st, [death()]);
    assert.equal(replays(plan).length, 0);
    assert.ok(plan.reasons.includes("instant-death-unjoinable:dev_target"), plan.reasons.join());
  });

  test("a null slot or a slot without dispatch_id is unjoinable -> no replay (INV-3 fail-closed)", () => {
    const nullSlot = baseState();
    nullSlot.slots.dev_target = null;
    const a = decide(nullSlot, [death()]);
    assert.equal(replays(a.plan).length, 0);
    assert.ok(a.plan.reasons.includes("instant-death-unjoinable:dev_target"), a.plan.reasons.join());
    const noId = baseState();
    delete noId.slots.dev_target.dispatch_id;
    const b = decide(noId, [death()]);
    assert.equal(replays(b.plan).length, 0);
    assert.ok(b.plan.reasons.includes("instant-death-unjoinable:dev_target"), b.plan.reasons.join());
  });

  test("a signal class with no slot entry still replays on the recorded dispatch (INV-3)", () => {
    const st = baseState({
      slots: { dev_target: null },
      last_dispatch_by_class: { retro_orch: { turn: 2, skill: "hydra-retro", prompt_args: {}, worktreeBranch: BRANCH } },
    });
    const { plan } = decide(st, [death({ slot: "retro_orch" })]);
    const [d] = plan.actions.filter((a: any) => a.type === "dispatch" && a.slot === "retro_orch");
    assert.ok(d, plan.reasons.join());
    assert.equal(d.prompt_args.escalate_model, "opus");
  });

  test("usage hard stop suppresses the replay with a named reason", () => {
    const st = baseState({ usage_eligibility: { allow: false, reasons: ["weekly"], shed: [] } });
    const { plan } = decide(st, [death()]);
    assert.equal(replays(plan).length, 0);
    assert.ok(plan.reasons.includes("instant-death-replay-suppressed:dev_target:usage_dispatch_blocked"), plan.reasons.join());
  });

  test("a burned class is not replayed; the skip names the burned gate and the reap survives (#5479)", () => {
    const { plan } = decide(baseState({ burned_classes: ["dev_target"] }), [death()]);
    assert.equal(replays(plan).length, 0);
    assert.ok(plan.reasons.includes("instant-death-replay-suppressed:dev_target:burned"), plan.reasons.join());
    assert.ok(plan.actions.some((a: any) => a.type === "reap" && a.slot === "dev_target"), "the reap is still emitted");
  });

  test("a scope-excluded class is not replayed; the skip names the scope_excluded gate (#5479)", () => {
    const st = baseState();
    st.limits.scope = "orch-only";
    const { plan } = decide(st, [death()]);
    assert.equal(replays(plan).length, 0);
    assert.ok(plan.reasons.includes("instant-death-replay-suppressed:dev_target:scope_excluded"), plan.reasons.join());
    assert.ok(plan.actions.some((a: any) => a.type === "reap" && a.slot === "dev_target"), "the reap is still emitted");
  });

  test("an orch-realm class over its weekly share is not replayed; the skip names orch_realm_share_exceeded and the reap survives (#5479 INV-3)", () => {
    const mk = (share: number) => {
      const st = baseState({
        slots: { dev_target: null },
        signals: { orch_realm_weekly_share: share },
        last_dispatch_by_class: { retro_orch: { turn: 2, skill: "hydra-retro", prompt_args: {}, worktreeBranch: BRANCH } },
      });
      st.limits.orch_realm_weekly_share_cap = 0.5;
      return st;
    };
    const over = decide(mk(0.9), [death({ slot: "retro_orch" })]).plan;
    assert.equal(over.actions.filter((a: any) => a.type === "dispatch" && a.slot === "retro_orch").length, 0);
    assert.ok(over.reasons.includes("instant-death-replay-suppressed:retro_orch:orch_realm_share_exceeded"), over.reasons.join());
    assert.ok(over.actions.some((a: any) => a.type === "reap" && a.slot === "retro_orch"), "the reap is still emitted");
    // Sibling shape: under the cap the same orch class still replays.
    const under = decide(mk(0.1), [death({ slot: "retro_orch" })]).plan;
    assert.equal(under.actions.filter((a: any) => a.type === "dispatch" && a.slot === "retro_orch").length, 1, under.reasons.join());
  });

  test("a replay plan passes assert_invariants.py against the post-decide state (#5479 INV-4)", () => {
    const dir = tmp();
    const s = join(dir, "state.json");
    writeFileSync(s, JSON.stringify(withTurnSnapshot(baseState())));
    writeFileSync(join(dir, "cands.json"), "null");
    writeFileSync(join(dir, "events.json"), JSON.stringify([death()]));
    const d = spawnSync("python3", [DECIDE, "decide", s, join(dir, "cands.json"), join(dir, "events.json")], {
      encoding: "utf-8", env: { ...process.env, HYDRA_AUTOPILOT_RUN_END_POST: "off" },
    });
    assert.equal(d.status, 0, d.stderr);
    const plan = JSON.parse(d.stdout);
    assert.equal(replays(plan).length, 1, "the replay is emitted");
    writeFileSync(join(dir, "plan.json"), d.stdout);
    const r = spawnSync("python3", [join(SCRIPTS, "assert_invariants.py"), join(dir, "plan.json"), s], { encoding: "utf-8" });
    assert.equal(r.status, 0, r.stderr);
  });

  test("an `inherit` class has no dispatch_model on the reap action", () => {
    const st = baseState({
      slots: { dev_target: null },
      last_dispatch_by_class: { wayfinder_orch: { turn: 2, skill: "hydra-wayfinder", prompt_args: {}, worktreeBranch: BRANCH } },
    });
    const { plan } = decide(st, [death({ slot: "wayfinder_orch" })]);
    const reap = plan.actions.find((a: any) => a.type === "reap");
    assert.equal(reap.instant_death, true);
    assert.equal("dispatch_model" in reap, false);
  });

  test("an INTENT-shaped dev_orch dispatch is replayed THROUGH its intent, not stranded without one (#5381)", () => {
    const intent = { kind: "ResumeBranch", anchor: "issue-9", branch: "feat/9-x" };
    const st = baseState({
      slots: { dev_orch: { skill: "hydra-dev", task_id: "abc123", started: "t0", started_epoch: 1, dispatch_id: BRANCH }, dev_target: null },
      last_dispatch_by_class: {
        dev_orch: { turn: 2, skill: "hydra-dev", prompt_args: { escalate_model: "fable" }, intent, worktreeBranch: BRANCH },
      },
    });
    const { plan, stateAfter } = decide(st, [death({ slot: "dev_orch" })]);
    const [d] = plan.actions.filter((a: any) => a.type === "dispatch" && a.slot === "dev_orch");
    assert.ok(d, "replayed");
    assert.deepEqual(d.intent, intent);
    assert.equal(d.anchor, "issue-9");
    assert.deepEqual(d.prompt_args, { escalate_model: "opus", attempt: 2, prior_attempt_status: "instant-death" });
    assert.deepEqual(stateAfter.last_dispatch_by_class.dev_orch.intent, intent, "the replay is itself recorded with its intent");
  });

  test("a recorded dev_orch intent that no longer parses is unjoinable, never replayed blind (#5381)", () => {
    const st = baseState({
      slots: { dev_orch: { skill: "hydra-dev", task_id: "abc123", started: "t0", started_epoch: 1, dispatch_id: BRANCH }, dev_target: null },
      last_dispatch_by_class: {
        dev_orch: { turn: 2, skill: "hydra-dev", prompt_args: { escalate_model: "fable" }, intent: { kind: "Bogus" }, worktreeBranch: BRANCH },
      },
    });
    const { plan } = decide(st, [death({ slot: "dev_orch" })]);
    assert.equal(plan.actions.filter((a: any) => a.type === "dispatch" && a.slot === "dev_orch").length, 0);
    assert.ok(plan.reasons.includes("instant-death-unjoinable:dev_orch"), plan.reasons.join());
  });

  test("a pre-intent dev_orch record (no intent) is unjoinable, never replayed intent-less (#5381)", () => {
    const st = baseState({
      slots: { dev_orch: { skill: "hydra-dev", task_id: "abc123", started: "t0", started_epoch: 1, dispatch_id: BRANCH }, dev_target: null },
      last_dispatch_by_class: {
        dev_orch: { turn: 2, skill: "hydra-dev", prompt_args: { anchor: "issue-9", escalate_model: "fable" }, worktreeBranch: BRANCH },
      },
    });
    const { plan } = decide(st, [death({ slot: "dev_orch" })]);
    assert.equal(plan.actions.filter((a: any) => a.type === "dispatch" && a.slot === "dev_orch").length, 0);
    assert.ok(plan.reasons.includes("instant-death-unjoinable:dev_orch"), plan.reasons.join());
  });

  test("decide records every emitted dispatch in state.last_dispatch_by_class", () => {
    const { plan, stateAfter } = decide(baseState(), [death()]);
    const [d] = replays(plan);
    assert.deepEqual(stateAfter.last_dispatch_by_class.dev_target.worktreeBranch, d.worktreeBranch);
    assert.equal(stateAfter.last_dispatch_by_class.dev_target.prompt_args.prior_attempt_status, "instant-death");
  });
});

describe("decide.py - route-prs-to-review carries pr_numbers (#5323)", () => {
  const brake = (engaged: boolean) => baseState({ emergency_brake: { engaged }, slots: {}, last_dispatch_by_class: {} });
  const verdict = (n: number) => ({ type: "qa-verdict", pr_number: n, tier: 3, verdict: "PASS" });

  test("sorted, de-duplicated sweep set; still exactly one action and zero auto-merge", () => {
    const { plan } = decide(brake(true), [verdict(12), verdict(7), verdict(12)]);
    const routes = plan.actions.filter((a: any) => a.type === "route-prs-to-review");
    assert.equal(routes.length, 1);
    assert.deepEqual(routes[0].pr_numbers, [7, 12]);
    assert.equal(plan.actions.filter((a: any) => a.type === "auto-merge").length, 0);
  });

  test("no sweep set -> an empty list", () => {
    const { plan } = decide(brake(true), []);
    assert.deepEqual(plan.actions.find((a: any) => a.type === "route-prs-to-review").pr_numbers, []);
  });
});

describe("reap.py post_instant_death_notice best-effort (#5323 INV-7)", () => {
  const probe = (exc: string) => spawnSync("python3", ["-I", "-c", `
import sys, http.client, urllib.error
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
import reap
reap._append_log = lambda m: None
def boom(*a, **k):
    raise ${exc}
reap.urllib.request.urlopen = boom
print(reap.post_instant_death_notice("x"))
`], { encoding: "utf-8" });

  for (const exc of ["http.client.RemoteDisconnected('gone')", "ValueError('bad')"]) {
    test(`${exc} is swallowed -> False, no traceback`, () => {
      const r = probe(exc);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trim(), "False");
    });
  }

  test("sibling shape: URLError still swallowed -> False", () => {
    const r = probe("urllib.error.URLError('down')");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "False");
  });
});

describe("run_ledger.py parent-exception (#5323)", () => {
  const ledger = (args: string[]) => spawnSync("python3", [LEDGER, ...args], { encoding: "utf-8" });
  const stateFile = (doc: Record<string, unknown> = { turn: 4 }) => {
    const p = join(tmp(), "state.json");
    writeFileSync(p, JSON.stringify(doc));
    return p;
  };
  const entries = (p: string) => JSON.parse(readFileSync(p, "utf-8")).parent_exceptions;

  test("every cause is journaled with turn, source, detail and ts_epoch", () => {
    const p = stateFile();
    for (const cause of CAUSES) {
      const r = ledger(["parent-exception", p, cause, "--source", "turn.sh", "--detail", `d-${cause}`]);
      assert.equal(r.status, 0, r.stderr);
    }
    const got = entries(p);
    assert.deepEqual(got.map((e: any) => e.cause), CAUSES);
    for (const e of got) {
      assert.equal(e.turn, 4);
      assert.equal(e.source, "turn.sh");
      assert.equal(e.detail, `d-${e.cause}`);
      assert.ok(Number.isInteger(e.ts_epoch) && e.ts_epoch > 0);
    }
  });

  test("source defaults to parent; detail is one line truncated to 200 chars", () => {
    const p = stateFile();
    ledger(["parent-exception", p, "defect-filed", "--detail", "#5300\nsecond line " + "x".repeat(300)]);
    const [e] = entries(p);
    assert.equal(e.source, "parent");
    assert.equal(e.detail.length, 200);
    assert.ok(!e.detail.includes("\n"));
  });

  test("an unknown cause or source exits 2 and writes nothing", () => {
    const p = stateFile();
    const before = readFileSync(p, "utf-8");
    assert.equal(ledger(["parent-exception", p, "made-up"]).status, 2);
    assert.equal(ledger(["parent-exception", p, "script-error", "--source", "cron"]).status, 2);
    assert.equal(readFileSync(p, "utf-8"), before);
  });

  test("FIFO cap of 200 keeps the newest entries", () => {
    const seed = Array.from({ length: 200 }, (_, i) => ({ cause: "script-error", turn: 1, source: "parent", detail: `old-${i}`, ts_epoch: 1 }));
    const p = stateFile({ turn: 9, parent_exceptions: seed });
    assert.equal(ledger(["parent-exception", p, "notes-steer", "--detail", "new"]).status, 0);
    const got = entries(p);
    assert.equal(got.length, 200);
    assert.equal(got[0].detail, "old-1");
    assert.equal(got[199].detail, "new");
  });
});

describe("turn.sh journals its own exceptions, best-effort (#5323)", () => {
  function sandboxTurn(state: Record<string, unknown>, extra: Record<string, string> = {}) {
    const dir = tmp();
    const sb = {
      state: join(dir, "state.json"), plan: join(dir, "plan.json"), events: join(dir, "events.json"), cands: join(dir, "cands.json"),
    };
    writeFileSync(sb.state, JSON.stringify(state));
    const r = spawnSync("bash", [TURN], {
      cwd: dir,
      encoding: "utf-8",
      env: {
        ...process.env,
        HYDRA_AUTOPILOT_STATE: sb.state, HYDRA_AUTOPILOT_PLAN: sb.plan, HYDRA_AUTOPILOT_EVENTS: sb.events,
        HYDRA_AUTOPILOT_CANDIDATES: sb.cands, HYDRA_AUTOPILOT_SNAPSHOT: join(dir, "snapshot.json"),
        HYDRA_AUTOPILOT_SNAPSHOT_REPLAY: SNAPSHOT_FIXTURE, HYDRA_AUTOPILOT_LOG: join(dir, "nightly.log"), ...extra,
      },
    });
    return { sb, r, doc: () => JSON.parse(readFileSync(sb.state, "utf-8")) };
  }
  const turnState = () => baseState({ slots: { dev_orch: null, qa_orch: null }, last_dispatch_by_class: {}, slot_events_last_id: "0-0", usage_eligibility: { allow: true } });

  test("assert_invariants rejection -> invariant-reject (first stderr line), exit stays 1", () => {
    const st = turnState();
    st.reaped_task_ids = ["dup1"];
    const dir = tmp();
    writeFileSync(join(dir, "events.json"), JSON.stringify([{ type: "completion", slot: "dev_orch", task_id: "dup1", total_tokens: 1 }]));
    const { r, doc } = sandboxTurn(st, { HYDRA_AUTOPILOT_EVENTS: join(dir, "events.json") });
    assert.equal(r.status, 1, r.stderr);
    const [e] = doc().parent_exceptions;
    assert.equal(e.cause, "invariant-reject");
    assert.equal(e.source, "turn.sh");
    assert.match(e.detail, /INV-004/);
  });

  test("decide.py failure -> script-error `decide:<rc>`, exit code unchanged", () => {
    const dir = tmp();
    writeFileSync(join(dir, "cands.json"), "{not json\n");
    const { r, doc } = sandboxTurn(turnState(), { HYDRA_AUTOPILOT_CANDIDATES: join(dir, "cands.json") });
    assert.notEqual(r.status, 0);
    const [e] = doc().parent_exceptions;
    assert.equal(e.cause, "script-error");
    assert.match(e.detail, /^decide:\d+$/);
  });

  test("a clean turn journals nothing", () => {
    const { r, doc } = sandboxTurn(turnState());
    assert.equal(r.status, 0, r.stderr);
    assert.equal(doc().parent_exceptions, undefined);
  });
});

describe("reap.py reports the instant-death notice (#5323)", () => {
  async function withServer(fn: (base: string, bodies: any[]) => Promise<void>) {
    const bodies: any[] = [];
    const server = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => { bodies.push({ url: req.url, body: JSON.parse(b || "{}") }); res.end("{}"); });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    try {
      await fn(`http://127.0.0.1:${(server.address() as any).port}`, bodies);
    } finally {
      server.close();
    }
  }
  const run = (base: string, flags: string[]) => {
    const dir = tmp();
    const s = join(dir, "state.json");
    writeFileSync(s, JSON.stringify(baseState({ slots: { dev_target: null } })));
    return new Promise<number | null>((done) => {
      import("node:child_process").then(({ spawn }) => {
        const c = spawn("python3", [REAP, "completion", "dev_target", "abc123", "0", "hydra-target-build", ...flags], {
          env: { ...process.env, HYDRA_AUTOPILOT_STATE: s, HYDRA_API_BASE: base, HYDRA_AUTOPILOT_LOG: join(dir, "log") },
          stdio: "ignore",
        });
        c.on("close", (code) => done(code));
      });
    });
  };

  test("POSTs {line, model} to /api/usage/session-block and never changes the exit code", async () => {
    await withServer(async (base, bodies) => {
      assert.equal(await run(base, ["--notice", "You're out of usage credits.", "--dispatch-model", "fable"]), 0);
      const hit = bodies.find((b) => b.url === "/api/usage/session-block");
      assert.deepEqual(hit.body, { line: "You're out of usage credits.", model: "fable" });
    });
  });

  test("no notice -> no POST; unreachable API -> still exit 0", async () => {
    await withServer(async (base, bodies) => {
      await run(base, []);
      assert.equal(bodies.filter((b) => b.url === "/api/usage/session-block").length, 0);
    });
    assert.equal(await run("http://127.0.0.1:1", ["--notice", "x"]), 0);
  });
});

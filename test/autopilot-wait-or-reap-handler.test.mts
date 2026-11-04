/**
 * Issue #5282 — the `wait_or_reap` action has a handler: a playbook row that
 * runs `reap.py wait-or-reap <slot> <task_id>` (transcript-mtime liveness,
 * final-usage token read, reap through run_completion).
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, utimesSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const REAP = join(REPO_ROOT, "scripts", "autopilot", "reap.py");
const DECIDE = join(REPO_ROOT, "scripts", "autopilot", "decide.py");
const PLAYBOOK = join(REPO_ROOT, "docs", "operator-playbooks", "hydra-autopilot.md");
const DEAD_API_BASE = "http://127.0.0.1:1";
const TASK = "a5282deadbeef0001";

function setup(opts: { transcript?: { ageSec: number }; slotAgeSec?: number }) {
  const dir = mkdtempSync(join(tmpdir(), "wait-or-reap-"));
  const state = join(dir, "state.json");
  const log = join(dir, "nightly.log");
  const projects = join(dir, "projects");
  writeFileSync(
    state,
    JSON.stringify({
      started_epoch: Math.floor(Date.now() / 1000),
      limits: { token_budget: 2_000_000, subagent_max_tokens: 400_000, subagent_hard_max_tokens: 800_000 },
      cumulative_tokens: 0,
      dispatches: 1,
      burned_classes: [],
      reaped_task_ids: [],
      slots: {
        dev_orch: {
          skill: "hydra-dev",
          task_id: TASK,
          started: "now",
          ...(opts.slotAgeSec !== undefined ? { started_epoch: Math.floor(Date.now() / 1000) - opts.slotAgeSec } : {}),
        },
        qa_orch: null,
      },
      signal_last_fired: {},
      failure_log: [],
    }),
  );
  if (opts.transcript) {
    const sub = join(projects, "-home-x", "sess-uuid", "subagents");
    mkdirSync(sub, { recursive: true });
    const f = join(sub, `agent-${TASK}.jsonl`);
    const usage = (i: number, o: number, cr: number, cc: number) =>
      JSON.stringify({
        message: {
          id: `m${o}`,
          usage: { input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cc },
        },
      });
    writeFileSync(f, [usage(10, 20, 1000, 500), "not json {", usage(7, 30, 4000, 100)].join("\n") + "\n");
    const t = Date.now() / 1000 - opts.transcript.ageSec;
    utimesSync(f, t, t);
  }
  return { dir, state, log, projects };
}

function run(env: { state: string; log: string; projects: string }, args: string[]) {
  const r = spawnSync(REAP, args, {
    env: {
      ...process.env,
      HYDRA_API_BASE: DEAD_API_BASE,
      HYDRA_BASE_URL: DEAD_API_BASE,
      HYDRA_AUTOPILOT_STATE: env.state,
      HYDRA_AUTOPILOT_LOG: env.log,
      HYDRA_CLAUDE_PROJECTS_ROOT: env.projects,
      HYDRA_AUTOPILOT_REPO: "hydra-test/nonexistent-fixture",
      GH_TOKEN: "invalid-test-token",
      HYDRA_REAP_WORKTREE_GC: "0",
      HYDRA_AUTOPILOT_REDIS_CLI: "true",
      HYDRA_AUTOPILOT_GH_CLI: "false",
    },
    encoding: "utf-8",
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const readState = (p: string) => JSON.parse(readFileSync(p, "utf8"));

describe("reap.py wait-or-reap (issue #5282)", () => {
  test("fresh transcript mtime: verdict=live and state is unchanged", () => {
    const e = setup({ transcript: { ageSec: 30 } });
    const before = readFileSync(e.state, "utf8");
    const r = run(e, ["wait-or-reap", "dev_orch", TASK]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /wait_or_reap verdict=live slot=dev_orch task_id=a5282deadbeef0001 transcript_age_s=\d+/);
    assert.equal(readFileSync(e.state, "utf8"), before);
  });

  test("stale transcript mtime: verdict=reaped with the last usage line's context total", () => {
    const e = setup({ transcript: { ageSec: 5000 } });
    const r = run(e, ["wait-or-reap", "dev_orch", TASK]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /verdict=reaped slot=dev_orch .*tokens=4137 token_source=transcript-final-usage/);
    const s = readState(e.state);
    assert.equal(s.slots.dev_orch, null);
    assert.equal(s.cumulative_tokens, 4137);
    assert.ok(s.reaped_task_ids.includes(TASK));
  });

  test("missing transcript: verdict=reaped with tokens=0 and token_source=unknown", () => {
    const e = setup({});
    const r = run(e, ["wait-or-reap", "dev_orch", TASK]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /transcript_age_s=missing tokens=0 token_source=unknown/);
    assert.equal(readState(e.state).slots.dev_orch, null);
  });

  test("transcript with no readable usage line: tokens=0 with distinct token_source=transcript-no-usage", () => {
    const e = setup({ transcript: { ageSec: 5000 } });
    const f = join(e.projects, "-home-x", "sess-uuid", "subagents", `agent-${TASK}.jsonl`);
    writeFileSync(f, "not json {\n");
    const t = Date.now() / 1000 - 5000;
    utimesSync(f, t, t);
    const r = run(e, ["wait-or-reap", "dev_orch", TASK]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /verdict=reaped .*tokens=0 token_source=transcript-no-usage/);
    assert.equal(readState(e.state).slots.dev_orch, null);
  });

  test("stat() failure on a found transcript past the wedge threshold: bounded, falls through to DEAD and reaps", () => {
    const e = setup({ slotAgeSec: 7200 });
    const sub = join(e.projects, "-home-x", "sess-uuid", "subagents");
    mkdirSync(sub, { recursive: true });
    symlinkSync(join(e.dir, "does-not-exist"), join(sub, `agent-${TASK}.jsonl`));
    const r = run(e, ["wait-or-reap", "dev_orch", TASK]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /verdict=reaped slot=dev_orch/);
    assert.equal(readState(e.state).slots.dev_orch, null);
  });

  test("stat() failure on a found transcript, young slot: verdict=unknown, nothing reaped", () => {
    const e = setup({ slotAgeSec: 60 });
    const sub = join(e.projects, "-home-x", "sess-uuid", "subagents");
    mkdirSync(sub, { recursive: true });
    symlinkSync(join(e.dir, "does-not-exist"), join(sub, `agent-${TASK}.jsonl`));
    const before = readFileSync(e.state, "utf8");
    const r = run(e, ["wait-or-reap", "dev_orch", TASK]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /verdict=unknown .*reason=stat-failed/);
    assert.equal(readFileSync(e.state, "utf8"), before);
  });

  test("stat() failure on a found transcript: verdict=unknown, nothing reaped", () => {
    const e = setup({});
    const sub = join(e.projects, "-home-x", "sess-uuid", "subagents");
    mkdirSync(sub, { recursive: true });
    symlinkSync(join(e.dir, "does-not-exist"), join(sub, `agent-${TASK}.jsonl`));
    const before = readFileSync(e.state, "utf8");
    const r = run(e, ["wait-or-reap", "dev_orch", TASK]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /verdict=unknown .*reason=stat-failed/);
    assert.equal(readFileSync(e.state, "utf8"), before);
  });

  test("glob metacharacters in task_id are rejected without touching state", () => {
    const e = setup({ transcript: { ageSec: 5000 } });
    const before = readFileSync(e.state, "utf8");
    const r = run(e, ["wait-or-reap", "dev_orch", "a*"]);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /invalid task_id/);
    assert.equal(readFileSync(e.state, "utf8"), before);
  });

  test("a second call for the same task_id is a dup_skip and leaves cumulative_tokens alone", () => {
    const e = setup({ transcript: { ageSec: 5000 } });
    run(e, ["wait-or-reap", "dev_orch", TASK]);
    const after = readState(e.state).cumulative_tokens;
    const r = run(e, ["wait-or-reap", "dev_orch", TASK]);
    assert.equal(r.status, 0);
    assert.match(readFileSync(e.log, "utf8"), /dup_skip task_id=a5282deadbeef0001/);
    assert.equal(readState(e.state).cumulative_tokens, after);
  });

  test("wrong arg count exits 0 with a usage line", () => {
    const e = setup({});
    const r = run(e, ["wait-or-reap", "dev_orch"]);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /wait-or-reap usage/);
  });
});

describe("wait_or_reap contract coverage (issue #5282)", () => {
  test("every decide.py action type has its own action-table row", () => {
    const smoke = spawnSync("python3", [DECIDE, "smoke"], { encoding: "utf-8" });
    const types: string[] = JSON.parse(smoke.stdout.split("\n")[0]).action_types;
    assert.equal(types.length, 11);
    const rows = readFileSync(PLAYBOOK, "utf8").split("\n");
    for (const t of types) {
      assert.ok(
        rows.some((l) => l.startsWith(`| \`${t}\` |`)),
        `hydra-autopilot.md action-to-tool table has no row for action type ${t}`,
      );
    }
  });

  test("the wait_or_reap row runs reap.py wait-or-reap and the wait row no longer names it", () => {
    const rows = readFileSync(PLAYBOOK, "utf8").split("\n");
    const row = rows.find((l) => l.startsWith("| `wait_or_reap` |")) ?? "";
    assert.match(row, /reap\.py wait-or-reap <slot> <task_id>/);
    const wait = rows.find((l) => l.startsWith("| `wait` |")) ?? "";
    assert.ok(!wait.includes("wait_or_reap"));
  });

  test("the false 'harness translates' text is gone", () => {
    for (const rel of [
      "scripts/autopilot/decide.py",
      "scripts/autopilot/reap.py",
      "docs/operator-playbooks/_fragments/hydra-autopilot-ops-reference.md",
    ]) {
      assert.ok(!readFileSync(join(REPO_ROOT, rel), "utf8").includes("harness translates"), rel);
    }
  });
});

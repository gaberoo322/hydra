/**
 * Autopilot adopts the dispatcher-claim seam (ADR-0047 D4/D7, issue #5418).
 *
 * Pins, with `subprocess.run` monkeypatched to capture argv:
 *   - stamp-slot `claim <slot>`: argv for pinned Fresh / ForwardFixRed /
 *     ResumeSalvage, the skip set, the exit contract, state.json untouched;
 *   - reap: `_release_dispatch_claim` argv / outcome mapping / never-raises,
 *     the snapshot's dispatch_id recovery chain;
 *   - playbooks: workers never write `in-progress`, hydra-qa claims at pick,
 *     the autopilot dispatch row names `stamp-slot.py claim`.
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, chmodSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const AUTOPILOT = join(REPO_ROOT, "scripts", "autopilot");

function py(code: string, env: Record<string, string> = {}): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("python3", ["-I", "-c", code], {
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const STAMP_LOAD = `
import importlib.util, json, os, sys
sys.path.insert(0, os.environ["AUTOPILOT"])
spec = importlib.util.spec_from_file_location("stamp_slot_u", os.path.join(os.environ["AUTOPILOT"], "stamp-slot.py"))
ss = importlib.util.module_from_spec(spec)
sys.modules["stamp_slot_u"] = ss
spec.loader.exec_module(ss)
`;

const STAMP_PROBE = `${STAMP_LOAD}
calls = []
class CP:
    def __init__(self, rc, out): self.returncode = rc; self.stdout = out; self.stderr = ""
canned = json.loads(os.environ["CANNED"])
def fake_run(argv, **kw):
    calls.append(argv)
    return CP(canned["rc"], canned["out"])
ss.subprocess.run = fake_run
state = json.loads(os.environ["STATE"])
plan = json.loads(os.environ["PLAN"])
before = json.dumps(state, sort_keys=True)
rc = ss.claim(state, plan, os.environ["SLOT"])
print(json.dumps({"rc": rc, "calls": calls, "untouched": before == json.dumps(state, sort_keys=True)}))
`;

function claim(slot: string, intent: unknown | null, canned = { rc: 0, out: '{"ok":true}' }) {
  const state = {
    run_id: "abcdef12-0000",
    turn: 3,
    slots: { dev_orch: null, qa_orch: null, dev_target: null },
  };
  const action: Record<string, unknown> = { type: "dispatch", slot, worktreeBranch: `worktree-agent-abcdef12-t3-${slot}` };
  if (intent) action.intent = intent;
  const r = py(STAMP_PROBE, {
    AUTOPILOT,
    CANNED: JSON.stringify(canned),
    STATE: JSON.stringify(state),
    PLAN: JSON.stringify({ actions: [action] }),
    SLOT: slot,
  });
  assert.equal(r.status, 0, `probe failed: ${r.stderr}`);
  const lines = r.stdout.trim().split("\n");
  return JSON.parse(lines[lines.length - 1]) as { rc: number; calls: string[][]; untouched: boolean };
}

describe("stamp-slot claim mode", () => {
  test("pinned Fresh dev_orch runs lifecycle dispatch with the worktree branch as dispatch id", () => {
    const out = claim("dev_orch", { kind: "Fresh", anchor: "issue-77" });
    assert.equal(out.rc, 0);
    assert.deepEqual(out.calls, [
      [
        "npx", "tsx", "scripts/lifecycle.ts", "dispatch", "77",
        "--dispatch", "worktree-agent-abcdef12-t3-dev_orch", "--class", "dev_orch",
        "--run", "abcdef12-0000", "--actor", "autopilot", "--purpose", "fresh",
      ],
    ]);
    assert.equal(out.untouched, true);
  });

  test("ForwardFixRed carries --pr and the forward-fix purpose", () => {
    const out = claim("dev_orch", { kind: "ForwardFixRed", anchor: "issue-8", pr: 9, branch: "b" });
    assert.equal(out.rc, 0);
    const argv = out.calls[0];
    assert.ok(argv.join(" ").includes("--pr 9 --purpose forward-fix"), argv.join(" "));
  });

  test("ResumeSalvage uses the resume purpose", () => {
    const out = claim("dev_orch", { kind: "ResumeSalvage", anchor: "issue-8" });
    assert.ok(out.calls[0].join(" ").endsWith("--purpose resume"));
  });

  test("unpinned Fresh, qa_orch ReviewLane, dev_target and a signal slot skip with zero subprocess calls", () => {
    const cases: [string, unknown][] = [
      ["dev_orch", { kind: "Fresh" }],
      ["qa_orch", { kind: "ReviewLane", anchor: "issue-5", pr: 5, rest: [] }],
      ["dev_target", { kind: "TargetFresh", anchor: "issue-5" }],
      ["health", null],
    ];
    for (const [slot, intent] of cases) {
      const out = claim(slot, intent);
      assert.equal(out.rc, 0, slot);
      assert.deepEqual(out.calls, [], `${slot} must not spawn a subprocess`);
    }
  });

  test("a seam refusal exits 1 and leaves state byte-identical", () => {
    const out = claim("dev_orch", { kind: "Fresh", anchor: "issue-77" }, { rc: 1, out: '{"ok":false,"code":"claim-held"}' });
    assert.equal(out.rc, 1);
    assert.equal(out.untouched, true);
  });

  test("a plan without a dispatch action for the slot exits 1 (not a skip)", () => {
    const r = py(STAMP_PROBE, {
      AUTOPILOT, CANNED: '{"rc":0,"out":""}', STATE: '{"slots":{"dev_orch":null}}', PLAN: '{"actions":[]}', SLOT: "dev_orch",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout.trim().split("\n").pop() as string).rc, 1);
  });

  test("a hung or unrunnable claim subprocess fails closed (exit 1, claim-error)", () => {
    const r = py(
      STAMP_PROBE.replace("ss.subprocess.run = fake_run", "def fake_run(argv, **kw):\n    raise ss.subprocess.TimeoutExpired(argv, 60)\nss.subprocess.run = fake_run"),
      {
        AUTOPILOT, CANNED: "{}", SLOT: "dev_orch",
        STATE: JSON.stringify({ run_id: "abcdef12", turn: 1, slots: { dev_orch: null } }),
        PLAN: JSON.stringify({ actions: [{ type: "dispatch", slot: "dev_orch", intent: { kind: "Fresh", anchor: "issue-7" } }] }),
      },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /"code": "claim-error"/);
    assert.equal(JSON.parse(r.stdout.trim().split("\n").pop() as string).rc, 1);
  });

  test("garbage stdout on a nonzero claim exit still refuses (exit 1)", () => {
    const out = claim("dev_orch", { kind: "Fresh", anchor: "issue-77" }, { rc: 1, out: "not json at all" });
    assert.equal(out.rc, 1);
    assert.equal(out.untouched, true);
  });

  test("main(): unreadable plan/state exits 2 (script-error), not a refusal", () => {
    const r = py(`${STAMP_LOAD}\nprint(ss.main(["stamp-slot.py", "claim", "dev_orch"]))`, {
      AUTOPILOT, HYDRA_AUTOPILOT_PLAN: "/nonexistent/plan.json", HYDRA_AUTOPILOT_STATE: "/nonexistent/state.json",
    });
    assert.equal(r.stdout.trim().split("\n").pop(), "2", r.stderr);
  });

  test("the claim --dispatch id equals the stamped slot dispatch_id, with and without worktreeBranch", () => {
    const code = `${STAMP_LOAD}
state = {"run_id": "abcdef12-0000", "turn": 3}
out = []
for extra in ({}, {"worktreeBranch": "worktree-agent-given"}):
    action = {"type": "dispatch", "slot": "dev_orch", "intent": {"kind": "Fresh", "anchor": "issue-7"}, **extra}
    argv = ss.build_claim_argv(state, action, "dev_orch")
    rec = ss.build_slot(action, "t", "sonnet", "abcdef12-0000", 3, 0)
    out.append([argv[argv.index("--dispatch") + 1], rec["dispatch_id"]])
print(json.dumps(out))
`;
    const r = py(code, { AUTOPILOT });
    assert.equal(r.status, 0, r.stderr);
    const pairs = JSON.parse(r.stdout.trim().split("\n").pop() as string) as string[][];
    for (const [claimId, slotId] of pairs) assert.equal(claimId, slotId);
    assert.equal(pairs[0][0], "worktree-agent-abcdef12-t3-dev_orch");
    assert.equal(pairs[1][0], "worktree-agent-given");
  });

  test("_is_dev_role agrees with src/lifecycle classRole for every classes.json slot (drift guard)", async () => {
    // Loaded by computed path: this file's subject is the autopilot scripts, so a
    // static import would count it as a second test file for caps.ts (#4134 ratchet).
    const { classRole } = (await import(join(REPO_ROOT, "src", "lifecycle", "caps.ts"))) as { classRole: (c: string) => string };
    const classes = (JSON.parse(readFileSync(join(AUTOPILOT, "classes.json"), "utf-8")) as { classes: { name: string }[] }).classes.map((c) => c.name);
    const names = [...classes, "glm-dev", "glm_orch", "dev_future", "qa_future", "other_thing"];
    const r = py(`${STAMP_LOAD}\nprint(json.dumps({n: ss._is_dev_role(n) for n in json.loads(os.environ["NAMES"])}))`, {
      AUTOPILOT, NAMES: JSON.stringify(names),
    });
    assert.equal(r.status, 0, r.stderr);
    const got = JSON.parse(r.stdout.trim().split("\n").pop() as string) as Record<string, boolean>;
    for (const n of names) assert.equal(got[n], classRole(n) === "dev", `${n} drifted from classRole`);
    assert.equal(got["dev_orch"], true);
    assert.equal(got["qa_orch"], false);
  });
});

const REAP_PROBE = `
import importlib.util, json, os, sys
sys.path.insert(0, os.environ["AUTOPILOT"])
spec = importlib.util.spec_from_file_location("reap_u", os.path.join(os.environ["AUTOPILOT"], "reap.py"))
reap = importlib.util.module_from_spec(spec)
sys.modules["reap_u"] = reap
spec.loader.exec_module(reap)
logs = []
reap._append_log = logs.append
calls = []
class CP:
    def __init__(self, rc, out): self.returncode = rc; self.stdout = out; self.stderr = ""
mode = os.environ["MODE"]
def fake_run(argv, **kw):
    calls.append(argv)
    if mode == "raise": raise OSError("boom")
    return CP(0, '{"ok":true,"prior":null}')
reap.subprocess.run = fake_run
cls = os.environ["CLS"]
pr = {"true": True, "false": False, "none": None}[os.environ["PR"]]
reap._release_dispatch_claim(cls, os.environ.get("DID") or None, reap._claim_release_outcome(cls, pr))
print(json.dumps({"calls": calls, "logs": logs}))
`;

function release(cls: string, pr: string, did = "worktree-agent-x-t1-" + cls, mode = "ok") {
  const r = py(REAP_PROBE, { AUTOPILOT, CLS: cls, PR: pr, DID: did, MODE: mode, HYDRA_AUTOPILOT_LOG: "/dev/null" });
  assert.equal(r.status, 0, `probe failed: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split("\n").pop() as string) as { calls: string[][]; logs: string[] };
}

describe("reap releases the dispatcher claim by dispatch id", () => {
  test("dev_orch maps PR evidence to pr-opened / no-pr / released", () => {
    const outcomes = (pr: string) => release("dev_orch", pr).calls[0].join(" ");
    assert.ok(outcomes("true").includes("release --dispatch worktree-agent-x-t1-dev_orch --outcome pr-opened --actor reap"));
    assert.ok(outcomes("false").includes("--outcome no-pr"));
    assert.ok(outcomes("none").includes("--outcome released"));
  });

  test("qa_orch releases with verdict-posted", () => {
    assert.ok(release("qa_orch", "none").calls[0].join(" ").includes("--outcome verdict-posted"));
  });

  test("dev_target and a missing dispatch id release nothing", () => {
    assert.deepEqual(release("dev_target", "true").calls, []);
    assert.deepEqual(release("dev_orch", "true", "").calls, []);
  });

  test("a raising subprocess is logged, never propagated", () => {
    const out = release("dev_orch", "true", "worktree-agent-x-t1-dev_orch", "raise");
    assert.equal(out.logs.length, 1);
    assert.match(out.logs[0], /claim_release .*result=error:OSError/);
  });

  test("the completion snapshot recovers dispatch_id: slot dispatch_id, then slot branch", () => {
    const code = `
import importlib.util, json, os, sys
sys.path.insert(0, os.environ["AUTOPILOT"])
spec = importlib.util.spec_from_file_location("reap_u", os.path.join(os.environ["AUTOPILOT"], "reap.py"))
reap = importlib.util.module_from_spec(spec)
sys.modules["reap_u"] = reap
spec.loader.exec_module(reap)
a = reap._snapshot_completion_slot({"slots": {"dev_orch": {"dispatch_id": "D1", "branch": "B1", "anchor": "issue-1"}}}, "dev_orch", "t")
b = reap._snapshot_completion_slot({"slots": {"dev_orch": {"branch": "B2", "anchor": "issue-1"}}}, "dev_orch", "t")
print(json.dumps([a.dispatch_id, b.dispatch_id]))
`;
    const r = py(code, { AUTOPILOT });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout.trim().split("\n").pop() as string), ["D1", "B2"]);
  });

});

describe("reap run_completion wires the claim release (INV-10/12)", () => {
  function runReap(opts: { slot: Record<string, unknown> | null; prList: string; npxExit: number; npxOut: string }) {
    const dir = mkdtempSync(join(tmpdir(), "reap-claim-release-"));
    try {
      const npxLog = join(dir, "npx.log");
      const bin = join(dir, "bin");
      const gh = join(dir, "gh.sh");
      writeFileSync(gh, `#!/usr/bin/env bash\nif [ "$1 $2" = "pr list" ]; then printf '%s' "$STUB_PR_LIST"; fi\nexit 0\n`);
      chmodSync(gh, 0o755);
      mkdirSync(bin);
      writeFileSync(join(bin, "npx"), `#!/usr/bin/env bash\necho "$*" >> "${npxLog}"\nprintf '%s' "$NPX_OUT"\nexit ${opts.npxExit}\n`);
      chmodSync(join(bin, "npx"), 0o755);
      const state = join(dir, "state.json");
      writeFileSync(state, JSON.stringify({
        started_epoch: Math.floor(Date.now() / 1000),
        limits: { token_budget: 2_000_000, subagent_max_tokens: 400_000, subagent_hard_max_tokens: 800_000 },
        cumulative_tokens: 0, dispatches: 0, idle_turns: 0, burned_classes: [], reaped_task_ids: [],
        slots: { dev_orch: opts.slot, qa_orch: null, research_orch: null, dev_target: null, qa_target: null, research_target: null },
        signal_last_fired: {}, failure_log: [],
      }));
      const r = spawnSync("python3", [join(AUTOPILOT, "reap.py"), "completion", "dev_orch", "t1", "50000", "hydra-dev"], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          HYDRA_API_BASE: "http://127.0.0.1:1", HYDRA_BASE_URL: "http://127.0.0.1:1",
          HYDRA_AUTOPILOT_STATE: state, HYDRA_AUTOPILOT_LOG: join(dir, "run.log"),
          HYDRA_AUTOPILOT_REPO: "hydra-test/nonexistent-fixture", HYDRA_REAP_WORKTREE_GC: "0",
          HYDRA_AUTOPILOT_GH_CLI: gh, HYDRA_AUTOPILOT_REDIS_CLI: "true",
          STUB_PR_LIST: opts.prList, NPX_OUT: opts.npxOut,
        },
        encoding: "utf-8",
      });
      const log = existsSync(join(dir, "run.log")) ? readFileSync(join(dir, "run.log"), "utf-8") : "";
      const calls = existsSync(npxLog) ? readFileSync(npxLog, "utf-8").trim().split("\n").filter(Boolean) : [];
      return { status: r.status ?? -1, stderr: r.stderr ?? "", log, calls };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const slot = { skill: "hydra-dev", started_epoch: Math.floor(Date.now() / 1000) - 600, task_id: "t1", anchor: "issue-4001", dispatch_id: "did-1", branch: "did-1" };

  test("an occupied slot with a PR for the anchor releases by dispatch id with pr-opened, exit 0", () => {
    const r = runReap({
      slot, npxExit: 0, npxOut: '{"ok":true,"prior":{"state":"in-progress"}}',
      prList: JSON.stringify([{ headRefName: "issue-4001-fix", body: "Closes #4001" }]),
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.calls.length, 1, JSON.stringify(r.calls));
    assert.match(r.calls[0], /scripts\/lifecycle\.ts release --dispatch did-1 --outcome pr-opened --actor reap/);
    assert.match(r.log, /claim_release cls=dev_orch dispatch_id=did-1 outcome=pr-opened result=ok/);
  });

  test("no PR for the anchor releases with outcome no-pr", () => {
    const r = runReap({ slot, npxExit: 0, npxOut: '{"ok":true,"prior":null}', prList: "[]" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.calls[0] ?? "", /--outcome no-pr/);
    assert.match(r.log, /result=ok:no-claim/);
  });

  test("a slot-less completion (already cleared) releases nothing", () => {
    const r = runReap({ slot: null, npxExit: 0, npxOut: "{}", prList: "[]" });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.calls, []);
  });

  test("a failing release CLI is logged and reap still exits 0", () => {
    const r = runReap({ slot, npxExit: 1, npxOut: '{"ok":false,"code":"redis-failed"}', prList: "[]" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.log, /claim_release .*result=redis-failed/);
  });
});

describe("playbook pins", () => {
  const frag = (n: string) =>
    readFileSync(join(REPO_ROOT, "docs", "operator-playbooks", "_fragments", n), "utf-8");

  test("neither hydra-dev fragment writes in-progress directly", () => {
    for (const n of ["hydra-dev-parent-flow.md", "hydra-dev-child-flow.md"]) {
      assert.doesNotMatch(frag(n), /--add-label[ =]+["']?in-progress/, n);
    }
  });

  test("hydra-qa claims at pick time as qa_orch", () => {
    const qa = readFileSync(join(REPO_ROOT, "docs", "operator-playbooks", "hydra-qa.md"), "utf-8");
    assert.match(qa, /lifecycle\.ts dispatch .*--class qa_orch/);
  });

  test("the autopilot dispatch row names stamp-slot.py claim", () => {
    const ap = readFileSync(join(REPO_ROOT, "docs", "operator-playbooks", "hydra-autopilot.md"), "utf-8");
    assert.ok(ap.includes("stamp-slot.py claim"));
  });
});

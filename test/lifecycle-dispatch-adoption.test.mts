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
import { readFileSync } from "node:fs";
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

const STAMP_PROBE = `
import importlib.util, json, os, sys
sys.path.insert(0, os.environ["AUTOPILOT"])
spec = importlib.util.spec_from_file_location("stamp_slot_u", os.path.join(os.environ["AUTOPILOT"], "stamp-slot.py"))
ss = importlib.util.module_from_spec(spec)
sys.modules["stamp_slot_u"] = ss
spec.loader.exec_module(ss)
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
    const r = py(
      STAMP_PROBE.replace('os.environ["SLOT"])\nprint', '"dev_orch")\nprint'),
      { AUTOPILOT, CANNED: '{"rc":0,"out":""}', STATE: '{"slots":{"dev_orch":null}}', PLAN: '{"actions":[]}', SLOT: "dev_orch" },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout.trim().split("\n").pop() as string).rc, 1);
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

  test("run_completion releases only after the accounting writes and only for an occupied slot", () => {
    const src = readFileSync(join(AUTOPILOT, "reap.py"), "utf-8");
    const release = src.indexOf("_release_dispatch_claim(cls, snap.dispatch_id");
    assert.ok(release > src.indexOf("pr_exists = _dev_orch_pr_exists_for_anchor(snap.anchor_ref, dev_target_pr_list_json)"));
    assert.ok(release < src.indexOf("_fire_reflection_for_completion(\n        s, snap.anchor_ref"));
    assert.match(src.slice(release - 80, release), /if snap\.slot_occupied:/);
  });
});

describe("playbook pins", () => {
  const frag = (n: string) =>
    readFileSync(join(REPO_ROOT, "docs", "operator-playbooks", "_fragments", n), "utf-8");

  test("neither hydra-dev fragment writes in-progress directly", () => {
    for (const n of ["hydra-dev-parent-flow.md", "hydra-dev-child-flow.md"]) {
      assert.ok(!frag(n).includes("--add-label in-progress"), n);
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

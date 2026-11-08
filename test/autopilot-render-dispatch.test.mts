/**
 * scripts/autopilot/render-dispatch.py — the dispatch prompt + model, rendered
 * from the plan action (issue #4833).
 *
 * Every `Agent(...)` dispatch prompt used to be hand-authored by the autopilot
 * session: 561 prompts × ~3.4k chars in 14 days (≈472k output tokens, 41% of
 * all parent output), ~80% of it the SAME preamble blocks the playbook already
 * pins as fences. This file pins the renderer's contract:
 *
 *   - the worktree-guard block and the forbidden-ending block in a rendered
 *     prompt are byte-identical to the playbook / fragment fences (the
 *     renderer READS them — there is no second copy), exactly one of each,
 *     and never the default guard composed with the self-isolation variant;
 *   - the class → forbidden-ending selection (dev_orch flat ban, dev_target
 *     delegated-mode variant, qa_orch blocking-fan-out variant, the short
 *     generic block for everything else);
 *   - the self-isolation line (`Use CYCLE_ID=…`, and `TARGET_WT_BASE` for a
 *     pinned qa_target);
 *   - every mandatory prompt_args-driven sentence in `## Task` (pinned anchor,
 *     resume + branch, the GLM forward-fix contract, `pr_ref`, the wayfinder
 *     claim + resolution protocol + ticket-type skill override, `apply: true`),
 *     and the dispatcher's notes appended verbatim;
 *   - model resolution: the classes.json `model` column (#4592 — the playbook
 *     routing table became a pointer to it) → `escalate_model` → the Fable
 *     out-of-credits pre-resolution (#4585), `inherit` → null, an unmapped
 *     class → null; the column covers every taxonomy class;
 *   - the CLI's exit codes, `--prompt-only`, `--notes-file` / `--notes -`.
 *
 * It references no other scripts/autopilot/ target on purpose — the
 * test-subject sprawl ratchet (test/fixtures/test-subject-baseline.json)
 * resolves it to render-dispatch.py alone.
 */
import test, { describe, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { withTurnSnapshot } from "./_helpers/turn-snapshot-state.mts";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "autopilot", "render-dispatch.py");
const PLAYBOOK = readFileSync(join(REPO_ROOT, "docs", "operator-playbooks", "hydra-autopilot.md"), "utf-8");
const FRAGMENT = readFileSync(
  join(REPO_ROOT, "docs", "operator-playbooks", "_fragments", "target-self-isolation-preamble.md"),
  "utf-8",
);
const TAXONOMY = JSON.parse(readFileSync(join(REPO_ROOT, "scripts", "autopilot", "classes.json"), "utf-8"))
  .classes as { name: string; model: string }[];
const CLASSES: string[] = TAXONOMY.map((c) => c.name);

/** Bodies of every ``` fence, in order — the same walk the renderer does. */
function fences(text: string): string[] {
  const out: string[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("```")) continue;
    let j = i + 1;
    while (j < lines.length && !lines[j].startsWith("```")) j++;
    out.push(lines.slice(i + 1, j).join("\n"));
    i = j;
  }
  return out;
}
const firstLine = (s: string) => s.split("\n")[0];
const DEFAULT_GUARD = fences(PLAYBOOK).find((f) => firstLine(f) === "## CRITICAL SAFETY RULE — READ FIRST")!;
const SELF_GUARD = fences(FRAGMENT).find((f) => firstLine(f).startsWith("## CRITICAL SAFETY RULE — READ FIRST (self-isolation variant"))!;
const NEVER = fences(PLAYBOOK).filter((f) => firstLine(f).startsWith("## NEVER END WAITING"));
const NEVER_DEV_ORCH = NEVER.find((f) => !firstLine(f).includes("dev_target") && !firstLine(f).includes("qa_orch"))!;
const NEVER_DEV_TARGET = NEVER.find((f) => firstLine(f).includes("dev_target"))!;
const NEVER_QA_ORCH = NEVER.find((f) => firstLine(f).includes("qa_orch"))!;
assert.ok(DEFAULT_GUARD && SELF_GUARD && NEVER_DEV_ORCH && NEVER_DEV_TARGET && NEVER_QA_ORCH, "playbook fences present");

const RUN_ID = "4dfd1dc9-e7ae-4729-af27-ab7fac74ef29";

function baseState(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: RUN_ID,
    turn: 4,
    slots: { dev_orch: null, qa_orch: null, research_orch: null, dev_target: null, qa_target: null, research_target: null, design_concept_orch: null },
    signals: {
      needs_qa_numbers: "4700 4825 4821",
      target_needs_qa_pr_head: "feature/aeb984cb-t1-dev_target",
    },
    usage_eligibility: { allow: true, reasons: {} },
    ...extra,
  };
}

function action(slot: string, skill: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "dispatch",
    slot,
    skill,
    prompt_args: {},
    worktreeBranch: `worktree-agent-4dfd1dc9-t4-${slot}`,
    isolation: "worktree",
    dispatchSentinel: `<!-- hydra-dispatch v1 skill=${skill} dispatchId=worktree-agent-4dfd1dc9-t4-${slot} runId=${RUN_ID} -->`,
    ...extra,
  };
}

/** A dev_orch dispatch action carrying a typed Dispatch Intent and NO prompt_args key (#5381). */
function devAction(intent?: Record<string, unknown>): Record<string, unknown> {
  const a = action("dev_orch", "hydra-dev", { intent: intent ?? { kind: "Fresh" } });
  delete a.prompt_args;
  return a;
}

/** A qa_orch dispatch action carrying a typed Dispatch Intent and NO prompt_args key (#5382). */
function qaAction(intent?: Record<string, unknown>): Record<string, unknown> {
  const a = action("qa_orch", "hydra-qa", { intent: intent ?? { kind: "ReviewLane", anchor: "issue-4700", rest: ["issue-4825", "issue-4821"] } });
  delete a.prompt_args;
  return a;
}

/** A dev_target dispatch action carrying a typed Dispatch Intent and NO prompt_args key (#5383). */
function devTargetAction(intent?: Record<string, unknown>): Record<string, unknown> {
  const a = action("dev_target", "hydra-target-build", { isolation: "self", intent: intent ?? { kind: "TargetFresh" } });
  delete a.prompt_args;
  return a;
}

/** A qa_target dispatch action carrying a typed Dispatch Intent and NO prompt_args key (#5383). */
function qaTargetAction(intent?: Record<string, unknown>): Record<string, unknown> {
  const a = action("qa_target", "hydra-target-qa", { isolation: "self", intent: intent ?? { kind: "TargetReviewSelfSelect" } });
  delete a.prompt_args;
  return a;
}

/** A design_concept_orch dispatch action carrying a typed Dispatch Intent and NO prompt_args key (#5384). */
function designConceptAction(intent?: Record<string, unknown>): Record<string, unknown> {
  const a = action("design_concept_orch", "hydra-grill", { intent: intent ?? { kind: "Grill", anchor: "issue-4806" }, anchor: "issue-4806" });
  delete a.prompt_args;
  return a;
}

/** A wayfinder_orch dispatch action; `skill` is what decide.py step 7 resolved from the kind (#5384). */
function wayfinderAction(intent?: Record<string, unknown>): Record<string, unknown> {
  const i = intent ?? { kind: "WayfinderResearch", ticket: "issue-4706" };
  const a = action("wayfinder_orch", i.kind === "WayfinderTask" ? "hydra-dev" : "hydra-issue-research", { intent: i });
  delete a.prompt_args;
  return a;
}

/** A research_orch dispatch action carrying a typed Dispatch Intent (#5384). */
function researchOrchAction(intent?: Record<string, unknown>): Record<string, unknown> {
  const a = action("research_orch", "hydra-issue-research", { intent: intent ?? { kind: "ResearchNeeded" } });
  delete a.prompt_args;
  return a;
}

/** A research_target dispatch action carrying a typed Dispatch Intent (#5384). */
function researchTargetAction(intent?: Record<string, unknown>): Record<string, unknown> {
  const a = action("research_target", "hydra-target-research", { isolation: "self", intent: intent ?? { kind: "TargetResearchDue" } });
  delete a.prompt_args;
  return a;
}

/** The right action builder for a class: intent-bearing slots get an intent, the rest a plain action. */
function actionFor(cls: string): Record<string, unknown> {
  if (cls === "dev_orch") return devAction();
  if (cls === "qa_orch") return qaAction();
  if (cls === "dev_target") return devTargetAction();
  if (cls === "qa_target") return qaTargetAction();
  if (cls === "design_concept_orch") return designConceptAction();
  if (cls === "wayfinder_orch") return wayfinderAction();
  if (cls === "research_orch") return researchOrchAction();
  if (cls === "research_target") return researchTargetAction();
  return action(cls, "hydra-x");
}

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface Rendered {
  slot: string;
  skill: string | null;
  model: string | null;
  model_source: string;
  isolation: string | null;
  run_in_background: boolean;
  description: string;
  prompt: string;
}

function run(
  slot: string,
  actions: Record<string, unknown>[],
  state: Record<string, unknown> = baseState(),
  args: string[] = [],
  opts: { env?: Record<string, string>; input?: string } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "render-dispatch-"));
  dirs.push(dir);
  const statePath = join(dir, "state.json");
  const planPath = join(dir, "plan.json");
  writeFileSync(statePath, JSON.stringify(withTurnSnapshot(state)));
  writeFileSync(planPath, JSON.stringify({ turn: 4, run_id: RUN_ID, actions }));
  const r = spawnSync("python3", [SCRIPT, slot, ...args], {
    cwd: dir,
    encoding: "utf-8",
    input: opts.input,
    env: { ...process.env, HYDRA_AUTOPILOT_STATE: statePath, HYDRA_AUTOPILOT_PLAN: planPath, ...(opts.env ?? {}) },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", dir };
}

function render(slot: string, a: Record<string, unknown>, state?: Record<string, unknown>, env?: Record<string, string>): Rendered {
  const r = run(slot, [a], state, [], { env });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim());
}

const count = (hay: string, needle: string) => hay.split(needle).length - 1;

// ---------------------------------------------------------------------------
describe("render-dispatch.py — preamble blocks come from the playbook fences (issue #4833)", () => {
  test("dev_orch: sentinel, the default guard, the dev_orch flat-ban block — each verbatim, once", () => {
    const a = devAction();
    const out = render("dev_orch", a);
    assert.ok(out.prompt.startsWith(`${a.dispatchSentinel}\n\n${DEFAULT_GUARD}\n\n${NEVER_DEV_ORCH}\n\n## Task`), out.prompt.slice(0, 600));
    assert.equal(count(out.prompt, "## CRITICAL SAFETY RULE"), 1);
    assert.equal(count(out.prompt, "## NEVER END WAITING"), 1);
    assert.equal(out.prompt.includes(SELF_GUARD), false, "never composed with the self-isolation variant");
    assert.equal(out.isolation, "worktree");
    assert.equal(out.run_in_background, true);
  });

  test("qa_orch gets the blocking-fan-out variant, not the flat ban", () => {
    const out = render("qa_orch", qaAction());
    assert.ok(out.prompt.includes(NEVER_QA_ORCH));
    assert.equal(out.prompt.includes(NEVER_DEV_ORCH), false);
    assert.equal(count(out.prompt, "## NEVER END WAITING"), 1);
  });

  test("dev_target (isolation self): the self-isolation guard REPLACES the default, plus its own forbidden-ending variant and the CYCLE_ID line", () => {
    const out = render("dev_target", devTargetAction());
    assert.ok(out.prompt.includes(SELF_GUARD));
    assert.equal(out.prompt.includes(DEFAULT_GUARD), false, "the default's cwd-ABORT clause would false-abort a self dispatch (#4178)");
    assert.ok(out.prompt.includes(NEVER_DEV_TARGET));
    assert.equal(count(out.prompt, "## NEVER END WAITING"), 1);
    assert.match(out.prompt, /^Use CYCLE_ID=`4dfd1dc9-t4-dev_target` for the Target worktree id\. NEVER symlink node_modules into the Target worktree\.$/m);
    assert.equal(out.isolation, null, "omit the kwarg for a self class");
  });

  test("qa_target pinned on a PR also sets TARGET_WT_BASE to the PR head carried in the intent", () => {
    const out = render(
      "qa_target",
      qaTargetAction({ kind: "TargetReviewPr", pr_ref: "https://github.com/example/target/pull/235", head: "feature/aeb984cb-t1-dev_target" }),
    );
    assert.match(out.prompt, /Use CYCLE_ID=`4dfd1dc9-t4-qa_target` for the Target worktree id and set `TARGET_WT_BASE=origin\/feature\/aeb984cb-t1-dev_target` \(the PR head\)\./);
    assert.ok(out.prompt.includes("on Target PR `https://github.com/example/target/pull/235` (`pr_ref`)"));
    assert.equal(out.description, "qa_target: hydra-target-qa on PR 235");
  });

  test("qa_target purity (#5383): the PR head comes from the intent, never the Turn Snapshot signal", () => {
    // baseState() carries target_needs_qa_pr_head = feature/aeb984cb-t1-dev_target.
    const out = render(
      "qa_target",
      qaTargetAction({ kind: "TargetReviewPr", pr_ref: "https://github.com/example/target/pull/235", head: "feature/from-intent" }),
    );
    assert.match(out.prompt, /TARGET_WT_BASE=origin\/feature\/from-intent/);
    assert.equal(out.prompt.includes("aeb984cb"), false, "the state signal must not leak into the prompt");
  });

  test("qa_target pinned with NO head: the CYCLE_ID line carries no TARGET_WT_BASE clause", () => {
    const out = render("qa_target", qaTargetAction({ kind: "TargetReviewPr", pr_ref: "https://github.com/example/target/pull/235" }));
    assert.match(out.prompt, /^Use CYCLE_ID=`4dfd1dc9-t4-qa_target` for the Target worktree id\. NEVER symlink/m);
    assert.match(out.prompt, /on Target PR `https:\/\/github.com\/example\/target\/pull\/235` \(`pr_ref`\)/);
  });

  test("qa_target unpinned: no TARGET_WT_BASE, the skill resolves the PR itself", () => {
    const out = render("qa_target", qaTargetAction());
    // The self-isolation fence itself mentions TARGET_WT_BASE; the CYCLE_ID line must not.
    assert.match(out.prompt, /^Use CYCLE_ID=`4dfd1dc9-t4-qa_target` for the Target worktree id\. NEVER symlink/m);
    assert.match(out.prompt, /unpinned — its own step 1 resolves the PR/);
  });

  test("every other class gets the short generic unattended block (one of each block, never a playbook variant)", () => {
    for (const slot of ["sweep_orch", "research_orch", "design_concept_orch", "health"]) {
      const out = render(slot, slot === "sweep_orch" ? action(slot, "hydra-sweep") : slot === "health" ? action(slot, "hydra-doctor") : actionFor(slot));
      assert.equal(count(out.prompt, "## CRITICAL SAFETY RULE"), 1, slot);
      assert.equal(count(out.prompt, "## NEVER END WAITING"), 1, slot);
      assert.match(out.prompt, /^## NEVER END WAITING\nThis is an UNATTENDED dispatch; reap\.py records/m, slot);
      for (const variant of [NEVER_DEV_ORCH, NEVER_DEV_TARGET, NEVER_QA_ORCH]) assert.equal(out.prompt.includes(variant), false, slot);
    }
  });

  test("a legacy action without isolation / sentinel fails safe to the default guard and no sentinel line", () => {
    const a = researchOrchAction();
    delete a.isolation;
    delete a.dispatchSentinel;
    const out = render("research_orch", a);
    assert.ok(out.prompt.startsWith(DEFAULT_GUARD));
    assert.equal(out.isolation, "worktree");
  });
});

// ---------------------------------------------------------------------------
describe("render-dispatch.py — dev_orch is a pure function of the Dispatch Intent (issue #5381)", () => {
  const SIGNATURE: Record<string, RegExp> = {
    Fresh: /Open the PR from the worktree branch/,
    ResumeBranch: /previously stalled without a landed result \(branch `b`\)/,
    ResumeSalvage: /no branch was recorded in the resume pin/,
    ForwardFixRed: /Red-PR forward-fix contract/,
    ForwardFixConflict: /\*\*Conflict fix-forward delta \(issue #4807\)\.\*\*/,
    ForwardFixConflictWithFail: /\*\*Two-phase conflict fix-forward delta \(issue #5253\)\.\*\*/,
  };
  const SAMPLE_FIELDS = { anchor: "issue-12", ticket: "issue-12", branch: "b", pr: 9, pr_ref: "https://github.com/o/r/pull/9", head: "feature/h" };

  const QA_SIGNATURE: Record<string, RegExp> = {
    ReviewLane: /parked-filtered needs-qa lane head/,
    ReviewSelfSelect: /Resolve the needs-qa lane head yourself/,
  };
  const DEV_TARGET_SIGNATURE: Record<string, RegExp> = {
    TargetFresh: /Work \*\*Target issue #12\*\* \(anchor `issue-12`\) — pinned/,
    TargetResume: /RESUME pin: Target issue #12 is `needs-dev-resume` with open PR #9 on branch `b`/,
  };
  const QA_TARGET_SIGNATURE: Record<string, RegExp> = {
    TargetReviewPr: /on Target PR `https:\/\/github.com\/o\/r\/pull\/9` \(`pr_ref`\) — pinned/,
    TargetReviewSelfSelect: /unpinned — its own step 1 resolves the PR/,
  };
  const DESIGN_CONCEPT_SIGNATURE: Record<string, RegExp> = {
    Grill: /on \*\*issue #12\*\* of gaberoo322\/hydra \(anchor `issue-12`, scope=orch\)/,
  };
  const WAYFINDER_SIGNATURE: Record<string, RegExp> = {
    WayfinderResearch: /\(type `research`\)[\s\S]*invoke the `hydra-issue-research` skill on #12/,
    WayfinderTask: /\(type `task`\)[\s\S]*invoke the `hydra-dev` skill on #12/,
  };
  const RESEARCH_ORCH_SIGNATURE: Record<string, RegExp> = {
    ResearchNeeded: /scope: orch, repo gaberoo322\/hydra/,
  };
  const RESEARCH_TARGET_SIGNATURE: Record<string, RegExp> = {
    TargetResearchDue: /The Target board has zero `ready-for-agent`/,
  };
  const SAMPLE_BY_SLOT: Record<string, { build: (i?: Record<string, unknown>) => Record<string, unknown>; sig: Record<string, RegExp> }> = {
    dev_orch: { build: devAction, sig: SIGNATURE },
    qa_orch: { build: qaAction, sig: QA_SIGNATURE },
    dev_target: { build: devTargetAction, sig: DEV_TARGET_SIGNATURE },
    qa_target: { build: qaTargetAction, sig: QA_TARGET_SIGNATURE },
    design_concept_orch: { build: designConceptAction, sig: DESIGN_CONCEPT_SIGNATURE },
    wayfinder_orch: { build: wayfinderAction, sig: WAYFINDER_SIGNATURE },
    research_orch: { build: researchOrchAction, sig: RESEARCH_ORCH_SIGNATURE },
    research_target: { build: researchTargetAction, sig: RESEARCH_TARGET_SIGNATURE },
  };

  test("completeness: every kind of every slot in INTENT_KINDS_BY_SLOT renders (a kind without a renderer, or a slot without a test signature, turns this red)", () => {
    const bySlot: Record<string, string[]> = JSON.parse(
      spawnSync("python3", ["-c", "import json, decide_base; print(json.dumps({s: list(k) for s, k in decide_base.INTENT_KINDS_BY_SLOT.items()}))"], {
        cwd: join(REPO_ROOT, "scripts", "autopilot"),
        encoding: "utf-8",
      }).stdout,
    );
    assert.deepEqual(Object.keys(bySlot).sort(), Object.keys(SAMPLE_BY_SLOT).sort());
    for (const [slot, kinds] of Object.entries(bySlot)) {
      const t = SAMPLE_BY_SLOT[slot];
      for (const kind of kinds) {
        assert.ok(t.sig[kind], `test knows kind ${kind}`);
        const out = render(slot, t.build({ kind, ...SAMPLE_FIELDS, rest: ["issue-13"] }));
        assert.match(out.prompt, t.sig[kind], `${slot}/${kind} renders its signature sentence`);
      }
    }
  });

  test("an unknown kind and a missing intent both exit 2 naming the problem (never generic task text)", () => {
    const bogus = run("dev_orch", [devAction({ kind: "Bogus" })]);
    assert.equal(bogus.status, 2);
    assert.match(bogus.stderr, /Bogus/);
    const a = devAction();
    delete a.intent;
    const missing = run("dev_orch", [a]);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /no intent/);
  });

  test("qa_orch: unknown, missing and cross-slot intent kinds exit 2 naming the slot and kind", () => {
    const bogus = run("qa_orch", [qaAction({ kind: "Bogus" })]);
    assert.equal(bogus.status, 2);
    assert.match(bogus.stderr, /Bogus/);
    const a = qaAction();
    delete a.intent;
    const missing = run("qa_orch", [a]);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /no intent/);
    const cross = run("qa_orch", [qaAction({ kind: "Fresh" })]);
    assert.equal(cross.status, 2);
    assert.match(cross.stderr, /qa_orch.*Fresh/);
    const crossDev = run("dev_orch", [devAction({ kind: "ReviewLane", anchor: "issue-1", rest: [] })]);
    assert.equal(crossDev.status, 2);
    assert.match(crossDev.stderr, /dev_orch.*ReviewLane/);
  });

  test("dev_target / qa_target: unknown, missing and cross-slot intent kinds exit 2 naming the slot and kind (#5383)", () => {
    for (const [slot, build, cross] of [
      ["dev_target", devTargetAction, { kind: "Fresh" }],
      ["qa_target", qaTargetAction, { kind: "ReviewLane", anchor: "issue-1", rest: [] }],
    ] as const) {
      const bogus = run(slot, [build({ kind: "Bogus" })]);
      assert.equal(bogus.status, 2, slot);
      assert.match(bogus.stderr, /Bogus/);
      const a = build();
      delete a.intent;
      const missing = run(slot, [a]);
      assert.equal(missing.status, 2, slot);
      assert.match(missing.stderr, /no intent/);
      const crossed = run(slot, [build(cross)]);
      assert.equal(crossed.status, 2, slot);
      assert.match(crossed.stderr, new RegExp(`${slot}.*${cross.kind}`));
    }
    const crossOrch = run("dev_orch", [devAction({ kind: "TargetFresh" })]);
    assert.equal(crossOrch.status, 2);
    assert.match(crossOrch.stderr, /dev_orch.*TargetFresh/);
  });

  test("a bespoke slot carrying a legacy work-shape prompt_args bag and no intent is refused, never rendered generically (#5385 AC2)", () => {
    const bags: Record<string, Record<string, unknown>> = {
      dev_orch: { anchor: "issue-9", resume: true, resume_branch: "b" },
      qa_orch: { anchor: "issue-9", scope: "orch" },
      dev_target: { anchor: "issue-9", resume: true, resume_pr: 4, resume_branch: "b" },
      qa_target: { scope: "target", pr_ref: "gaberoo322/x#4" },
      design_concept_orch: { anchor: "issue-9", scope: "orch" },
      wayfinder_orch: { ticket: "issue-9", ticket_type: "task" },
      research_orch: { scope: "orch" },
      research_target: { scope: "target" },
    };
    for (const [slot, bag] of Object.entries(bags)) {
      const res = run(slot, [{ type: "dispatch", slot, skill: "x", prompt_args: bag }]);
      assert.equal(res.status, 2, slot);
      assert.match(res.stderr, /carries no intent/, slot);
      assert.doesNotMatch(res.stdout, /## Task/, slot);
    }
  });

  test("dispatch_pr: the intent's pr wins; a prompt_args-only action resolves None (#5385)", () => {
    const cases: Array<[Record<string, unknown>, number | null]> = [
      [{ intent: { kind: "TargetResume", anchor: "issue-5", pr: 57, branch: "b" } }, 57],
      [{ prompt_args: { resume: true, resume_pr: 57 } }, null],
      [{ intent: { kind: "ForwardFixRed", anchor: "issue-5", pr: 8, branch: "b" } }, 8],
      [{ intent: { kind: "TargetFresh" } }, null],
      [{ prompt_args: { resume_pr: true } }, null],
      [{ prompt_args: { resume_pr: "57" } }, null],
      [{ prompt_args: {} }, null],
    ];
    for (const [act, want] of cases) {
      const res = spawnSync(
        "python3",
        ["-c", "import json, sys, decide_base; print(json.dumps(decide_base.dispatch_pr(json.loads(sys.argv[1]))))", JSON.stringify(act)],
        { cwd: join(REPO_ROOT, "scripts", "autopilot"), encoding: "utf-8" },
      );
      assert.equal(JSON.parse(res.stdout), want, JSON.stringify(act));
    }
  });

  test("the dev_orch branch ignores any prompt_args bag: only the intent selects the shape", () => {
    const a = devAction({ kind: "Fresh" });
    a.prompt_args = { anchor: "issue-999", resume: true, forward_fix_pr: 1 };
    const out = render("dev_orch", a);
    assert.match(out.prompt, /unpinned/);
    assert.doesNotMatch(out.prompt, /999|forward-fix contract/);
  });
});

// ---------------------------------------------------------------------------
describe("decide_base — Dispatch Intent accessors and the make_dispatch writer (issue #5381)", () => {
  const PY = `
import json, sys
import decide_base as db
pairs = json.loads(sys.stdin.read())
out = []
for p in pairs:
    row = []
    for act in (p["intent"], p["legacy"]):
        row.append([db.dispatch_anchor(act), db.dispatch_resume_branch(act), db.dispatch_attempt(act), db.dispatch_forced(act)])
    out.append(row)
print(json.dumps(out))
`;
  const wrap = (extra: Record<string, unknown>) => ({ type: "dispatch", slot: "dev_orch", skill: "hydra-dev", ...extra });
  const pyRun = (code: string, input = "") =>
    spawnSync("python3", ["-c", code], { cwd: join(REPO_ROOT, "scripts", "autopilot"), encoding: "utf-8", input });

  test("anchor / resume_branch / pr are intent-only: a prompt_args-only action resolves None (#5385)", () => {
    const pairs = [
      { intent: wrap({ intent: { kind: "Fresh" } }), legacy: wrap({ prompt_args: {} }) },
      { intent: wrap({ intent: { kind: "Fresh", anchor: "issue-3" } }), legacy: wrap({ prompt_args: { anchor: "issue-3" } }) },
      { intent: wrap({ intent: { kind: "ResumeBranch", anchor: "issue-3", branch: "b" } }), legacy: wrap({ prompt_args: { anchor: "issue-3", resume: true, resume_branch: "b" } }) },
    ];
    const r = pyRun(PY, JSON.stringify(pairs));
    assert.equal(r.status, 0, r.stderr);
    const rows = JSON.parse(r.stdout) as unknown[][][];
    assert.deepEqual(rows[0][0].slice(0, 2), [null, null]);
    assert.deepEqual(rows[1][0].slice(0, 2), ["issue-3", null]);
    assert.deepEqual(rows[2][0].slice(0, 2), ["issue-3", "b"]);
    for (const [i, [, legacy]] of rows.entries()) assert.deepEqual(legacy.slice(0, 2), [null, null], `legacy pair ${i}`);
  });

  test("dispatch_escalate_model reads the prompt_args hint; non-string / empty -> None (#5385)", () => {
    const r = pyRun(
      "import json, decide_base as db; print(json.dumps([db.dispatch_escalate_model({'prompt_args': {'escalate_model': 'fable'}}), db.dispatch_escalate_model({'prompt_args': {'escalate_model': 3}}), db.dispatch_escalate_model({'intent': {'kind': 'Fresh'}})]))",
    );
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), ["fable", null, null]);
  });

  test("every ESCALATION_POLICY slot that is intent-bearing has an escalation_intent (#5385 INV-5)", () => {
    const r = pyRun(
      "import json, decide_base as db; print(json.dumps([s for s in db.ESCALATION_POLICY if s in db.INTENT_KINDS_BY_SLOT and db.escalation_intent(s) is None]))",
    );
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), []);
  });

  test("render-dispatch.py reads action prompt_args in exactly one place (#5385 INV-1)", () => {
    const src = readFileSync(join(REPO_ROOT, "scripts", "autopilot", "render-dispatch.py"), "utf-8");
    assert.equal((src.match(/action\.get\("prompt_args"\)/g) ?? []).length, 2, "one helper line: the isinstance guard names it twice");
  });

  test("the legacy resume_branch / attempt / forced coercions: attempt coerces; forced is strict", () => {
    const pairs = [
      { intent: wrap({ prompt_args: { resume_branch: "b" } }), legacy: wrap({ prompt_args: { attempt: "nope", forced: "yes" } }) },
    ];
    const r = pyRun(PY, JSON.stringify(pairs));
    assert.equal(r.status, 0, r.stderr);
    const [[a, b]] = JSON.parse(r.stdout);
    assert.deepEqual(a, [null, null, 1, false]);
    assert.deepEqual(b, [null, null, 1, false]);
  });

  test("an intent action carries NO prompt_args key and projects the pinned anchor to the top level (INV-1, INV-8)", () => {
    const r = pyRun(
      "import json, decide_base as db; a = db.make_dispatch('dev_orch', 'hydra-dev', intent=db.Fresh(anchor='issue-5'), reason='r'); b = db.make_dispatch('dev_orch', 'hydra-dev', intent=db.Fresh(), reason='r'); print(json.dumps([a, b]))",
    );
    assert.equal(r.status, 0, r.stderr);
    const [a, b] = JSON.parse(r.stdout);
    assert.deepEqual(a.intent, { kind: "Fresh", anchor: "issue-5" });
    assert.equal("prompt_args" in a, false);
    assert.equal(a.anchor, "issue-5");
    assert.equal("anchor" in b, false);
  });

  test("make_dispatch refuses an intent combined with work-shape prompt_args but allows the escalation keys (INV-1, INV-3)", () => {
    const bad = pyRun("import decide_base as db; db.make_dispatch('dev_orch', 'hydra-dev', intent=db.Fresh(), prompt_args={'anchor': 'issue-1'})");
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /ValueError/);
    const ok = pyRun("import json, decide_base as db; print(json.dumps(db.make_dispatch('dev_orch', 'hydra-dev', intent=db.escalation_intent('dev_orch'), prompt_args={'escalate_model': 'fable', 'attempt': 2, 'prior_attempt_status': 'failure'})))");
    assert.equal(ok.status, 0, ok.stderr);
    const a = JSON.parse(ok.stdout);
    assert.deepEqual(a.intent, { kind: "Fresh" });
    assert.equal(a.prompt_args.attempt, 2);
    assert.equal(pyRun("import decide_base as db; print(db.escalation_intent('qa_orch'))").stdout.trim(), "None");
  });

  test("intent_from_dict fails loud on an unknown kind", () => {
    const r = pyRun("import decide_base as db; db.intent_from_dict({'kind': 'Nope'})");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /unknown dispatch intent kind 'Nope'/);
  });
});

// ---------------------------------------------------------------------------
describe("render-dispatch.py — the mandatory `## Task` sentences per prompt_args shape", () => {
  test("dev_orch pinned anchor names the issue and forbids self-selection (#3711)", () => {
    const out = render("dev_orch", devAction({ kind: "Fresh", anchor: "issue-4687" }));
    assert.match(out.prompt, /on \*\*issue #4687\*\* of gaberoo322\/hydra \(anchor `issue-4687`\) — this anchor is PINNED/);
    assert.doesNotMatch(out.prompt, /Ordering the unpinned pick/);
    assert.match(out.prompt, /ends `Closes #4687`/);
    assert.match(out.prompt, /api\/design-concepts\/issue-4687/);
    assert.equal(out.description, "dev_orch: hydra-dev on #4687");
  });

  test("dev_orch unpinned carries the #3981 tie-break ranking and the Files-in-scope / open-PR fall-through", () => {
    const out = render("dev_orch", devAction());
    assert.match(out.prompt, /unpinned — it self-selects one `ready-for-agent` issue/);
    assert.match(out.prompt, /1\. \*\*Maintainability\*\*.*2\. \*\*Operator surface\*\*.*3\. \*\*Throughput\*\*/);
    assert.match(out.prompt, /lacks a `## Files in scope` section, fall through/);
  });

  test("dev_orch resume names the branch and the ls-remote check (#3866)", () => {
    const out = render("dev_orch", devAction({ kind: "ResumeBranch", anchor: "issue-4511", branch: "dev/4511-split" }));
    assert.match(out.prompt, /previously stalled without a landed result \(branch `dev\/4511-split`\)/);
    assert.match(out.prompt, /git ls-remote origin <branch>/);
    assert.doesNotMatch(out.prompt, /forward-fix contract/);
  });

  test("dev_orch resume without a branch: read the issue comments for the stall Branch line (#4808)", () => {
    // The no-PR resume pin carries NO resume_branch (there is no PR, so no
    // headRefName) — the salvage branch, if any, lives in the issue's own
    // comment history.
    const out = render("dev_orch", devAction({ kind: "ResumeSalvage", anchor: "issue-4806" }));
    assert.match(out.prompt, /no branch was recorded in the resume pin/);
    assert.match(out.prompt, /gh issue view 4806 --json comments/);
    assert.match(out.prompt, /latest reap stall comment's `\*\*Branch:\*\*` line/);
    assert.match(out.prompt, /git ls-remote origin <branch>/);
    assert.match(out.prompt, /judge whether continuing it against current origin\/master beats starting fresh/);
    // The #3866 with-branch wording stays byte-identical for branch-carrying
    // resumes — and never leaks into the no-branch prompt.
    assert.doesNotMatch(out.prompt, /previously stalled without a landed result \(branch/);
    const withBranch = render("dev_orch", devAction({ kind: "ResumeBranch", anchor: "issue-4806", branch: "dev/4806" }));
    assert.match(withBranch.prompt, /previously stalled without a landed result \(branch `dev\/4806`\)/);
    assert.doesNotMatch(withBranch.prompt, /no branch was recorded in the resume pin/);
  });

  test("dev_orch forward-fix carries the #4460 INV-10 contract (provenance-agnostic since #5058) with the PR and branch substituted", () => {
    const out = render(
      "dev_orch",
      devAction({ kind: "ForwardFixRed", anchor: "issue-4728", branch: "worktree-agent-glm-4728", pr: 4776 }),
    );
    for (const needle of [
      "Red-PR forward-fix contract (issues #4460, #5058, INV-10) — PR #4776 on branch `worktree-agent-glm-4728` already exists",
      "1. **Stay on the harness branch.**",
      "git fetch origin worktree-agent-glm-4728 && git reset --hard FETCH_HEAD",
      "NEVER `gh pr create`",
      "NEVER remove the `glm-authored` label",
      "2. **Read the failure before fixing it.**",
      "gh pr checks 4776 --json",
      "3. **Push to the SAME branch:** `git push origin HEAD:worktree-agent-glm-4728`",
      "4. **Design-concept-reconcile failure specifically:**",
      "gh pr edit 4776 --body-file <file>",
      "5. **Verify in the foreground**",
    ]) assert.ok(out.prompt.includes(needle), `missing: ${needle}`);
    assert.doesNotMatch(out.prompt, /Open the PR from the worktree branch/, "no fresh-PR instruction on a forward-fix");
  });

  test("a QA-FAIL forward-fix reads hydra-qa's findings comment and green CI does not complete it (#4849)", () => {
    const out = render(
      "dev_orch",
      devAction({ kind: "ForwardFixRed", anchor: "issue-4728", branch: "worktree-agent-glm-4728", pr: 4776 }),
    );
    const secStart = PLAYBOOK.indexOf("**Red-PR forward-fix dispatch contract");
    const secEnd = PLAYBOOK.indexOf("The cap (red-CI arm only): `state.red_forward_fix_attempts`");
    assert.ok(secStart >= 0 && secEnd > secStart, "playbook contract section markers present");
    const section = PLAYBOOK.slice(secStart, secEnd);
    const flat = (text: string) => text.replace(/\s+/g, " ");
    for (const text of [out.prompt, flat(section)]) {
      // hydra-qa posts every FAIL as a PR comment (#4746): the old pointer at a
      // request-changes review sent resumes looking for a finding list that
      // never exists, so they checked CI, saw green, and pushed nothing.
      assert.doesNotMatch(text, /request-changes review/);
      assert.ok(text.includes("resolve the blocking findings of its latest QA FAIL"));
      assert.ok(text.includes("the `### Findings` table in the latest hydra-qa comment on the PR containing `### Findings` whose own trailing `QA-Verdict` sha matches the `sha=` in the anchor issue's latest `QA-Verdict: FAIL pr="));
      assert.ok(text.includes("gh issue view <anchor> --json comments"));
      assert.ok(text.includes("a later non-Findings hydra-qa comment is not the finding list"));
      assert.ok(text.includes("Green required checks do NOT complete a QA-FAIL forward-fix"));
      assert.ok(text.includes("\"no code change needed\" is never the outcome while the latest verdict is FAIL"));
      assert.ok(text.includes("which required check(s) or QA finding(s) the fix targets, plus any finding you rebutted and why"));
    }
    assert.ok(out.prompt.includes("gh pr view 4776 --json comments"), "the PR number is substituted into the findings lookup");
    assert.ok(out.prompt.includes("`QA-Verdict: FAIL pr=4776`"));
  });

  test("a forward-fix resolves a code finding with a test and verifies with the full dev trio (#5036)", () => {
    const out = render(
      "dev_orch",
      devAction({ kind: "ForwardFixRed", anchor: "issue-4720", branch: "b", pr: 5003 }),
    );
    const secStart = PLAYBOOK.indexOf("**Red-PR forward-fix dispatch contract");
    const secEnd = PLAYBOOK.indexOf("The cap (red-CI arm only): `state.red_forward_fix_attempts`");
    assert.ok(secStart >= 0 && secEnd > secStart, "playbook section markers must exist in order");
    const flat = (text: string) => text.replace(/\s+/g, " ");
    for (const text of [out.prompt, flat(PLAYBOOK.slice(secStart, secEnd))]) {
      assert.doesNotMatch(text, /as the change requires/);
      assert.ok(text.includes("`npm test`, `npm run typecheck` AND `npm run typecheck:test`"));
      assert.ok(text.includes("ALSO adds or extends a test that is red without the fix"));
      assert.ok(text.includes("adds or cites a test pinning the nearest sibling shape that must keep its old verdict"));
      assert.ok(text.includes("naming both tests"));
      assert.ok(text.includes("needs no test"));
      assert.ok(text.includes("judged by what changed: prompt or doc text needs no test, even when it lives under `scripts/`"));
      assert.ok(text.includes("for each QA-FAIL finding fixed with a code change — none for a rebutted finding or a CI-only fix"));
    }
  });

  test("a forward-fix records artifact deviations in the PR body before the push; non-forward-fix prompts do not carry it (#5370)", () => {
    const flat = (text: string) => text.replace(/\s+/g, " ");
    const fix = flat(render("dev_orch", devAction({ kind: "ForwardFixRed", anchor: "issue-5325", branch: "b", pr: 5355 })).prompt);
    assert.ok(fix.includes("deviate from the design-concept artifact (narrower or broader than an invariant line)"));
    assert.ok(fix.includes("record the deviation plus evidence in the PR body's reconciliation section via `gh pr edit 5355 --body-file <file>` BEFORE the push"));
    for (const intent of [{ kind: "Fresh" }, { kind: "ResumeBranch", anchor: "issue-1", branch: "b" }]) {
      const other = flat(render("dev_orch", devAction(intent as never)).prompt);
      assert.ok(!other.includes("deviate from the design-concept artifact"), `${intent.kind} must not carry the deviation sentence`);
    }
  });

  test("the forward-fix contract's five steps are the playbook's five (same bold step titles, same order)", () => {
    const out = render("dev_orch", devAction({ kind: "ForwardFixRed", anchor: "issue-1", branch: "b", pr: 2 }));
    const titles = (text: string) => [...text.matchAll(/^\d\. \*\*([^*]+)\*\*/gm)].map((m) => m[1]);
    const section = PLAYBOOK.slice(PLAYBOOK.indexOf("**Red-PR forward-fix dispatch contract"), PLAYBOOK.indexOf("The cap (red-CI arm only): `state.red_forward_fix_attempts`"));
    const want = titles(section);
    assert.equal(want.length, 5, "the playbook contract has five steps");
    assert.deepEqual(titles(out.prompt.slice(out.prompt.indexOf("Red-PR forward-fix contract"))), want);
  });

  test("the conflict kinds render the matching delta per arm; the no-address-findings clause is conflict-only (issues #4807, #5253)", () => {
    const flat = (text: string) => text.replace(/\s+/g, " ");
    const base = { anchor: "issue-4511", branch: "b", pr: 4818 };
    const conflictOnly = render("dev_orch", devAction({ kind: "ForwardFixConflict", ...base })).prompt;
    const twoPhase = render("dev_orch", devAction({ kind: "ForwardFixConflictWithFail", ...base })).prompt;
    const plain = render("dev_orch", devAction({ kind: "ForwardFixRed", ...base })).prompt;

    assert.ok(conflictOnly.includes("**Conflict fix-forward delta (issue #4807).**"));
    assert.ok(conflictOnly.includes("do NOT address review findings"));
    assert.ok(!conflictOnly.includes("Two-phase conflict fix-forward delta"));

    assert.ok(twoPhase.includes("**Two-phase conflict fix-forward delta (issue #5253).**"));
    assert.ok(!twoPhase.includes("do NOT address review findings"));
    assert.ok(twoPhase.indexOf("(c) merge `origin/master`") < twoPhase.indexOf("(d) only then carry steps 2-5 on the merged head"));
    assert.ok(!twoPhase.includes("**Conflict fix-forward delta (issue #4807).**"));

    assert.ok(!plain.includes("conflict fix-forward delta") && !plain.includes("Conflict fix-forward delta"), "a plain forward-fix carries no delta");

    // The kind IS the condition: neither delta (nor its playbook paragraph) names a prompt_args flag.
    for (const delta of [conflictOnly.slice(conflictOnly.indexOf("**Conflict fix-forward delta")), twoPhase.slice(twoPhase.indexOf("**Two-phase conflict"))]) {
      assert.ok(!delta.split(/\n\s*\n/)[0].includes("prompt_args"), "delta paragraph states its instructions without a prompt_args condition");
    }

    // Playbook parity: each rendered delta is a verbatim paragraph of the playbook.
    const paragraphs = PLAYBOOK.split(/\n\s*\n/).map(flat);
    for (const [head, prompt] of [
      ["**Conflict fix-forward delta (issue #4807).**", conflictOnly],
      ["**Two-phase conflict fix-forward delta (issue #5253).**", twoPhase],
    ] as const) {
      const rendered = flat(prompt.slice(prompt.indexOf(head))).split(" ").join(" ");
      const para = paragraphs.find((p) => p.startsWith(head));
      assert.ok(para !== undefined, `playbook paragraph ${head}`);
      assert.ok(rendered.startsWith(para), `renderer constant for ${head} matches the playbook paragraph verbatim`);
    }
  });

  test("qa_orch ReviewLane names the intent's head and rest, and the review rules", () => {
    const out = render("qa_orch", qaAction());
    assert.match(out.prompt, /Review \*\*issue #4700\*\* \(the selector's parked-filtered needs-qa lane head - do NOT self-select a different needs-qa issue\); the rest of the lane, in order: #4825, #4821\./);
    assert.match(out.prompt, /FULL step-7 Standards \+ Spec fan-out \(blocking reviewer spawns, all in one message\)/);
    assert.match(out.prompt, /do NOT `gh pr checkout` and do NOT approve the PR/);
    assert.match(out.prompt, /`QA-Verdict:` trailer and execute the step-10 routing/);
    assert.match(out.prompt, /move on to the next issue in the lane above \(never one outside it\)\./);
    assert.match(out.prompt, /gh pr update-branch/);
  });

  test("qa_orch ReviewLane with an empty rest omits the rest-of-lane clause", () => {
    const out = render("qa_orch", qaAction({ kind: "ReviewLane", anchor: "issue-4700", rest: [] }));
    assert.match(out.prompt, /different needs-qa issue\)\. Find its open PR by closing-ref/);
    assert.doesNotMatch(out.prompt, /the rest of the lane, in order/);
  });

  test("qa_orch ReviewSelfSelect renders the unpinned text", () => {
    const out = render("qa_orch", qaAction({ kind: "ReviewSelfSelect" }), baseState({ signals: {} }));
    assert.match(out.prompt, /Resolve the needs-qa lane head yourself\. Find its open PR/);
    assert.match(out.prompt, /move on to the next needs-qa issue instead\./);
  });

  test("a parked issue in the Turn Snapshot's needs-qa lane but absent from the intent never reaches the qa_orch prompt (#5319 bug class)", () => {
    const out = render("qa_orch", qaAction({ kind: "ReviewLane", anchor: "issue-4700", rest: ["issue-4825"] }));
    assert.equal(out.prompt.includes("4821"), false, "the parked lane member is nowhere in the prompt");
    assert.ok(out.prompt.includes("#4700") && out.prompt.includes("#4825"));
  });

  test("qa_orch renders head and rest from the intent alone (no lane in the snapshot, no prompt_args)", () => {
    const out = render("qa_orch", qaAction(), baseState({ signals: {} }));
    assert.match(out.prompt, /issue #4700/);
    assert.match(out.prompt, /#4825, #4821/);
  });

  test("design_concept_orch carries the AFK grill rules (premise-check on master, commit to a position, persistence read-back)", () => {
    const out = render("design_concept_orch", designConceptAction());
    assert.match(out.prompt, /on \*\*issue #4806\*\* of gaberoo322\/hydra \(anchor `issue-4806`, scope=orch\)/);
    assert.match(out.prompt, /Grill against `origin\/master`/);
    assert.match(out.prompt, /no neutral option matrices/);
    assert.match(out.prompt, /api\/design-concepts\/issue-4806` \(use the skill's `grill-artifact\.sh`/);
    assert.equal(out.model, "fable");
  });

  test("dev_target asks for delegated mode; a resume pin names the issue, PR and branch", () => {
    const fresh = render("dev_target", devTargetAction());
    assert.match(fresh.prompt, /\*\*Use delegated mode\*\*/);
    assert.match(fresh.prompt, /Pick ONE `ready-for-agent` Target issue/);
    const pinned = render("dev_target", devTargetAction({ kind: "TargetFresh", anchor: "issue-210" }));
    assert.match(pinned.prompt, /Work \*\*Target issue #210\*\* \(anchor `issue-210`\) — pinned; no other issue\./);
    assert.doesNotMatch(pinned.prompt, /Pick ONE/);
    const resume = render(
      "dev_target",
      devTargetAction({ kind: "TargetResume", anchor: "issue-210", pr: 240, branch: "feature/x-t1-dev_target" }),
    );
    assert.match(resume.prompt, /RESUME pin: Target issue #210 is `needs-dev-resume` with open PR #240 on branch `feature\/x-t1-dev_target`/);
    assert.doesNotMatch(resume.prompt, /Pick ONE/);
  });

  test("wayfinder_orch: claim first, ticket-type routes the skill, the three-step resolution protocol", () => {
    const task = render("wayfinder_orch", wayfinderAction({ kind: "WayfinderTask", ticket: "issue-4705" }));
    assert.equal(task.skill, "hydra-dev", "task tickets run hydra-dev (#3351)");
    assert.match(task.prompt, /Step 0 — CLAIM FIRST \(issue #3354\): `gh issue edit 4705 --repo gaberoo322\/hydra --add-assignee @me`/);
    assert.match(task.prompt, /invoke the `hydra-dev` skill on #4705/);
    assert.match(task.prompt, /\(1\) post a resolution comment.*\(2\) close the ticket.*\(3\) append a line to the parent map's `## Decisions so far`/);
    assert.equal(task.model, null, "wayfinder_orch inherits the parent");
    assert.equal(task.description, "wayfinder_orch: hydra-dev on ticket #4705");
    const research = render("wayfinder_orch", wayfinderAction({ kind: "WayfinderResearch", ticket: "issue-4706" }));
    assert.equal(research.skill, "hydra-issue-research");
    assert.match(research.prompt, /invoke the `hydra-issue-research` skill on #4706/);
  });

  test("wayfinder_orch: the renderer has no skill routing of its own — the action's skill is what runs (#5384 INV-4)", () => {
    const a = wayfinderAction({ kind: "WayfinderTask", ticket: "issue-4705" });
    a.skill = "stamped-by-the-brain";
    assert.equal(render("wayfinder_orch", a).skill, "stamped-by-the-brain");
  });

  test("design_concept / wayfinder / research: unknown, missing and cross-slot intent kinds exit 2 naming the slot and kind", () => {
    for (const [slot, build, cross] of [
      ["design_concept_orch", designConceptAction, "Fresh"],
      ["wayfinder_orch", wayfinderAction, "Grill"],
      ["research_orch", researchOrchAction, "TargetResearchDue"],
      ["research_target", researchTargetAction, "ResearchNeeded"],
    ] as const) {
      const bogus = run(slot, [build({ kind: "Bogus" })]);
      assert.equal(bogus.status, 2, slot);
      assert.match(bogus.stderr, /Bogus/, slot);
      const crossed = run(slot, [build({ kind: cross, anchor: "issue-1", ticket: "issue-1" })]);
      assert.equal(crossed.status, 2, `${slot} rejects ${cross}`);
      assert.match(crossed.stderr, new RegExp(`${slot}.*${cross}`), slot);
      const a = build();
      delete a.intent;
      const missing = run(slot, [a]);
      assert.equal(missing.status, 2, slot);
      assert.match(missing.stderr, /no intent/, slot);
    }
  });

  test("apply:true scan classes say so, issue-producing classes carry the admission rule, sweeps carry the label-API rule", () => {
    const retro = render("retro_orch", action("retro_orch", "hydra-retro", { prompt_args: { apply: true } }));
    assert.match(retro.prompt, /`apply: true` — this is a REAL run, not a dry run/);
    assert.match(retro.prompt, /Admission rule \(operator directive 2026-08-19\)/);
    assert.match(retro.prompt, /Invoke the `hydra-retro` skill \(via the Skill tool; apply: true\)/);
    const sweep = render("sweep_orch", action("sweep_orch", "hydra-sweep", { prompt_args: { scope: "orch", anchor: "issue-4823" } }));
    assert.match(sweep.prompt, /match by closing ref, not by title/);
    assert.match(sweep.prompt, /put its name in the URL PATH \(`DELETE \.\.\.\/labels\/<name>`\)/);
    assert.match(sweep.prompt, /scripts\/lifecycle\.ts advance <N> <to>/);
    assert.match(retro.prompt, /Issue STATE labels .* move only through `npx tsx scripts\/lifecycle\.ts advance <N> <to> \.\.\.`/);
    assert.match(retro.prompt, /refusal exits non-zero and is final/);
    const health = render("health", action("health", "hydra-doctor"));
    assert.doesNotMatch(health.prompt, /Admission rule/);
    assert.match(health.prompt, /Invoke the `hydra-doctor` skill \(via the Skill tool\) and follow it end to end/);
  });

  test("dispatcher notes are appended verbatim, after the skeleton", () => {
    const notes = "- PR #4826 is at head fc7a492c\n- skip #4700, it already has a verdict\n";
    const r = run("qa_orch", [qaAction()], baseState(), ["--notes", "-"], { input: notes });
    assert.equal(r.status, 0, r.stderr);
    const out: Rendered = JSON.parse(r.stdout);
    assert.ok(out.prompt.endsWith(`Notes from the dispatcher:\n${notes.trim()}\n`), out.prompt.slice(-300));
    const viaFile = run("qa_orch", [qaAction()], baseState(), ["--notes-file", join(r.dir, "notes.md")]);
    assert.equal(viaFile.status, 2, "missing notes file → exit 2");
    writeFileSync(join(r.dir, "notes.md"), notes);
    const ok = run("qa_orch", [qaAction()], baseState(), ["--notes-file", join(r.dir, "notes.md")]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.ok((JSON.parse(ok.stdout) as Rendered).prompt.includes(notes.trim()));
  });
});

// ---------------------------------------------------------------------------
describe("render-dispatch.py — model resolution (#1093, #3274, #4585)", () => {
  test("the model column the renderer reads covers every taxonomy class; the inherit set is the column's", () => {
    const seen: Record<string, string | null> = {};
    for (const cls of CLASSES) {
      const out = render(cls, actionFor(cls));
      seen[cls] = out.model;
      assert.ok(out.model === null || ["fable", "sonnet", "haiku", "opus"].includes(out.model), `${cls}: ${out.model}`);
    }
    const inherit = CLASSES.filter((c) => seen[c] === null).sort();
    assert.deepEqual(inherit, ["design_qa_target", "skill_prune", "tickets_orch", "wayfinder_orch", "wire_or_retire_target"],
      "inherit set drifted — a model value changed; update this pin deliberately");
    assert.equal(seen.dev_orch, "sonnet");
    assert.equal(seen.cleanup_orch, "haiku");
    assert.equal(seen.dev_target, "fable");
  });

  test("the rows the renderer reads are classes.json's model column", () => {
    const column: Record<string, string> = {};
    for (const row of TAXONOMY) column[row.name] = row.model;
    assert.ok(Object.keys(column).length >= 18, `column rows: ${Object.keys(column).length}`);
    for (const cls of Object.keys(column)) {
      const cell = column[cls];
      const out = render(cls, actionFor(cls));
      assert.equal(out.model, cell === "inherit" ? null : cell, cls);
      assert.equal(out.model_source, cell === "inherit" ? "model-column:inherit" : "model-column", cls);
    }
  });

  test("escalate_model overrides the static row", () => {
    const out = render("cleanup_orch", action("cleanup_orch", "hydra-cleanup", { prompt_args: { apply: true, escalate_model: "sonnet", attempt: 2, prior_attempt_status: "no_op" } }));
    assert.equal(out.model, "sonnet");
    assert.equal(out.model_source, "escalate_model");
  });

  test("Fable exhausted (action.admission.modelFallbackReason set) → admission.launchModel (#5103, #5384)", () => {
    const admission = (over: Record<string, unknown> = {}) => ({
      launchModel: "opus",
      primaryModel: "fable",
      fallbackModel: "opus",
      modelFallbackReason: "out-of-credits",
      ...over,
    });
    const withAdm = (a: Record<string, unknown>, adm: unknown) => ({ ...a, admission: adm });
    const a = devTargetAction();
    const out = render("dev_target", withAdm(a, admission()));
    assert.equal(out.model, "opus");
    assert.equal(out.model_source, "model-column→fable-exhausted-fallback");
    // The launch model is the verdict's value, not a second env read.
    assert.equal(render("dev_target", withAdm(a, admission({ launchModel: "sonnet" }))).model, "sonnet");
    const env = render("dev_target", withAdm(a, admission()), undefined, { HYDRA_AUTOPILOT_FALLBACK_MODEL: "haiku" });
    assert.equal(env.model, "opus", "the renderer no longer reads the fallback env itself");
    const calm = withAdm(a, admission({ modelFallbackReason: null, launchModel: "fable" }));
    assert.equal(render("dev_target", calm).model, "fable", "no fallback reason does nothing");
    assert.equal(render("dev_target", a).model, "fable", "no action.admission → column value (fail-safe)");
    const hint = render("cleanup_orch", withAdm(action("cleanup_orch", "hydra-cleanup", { prompt_args: { escalate_model: "fable" } }), admission()));
    assert.equal(hint.model, "opus", "the hint is pre-resolved too");
    assert.equal(hint.model_source, "escalate_model→fable-exhausted-fallback");
    const sonnetClass = render("dev_orch", withAdm(devAction(), admission()));
    assert.equal(sonnetClass.model, "sonnet", "non-fable rows are untouched");
  });

  test("purity: an admission verdict ONLY in the state file (not on the action) is never read (#5384 INV-3)", () => {
    const stateOnly = baseState({
      usage_eligibility: {
        allow: true,
        reasons: {},
        admission: { launchModel: "opus", primaryModel: "fable", fallbackModel: "opus", modelFallbackReason: "out-of-credits" },
      },
    });
    assert.equal(render("dev_target", devTargetAction(), stateOnly).model, "fable");
  });

  test("render-dispatch.py imports no turn_snapshot and has no skill_by_ticket_type routing (#5384)", () => {
    const src = readFileSync(join(REPO_ROOT, "scripts", "autopilot", "render-dispatch.py"), "utf-8");
    assert.equal(src.includes("import turn_snapshot"), false);
    assert.equal(src.includes("skill_by_ticket_type"), false);
  });

  test("an unknown class inherits (model null) and says why", () => {
    const out = render("brand_new_class", action("brand_new_class", "hydra-x"));
    assert.equal(out.model, null);
    assert.equal(out.model_source, "unmapped-class:inherit");
  });
});

// ---------------------------------------------------------------------------
describe("render-dispatch.py — CLI contract", () => {
  test("no dispatch for the slot → exit 1, nothing on stdout", () => {
    const r = run("qa_orch", [action("dev_orch", "hydra-dev")]);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /no dispatch action for slot 'qa_orch'/);
  });

  test("--prompt-only prints the prompt text, nothing else", () => {
    const r = run("dev_orch", [devAction()], baseState(), ["--prompt-only"]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.startsWith("<!-- hydra-dispatch v1"));
    assert.ok(r.stdout.includes("## Task"));
    assert.throws(() => JSON.parse(r.stdout));
  });

  test("usage / unreadable inputs → exit 2", () => {
    const noArgs = spawnSync("python3", [SCRIPT], { encoding: "utf-8" });
    assert.equal(noArgs.status, 2);
    assert.match(noArgs.stderr, /usage:/);
    const badFlag = run("dev_orch", [devAction()], baseState(), ["--bogus"]);
    assert.equal(badFlag.status, 2);
    const r = spawnSync("python3", [SCRIPT, "dev_orch"], {
      encoding: "utf-8",
      env: { ...process.env, HYDRA_AUTOPILOT_STATE: "/nonexistent/state.json", HYDRA_AUTOPILOT_PLAN: "/nonexistent/plan.json" },
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /cannot read state\/plan/);
  });

  test("the playbook routes the dispatch row through the renderer", () => {
    const row = PLAYBOOK.split("\n").find((l) => l.startsWith("| `dispatch` |"))!;
    assert.match(row, /python3 scripts\/autopilot\/render-dispatch\.py <slot>/);
    assert.match(row, /stamp-slot\.py/);
  });
});

describe("Dispatch Intent validation (#5381 QA round 1)", () => {
  const py = (code: string) =>
    spawnSync(
      "python3",
      ["-c", `import sys; sys.path.insert(0, ${JSON.stringify(join(REPO_ROOT, "scripts", "autopilot"))})\nimport decide_base as db\n${code}`],
      { encoding: "utf-8" },
    );

  for (const [label, raw] of [
    ["empty branch", `{"kind":"ForwardFixRed","anchor":"issue-1","pr":5,"branch":""}`],
    ["non-int pr", `{"kind":"ForwardFixRed","anchor":"issue-1","pr":"5","branch":"b"}`],
    ["bool pr", `{"kind":"ForwardFixConflict","anchor":"issue-1","pr":True,"branch":"b"}`],
    ["empty resume branch", `{"kind":"ResumeBranch","anchor":"issue-1","branch":""}`],
    ["non-issue anchor on Fresh", `{"kind":"Fresh","anchor":"foo"}`],
    ["non-issue anchor on ResumeSalvage", `{"kind":"ResumeSalvage","anchor":"issue-"}`],
    ["non-numeric issue anchor on a forward-fix", `{"kind":"ForwardFixRed","anchor":"issue-x","pr":5,"branch":"b"}`],
  ] as const) {
    test(`intent_from_dict rejects ${label}`, () => {
      const r = py(`try:\n    db.intent_from_dict(${raw})\n    print("accepted")\nexcept ValueError:\n    print("rejected")`);
      assert.equal(r.stdout.trim(), "rejected", r.stderr);
    });
  }

  test("sibling shapes keep their verdict: well-formed intents still parse", () => {
    const r = py(
      `print(db.intent_from_dict({"kind":"ForwardFixRed","anchor":"issue-1","pr":5,"branch":"b"}).pr, db.intent_from_dict({"kind":"Fresh"}).anchor, db.intent_from_dict({"kind":"ResumeSalvage","anchor":"issue-1"}).anchor)`,
    );
    assert.equal(r.stdout.trim(), "5 None issue-1", r.stderr);
  });
});

describe("Dispatch Intent through the INV-7 consumers (#5381)", () => {
  const py = (code: string) =>
    spawnSync(
      "python3",
      ["-c", `import sys, json; sys.path.insert(0, ${JSON.stringify(join(REPO_ROOT, "scripts", "autopilot"))})\n${code}`],
      { encoding: "utf-8" },
    );

  test("the pinned-anchor sentinel is read from an INTENT action (no prompt_args)", () => {
    const r = py(
      `import decide_base as db, decide\n` +
        `a = db.make_dispatch('dev_orch', 'hydra-dev', intent=db.ResumeSalvage(anchor='issue-77'))\n` +
        `acts = [a]\ndecide._stamp_dispatch_metadata(acts, {'run_id': 'r1', 'turn': 1})\n` +
        `print(json.dumps({'sentinel': acts[0]['dispatchSentinel'], 'pa': acts[0].get('prompt_args')}))`,
    );
    const out = JSON.parse(r.stdout);
    assert.ok(!out.pa, "intent actions carry no prompt_args");
    assert.match(out.sentinel, /anchor=issue-77/);
  });

  test("a legacy prompt_args-only action no longer yields an anchor in the sentinel (#5385)", () => {
    const r = py(
      `import decide\n` +
        `acts = [{'type': 'dispatch', 'slot': 'dev_orch', 'skill': 'hydra-dev', 'prompt_args': {'anchor': 'issue-78'}}]\n` +
        `decide._stamp_dispatch_metadata(acts, {'run_id': 'r1', 'turn': 1})\nprint(acts[0]['dispatchSentinel'])`,
    );
    assert.doesNotMatch(r.stdout, /anchor=issue-78/);
  });

  test("stamp-slot build_slot stamps anchor and attempt from an INTENT action", () => {
    const r = py(
      `import importlib.util, decide_base as db\n` +
        `spec = importlib.util.spec_from_file_location('stamp_slot', ${JSON.stringify(join(REPO_ROOT, "scripts", "autopilot", "stamp-slot.py"))})\n` +
        `m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\n` +
        `a = db.make_dispatch('dev_orch', 'hydra-dev', intent=db.ForwardFixRed(anchor='issue-5', pr=9, branch='b'), prompt_args={'attempt': 3, 'escalate_model': 'fable'})\n` +
        `rec = m.build_slot(a, 'tid', 'sonnet', 'abcdef012345', 4, 1000)\n` +
        `print(json.dumps({'anchor': rec.get('anchor'), 'attempt': rec['attempt']}))`,
    );
    assert.deepEqual(JSON.parse(r.stdout), { anchor: "issue-5", attempt: 3 }, r.stderr);
  });

  test("sibling shape: build_slot on an unpinned Fresh intent stamps no anchor, attempt 1", () => {
    const r = py(
      `import importlib.util, decide_base as db\n` +
        `spec = importlib.util.spec_from_file_location('stamp_slot', ${JSON.stringify(join(REPO_ROOT, "scripts", "autopilot", "stamp-slot.py"))})\n` +
        `m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\n` +
        `rec = m.build_slot(db.make_dispatch('dev_orch', 'hydra-dev', intent=db.Fresh()), 'tid', 'sonnet', 'abcdef012345', 4, 1000)\n` +
        `print(json.dumps({'has_anchor': 'anchor' in rec, 'attempt': rec['attempt']}))`,
    );
    assert.deepEqual(JSON.parse(r.stdout), { has_anchor: false, attempt: 1 }, r.stderr);
  });
});

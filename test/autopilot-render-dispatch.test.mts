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
 *   - model resolution: the playbook routing table → `escalate_model` →
 *     the Fable out-of-credits pre-resolution (#4585), `inherit` → null,
 *     an unmapped class → null; the table parser covers every taxonomy class
 *     except the two the playbook deliberately leaves to inherit;
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
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "autopilot", "render-dispatch.py");
const PLAYBOOK = readFileSync(join(REPO_ROOT, "docs", "operator-playbooks", "hydra-autopilot.md"), "utf-8");
const FRAGMENT = readFileSync(
  join(REPO_ROOT, "docs", "operator-playbooks", "_fragments", "target-self-isolation-preamble.md"),
  "utf-8",
);
const CLASSES: string[] = JSON.parse(readFileSync(join(REPO_ROOT, "scripts", "autopilot", "classes.json"), "utf-8"))
  .classes.map((c: { name: string }) => c.name);

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
  writeFileSync(statePath, JSON.stringify(state));
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
    const a = action("dev_orch", "hydra-dev");
    const out = render("dev_orch", a);
    assert.ok(out.prompt.startsWith(`${a.dispatchSentinel}\n\n${DEFAULT_GUARD}\n\n${NEVER_DEV_ORCH}\n\n## Task`), out.prompt.slice(0, 600));
    assert.equal(count(out.prompt, "## CRITICAL SAFETY RULE"), 1);
    assert.equal(count(out.prompt, "## NEVER END WAITING"), 1);
    assert.equal(out.prompt.includes(SELF_GUARD), false, "never composed with the self-isolation variant");
    assert.equal(out.isolation, "worktree");
    assert.equal(out.run_in_background, true);
  });

  test("qa_orch gets the blocking-fan-out variant, not the flat ban", () => {
    const out = render("qa_orch", action("qa_orch", "hydra-qa", { prompt_args: { scope: "orch" } }));
    assert.ok(out.prompt.includes(NEVER_QA_ORCH));
    assert.equal(out.prompt.includes(NEVER_DEV_ORCH), false);
    assert.equal(count(out.prompt, "## NEVER END WAITING"), 1);
  });

  test("dev_target (isolation self): the self-isolation guard REPLACES the default, plus its own forbidden-ending variant and the CYCLE_ID line", () => {
    const out = render("dev_target", action("dev_target", "hydra-target-build", { isolation: "self" }));
    assert.ok(out.prompt.includes(SELF_GUARD));
    assert.equal(out.prompt.includes(DEFAULT_GUARD), false, "the default's cwd-ABORT clause would false-abort a self dispatch (#4178)");
    assert.ok(out.prompt.includes(NEVER_DEV_TARGET));
    assert.equal(count(out.prompt, "## NEVER END WAITING"), 1);
    assert.match(out.prompt, /^Use CYCLE_ID=`4dfd1dc9-t4-dev_target` for the Target worktree id\. NEVER symlink node_modules into the Target worktree\.$/m);
    assert.equal(out.isolation, null, "omit the kwarg for a self class");
  });

  test("qa_target pinned on a PR also sets TARGET_WT_BASE to the PR head from the signals", () => {
    const out = render(
      "qa_target",
      action("qa_target", "hydra-target-qa", {
        isolation: "self",
        prompt_args: { scope: "target", pr_ref: "https://github.com/example/target/pull/235" },
      }),
    );
    assert.match(out.prompt, /Use CYCLE_ID=`4dfd1dc9-t4-qa_target` for the Target worktree id and set `TARGET_WT_BASE=origin\/feature\/aeb984cb-t1-dev_target` \(the PR head\)\./);
    assert.ok(out.prompt.includes("on Target PR `https://github.com/example/target/pull/235` (`pr_ref`)"));
    assert.equal(out.description, "qa_target: hydra-target-qa on PR 235");
  });

  test("qa_target unpinned: no TARGET_WT_BASE, the skill resolves the PR itself", () => {
    const out = render("qa_target", action("qa_target", "hydra-target-qa", { isolation: "self", prompt_args: { scope: "target" } }));
    // The self-isolation fence itself mentions TARGET_WT_BASE; the CYCLE_ID line must not.
    assert.match(out.prompt, /^Use CYCLE_ID=`4dfd1dc9-t4-qa_target` for the Target worktree id\. NEVER symlink/m);
    assert.match(out.prompt, /unpinned — its own step 1 resolves the PR/);
  });

  test("every other class gets the short generic unattended block (one of each block, never a playbook variant)", () => {
    for (const [slot, skill] of [["sweep_orch", "hydra-sweep"], ["research_orch", "hydra-issue-research"], ["design_concept_orch", "hydra-grill"], ["health", "hydra-doctor"]]) {
      const out = render(slot, action(slot, skill, { prompt_args: slot === "design_concept_orch" ? { scope: "orch", anchor: "issue-4806" } : {} }));
      assert.equal(count(out.prompt, "## CRITICAL SAFETY RULE"), 1, slot);
      assert.equal(count(out.prompt, "## NEVER END WAITING"), 1, slot);
      assert.match(out.prompt, /^## NEVER END WAITING\nThis is an UNATTENDED dispatch; reap\.py records/m, slot);
      for (const variant of [NEVER_DEV_ORCH, NEVER_DEV_TARGET, NEVER_QA_ORCH]) assert.equal(out.prompt.includes(variant), false, slot);
    }
  });

  test("a legacy action without isolation / sentinel fails safe to the default guard and no sentinel line", () => {
    const a = action("research_orch", "hydra-issue-research");
    delete a.isolation;
    delete a.dispatchSentinel;
    const out = render("research_orch", a);
    assert.ok(out.prompt.startsWith(DEFAULT_GUARD));
    assert.equal(out.isolation, "worktree");
  });
});

// ---------------------------------------------------------------------------
describe("render-dispatch.py — the mandatory `## Task` sentences per prompt_args shape", () => {
  test("dev_orch pinned anchor names the issue and forbids self-selection (#3711)", () => {
    const out = render("dev_orch", action("dev_orch", "hydra-dev", { prompt_args: { anchor: "issue-4687" } }));
    assert.match(out.prompt, /on \*\*issue #4687\*\* of gaberoo322\/hydra \(anchor `issue-4687`\) — this anchor is PINNED/);
    assert.doesNotMatch(out.prompt, /Ordering the unpinned pick/);
    assert.match(out.prompt, /ends `Closes #4687`/);
    assert.match(out.prompt, /api\/design-concepts\/issue-4687/);
    assert.equal(out.description, "dev_orch: hydra-dev on #4687");
  });

  test("dev_orch unpinned carries the #3981 tie-break ranking and the Files-in-scope / open-PR fall-through", () => {
    const out = render("dev_orch", action("dev_orch", "hydra-dev"));
    assert.match(out.prompt, /unpinned — it self-selects one `ready-for-agent` issue/);
    assert.match(out.prompt, /1\. \*\*Maintainability\*\*.*2\. \*\*Operator surface\*\*.*3\. \*\*Throughput\*\*/);
    assert.match(out.prompt, /lacks a `## Files in scope` section, fall through/);
  });

  test("dev_orch resume names the branch and the ls-remote check (#3866)", () => {
    const out = render("dev_orch", action("dev_orch", "hydra-dev", { prompt_args: { anchor: "issue-4511", resume: true, resume_branch: "dev/4511-split" } }));
    assert.match(out.prompt, /previously stalled without a landed result \(branch `dev\/4511-split`\)/);
    assert.match(out.prompt, /git ls-remote origin <branch>/);
    assert.doesNotMatch(out.prompt, /forward-fix contract/);
  });

  test("dev_orch forward-fix carries the #4460 INV-10 contract with the PR and branch substituted", () => {
    const out = render(
      "dev_orch",
      action("dev_orch", "hydra-dev", { prompt_args: { anchor: "issue-4728", resume: true, resume_branch: "worktree-agent-glm-4728", forward_fix_pr: 4776 } }),
    );
    for (const needle of [
      "GLM red-PR forward-fix contract (issue #4460, INV-10) — PR #4776 on branch `worktree-agent-glm-4728` already exists",
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
      action("dev_orch", "hydra-dev", { prompt_args: { anchor: "issue-4728", resume: true, resume_branch: "worktree-agent-glm-4728", forward_fix_pr: 4776 } }),
    );
    const secStart = PLAYBOOK.indexOf("**GLM red-PR forward-fix dispatch contract");
    const secEnd = PLAYBOOK.indexOf("The cap: `state.glm_red_forward_fix_attempts`");
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

  test("the forward-fix contract's five steps are the playbook's five (same bold step titles, same order)", () => {
    const out = render("dev_orch", action("dev_orch", "hydra-dev", { prompt_args: { anchor: "issue-1", resume: true, resume_branch: "b", forward_fix_pr: 2 } }));
    const titles = (text: string) => [...text.matchAll(/^\d\. \*\*([^*]+)\*\*/gm)].map((m) => m[1]);
    const section = PLAYBOOK.slice(PLAYBOOK.indexOf("**GLM red-PR forward-fix dispatch contract"), PLAYBOOK.indexOf("The cap: `state.glm_red_forward_fix_attempts`"));
    const want = titles(section);
    assert.equal(want.length, 5, "the playbook contract has five steps");
    assert.deepEqual(titles(out.prompt.slice(out.prompt.indexOf("GLM red-PR forward-fix contract"))), want);
  });

  test("qa_orch names the needs-qa lane head and the rest of the lane, and the review rules", () => {
    const out = render("qa_orch", action("qa_orch", "hydra-qa", { prompt_args: { scope: "orch" } }));
    assert.match(out.prompt, /The needs-qa lane head is \*\*issue #4700\*\*; the rest of the lane, in order: #4825, #4821\./);
    assert.match(out.prompt, /FULL step-7 Standards \+ Spec fan-out \(blocking reviewer spawns, all in one message\)/);
    assert.match(out.prompt, /do NOT `gh pr checkout` and do NOT approve the PR/);
    assert.match(out.prompt, /`QA-Verdict:` trailer and execute the step-10 routing/);
    assert.match(out.prompt, /gh pr update-branch/);
  });

  test("qa_orch with an empty lane does not invent a head", () => {
    const out = render("qa_orch", action("qa_orch", "hydra-qa", { prompt_args: { scope: "orch" } }), baseState({ signals: {} }));
    assert.match(out.prompt, /Resolve the needs-qa lane head yourself\./);
  });

  test("design_concept_orch carries the AFK grill rules (premise-check on master, commit to a position, persistence read-back)", () => {
    const out = render("design_concept_orch", action("design_concept_orch", "hydra-grill", { prompt_args: { scope: "orch", anchor: "issue-4806" } }));
    assert.match(out.prompt, /on \*\*issue #4806\*\* of gaberoo322\/hydra \(anchor `issue-4806`, scope=orch\)/);
    assert.match(out.prompt, /Grill against `origin\/master`/);
    assert.match(out.prompt, /no neutral option matrices/);
    assert.match(out.prompt, /api\/design-concepts\/issue-4806` \(use the skill's `grill-artifact\.sh`/);
    assert.equal(out.model, "fable");
  });

  test("dev_target asks for delegated mode; a resume pin names the issue, PR and branch", () => {
    const fresh = render("dev_target", action("dev_target", "hydra-target-build", { isolation: "self" }));
    assert.match(fresh.prompt, /\*\*Use delegated mode\*\*/);
    assert.match(fresh.prompt, /Pick ONE `ready-for-agent` Target issue/);
    const resume = render(
      "dev_target",
      action("dev_target", "hydra-target-build", {
        isolation: "self",
        prompt_args: { anchor: "issue-210", resume: true, resume_issue: 210, resume_pr: 240, resume_branch: "feature/x-t1-dev_target" },
      }),
    );
    assert.match(resume.prompt, /RESUME pin: Target issue #210 is `needs-dev-resume` with open PR #240 on branch `feature\/x-t1-dev_target`/);
    assert.doesNotMatch(resume.prompt, /Pick ONE/);
  });

  test("wayfinder_orch: claim first, ticket-type routes the skill, the three-step resolution protocol", () => {
    const task = render("wayfinder_orch", action("wayfinder_orch", "hydra-issue-research", { prompt_args: { ticket: "issue-4705", ticket_type: "task" } }));
    assert.equal(task.skill, "hydra-dev", "task tickets run hydra-dev (#3351)");
    assert.match(task.prompt, /Step 0 — CLAIM FIRST \(issue #3354\): `gh issue edit 4705 --repo gaberoo322\/hydra --add-assignee @me`/);
    assert.match(task.prompt, /invoke the `hydra-dev` skill on #4705/);
    assert.match(task.prompt, /\(1\) post a resolution comment.*\(2\) close the ticket.*\(3\) append a line to the parent map's `## Decisions so far`/);
    assert.equal(task.model, null, "wayfinder_orch inherits the parent");
    assert.equal(task.description, "wayfinder_orch: hydra-dev on ticket #4705");
    const research = render("wayfinder_orch", action("wayfinder_orch", "hydra-issue-research", { prompt_args: { ticket: "issue-4706", ticket_type: "research" } }));
    assert.equal(research.skill, "hydra-issue-research");
    assert.match(research.prompt, /invoke the `hydra-issue-research` skill on #4706/);
  });

  test("apply:true scan classes say so, issue-producing classes carry the admission rule, sweeps carry the label-API rule", () => {
    const retro = render("retro_orch", action("retro_orch", "hydra-retro", { prompt_args: { apply: true } }));
    assert.match(retro.prompt, /`apply: true` — this is a REAL run, not a dry run/);
    assert.match(retro.prompt, /Admission rule \(operator directive 2026-08-19\)/);
    assert.match(retro.prompt, /Invoke the `hydra-retro` skill \(via the Skill tool; apply: true\)/);
    const sweep = render("sweep_orch", action("sweep_orch", "hydra-sweep", { prompt_args: { scope: "orch", anchor: "issue-4823" } }));
    assert.match(sweep.prompt, /match by closing ref, not by title/);
    assert.match(sweep.prompt, /put its name in the URL PATH \(`DELETE \.\.\.\/labels\/<name>`\)/);
    const health = render("health", action("health", "hydra-doctor"));
    assert.doesNotMatch(health.prompt, /Admission rule/);
    assert.match(health.prompt, /Invoke the `hydra-doctor` skill \(via the Skill tool\) and follow it end to end/);
  });

  test("dispatcher notes are appended verbatim, after the skeleton", () => {
    const notes = "- PR #4826 is at head fc7a492c\n- skip #4700, it already has a verdict\n";
    const r = run("qa_orch", [action("qa_orch", "hydra-qa", { prompt_args: { scope: "orch" } })], baseState(), ["--notes", "-"], { input: notes });
    assert.equal(r.status, 0, r.stderr);
    const out: Rendered = JSON.parse(r.stdout);
    assert.ok(out.prompt.endsWith(`Notes from the dispatcher:\n${notes.trim()}\n`), out.prompt.slice(-300));
    const viaFile = run("qa_orch", [action("qa_orch", "hydra-qa")], baseState(), ["--notes-file", join(r.dir, "notes.md")]);
    assert.equal(viaFile.status, 2, "missing notes file → exit 2");
    writeFileSync(join(r.dir, "notes.md"), notes);
    const ok = run("qa_orch", [action("qa_orch", "hydra-qa")], baseState(), ["--notes-file", join(r.dir, "notes.md")]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.ok((JSON.parse(ok.stdout) as Rendered).prompt.includes(notes.trim()));
  });
});

// ---------------------------------------------------------------------------
describe("render-dispatch.py — model resolution (#1093, #3274, #4585)", () => {
  test("the routing table parsed from the playbook covers every taxonomy class except the two that inherit by omission", () => {
    const seen: Record<string, string | null> = {};
    for (const cls of CLASSES) {
      const skill = "hydra-x";
      const out = render(cls, action(cls, skill));
      seen[cls] = out.model;
      assert.ok(out.model === null || ["fable", "sonnet", "haiku", "opus"].includes(out.model), `${cls}: ${out.model}`);
    }
    const inherit = CLASSES.filter((c) => seen[c] === null).sort();
    assert.deepEqual(inherit, ["design_qa_target", "skill_prune", "tickets_orch", "wayfinder_orch", "wire_or_retire_target"],
      "inherit set drifted — a routing row was added or removed; update this pin deliberately");
    assert.equal(seen.dev_orch, "sonnet");
    assert.equal(seen.cleanup_orch, "haiku");
    assert.equal(seen.dev_target, "fable");
  });

  test("the table rows the renderer reads are the playbook's rows", () => {
    const section = PLAYBOOK.slice(PLAYBOOK.indexOf("### Per-class model routing"));
    const rows = [...section.slice(0, section.indexOf("\n### ", 10)).matchAll(/^\| (`[^|]+?)\s*\| ([^|]+?)\s*\|$/gm)];
    const classesInTable = rows.flatMap((m) => [...m[1].matchAll(/`([a-z][a-z0-9_]*)`/g)].map((x) => x[1]));
    assert.ok(classesInTable.length >= 18, `table rows parsed: ${classesInTable.length}`);
    for (const cls of classesInTable) {
      const cell = rows.find((m) => m[1].includes(`\`${cls}\``))![2].trim().split(/\s+/)[0].toLowerCase();
      const out = render(cls, action(cls, "hydra-x"));
      assert.equal(out.model, cell === "inherit" ? null : cell, cls);
      assert.equal(out.model_source, cell === "inherit" ? "routing-table:inherit" : "routing-table", cls);
    }
  });

  test("escalate_model overrides the static row", () => {
    const out = render("cleanup_orch", action("cleanup_orch", "hydra-cleanup", { prompt_args: { apply: true, escalate_model: "sonnet", attempt: 2, prior_attempt_status: "no_op" } }));
    assert.equal(out.model, "sonnet");
    assert.equal(out.model_source, "escalate_model");
  });

  test("Fable exhausted (reasons.fableExhaustedUntil in the future) → opus, or $HYDRA_AUTOPILOT_FALLBACK_MODEL", () => {
    const exhausted = baseState({ usage_eligibility: { allow: true, reasons: { fableExhaustedUntil: "2099-01-01T00:00:00.000Z" } } });
    const a = action("dev_target", "hydra-target-build", { isolation: "self" });
    const out = render("dev_target", a, exhausted);
    assert.equal(out.model, "opus");
    assert.equal(out.model_source, "routing-table→fable-exhausted-fallback");
    const env = render("dev_target", a, exhausted, { HYDRA_AUTOPILOT_FALLBACK_MODEL: "sonnet" });
    assert.equal(env.model, "sonnet");
    const hint = render("cleanup_orch", action("cleanup_orch", "hydra-cleanup", { prompt_args: { escalate_model: "fable" } }), exhausted);
    assert.equal(hint.model, "opus", "the hint is pre-resolved too");
    assert.equal(hint.model_source, "escalate_model→fable-exhausted-fallback");
    const expired = baseState({ usage_eligibility: { allow: true, reasons: { fableExhaustedUntil: "2020-01-01T00:00:00.000Z" } } });
    assert.equal(render("dev_target", a, expired).model, "fable", "an expired flag does nothing");
    const sonnetClass = render("dev_orch", action("dev_orch", "hydra-dev"), exhausted);
    assert.equal(sonnetClass.model, "sonnet", "non-fable rows are untouched");
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
    const r = run("dev_orch", [action("dev_orch", "hydra-dev")], baseState(), ["--prompt-only"]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.startsWith("<!-- hydra-dispatch v1"));
    assert.ok(r.stdout.includes("## Task"));
    assert.throws(() => JSON.parse(r.stdout));
  });

  test("usage / unreadable inputs → exit 2", () => {
    const noArgs = spawnSync("python3", [SCRIPT], { encoding: "utf-8" });
    assert.equal(noArgs.status, 2);
    assert.match(noArgs.stderr, /usage:/);
    const badFlag = run("dev_orch", [action("dev_orch", "hydra-dev")], baseState(), ["--bogus"]);
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

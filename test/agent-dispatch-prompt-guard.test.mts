/**
 * Regression tests for the Agent-dispatch prompt guard (issue #5143, Refs
 * #4839).
 *
 * Failure mode being prevented: the unattended autopilot parent is meant to
 * pass `render-dispatch.py`'s `prompt` to the Agent tool verbatim. In the
 * Sonnet-parent trial 25 class dispatches went out with a literal placeholder
 * instead (`PLACEHOLDER`, `$(placeholder)`, `$(see below)`,
 * `$(cat /tmp/….json | jq -r .prompt)`), and two were never corrected.
 *
 * The guard is a PreToolUse hook on the `Agent` tool. What each test pins:
 *
 *   - in scope = HYDRA_AUTOPILOT_TRIGGER non-empty AND no `agent_id` in the
 *     payload (the parent's main thread); the `agent_id` arm is replayed with
 *     a REAL child payload shape (test/fixtures/agent-dispatch-prompt-guard/);
 *   - in scope, a real rendered prompt for EVERY class in classes.json, plus
 *     the prompt_args variants (resume, forward-fix, pr_ref, wayfinder,
 *     escalate_model), is ALLOWED — including when the embedded issue text /
 *     dispatcher notes quote `$(...)` or the word "placeholder" (#5145 QA
 *     round 1: a rendered prompt's content is never token-scanned);
 *   - in scope, the observed placeholder shapes, a prompt with no exact
 *     `## Task` heading line, and an empty / placeholder-only `## Task`
 *     section are DENIED with the harness deny contract (exit 2, stderr JSON
 *     permissionDecision "deny") naming render-dispatch.py;
 *   - out of scope (env var unset or empty, `agent_id` present, or a tool
 *     other than `Agent`), any prompt is ALLOWED;
 *   - .claude/settings.json registers the hook on the `Agent` matcher;
 *   - malformed input fails OPEN (exit 0) with a stderr warning.
 *
 * The hook is shell + python3, so it is exercised as a subprocess fed stdin,
 * mirroring test/gh-label-delete-guard.test.mts. The renderer is only a
 * fixture source here; its path is built from a named constant so
 * scripts/ci/test-subject-map.ts resolves this file's primary subject to the
 * hook alone (render-dispatch.py's own contract lives in
 * test/autopilot-render-dispatch.test.mts).
 */

import test, { describe, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const HOOK = resolve(REPO_ROOT, "scripts/claude-hooks/agent-dispatch-prompt-guard.sh");
const AUTOPILOT_DIR = join(REPO_ROOT, "scripts", "autopilot");
const RENDERER_NAME = "render-dispatch.py";
const RENDERER = join(AUTOPILOT_DIR, RENDERER_NAME);
const HOOK_REL = "scripts/claude-hooks/agent-dispatch-prompt-guard.sh";
const SETTINGS = join(REPO_ROOT, ".claude", "settings.json");
const CHILD_FIXTURE = join(REPO_ROOT, "test", "fixtures", "agent-dispatch-prompt-guard", "subagent-pretooluse-payload.json");
const CLASSES: string[] = JSON.parse(
  readFileSync(join(AUTOPILOT_DIR, "classes.json"), "utf-8"),
).classes.map((c: { name: string }) => c.name);

const IN_SCOPE = { HYDRA_AUTOPILOT_TRIGGER: "pace-gate" };
/** Absolute bash/cat, so a test can narrow PATH without losing them. */
const BASH = spawnSync("bash", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim();
const CAT = spawnSync("bash", ["-c", "command -v cat"], { encoding: "utf8" }).stdout.trim();

/** process.env without HYDRA_AUTOPILOT_TRIGGER, so a test run inside an
 * autopilot child never inherits scope by accident. */
function baseEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.HYDRA_AUTOPILOT_TRIGGER;
  return env;
}

function runHook(
  payload: unknown,
  env: Record<string, string> = IN_SCOPE,
  raw?: string,
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(BASH, [HOOK], {
    input: raw !== undefined ? raw : JSON.stringify(payload),
    encoding: "utf8",
    env: { ...baseEnv(), ...env },
  });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function agent(prompt: unknown, extra: Record<string, unknown> = {}) {
  return {
    session_id: "s-1",
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: { description: "dev_orch: hydra-dev on #1", prompt, run_in_background: true },
    ...extra,
  };
}

function assertDenied(r: ReturnType<typeof runHook>, why: RegExp) {
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}; stderr=${r.stderr}`);
  const jsonLine = r.stderr.split("\n").find((l) => l.startsWith("{"));
  assert.ok(jsonLine, `deny JSON on stderr: ${r.stderr}`);
  const out = JSON.parse(jsonLine!);
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  const reason: string = out.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /render-dispatch\.py/);
  assert.match(reason, /VERBATIM/);
  assert.match(reason, why);
}

function assertAllowed(r: ReturnType<typeof runHook>) {
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
  assert.equal(r.stderr.includes("permissionDecision"), false, r.stderr);
}

// ---------------------------------------------------------------------------
// Real renderer output for every class.

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** One scratch dir for every render: state/plan/notes are overwritten per call. */
let renderDir: string | undefined;
function scratch(): string {
  if (!renderDir) {
    renderDir = mkdtempSync(join(tmpdir(), "agent-prompt-guard-"));
    dirs.push(renderDir);
  }
  return renderDir;
}

interface RenderOpts {
  notes?: string;
  skill?: string;
  promptArgs?: Record<string, unknown>;
}

function renderPrompt(slot: string, isolation: "worktree" | "self", opts: RenderOpts = {}): string {
  const dir = scratch();
  const skill = opts.skill ?? "hydra-dev";
  const runId = "4dfd1dc9-e7ae-4729-af27-ab7fac74ef29";
  const state = {
    run_id: runId,
    turn: 4,
    slots: {},
    usage_eligibility: { allow: true, reasons: {} },
    turn_snapshot: {
      schema_version: 1,
      generated_at: "test-fixture",
      signals: { needs_qa_numbers: "4700", target_needs_qa_pr_head: "feature/x-t1-dev_target" },
      blobs: {},
      degraded: [],
      validation: { ok: true },
    },
  };
  const action = {
    type: "dispatch",
    slot,
    skill,
    prompt_args: opts.promptArgs ?? { anchor: "issue-1234", scope: "orch" },
    worktreeBranch: `worktree-agent-4dfd1dc9-t4-${slot}`,
    isolation,
    dispatchSentinel: `<!-- hydra-dispatch v1 skill=${skill} dispatchId=worktree-agent-4dfd1dc9-t4-${slot} runId=${runId} -->`,
  };
  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
  writeFileSync(join(dir, "plan.json"), JSON.stringify({ turn: 4, run_id: runId, actions: [action] }));
  const args = [RENDERER, slot];
  if (opts.notes !== undefined) {
    writeFileSync(join(dir, "notes.md"), opts.notes);
    args.push("--notes-file", join(dir, "notes.md"));
  }
  const r = spawnSync("python3", args, {
    cwd: dir,
    encoding: "utf-8",
    env: {
      ...process.env,
      HYDRA_AUTOPILOT_STATE: join(dir, "state.json"),
      HYDRA_AUTOPILOT_PLAN: join(dir, "plan.json"),
    },
  });
  assert.equal(r.status, 0, `render ${slot}/${isolation} failed: ${r.stderr}`);
  // The JSON form is what the parent reads: its `prompt` field goes to Agent.
  return JSON.parse(r.stdout).prompt;
}

/** prompt_args shapes whose `## Task` skeleton sentences differ (render-dispatch task_section). */
const VARIANTS: Array<{ name: string; slot: string; isolation: "worktree" | "self"; skill: string; promptArgs: Record<string, unknown> }> = [
  { name: "dev_orch resume with branch", slot: "dev_orch", isolation: "worktree", skill: "hydra-dev", promptArgs: { anchor: "issue-1234", scope: "orch", resume: true, resume_branch: "worktree-agent-abc-t3-dev_orch" } },
  { name: "dev_orch resume without branch", slot: "dev_orch", isolation: "worktree", skill: "hydra-dev", promptArgs: { anchor: "issue-1234", scope: "orch", resume: true } },
  { name: "dev_orch red-PR forward-fix", slot: "dev_orch", isolation: "worktree", skill: "hydra-dev", promptArgs: { anchor: "issue-1234", scope: "orch", resume: true, resume_branch: "fix/1234-x", forward_fix_pr: 5145 } },
  { name: "dev_orch unpinned", slot: "dev_orch", isolation: "worktree", skill: "hydra-dev", promptArgs: { scope: "orch" } },
  { name: "dev_orch escalate_model", slot: "dev_orch", isolation: "worktree", skill: "hydra-dev", promptArgs: { anchor: "issue-1234", scope: "orch", escalate_model: "opus" } },
  { name: "dev_target resume pin", slot: "dev_target", isolation: "self", skill: "hydra-target-build", promptArgs: { anchor: "issue-77", scope: "target", resume: true, resume_issue: 77, resume_pr: 88, resume_branch: "feature/x" } },
  { name: "qa_target pr_ref", slot: "qa_target", isolation: "self", skill: "hydra-target-qa", promptArgs: { scope: "target", pr_ref: "https://github.com/o/r/pull/88" } },
  { name: "wayfinder_orch task ticket", slot: "wayfinder_orch", isolation: "worktree", skill: "hydra-issue-research", promptArgs: { ticket: "issue-4200", ticket_type: "task" } },
  { name: "wayfinder_orch research ticket", slot: "wayfinder_orch", isolation: "worktree", skill: "hydra-issue-research", promptArgs: { ticket: "issue-4201", ticket_type: "research" } },
  { name: "signal class apply:true", slot: "cleanup_orch", isolation: "worktree", skill: "hydra-cleanup", promptArgs: { scope: "orch", apply: true } },
];

/** Issue text a dispatcher pastes into --notes: shell snippets and the word "placeholder" are routine. */
const ISSUE_TEXT_NOTES = [
  "Issue #1234 body, quoted for context:",
  "",
  "Repro: `git -C $(git rev-parse --show-toplevel) log -1` prints the wrong SHA; also `HEAD=$(git rev-parse HEAD)`.",
  "The config template still has a placeholder value for `TARGET_WT_BASE`; replace the PLACEHOLDER with origin/master.",
  "",
].join("\n");

describe("agent-dispatch-prompt-guard — in scope, rendered prompts pass", () => {
  test("every class in classes.json, both isolations, is ALLOWED", () => {
    assert.ok(CLASSES.length > 10, "classes.json parsed");
    for (const slot of CLASSES) {
      for (const isolation of ["worktree", "self"] as const) {
        const prompt = renderPrompt(slot, isolation, { skill: "hydra-dev" });
        assert.match(prompt, /^## Task$/m, `${slot}/${isolation} rendered a ## Task heading`);
        const r = runHook(agent(prompt));
        assert.equal(r.status, 0, `${slot}/${isolation} denied: ${r.stderr}`);
      }
    }
  });

  test("a rendered prompt with ordinary dispatcher notes is ALLOWED", () => {
    const prompt = renderPrompt("dev_orch", "worktree", { notes: "Lane head: origin/master at 961debfdf. PR #5133 merged.\n" });
    assertAllowed(runHook(agent(prompt)));
  });

  for (const v of VARIANTS) {
    test(`prompt_args variant "${v.name}" renders a prompt that is ALLOWED`, () => {
      const prompt = renderPrompt(v.slot, v.isolation, { skill: v.skill, promptArgs: v.promptArgs });
      assert.match(prompt, /^## Task$/m);
      assertAllowed(runHook(agent(prompt)));
    });
  }

  test("embedded issue text quoting `$(git rev-parse HEAD)` and the word \"placeholder\" is ALLOWED (#5145 QA r1)", () => {
    const prompt = renderPrompt("dev_orch", "worktree", { notes: ISSUE_TEXT_NOTES });
    assert.ok(prompt.includes("$(git rev-parse HEAD)") && /placeholder/i.test(prompt), "fixture embeds both tokens");
    assertAllowed(runHook(agent(prompt)));
  });

  test("a rendered prompt with a `$(…)` spliced into its notes is ALLOWED (content is not token-scanned)", () => {
    const prompt = renderPrompt("qa_orch", "worktree", { skill: "hydra-qa", notes: "Review $(gh pr list --json number -q '.[0].number')\n" });
    assertAllowed(runHook(agent(prompt)));
  });

  test("every prompt_args variant with issue-text notes is ALLOWED", () => {
    for (const v of VARIANTS) {
      const prompt = renderPrompt(v.slot, v.isolation, { skill: v.skill, promptArgs: v.promptArgs, notes: ISSUE_TEXT_NOTES });
      const r = runHook(agent(prompt));
      assert.equal(r.status, 0, `${v.name} denied: ${r.stderr}`);
    }
  });
});

describe("agent-dispatch-prompt-guard — in scope, unrendered prompts are denied", () => {
  for (const prompt of ["PLACEHOLDER", "placeholder", "$(placeholder)", "$(see below)"]) {
    test(`bare ${JSON.stringify(prompt)} is DENIED`, () => {
      const r = runHook(agent(prompt));
      assertDenied(r, /PLACEHOLDER|\$\(|## Task/);
    });
  }

  test("an unexpanded `$(cat … | jq -r .prompt)` substitution is DENIED", () => {
    const r = runHook(agent("$(cat /tmp/hydra-dispatch-dev_orch.json | jq -r .prompt)"));
    assertDenied(r, /\$\( shell substitution/);
  });

  test("a hand-written prompt with no `## Task` heading is DENIED", () => {
    const r = runHook(
      agent("<!-- hydra-dispatch v1 skill=hydra-dev dispatchId=x runId=y -->\n\nRead your full prompt from /tmp/prompt.md and follow it."),
    );
    assertDenied(r, /no '## Task' heading/);
  });

  test("a `## Task` section that is only a placeholder is DENIED", () => {
    const r = runHook(agent("## CRITICAL SAFETY RULE\n\n## Task\nPLACEHOLDER — fill in later\n"));
    assertDenied(r, /PLACEHOLDER token/);
  });

  test("a `## Task` section that is only `$(placeholder)` is DENIED", () => {
    const r = runHook(agent("<!-- hydra-dispatch v1 skill=hydra-dev dispatchId=x runId=y -->\n\n## Task\n\n$(placeholder)\n"));
    assertDenied(r, /\$\( shell substitution/);
  });

  test("an empty `## Task` section is DENIED", () => {
    const r = runHook(agent("## CRITICAL SAFETY RULE\nRun pwd.\n\n## Task\n\n## Notes\nsee issue\n"));
    assertDenied(r, /'## Task' section is empty/);
  });

  test("a `## Task` heading at the very end with no body is DENIED", () => {
    assertDenied(runHook(agent("## CRITICAL SAFETY RULE\n\n## Task\n")), /'## Task' section is empty/);
  });

  test("a prompt that STARTS with a placeholder token is DENIED even with a `## Task` later", () => {
    const r = runHook(agent("PLACEHOLDER\n\n## Task\nInvoke the `hydra-dev` skill on issue #1.\n"));
    assertDenied(r, /PLACEHOLDER token/);
  });

  test("leading whitespace and a bracketed `<placeholder>` are still a bare placeholder", () => {
    assertDenied(runHook(agent("  \n <placeholder>\n")), /PLACEHOLDER token/);
  });

  test("`## Task` mentioned inline (not as a heading line) does not count", () => {
    const r = runHook(agent("Please do the ## Task described in issue #1."));
    assertDenied(r, /no '## Task' heading/);
  });

  test("the heading must be exactly `## Task` (trailing text or spaces do not count)", () => {
    assertDenied(runHook(agent("## Task: do issue #1\nInvoke the skill.\n")), /no '## Task' heading/);
    assertDenied(runHook(agent("## Task  \nInvoke the skill.\n")), /no '## Task' heading/);
    assertDenied(runHook(agent("### Task\nInvoke the skill.\n")), /no '## Task' heading/);
  });

  test("a CRLF `## Task` heading line still counts", () => {
    assertAllowed(runHook(agent("## Task\r\nInvoke the `hydra-dev` skill on issue #1.\r\n")));
  });

  test("python stderr noise does not change the verdict (stdout verdict line only)", () => {
    // PYTHONVERBOSE floods python's stderr with import traces.
    const r = runHook(agent("PLACEHOLDER"), { ...IN_SCOPE, PYTHONVERBOSE: "1" });
    assertDenied(r, /PLACEHOLDER token/);
  });
});

describe("agent-dispatch-prompt-guard — out of scope is never blocked", () => {
  test("interactive session (HYDRA_AUTOPILOT_TRIGGER unset): a free-form prompt is ALLOWED", () => {
    assertAllowed(runHook(agent("Explore the repo and find every caller of moveItemToLane."), {}));
  });

  test("interactive session: even a PLACEHOLDER prompt is ALLOWED", () => {
    assertAllowed(runHook(agent("PLACEHOLDER"), {}));
  });

  test("HYDRA_AUTOPILOT_TRIGGER set but empty counts as interactive", () => {
    assertAllowed(runHook(agent("PLACEHOLDER"), { HYDRA_AUTOPILOT_TRIGGER: "" }));
  });

  test("inside a dispatched child (agent_id present): free-form reviewer fan-out is ALLOWED", () => {
    const r = runHook(agent("You are the Standards reviewer. Review the diff for $(…) misuse.", { agent_id: "a1b2c3d4e5f6" }));
    assertAllowed(r);
  });

  test("a non-Agent tool is ALLOWED", () => {
    assertAllowed(runHook({ tool_name: "Bash", tool_input: { command: "echo PLACEHOLDER $(date)" } }));
  });

  test("the legacy `Task` tool name is not inspected (the hook is registered on `Agent` only)", () => {
    assertAllowed(runHook({ ...agent("PLACEHOLDER"), tool_name: "Task" }));
  });
});

describe("agent-dispatch-prompt-guard — child detection on a real subagent payload shape", () => {
  const fixture = JSON.parse(readFileSync(CHILD_FIXTURE, "utf-8")) as { payload: Record<string, unknown> };
  const childPayload = fixture.payload;

  test("the fixture carries the field set on-subagent-tool-call.sh reads from a child payload", () => {
    for (const key of ["session_id", "transcript_path", "cwd", "agent_id", "tool_name", "tool_input"]) {
      assert.ok(key in childPayload, `fixture has ${key}`);
    }
    assert.match(String(childPayload.agent_id), /^[0-9a-f]{8,40}$/, "agent_id passes that hook's hex-shape check");
    assert.equal(childPayload.tool_name, "Agent");
  });

  test("in scope, a child's free-form Agent call with the real payload shape is ALLOWED", () => {
    const prompt = (childPayload.tool_input as { prompt: string }).prompt;
    assert.doesNotMatch(prompt, /^## Task$/m, "the child's prompt is free-form (would be denied on the main thread)");
    assertAllowed(runHook(childPayload));
  });

  test("in scope, a child's Agent call is ALLOWED even with a placeholder prompt", () => {
    const tool_input = { ...(childPayload.tool_input as object), prompt: "PLACEHOLDER" };
    assertAllowed(runHook({ ...childPayload, tool_input }));
  });

  test("the same payload WITHOUT agent_id (the parent's main thread) is DENIED", () => {
    const { agent_id: _omit, ...parentPayload } = childPayload;
    assertDenied(runHook(parentPayload), /no '## Task' heading/);
  });
});

describe("agent-dispatch-prompt-guard — .claude/settings.json registration", () => {
  const settings = JSON.parse(readFileSync(SETTINGS, "utf-8")) as {
    hooks?: { PreToolUse?: Array<{ matcher?: string; hooks?: Array<{ type?: string; command?: string }> }> };
    [key: string]: unknown;
  };

  test("hooks.PreToolUse registers the guard on a matcher covering `Agent`", () => {
    const blocks = settings.hooks?.PreToolUse ?? [];
    const hit = blocks.find((b) =>
      typeof b.matcher === "string" &&
      new RegExp(`^(?:${b.matcher})$`).test("Agent") &&
      (b.hooks ?? []).some((h) => h.type === "command" && typeof h.command === "string" && h.command.trim().endsWith(HOOK_REL)),
    );
    assert.ok(hit, `no PreToolUse block with an Agent matcher runs ${HOOK_REL}: ${JSON.stringify(blocks)}`);
  });

  test("a `_comment_` key documents the guard and cites #5143", () => {
    const comments = Object.entries(settings).filter(
      ([k, v]) => k.startsWith("_comment_") && typeof v === "string" && v.includes("#5143"),
    );
    assert.ok(comments.length >= 1, "a _comment_* key mentions #5143");
  });
});

describe("agent-dispatch-prompt-guard — fails open on bad input", () => {
  test("malformed JSON stdin exits 0 with a warning", () => {
    const r = runHook(null, IN_SCOPE, "{not json");
    assert.equal(r.status, 0);
    assert.match(r.stderr, /agent-dispatch-prompt-guard: WARN .*not valid JSON.*failing open/);
  });

  test("empty stdin exits 0 with a warning", () => {
    const r = runHook(null, IN_SCOPE, "");
    assert.equal(r.status, 0);
    assert.match(r.stderr, /WARN/);
  });

  test("a JSON array payload exits 0 with a warning", () => {
    const r = runHook([1, 2], IN_SCOPE);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /not an object/);
  });

  test("an Agent call with no prompt exits 0 with a warning", () => {
    const r = runHook({ tool_name: "Agent", tool_input: { description: "x" } });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /tool_input\.prompt is missing/);
  });

  test("a non-string prompt exits 0 with a warning", () => {
    const r = runHook(agent(42));
    assert.equal(r.status, 0);
    assert.match(r.stderr, /not a string/);
  });

  test("a missing python3 fails open with a warning", () => {
    // PATH holds only `cat`, so the hook reads stdin but cannot find python3.
    const bin = mkdtempSync(join(tmpdir(), "agent-prompt-guard-bin-"));
    dirs.push(bin);
    symlinkSync(CAT, join(bin, "cat"));
    const r = runHook(agent("PLACEHOLDER"), { ...IN_SCOPE, PATH: bin });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /WARN python3 exited 127/);
  });
});

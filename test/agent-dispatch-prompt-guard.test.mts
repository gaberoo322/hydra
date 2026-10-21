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
 *     payload (the parent's main thread);
 *   - in scope, a real rendered prompt for EVERY class in classes.json is
 *     ALLOWED — so a future preamble edit that adds `$(` or "placeholder" to
 *     the rendered text fails here instead of wedging every dispatch;
 *   - in scope, the observed placeholder shapes and a prompt with no
 *     `## Task` heading are DENIED with the harness deny contract (exit 2,
 *     stderr JSON permissionDecision "deny") naming render-dispatch.py;
 *   - out of scope (env var unset or empty, or `agent_id` present), any
 *     prompt is ALLOWED;
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

function renderPrompt(slot: string, isolation: "worktree" | "self", notes?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-prompt-guard-"));
  dirs.push(dir);
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
    skill: "hydra-dev",
    prompt_args: { anchor: "issue-1234", scope: "orch" },
    worktreeBranch: `worktree-agent-4dfd1dc9-t4-${slot}`,
    isolation,
    dispatchSentinel: `<!-- hydra-dispatch v1 skill=hydra-dev dispatchId=worktree-agent-4dfd1dc9-t4-${slot} runId=${runId} -->`,
  };
  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
  writeFileSync(join(dir, "plan.json"), JSON.stringify({ turn: 4, run_id: runId, actions: [action] }));
  const args = [RENDERER, slot];
  if (notes !== undefined) {
    writeFileSync(join(dir, "notes.md"), notes);
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

describe("agent-dispatch-prompt-guard — in scope, rendered prompts pass", () => {
  test("every class in classes.json, both isolations, is ALLOWED", () => {
    assert.ok(CLASSES.length > 10, "classes.json parsed");
    for (const slot of CLASSES) {
      for (const isolation of ["worktree", "self"] as const) {
        const prompt = renderPrompt(slot, isolation);
        assert.match(prompt, /^## Task$/m, `${slot}/${isolation} rendered a ## Task heading`);
        const r = runHook(agent(prompt));
        assert.equal(r.status, 0, `${slot}/${isolation} denied: ${r.stderr}`);
      }
    }
  });

  test("a rendered prompt with ordinary dispatcher notes is ALLOWED", () => {
    const prompt = renderPrompt("dev_orch", "worktree", "Lane head: origin/master at 961debfdf. PR #5133 merged.\n");
    assertAllowed(runHook(agent(prompt)));
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

  test("a `## Task` prompt that still carries a placeholder is DENIED", () => {
    const r = runHook(agent("## CRITICAL SAFETY RULE\n\n## Task\nPLACEHOLDER — fill in later\n"));
    assertDenied(r, /PLACEHOLDER token/);
  });

  test("a rendered prompt with a `$(…)` spliced into its notes is DENIED", () => {
    const prompt = renderPrompt("qa_orch", "worktree", "Review $(gh pr list --json number -q '.[0].number')\n");
    assertDenied(runHook(agent(prompt)), /\$\( shell substitution/);
  });

  test("`## Task` mentioned inline (not as a heading line) does not count", () => {
    const r = runHook(agent("Please do the ## Task described in issue #1."));
    assertDenied(r, /no '## Task' heading/);
  });

  test("the legacy `Task` tool name is guarded the same way", () => {
    const r = runHook({ ...agent("PLACEHOLDER"), tool_name: "Task" });
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

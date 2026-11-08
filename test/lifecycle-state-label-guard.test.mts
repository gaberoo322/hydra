/**
 * Regression tests for the lifecycle state-label deny hook (issue #5322,
 * ADR-0047 Decision 3 / Decision 7).
 *
 * `scripts/claude-hooks/lifecycle-state-label-guard.sh` is a PreToolUse Bash
 * hook that DENIES a hand-written write of one of the 13 lifecycle STATE
 * labels (`gh issue edit|create` label flags, mutating `gh api .../labels`)
 * and names the lifecycle CLI. Flag labels, reads, `gh pr edit` and the CLI
 * itself are allowed. Tested like gh-label-delete-guard: spawn the hook with
 * JSON stdin and read the exit code / stderr.
 *
 * Several command strings are built by concatenation so the LIVE sibling
 * guards in this repo's own session never see a literal write.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { OPEN_STATES } from "../src/lifecycle/index.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const HOOK = resolve(REPO_ROOT, "scripts/claude-hooks/lifecycle-state-label-guard.sh");

function runHook(payload: unknown, raw?: string): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const input = raw !== undefined ? raw : JSON.stringify(payload);
  const r = spawnSync("bash", [HOOK], { input, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function bash(command: string) {
  return { tool_name: "Bash", tool_input: { command } };
}

const GH_EDIT = "gh issue " + "edit";
const GH_CREATE = "gh issue " + "create";
const GH_API = "gh " + "api";
const ADD = "--add-" + "label";
const REMOVE = "--remove-" + "label";

function assertDeny(command: string): void {
  const r = runHook(bash(command));
  assert.equal(r.status, 2, `expected deny for: ${command}; got ${r.status}; stderr=${r.stderr}`);
}

function assertAllow(command: string): void {
  const r = runHook(bash(command));
  assert.equal(r.status, 0, `expected allow for: ${command}; got ${r.status}; stderr=${r.stderr}`);
}

describe("lifecycle-state-label-guard: denies direct state-label writes", () => {
  test("gh issue edit --add-label in-progress", () => {
    assertDeny(`${GH_EDIT} 42 ${ADD} in-progress`);
  });

  test("the child-flow two-flag form (continuation lines)", () => {
    assertDeny(
      `${GH_EDIT} "$ISSUE_NUMBER" --repo gaberoo322/hydra \\\n  ${REMOVE} ready-for-agent \\\n  ${ADD} in-progress`,
    );
  });

  test("--add-label=needs-qa (equals form)", () => {
    assertDeny(`${GH_EDIT} 42 ${ADD}=needs-qa`);
  });

  test("single-quoted, double-quoted and comma-list operands", () => {
    assertDeny(`${GH_EDIT} 42 ${ADD} 'needs-qa'`);
    assertDeny(`${GH_EDIT} 42 ${ADD} "needs-qa"`);
    assertDeny(`${GH_EDIT} 42 ${ADD} "enhancement,needs-triage"`);
  });

  test("a remove of a state label is denied too", () => {
    assertDeny(`${GH_EDIT} 42 ${REMOVE} ready-for-agent`);
  });

  test("gh issue create --label needs-triage and -l ready-for-agent", () => {
    assertDeny(`${GH_CREATE} --title t --label needs-triage`);
    assertDeny(`${GH_CREATE} --title t -l ready-for-agent`);
  });

  test("gh api labels POST naming a state via labels[]=", () => {
    assertDeny(`${GH_API} repos/o/r/issues/42/labels -f 'labels[]=in-progress'`);
  });

  test("gh api single-label DELETE path naming a state", () => {
    assertDeny(`${GH_API} -X ` + "DELETE" + ` repos/o/r/issues/42/labels/ready-for-agent`);
  });

  test("gh api raw JSON payload naming a state", () => {
    assertDeny(`${GH_API} repos/o/r/issues/42/labels --input - <<< '{"labels":["needs-qa"]}'`);
    assertDeny(`${GH_API} -X POST repos/o/r/issues/42/labels -f name=blocked`);
  });

  test("after a leading VAR=state binding", () => {
    assertDeny(`L=in-progress; ${GH_EDIT} 42 ${ADD} "$L"`);
  });

  test("every one of the 13 states is denied", () => {
    for (const s of OPEN_STATES) assertDeny(`${GH_EDIT} 7 ${ADD} ${s}`);
  });

  test("deny payload shape names the CLI and ADR-0047 D3", () => {
    const r = runHook(bash(`${GH_EDIT} 42 ${ADD} in-progress`));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /npx tsx scripts\/lifecycle\.ts advance <issue> <to>/);
    assert.match(r.stderr, /ADR-0047 D3/);
    const jsonLine = r.stderr.split("\n").find((l) => l.startsWith("{"));
    assert.ok(jsonLine, "stderr carries the JSON deny payload");
    const parsed = JSON.parse(jsonLine);
    assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
    assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
  });
});

describe("lifecycle-state-label-guard: allows everything else", () => {
  test("flag labels on issue edit / create", () => {
    for (const flag of [
      "glm-eligible",
      "needs-design-concept",
      "enhancement",
      "conflict-fix-attempted",
      "keep-open",
      "target-backlog",
      "wayfinder:map",
      "architecture-scan",
    ]) {
      assertAllow(`${GH_EDIT} 42 ${ADD} ${flag}`);
      assertAllow(`${GH_CREATE} --title t --label ${flag}`);
    }
    assertAllow(`${GH_EDIT} 42 ${ADD} "enhancement,glm-eligible"`);
  });

  test("a flag label whose name merely contains a state is allowed", () => {
    assertAllow(`${GH_EDIT} 42 ${ADD} blocked-by-vendor`);
    assertAllow(`${GH_EDIT} 42 ${ADD} not-needs-qa`);
  });

  test("gh pr edit labels are PR flags", () => {
    assertAllow(`gh pr ` + `edit 42 ${ADD} ready-for-human`);
  });

  test("read verbs", () => {
    assertAllow("gh issue list --label ready-for-agent");
    assertAllow("gh issue view 42 --json labels");
    assertAllow(`${GH_API} repos/o/r/issues/42/labels`);
    assertAllow("gh search issues --label in-progress");
  });

  test("flag-label gh api writes", () => {
    assertAllow(`${GH_API} repos/o/r/issues/42/labels -f 'labels[]=glm-eligible'`);
    assertAllow(`${GH_API} -X ` + "DELETE" + ` repos/o/r/issues/42/labels/glm-eligible`);
  });

  test("the lifecycle CLI itself, and a chain with a comment", () => {
    assertAllow("npx tsx scripts/lifecycle.ts advance 42 needs-qa --evidence pr=7");
    assertAllow(
      "npx tsx scripts/lifecycle.ts advance 42 needs-qa --evidence pr=7 && gh issue comment 42 --body done",
    );
  });

  test("recover-stale.sh is not inspected", () => {
    assertAllow("bash scripts/autopilot/recover-stale.sh");
  });

  test("echo / comment mentions", () => {
    assertAllow(`echo "${GH_EDIT} 42 ${ADD} in-progress"`);
    assertAllow(`# ${GH_EDIT} 42 ${ADD} in-progress`);
  });

  test("an unresolvable $VAR operand fails open", () => {
    assertAllow(`${GH_EDIT} 42 ${ADD} "$NEWSTATE"`);
  });
});

describe("lifecycle-state-label-guard: fail-open on bad input", () => {
  test("non-Bash tool", () => {
    const r = runHook({ tool_name: "Read", tool_input: { file_path: "/x" } });
    assert.equal(r.status, 0);
  });

  test("malformed JSON", () => {
    const r = runHook(null, "{not json");
    assert.equal(r.status, 0);
  });

  test("empty command", () => {
    const r = runHook(bash(""));
    assert.equal(r.status, 0);
  });

  test("missing tool_input", () => {
    const r = runHook({ tool_name: "Bash" });
    assert.equal(r.status, 0);
  });
});

describe("lifecycle-state-label-guard: vocabulary drift (INV-8)", () => {
  test("the embedded state list equals OPEN_STATES", () => {
    const src = readFileSync(HOOK, "utf8");
    const block = /LIFECYCLE_STATES_BEGIN([\s\S]*?)LIFECYCLE_STATES_END/.exec(src);
    assert.ok(block, "BEGIN/END markers present");
    const embedded = [...block[1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
    assert.deepEqual(new Set(embedded), new Set(OPEN_STATES));
    assert.equal(embedded.length, OPEN_STATES.length, "no duplicates");
  });
});

describe("lifecycle-state-label-guard: performance", () => {
  test("median of 5 runs under 1000ms", () => {
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = Date.now();
      const r = runHook(bash(`${GH_EDIT} 42 ${ADD} enhancement`));
      samples.push(Date.now() - start);
      assert.equal(r.status, 0);
    }
    samples.sort((a, b) => a - b);
    assert.ok(samples[2] < 1000, `guard median ${samples[2]}ms (samples ${samples.join(",")})`);
  });
});

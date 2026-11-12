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
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
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
    assertDeny(`${GH_API} repos/gaberoo322/hydra/issues/42/labels -f 'labels[]=in-progress'`);
  });

  test("gh api single-label DELETE path naming a state", () => {
    assertDeny(`${GH_API} -X ` + "DELETE" + ` repos/gaberoo322/hydra/issues/42/labels/ready-for-agent`);
  });

  test("gh api raw JSON payload naming a state", () => {
    assertDeny(`${GH_API} repos/gaberoo322/hydra/issues/42/labels --input - <<< '{"labels":["needs-qa"]}'`);
    assertDeny(`${GH_API} -X POST repos/gaberoo322/hydra/issues/42/labels -f name=blocked`);
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

  test("issue edit/create on another repo (the Target board) is outside the seam", () => {
    assertAllow(`${GH_CREATE} --repo "$TARGET_GH_REPO" --title t --label blocked`);
    assertAllow(`${GH_EDIT} 42 --repo owner/target ${ADD} ready-for-agent`);
    assertDeny(`${GH_EDIT} 42 --repo gaberoo322/hydra ${ADD} ready-for-agent`);
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

describe("lifecycle-state-label-guard: QA round-2 hardening (#5322)", () => {
  // finding 1 (high): shell keywords stay as leading tokens
  test("denies a state write behind do/then/else/( { ! keywords", () => {
    assertDeny(`for n in 1 2; do ${GH_EDIT} $n ${ADD} needs-qa; done`);
    assertDeny(`if true; then ${GH_EDIT} 5 ${ADD} needs-qa; fi`);
    assertDeny(`(${GH_EDIT} 5 ${ADD} needs-qa)`);
    assertDeny(`{ ${GH_EDIT} 5 ${ADD} needs-qa; }`);
  });
  test("keyword-wrapped FLAG label write is still allowed (sibling pin)", () => {
    assertAllow(`for n in 1 2; do ${GH_EDIT} $n ${ADD} glm-eligible; done`);
    assertAllow(`if true; then ${GH_EDIT} 5 ${ADD} enhancement; fi`);
  });

  // finding 8: wrapper bypasses
  test("denies bash -c / sh -c / xargs / timeout / sudo -u wrappers", () => {
    assertDeny(`bash -c '${GH_EDIT} 5 ${ADD} needs-qa'`);
    assertDeny(`sh -lc "${GH_EDIT} 5 ${ADD} needs-qa"`);
    assertDeny(`echo 5 | xargs -I{} ${GH_EDIT} {} ${ADD} needs-qa`);
    assertDeny(`timeout 5 ${GH_EDIT} 5 ${ADD} needs-qa`);
    assertDeny(`sudo -u bob ${GH_EDIT} 5 ${ADD} needs-qa`);
  });
  test("wrapped FLAG label writes and wrapped reads stay allowed (sibling pin)", () => {
    assertAllow(`bash -c '${GH_EDIT} 5 ${ADD} glm-eligible'`);
    assertAllow(`timeout 5 ${GH_EDIT} 5 ${ADD} enhancement`);
    assertAllow(`bash -c 'gh issue list --label ready-for-agent'`);
  });

  // finding 4: PATCH payload scanning limited to label-bearing fields
  test("PATCH issues/N: state word in title is not a label write", () => {
    assertAllow(`${GH_API} -X PATCH repos/gaberoo322/hydra/issues/5 -f title='unblock: blocked on X' -f 'labels[]=bug'`);
  });
  test("PATCH issues/N: state in labels[] is still denied (sibling pin)", () => {
    assertDeny(`${GH_API} -X PATCH repos/gaberoo322/hydra/issues/5 -f title=t -f 'labels[]=blocked'`);
  });

  // finding 9: GraphQL label mutation
  test("gh api graphql label mutation naming a state is denied", () => {
    assertDeny(`${GH_API} graphql -f query='mutation { addLabelsToLabelable(input:{labelableId:"X", labelIds:["needs-qa"]}) { clientMutationId } }'`);
  });
  test("gh api graphql read query naming a state is allowed (sibling pin)", () => {
    assertAllow(`${GH_API} graphql -f query='{ repository(owner:"a",name:"b") { label(name:"needs-qa") { id } } }'`);
  });

  // finding 7: --repo exemption narrowed to the Target idiom
  test("--repo $TARGET_REPO (not the sanctioned idiom) is inspected", () => {
    assertDeny(`${GH_EDIT} 5 --repo $TARGET_REPO ${ADD} in-progress`);
  });
  test("--repo $TARGET_GH_REPO stays exempt (sibling pin)", () => {
    assertAllow(`${GH_EDIT} 5 --repo "$TARGET_GH_REPO" ${ADD} in-progress`);
  });

  // finding 5: INV-7 fail-closed when the python verdict machinery crashes
  function runWithBrokenVerdictPython(command: string) {
    const dir = mkdtempSync(join(tmpdir(), "lsg-shim-"));
    const real = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
    const shim = join(dir, "python3");
    // The JSON-parse call uses `-c`; the verdict script is fed on stdin as `-`.
    writeFileSync(shim, `#!/bin/sh\nif [ "$1" = "-" ]; then exit 1; fi\nexec ${real} "$@"\n`);
    chmodSync(shim, 0o755);
    const r = spawnSync("bash", [HOOK], {
      input: JSON.stringify(bash(command)),
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
    return r.status;
  }
  test("verdict crash on a suspect command fails closed (exit 2)", () => {
    assert.equal(runWithBrokenVerdictPython(`${GH_EDIT} 5 ${ADD} needs-qa`), 2);
  });
  test("verdict crash on an unrelated command exits 0 (sibling pin)", () => {
    assert.equal(runWithBrokenVerdictPython("ls -la"), 0);
  });
});

// QA round 4 (operator ruling): the shell-parsing pipeline is hand-copied from
// gh-label-delete-guard.sh; until a shared module is extracted (follow-up), a
// parity test keeps the two tokenisations in agreement over one corpus.
describe("lifecycle-state-label-guard: tokenisation parity with gh-label-delete-guard", () => {
  const DELETE_HOOK = resolve(REPO_ROOT, "scripts/claude-hooks/gh-label-delete-guard.sh");

  /** Extract a hook's embedded python, cut before its verdict logic, and
   *  print the post-resolution segments (each joined by a space) for `cmd`. */
  function segmentsVia(hookPath: string, envVar: string, cmd: string): string[] {
    const src = readFileSync(hookPath, "utf8");
    const start = src.indexOf("<<'PY'");
    assert.ok(start >= 0, `${hookPath}: no embedded python`);
    const body = src.slice(src.indexOf("\n", start) + 1, src.indexOf("\nPY\n", start));
    const cut = body.search(/^offending(_issue)? = /m);
    assert.ok(cut > 0, `${hookPath}: verdict marker not found`);
    const prog =
      body.slice(0, cut) +
      "\nimport json as _j\n" +
      "_s = _segments(cmd)\n" +
      "print(_j.dumps([x if isinstance(x, str) else ' '.join(x) for x in _s]))\n";
    const r = spawnSync("python3", ["-c", prog], {
      encoding: "utf8",
      env: { ...process.env, [envVar]: cmd },
    });
    assert.equal(r.status, 0, `python failed for ${hookPath}: ${r.stderr}`);
    return JSON.parse(r.stdout);
  }

  const CORPUS = [
    "gh issue view 5 --json labels",
    "FOO=needs-qa; gh issue edit 5 --add-label $FOO",
    "export L=blocked && gh issue edit 5 --add-label \"$L\"",
    "cat <<'EOF' | tee out.txt\nbody with 'quote\nEOF\ngh issue list",
    "gh issue edit 5 \\\n  --add-label x",
    "printf -v L %s needs-qa; gh issue edit 5 --add-label $L",
    "read L <<< needs-qa; gh issue edit 5 --add-label $L",
    "echo 'a; b' && gh api repos/o/r/issues/5/labels -f 'labels[]=bug'",
    "for n in 1 2; do gh issue edit $n --add-label bug; done",
    "ls | grep foo || true",
  ];

  for (const cmd of CORPUS) {
    test(`segments agree: ${JSON.stringify(cmd).slice(0, 60)}`, () => {
      const a = segmentsVia(HOOK, "LIFECYCLE_GUARD_CMD", cmd);
      const b = segmentsVia(DELETE_HOOK, "GH_LABEL_GUARD_CMD", cmd);
      assert.deepEqual(a, b);
    });
  }
});

describe("lifecycle-state-label-guard: QA round-4 bypasses (operator ruling)", () => {
  // high: gh's {owner}/{repo} / :owner/:repo placeholders mean THIS repo.
  test("gh api repos/{owner}/{repo}/issues/N/labels naming a state is denied", () => {
    assertDeny(`${GH_API} -X POST 'repos/{owner}/{repo}/issues/5/labels' -f 'labels[]=needs-qa'`);
  });
  test("gh api repos/:owner/:repo/issues/N/labels naming a state is denied", () => {
    assertDeny(`${GH_API} -X POST repos/:owner/:repo/issues/5/labels -f 'labels[]=needs-qa'`);
  });
  test("a placeholder repo with a FLAG label stays allowed; literal foreign repo stays exempt (sibling pins)", () => {
    assertAllow(`${GH_API} -X POST 'repos/{owner}/{repo}/issues/5/labels' -f 'labels[]=bug'`);
    assertAllow(`${GH_API} -X POST repos/someone/else/issues/5/labels -f 'labels[]=needs-qa'`);
  });
  // medium: gh reached through substitution / eval / find -exec.
  test("gh behind $( ), backticks, eval and find -exec is denied", () => {
    assertDeny(`echo $(${GH_EDIT} 5 ${ADD} needs-qa)`);
    assertDeny("echo `" + GH_EDIT + " 5 " + ADD + " needs-qa`");
    assertDeny(`eval "${GH_EDIT} 5 ${ADD} needs-qa"`);
    assertDeny(`find . -name x -exec ${GH_EDIT} 5 ${ADD} needs-qa \\;`);
  });
  test("the same indirections with a FLAG label or a read stay allowed (sibling pins)", () => {
    assertAllow(`echo $(${GH_EDIT} 5 ${ADD} bug)`);
    assertAllow("echo `gh issue view 5 --json labels`");
    assertAllow(`eval "${GH_EDIT} 5 ${ADD} glm-eligible"`);
    assertAllow(`find . -name x -exec ${GH_EDIT} 5 ${ADD} bug \\;`);
    assertAllow("echo $(date) needs-qa");
  });
  // QA round 4: nested parentheses, repo spellings, last --repo wins.
  test("nested $( ) with parenthesised bodies is denied (also inside bash -c)", () => {
    assertDeny(`echo $(${GH_EDIT} 5 ${ADD} needs-qa --body "$(date)")`);
    assertDeny(`bash -c 'echo $(${GH_EDIT} 5 ${ADD} needs-qa --body "$(date)")'`);
  });
  test("nested $( ) with a FLAG label stays allowed (sibling pin)", () => {
    assertAllow(`echo $(${GH_EDIT} 5 ${ADD} bug --body "$(date)")`);
  });
  test("alternate spellings of this repo are inspected, not exempt", () => {
    for (const r of ["gaberoo322/hydra.git", "https://github.com/gaberoo322/hydra", "github.com/gaberoo322/hydra", "GaberOO322/Hydra/"]) {
      assertDeny(`${GH_EDIT} 5 --repo ${r} ${ADD} needs-qa`);
    }
    assertAllow(`${GH_EDIT} 5 --repo https://github.com/someone/else ${ADD} needs-qa`);
  });
  test("the LAST --repo operand decides", () => {
    assertDeny(`${GH_EDIT} 5 --repo other/x --repo gaberoo322/hydra ${ADD} needs-qa`);
    assertAllow(`${GH_EDIT} 5 --repo gaberoo322/hydra --repo other/x ${ADD} needs-qa`);
  });
});

describe("lifecycle-state-label-guard: -R ordering and documented gaps (PR #5426 operator ruling)", () => {
  test("global -R other then subcommand --repo this repo is denied (subcommand --repo wins)", () => {
    assertDeny(`gh -R other/x issue edit 5 ${ADD} needs-qa --repo gaberoo322/hydra`);
  });
  test("global -R this repo then subcommand --repo other stays allowed (sibling pin)", () => {
    assertAllow(`gh -R gaberoo322/hydra issue edit 5 ${ADD} needs-qa --repo other/x`);
  });
  test("known gaps are pinned as currently allowed", () => {
    assertAllow(`${GH_EDIT} 5 ${ADD} $'needs-qa'`);
    assertAllow(`${GH_EDIT} 5 ${ADD} $(echo needs-qa)`);
    assertAllow(`bash <<< "${GH_EDIT} 5 ${ADD} needs-qa"`);
  });
});

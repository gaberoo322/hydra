/**
 * Regression tests for the gh-label DELETE-collection guard (issue #4654).
 *
 * Failure mode being prevented: an agent removing ONE label reaches for
 *   gh api repos/gaberoo322/hydra/issues/<n>/labels -X DELETE -f name=<label>
 * which hits the GitHub REST *collection* endpoint
 * (`DELETE /issues/{n}/labels`) — that removes EVERY label on the issue,
 * silently (exit 0). The single-label form puts the name in the URL PATH:
 * `DELETE /issues/{n}/labels/{name}`. This bit 3 times across 2 dispatch
 * classes (dev_orch on #4632, two qa_orch dispatches on #4349/#4354),
 * wiping routing labels like `glm-ab-control` / `design-concept-exempt`.
 *
 * The guard is a PreToolUse hook (`scripts/claude-hooks/
 * gh-label-delete-guard.sh`) that denies any Bash tool call whose command
 * text carries, in a single shell segment, BOTH a DELETE HTTP method and a
 * reference to `issues/<n>/labels` with no trailing `/<name>` path segment.
 *
 * What each test pins (design-concept invariants INV-1..INV-3 for
 * issue-4654, artifact hash f62001c6994b...):
 *
 *   - the exact #4632 transcript call is DENIED (`-X DELETE`).
 *   - `--method DELETE` / `--method=DELETE` / `-XDELETE` are all DENIED.
 *   - the raw `curl` form is DENIED (the rule matches command text, not the
 *     binary).
 *   - the single-label PATH form is ALLOWED — literal, `$VAR`, `${VAR}`.
 *   - GET/POST on the collection endpoint is ALLOWED.
 *   - `gh issue edit --remove-label` (the sanctioned path) is ALLOWED.
 *   - a repo-level `repos/o/r/labels/<name>` delete is ALLOWED.
 *   - a chained path-form-delete `&&` collection-GET is ALLOWED (segment-wise
 *     evaluation, not a whole-command substring match).
 *   - a comment/echo merely mentioning DELETE + the collection URL (no real
 *     invocation) is ALLOWED.
 *   - a non-Bash tool_name, missing command, or malformed JSON stdin all
 *     fail OPEN (exit 0) — the guard must never wedge an unrelated call.
 *   - the deny payload shape matches the harness contract (stderr JSON with
 *     hookSpecificOutput.permissionDecision == "deny") and names the
 *     corrected forms + issue #4654.
 *
 * The hook is pure shell + python (no Node), so we exercise it by spawning
 * it as a subprocess and feeding stdin — mirroring
 * test/worktree-write-fence.test.mts.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const HOOK = resolve(REPO_ROOT, "scripts/claude-hooks/gh-label-delete-guard.sh");

function runHook(payload: unknown, raw?: string): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const input = raw !== undefined ? raw : JSON.stringify(payload);
  const r = spawnSync("bash", [HOOK], {
    input,
    encoding: "utf8",
  });
  return {
    status: r.status,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
  };
}

function bash(command: string) {
  return { tool_name: "Bash", tool_input: { command } };
}

describe("gh-label-delete-guard — denies the collection-endpoint wipe", () => {
  test("the exact #4632 transcript call is DENIED", () => {
    const r = runHook(
      bash(
        'gh api repos/gaberoo322/hydra/issues/4632/labels -X DELETE -f name="in-progress"',
      ),
    );
    assert.equal(r.status, 2, `expected deny, got ${r.status}; stderr=${r.stderr}`);
    assert.match(r.stderr, /#4632/);
    assert.match(r.stderr, /#4654/);
  });

  test("--method DELETE is DENIED", () => {
    const r = runHook(
      bash("gh api --method DELETE repos/gaberoo322/hydra/issues/10/labels -f name=foo"),
    );
    assert.equal(r.status, 2);
  });

  test("--method=DELETE is DENIED", () => {
    const r = runHook(
      bash("gh api --method=DELETE repos/gaberoo322/hydra/issues/10/labels"),
    );
    assert.equal(r.status, 2);
  });

  test("-XDELETE (no space) is DENIED", () => {
    const r = runHook(bash("gh api -XDELETE repos/gaberoo322/hydra/issues/10/labels"));
    assert.equal(r.status, 2);
  });

  test("raw curl DELETE against the collection URL is DENIED", () => {
    const r = runHook(
      bash("curl -X DELETE https://api.github.com/repos/o/r/issues/10/labels"),
    );
    assert.equal(r.status, 2, "the rule matches command text, not the binary");
  });

  test("a bare trailing slash ('/labels/') is still the collection endpoint — DENIED", () => {
    const r = runHook(bash("gh api repos/o/r/issues/10/labels/ -X DELETE"));
    assert.equal(r.status, 2);
  });
});

describe("gh-label-delete-guard — allows the sanctioned forms", () => {
  test("the single-label PATH form (literal name) is ALLOWED", () => {
    const r = runHook(
      bash("gh api repos/gaberoo322/hydra/issues/10/labels/in-progress -X DELETE"),
    );
    assert.equal(r.status, 0, `expected allow, got ${r.status}; stderr=${r.stderr}`);
  });

  test("the single-label PATH form with a $VAR name is ALLOWED", () => {
    const r = runHook(bash("gh api repos/o/r/issues/10/labels/$L -X DELETE"));
    assert.equal(r.status, 0);
  });

  test("the single-label PATH form with a ${VAR} name is ALLOWED", () => {
    const r = runHook(bash("gh api repos/o/r/issues/10/labels/${LABEL} -X DELETE"));
    assert.equal(r.status, 0);
  });

  test("GET on the collection endpoint is ALLOWED", () => {
    const r = runHook(bash("gh api repos/o/r/issues/10/labels"));
    assert.equal(r.status, 0);
  });

  test("POST on the collection endpoint is ALLOWED", () => {
    const r = runHook(bash("gh api repos/o/r/issues/10/labels -X POST -f labels[]=foo"));
    assert.equal(r.status, 0);
  });

  test("the sanctioned `gh issue edit --remove-label` path is ALLOWED", () => {
    const r = runHook(
      bash("gh issue edit 10 --repo gaberoo322/hydra --remove-label foo"),
    );
    assert.equal(r.status, 0);
  });

  test("a repo-level label delete (`repos/o/r/labels/<name>`) is ALLOWED", () => {
    const r = runHook(bash("gh api repos/o/r/labels/foo -X DELETE"));
    assert.equal(r.status, 0);
  });

  test("a chained path-form delete followed by a collection GET is ALLOWED (segment-wise)", () => {
    const r = runHook(
      bash(
        "gh api repos/o/r/issues/10/labels/x -X DELETE && gh api repos/o/r/issues/10/labels",
      ),
    );
    assert.equal(
      r.status,
      0,
      "each shell segment must be evaluated independently, not the whole command as one string",
    );
  });

  test("a comment merely mentioning DELETE + the collection URL is ALLOWED", () => {
    const r = runHook(bash('echo "DELETE issues/10/labels is dangerous"'));
    assert.equal(r.status, 0);
  });
});

describe("gh-label-delete-guard — fail-open cases", () => {
  test("a non-Bash tool_name is ALLOWED (fail open)", () => {
    const r = runHook({ tool_name: "Read", tool_input: { file_path: "x" } });
    assert.equal(r.status, 0);
  });

  test("a missing tool_input.command is ALLOWED (fail open)", () => {
    const r = runHook({ tool_name: "Bash", tool_input: {} });
    assert.equal(r.status, 0);
  });

  test("malformed JSON stdin is ALLOWED (fail open)", () => {
    const r = runHook(undefined, "not json{{{");
    assert.equal(r.status, 0);
  });

  test("empty stdin is ALLOWED (fail open)", () => {
    const r = runHook(undefined, "");
    assert.equal(r.status, 0);
  });
});

describe("gh-label-delete-guard — deny payload shape", () => {
  test("deny payload matches the harness contract and names the corrected forms", () => {
    const r = runHook(
      bash("gh api repos/gaberoo322/hydra/issues/4632/labels -X DELETE -f name=in-progress"),
    );
    assert.equal(r.status, 2);

    const lines = r.stderr.trim().split("\n");
    assert.ok(lines.length >= 2, `expected reason line + JSON line, got: ${r.stderr}`);

    const jsonLine = lines[lines.length - 1];
    const parsed = JSON.parse(jsonLine);
    assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
    assert.match(
      parsed.hookSpecificOutput.permissionDecisionReason,
      /gh issue edit 4632 --repo gaberoo322\/hydra --remove-label/,
      "deny reason must name the sanctioned gh issue edit form for the same issue number",
    );
    assert.match(
      parsed.hookSpecificOutput.permissionDecisionReason,
      /issues\/4632\/labels\/<name>/,
      "deny reason must also name the single-label REST path form",
    );
  });
});

describe("gh-label-delete-guard — performance", () => {
  test("typical invocation completes in under 250ms", () => {
    // PreToolUse hooks run synchronously and stall every tool call. A
    // python shell-out per parse field puts us in the tens-of-ms range; we
    // leave generous headroom for cold-cache CI runners (matches the
    // worktree-write-fence performance test's budget).
    const start = Date.now();
    const r = runHook(bash("gh api repos/o/r/issues/10/labels"));
    const elapsed = Date.now() - start;
    assert.equal(r.status, 0);
    assert.ok(
      elapsed < 250,
      `guard ran in ${elapsed}ms — too slow for a per-tool-call hook`,
    );
  });
});

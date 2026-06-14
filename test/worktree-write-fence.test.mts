/**
 * Regression tests for the worktree write-fence (issue #549).
 *
 * Failure mode being prevented: the Claude Code `Edit`/`Write`/`MultiEdit`
 * tools resolve absolute paths against the actual filesystem, not the
 * worktree-isolated namespace. A hydra-dev BG agent dispatched into a
 * worktree under /home/gabe/hydra/.claude/worktrees/agent-XXXX/ can pass
 * `file_path: /home/gabe/hydra/src/foo.ts` and the Edit lands in the MAIN
 * checkout's working tree, leaving ghost M-files for the operator to
 * discover.
 *
 * The fence is a PreToolUse hook (`scripts/claude-hooks/worktree-write-
 * fence.sh`) that denies any Edit/Write/MultiEdit call whose `file_path`
 * resolves outside the dispatch cwd when that cwd is a recognised worktree
 * namespace. Operator sessions (cwd == ~/hydra) are unaffected — they
 * pass straight through.
 *
 * What each test pins:
 *
 *   - cwd outside a worktree namespace → no-op exit 0 (operator session
 *     compatibility).
 *   - cwd in worktree + file_path inside that worktree → exit 0 (the
 *     normal happy path: the agent edits files in its own workspace).
 *   - cwd in worktree + file_path in a sibling worktree → DENY (one
 *     subagent must never reach into another's working tree).
 *   - cwd in worktree + file_path in the main tree (~/hydra/) → DENY (the
 *     PR #548 / #549 ghost-write failure mode).
 *   - cwd in worktree + file_path under /tmp or /dev/shm → exit 0
 *     (legitimate scratch space).
 *   - Missing/empty file_path → exit 0 (the fence's job isn't to
 *     second-guess the tool input layer; only to fence destinations).
 *   - Malformed JSON stdin → exit 0 (fail open, don't block on parse
 *     errors).
 *   - Deny payload shape matches the harness contract (stderr JSON with
 *     hookSpecificOutput.permissionDecision == "deny").
 *
 * The hook is pure shell + python (no Node), so we exercise it by spawning
 * it as a subprocess and feeding stdin.
 */

import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const HOOK = resolve(REPO_ROOT, "scripts/claude-hooks/worktree-write-fence.sh");

function runHook(payload: Record<string, unknown>): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const r = spawnSync("bash", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  return {
    status: r.status,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
  };
}

describe("worktree-write-fence — pass-through cases", () => {
  test("operator session (cwd == main hydra tree) is unaffected", () => {
    const r = runHook({
      cwd: "/home/gabe/hydra",
      tool_name: "Edit",
      tool_input: { file_path: "/home/gabe/hydra/src/foo.ts" },
    });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
  });

  test("operator session in hydra-betting main tree is unaffected", () => {
    const r = runHook({
      cwd: "/home/gabe/hydra-betting",
      tool_name: "Write",
      tool_input: { file_path: "/home/gabe/hydra-betting/web/x.ts" },
    });
    assert.equal(r.status, 0);
  });

  test("file_path inside the worktree cwd is allowed (happy path)", () => {
    const r = runHook({
      cwd: "/home/gabe/hydra/.claude/worktrees/agent-abc123",
      tool_name: "Edit",
      tool_input: {
        file_path: "/home/gabe/hydra/.claude/worktrees/agent-abc123/src/foo.ts",
      },
    });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
  });

  test("dev_target worktree under /dev/shm allowed when file is inside it", () => {
    const r = runHook({
      cwd: "/dev/shm/hydra-worktrees/issue-100-dev",
      tool_name: "MultiEdit",
      tool_input: {
        file_path: "/dev/shm/hydra-worktrees/issue-100-dev/web/x.ts",
      },
    });
    assert.equal(r.status, 0);
  });

  test("scratch paths (/tmp) outside main tree are allowed", () => {
    const r = runHook({
      cwd: "/home/gabe/hydra/.claude/worktrees/agent-abc123",
      tool_name: "Write",
      tool_input: { file_path: "/tmp/scratch.txt" },
    });
    assert.equal(r.status, 0);
  });

  test("missing file_path → no-op (nothing to fence)", () => {
    const r = runHook({
      cwd: "/home/gabe/hydra/.claude/worktrees/agent-abc123",
      tool_name: "Edit",
      tool_input: {},
    });
    assert.equal(r.status, 0);
  });

  test("malformed JSON stdin → fail open (don't block on parse error)", () => {
    const r = spawnSync("bash", [HOOK], {
      input: "this is not json {{{",
      encoding: "utf8",
    });
    assert.equal(r.status, 0, "fence must fail open, never block on garbage input");
  });
});

describe("worktree-write-fence — deny cases", () => {
  test("hydra-dev worktree writing to main hydra tree is DENIED", () => {
    const r = runHook({
      cwd: "/home/gabe/hydra/.claude/worktrees/agent-abc123",
      tool_name: "Edit",
      tool_input: { file_path: "/home/gabe/hydra/src/foo.ts" },
    });
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}`);
    assert.match(r.stderr, /worktree-write-fence/, "human-readable reason on stderr");
    assert.match(r.stderr, /permissionDecision/, "JSON deny payload on stderr");
    assert.match(
      r.stderr,
      /"permissionDecision":\s*"deny"/,
      "deny payload must be parsable",
    );
  });

  test("hydra-target-build worktree writing to hydra-betting main tree is DENIED", () => {
    const r = runHook({
      cwd: "/dev/shm/hydra-worktrees/issue-100-dev",
      tool_name: "Write",
      tool_input: { file_path: "/home/gabe/hydra-betting/web/x.ts" },
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /worktree-write-fence/);
  });

  test("worktree reaching into a sibling worktree's tree is DENIED", () => {
    const r = runHook({
      cwd: "/home/gabe/hydra/.claude/worktrees/agent-abc123",
      tool_name: "Edit",
      tool_input: {
        file_path: "/home/gabe/hydra/.claude/worktrees/agent-deadbeef/src/foo.ts",
      },
    });
    assert.equal(r.status, 2, "sibling-worktree reads-through must be denied too");
  });

  test("deny payload contains the file_path so the agent can self-correct", () => {
    const target = "/home/gabe/hydra/src/api/metrics.ts";
    const r = runHook({
      cwd: "/home/gabe/hydra/.claude/worktrees/agent-abc123",
      tool_name: "Edit",
      tool_input: { file_path: target },
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, new RegExp(target.replace(/\//g, "\\/")));
  });

  test("MultiEdit also fenced", () => {
    const r = runHook({
      cwd: "/home/gabe/hydra/.claude/worktrees/agent-abc123",
      tool_name: "MultiEdit",
      tool_input: { file_path: "/home/gabe/hydra/src/foo.ts" },
    });
    assert.equal(r.status, 2);
  });
});

describe("worktree-write-fence — suggested-path surfacing (issue #1861)", () => {
  test("write deny names the corrected worktree-anchored path", () => {
    const r = runHook({
      cwd: "/home/gabe/hydra/.claude/worktrees/agent-abc123",
      tool_name: "Edit",
      tool_input: { file_path: "/home/gabe/hydra/src/api/metrics.ts" },
    });
    assert.equal(r.status, 2);
    // The agent must be told the exact worktree path to retry against, so it
    // self-corrects in one turn rather than recomputing the mapping.
    assert.match(
      r.stderr,
      /\/home\/gabe\/hydra\/\.claude\/worktrees\/agent-abc123\/src\/api\/metrics\.ts/,
      "deny reason must surface the corrected worktree path",
    );
    assert.match(r.stderr, /#1861/, "deny reason references the recurrence issue");
  });

  test("hydra-betting write deny re-anchors under the worktree cwd", () => {
    const r = runHook({
      cwd: "/dev/shm/hydra-worktrees/issue-100-dev",
      tool_name: "Write",
      tool_input: { file_path: "/home/gabe/hydra-betting/web/src/x.ts" },
    });
    assert.equal(r.status, 2);
    assert.match(
      r.stderr,
      /\/dev\/shm\/hydra-worktrees\/issue-100-dev\/web\/src\/x\.ts/,
      "hydra-betting path must re-anchor under the worktree, dropping the main-tree root",
    );
  });
});

describe("worktree-write-fence — Read steering (issue #1861)", () => {
  // The fence's Read arm checks the worktree copy's existence on disk, so these
  // tests use the real filesystem. The fence keys off the cwd PREFIX (one of
  // /home/gabe/hydra/.claude/worktrees/, /dev/shm/hydra-worktrees/,
  // /home/gabe/hydra-worktrees/); we use the canonical /dev/shm namespace
  // (writable in CI) for cwd and create the worktree copy there.
  const wtCwd = join("/dev/shm/hydra-worktrees", `fence-read-${process.pid}`);
  const wtFile = join(wtCwd, "web", "shared.ts");

  before(() => {
    mkdirSync(join(wtCwd, "web"), { recursive: true });
    writeFileSync(wtFile, "// worktree copy\n");
  });

  after(() => {
    rmSync(wtCwd, { recursive: true, force: true });
  });

  test("Read of a main-tree copy WITH a worktree equivalent is DENIED + steered", () => {
    const r = runHook({
      cwd: wtCwd,
      tool_name: "Read",
      tool_input: { file_path: "/home/gabe/hydra-betting/web/shared.ts" },
    });
    assert.equal(r.status, 2, `expected deny, got ${r.status}; stderr=${r.stderr}`);
    assert.match(r.stderr, new RegExp(wtFile.replace(/\//g, "\\/")),
      "Read deny must steer to the worktree copy that exists");
    assert.match(r.stderr, /#1861/);
  });

  test("Read of a main-tree-only file (no worktree equivalent) is ALLOWED", () => {
    const r = runHook({
      cwd: wtCwd,
      tool_name: "Read",
      // No web/only-in-main.ts exists under wtCwd → legitimate cross-reference.
      tool_input: { file_path: "/home/gabe/hydra-betting/web/only-in-main.ts" },
    });
    assert.equal(r.status, 0,
      `cross-reference Read must pass through, got ${r.status}; stderr=${r.stderr}`);
  });

  test("Read of a path already inside the worktree is ALLOWED", () => {
    const r = runHook({
      cwd: wtCwd,
      tool_name: "Read",
      tool_input: { file_path: wtFile },
    });
    assert.equal(r.status, 0);
  });
});

describe("worktree-write-fence — performance", () => {
  test("typical invocation completes in under 250ms", () => {
    // PreToolUse hooks run synchronously and stall every tool call. A python
    // shell-out per parse field puts us in the ~30-80ms range; we leave
    // generous headroom for cold-cache CI runners.
    const start = Date.now();
    const r = runHook({
      cwd: "/home/gabe/hydra/.claude/worktrees/agent-abc123",
      tool_name: "Edit",
      tool_input: {
        file_path: "/home/gabe/hydra/.claude/worktrees/agent-abc123/src/foo.ts",
      },
    });
    const elapsed = Date.now() - start;
    assert.equal(r.status, 0);
    assert.ok(
      elapsed < 250,
      `fence ran in ${elapsed}ms — too slow for a per-tool-call hook`,
    );
  });
});

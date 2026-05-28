/**
 * Regression tests for `scripts/autopilot/hooks/on-subagent-tool-call.sh`
 * — the Claude Code `PostToolUse` hook (issue #671) that classifies each
 * tool call into one of {milestone, io, background} and XADDs a
 * `subagent_tool_call` event onto `hydra:autopilot:slot-events`.
 *
 * Cases pinned here:
 *
 *   1. Write tool → category=milestone, target=file_path
 *   2. Read tool → category=background, target=file_path
 *   3. Grep tool → category=background, target empty (no stable field)
 *   4. Bash `npm test` → category=milestone
 *   5. Bash `git commit ...` → category=milestone
 *   6. Bash `ls -la` → category=io (non-milestone bash)
 *   7. WebFetch → category=io
 *   8. NotebookEdit → category=milestone (uses notebook_path as target)
 *   9. MCP write tool (mcp__atlassian__createJiraIssue) → milestone
 *  10. MCP read tool (mcp__atlassian__getJiraIssue) → io
 *  11. Slot derivation from description prefix
 *  12. Slot fallback via subagent_type when description missing
 *  13. Best-effort: Redis outage MUST exit 0
 *  14. Missing tool_name → exit 0, no event
 *  15. Hook script has executable bit + shebang
 *
 * Test isolation: each test uses a unique stream name (per-test prefix +
 * timestamp + pid) so concurrent runs don't collide. Streams are deleted
 * at the end of each test. The pattern mirrors test/autopilot-hooks.test.mts.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { statSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const HOOK = join(REPO_ROOT, "scripts", "autopilot", "hooks", "on-subagent-tool-call.sh");

function dockerRedisAvailable(): boolean {
  const r = spawnSync("docker", ["exec", "hydra-redis-1", "redis-cli", "PING"], { encoding: "utf-8" });
  return r.status === 0 && (r.stdout ?? "").trim() === "PONG";
}

function uniqueStream(label: string): string {
  return `hydra:autopilot:slot-events:test-tcall-${label}-${Date.now()}-${process.pid}`;
}

function redisDel(key: string): void {
  spawnSync("docker", ["exec", "hydra-redis-1", "redis-cli", "DEL", key], { encoding: "utf-8" });
}

function redisXrange(key: string): Array<{ id: string; fields: Record<string, string> }> {
  const r = spawnSync("docker", ["exec", "hydra-redis-1", "redis-cli", "XRANGE", key, "-", "+"], {
    encoding: "utf-8",
  });
  const lines = (r.stdout ?? "").split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const events: Array<{ id: string; fields: Record<string, string> }> = [];
  let i = 0;
  while (i < lines.length) {
    if (/^\d+-\d+$/.test(lines[i])) {
      const id = lines[i];
      i++;
      const fields: Record<string, string> = {};
      while (i < lines.length && !/^\d+-\d+$/.test(lines[i])) {
        const k = lines[i];
        i++;
        const v = i < lines.length && !/^\d+-\d+$/.test(lines[i]) ? lines[i] : "";
        if (v !== "") i++;
        fields[k] = v;
      }
      events.push({ id, fields });
    } else {
      i++;
    }
  }
  return events;
}

function runHook(payload: object, stream: string): { status: number | null; stderr: string } {
  const r = spawnSync(HOOK, [], {
    input: JSON.stringify(payload),
    env: { ...process.env, HYDRA_AUTOPILOT_SLOT_EVENTS_STREAM: stream },
    encoding: "utf-8",
  });
  return { status: r.status, stderr: r.stderr ?? "" };
}

describe("scripts/autopilot/hooks/on-subagent-tool-call.sh", () => {
  test(
    "Write → category=milestone, target=file_path, slot from description",
    { skip: !dockerRedisAvailable() },
    () => {
      const stream = uniqueStream("write");
      try {
        const r = runHook(
          {
            tool_name: "Write",
            tool_input: { file_path: "/home/gabe/hydra/src/foo.ts", content: "..." },
            task: { id: "t-write-1", description: "dev_orch — implement #671", subagent_type: "hydra-dev" },
          },
          stream,
        );
        assert.equal(r.status, 0, `hook exited ${r.status}: ${r.stderr}`);
        const events = redisXrange(stream);
        assert.equal(events.length, 1);
        const ev = events[0].fields;
        assert.equal(ev.event, "subagent_tool_call");
        assert.equal(ev.tool, "Write");
        assert.equal(ev.category, "milestone");
        assert.equal(ev.slot, "dev_orch");
        assert.equal(ev.target, "/home/gabe/hydra/src/foo.ts");
        assert.ok(parseInt(ev.ts_epoch, 10) > 0);
      } finally {
        redisDel(stream);
      }
    },
  );

  test(
    "Read → category=background, target=file_path",
    { skip: !dockerRedisAvailable() },
    () => {
      const stream = uniqueStream("read");
      try {
        const r = runHook(
          {
            tool_name: "Read",
            tool_input: { file_path: "/home/gabe/hydra/CLAUDE.md" },
            task: { description: "dev_orch — research", subagent_type: "hydra-dev" },
          },
          stream,
        );
        assert.equal(r.status, 0);
        const ev = redisXrange(stream)[0].fields;
        assert.equal(ev.category, "background");
        assert.equal(ev.tool, "Read");
        assert.equal(ev.target, "/home/gabe/hydra/CLAUDE.md");
      } finally {
        redisDel(stream);
      }
    },
  );

  test(
    "Grep → category=background, target=n/a sentinel (no stable pattern field)",
    { skip: !dockerRedisAvailable() },
    () => {
      const stream = uniqueStream("grep");
      try {
        const r = runHook(
          {
            tool_name: "Grep",
            tool_input: { pattern: "TODO", path: "src/" },
            task: { description: "dev_orch — patrol", subagent_type: "hydra-dev" },
          },
          stream,
        );
        assert.equal(r.status, 0);
        const ev = redisXrange(stream)[0].fields;
        assert.equal(ev.category, "background");
        assert.equal(ev.tool, "Grep");
        // target is the `n/a` sentinel for Grep/Glob (see hook script —
        // empty values would lose alignment in the redis-cli XRANGE
        // text-mode output that downstream parsers consume).
        assert.equal(ev.target, "n/a");
      } finally {
        redisDel(stream);
      }
    },
  );

  test(
    "Bash `npm test` → category=milestone",
    { skip: !dockerRedisAvailable() },
    () => {
      const stream = uniqueStream("bash-npm-test");
      try {
        const r = runHook(
          {
            tool_name: "Bash",
            tool_input: { command: "npm test", description: "Run tests" },
            task: { description: "dev_orch — verify", subagent_type: "hydra-dev" },
          },
          stream,
        );
        assert.equal(r.status, 0);
        const ev = redisXrange(stream)[0].fields;
        assert.equal(ev.category, "milestone");
        assert.equal(ev.tool, "Bash");
      } finally {
        redisDel(stream);
      }
    },
  );

  test(
    "Bash `git commit -m ...` → category=milestone",
    { skip: !dockerRedisAvailable() },
    () => {
      const stream = uniqueStream("bash-git-commit");
      try {
        const r = runHook(
          {
            tool_name: "Bash",
            tool_input: { command: "git commit -m 'feat: ...'" },
            task: { description: "dev_orch — commit", subagent_type: "hydra-dev" },
          },
          stream,
        );
        assert.equal(r.status, 0);
        const ev = redisXrange(stream)[0].fields;
        assert.equal(ev.category, "milestone");
      } finally {
        redisDel(stream);
      }
    },
  );

  test(
    "Bash `ls -la` → category=io (non-milestone bash)",
    { skip: !dockerRedisAvailable() },
    () => {
      const stream = uniqueStream("bash-ls");
      try {
        const r = runHook(
          {
            tool_name: "Bash",
            tool_input: { command: "ls -la /tmp" },
            task: { description: "dev_orch — inspect", subagent_type: "hydra-dev" },
          },
          stream,
        );
        assert.equal(r.status, 0);
        const ev = redisXrange(stream)[0].fields;
        assert.equal(ev.category, "io");
      } finally {
        redisDel(stream);
      }
    },
  );

  test(
    "WebFetch → category=io, target=url",
    { skip: !dockerRedisAvailable() },
    () => {
      const stream = uniqueStream("webfetch");
      try {
        const r = runHook(
          {
            tool_name: "WebFetch",
            tool_input: { url: "https://example.com/foo", prompt: "extract" },
            task: { description: "research_orch — survey", subagent_type: "hydra-research" },
          },
          stream,
        );
        assert.equal(r.status, 0);
        const ev = redisXrange(stream)[0].fields;
        assert.equal(ev.category, "io");
        assert.equal(ev.target, "https://example.com/foo");
      } finally {
        redisDel(stream);
      }
    },
  );

  test(
    "NotebookEdit → category=milestone, target=notebook_path",
    { skip: !dockerRedisAvailable() },
    () => {
      const stream = uniqueStream("notebook");
      try {
        const r = runHook(
          {
            tool_name: "NotebookEdit",
            tool_input: { notebook_path: "/tmp/foo.ipynb", new_source: "..." },
            task: { description: "dev_orch — edit", subagent_type: "hydra-dev" },
          },
          stream,
        );
        assert.equal(r.status, 0);
        const ev = redisXrange(stream)[0].fields;
        assert.equal(ev.category, "milestone");
        assert.equal(ev.target, "/tmp/foo.ipynb");
      } finally {
        redisDel(stream);
      }
    },
  );

  test(
    "MCP write surface (mcp__foo__createIssue) → category=milestone",
    { skip: !dockerRedisAvailable() },
    () => {
      const stream = uniqueStream("mcp-write");
      try {
        const r = runHook(
          {
            tool_name: "mcp__claude_ai_Atlassian__createJiraIssue",
            tool_input: { project: "X" },
            task: { description: "dev_orch — file ticket", subagent_type: "hydra-dev" },
          },
          stream,
        );
        assert.equal(r.status, 0);
        const ev = redisXrange(stream)[0].fields;
        assert.equal(ev.category, "milestone");
      } finally {
        redisDel(stream);
      }
    },
  );

  test(
    "MCP read surface (mcp__foo__getIssue) → category=io",
    { skip: !dockerRedisAvailable() },
    () => {
      const stream = uniqueStream("mcp-read");
      try {
        const r = runHook(
          {
            tool_name: "mcp__claude_ai_Atlassian__getJiraIssue",
            tool_input: { issueIdOrKey: "X-1" },
            task: { description: "dev_orch — research", subagent_type: "hydra-dev" },
          },
          stream,
        );
        assert.equal(r.status, 0);
        const ev = redisXrange(stream)[0].fields;
        assert.equal(ev.category, "io");
      } finally {
        redisDel(stream);
      }
    },
  );

  test(
    "Slot fallback via subagent_type when description missing",
    { skip: !dockerRedisAvailable() },
    () => {
      const stream = uniqueStream("slot-fallback");
      try {
        const r = runHook(
          {
            tool_name: "Read",
            tool_input: { file_path: "/tmp/x" },
            // No description — only subagent_type.
            task: { subagent_type: "hydra-target-build" },
          },
          stream,
        );
        assert.equal(r.status, 0);
        const ev = redisXrange(stream)[0].fields;
        assert.equal(ev.slot, "dev_target");
      } finally {
        redisDel(stream);
      }
    },
  );

  test("Best-effort: Redis outage must NOT propagate error to parent (exit 0)", () => {
    const r = spawnSync(HOOK, [], {
      input: JSON.stringify({
        tool_name: "Read",
        tool_input: { file_path: "/tmp/x" },
        task: { description: "dev_orch — read", subagent_type: "hydra-dev" },
      }),
      env: {
        ...process.env,
        HYDRA_REDIS_HOST: "127.0.0.1",
        HYDRA_REDIS_PORT: "1",
        HYDRA_AUTOPILOT_SLOT_EVENTS_STREAM: uniqueStream("outage"),
      },
      encoding: "utf-8",
    });
    assert.equal(r.status, 0, "hook MUST exit 0 even when Redis is unreachable");
  });

  test("Missing tool_name → exit 0, no event", { skip: !dockerRedisAvailable() }, () => {
    const stream = uniqueStream("notool");
    try {
      const r = runHook(
        { tool_input: { file_path: "/tmp/x" }, task: { description: "dev_orch" } },
        stream,
      );
      assert.equal(r.status, 0);
      const events = redisXrange(stream);
      assert.equal(events.length, 0, "no event should be emitted when tool_name is missing");
    } finally {
      redisDel(stream);
    }
  });

  test("Hook script has executable bit + bash shebang", () => {
    assert.ok(existsSync(HOOK), "hook script missing");
    const stat = statSync(HOOK);
    // Owner execute bit must be set so the harness can exec it directly.
    assert.ok((stat.mode & 0o100) !== 0, "hook script must be executable");
    const head = readFileSync(HOOK, "utf-8").split("\n")[0];
    assert.match(head, /^#!.*bash/, "first line must be a bash shebang");
  });
});

/**
 * Regression test for issue #4985 — a dev_orch dispatch that produced NO work
 * (no commits, no pushed ref) must be recorded `empty`, not `completed`
 * (which dispatch.sh maps to tasksMerged=1, hiding it from emptyRate).
 *
 * Drives the real `reap.py completion` CLI against a throwaway repo that
 * stands in for ~/hydra (HYDRA_AUTOPILOT_REPO_ROOT). The status is read off the
 * `status=` field of the slot_complete run-log line. The orchestrator is a
 * closed port so the cycle-record POST fails fast and is swallowed.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const REAP = join(REPO_ROOT, "scripts", "autopilot", "reap.py");
const DEAD_API_BASE = "http://127.0.0.1:1";
const SOFT_CAP = 400_000;

function vcs(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
}

interface Fixture {
  dir: string;
  repo: string;
  state: string;
  log: string;
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "reap-empty-"));
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  vcs(repo, "init", "-q", "-b", "master");
  vcs(repo, "config", "user.email", "t@example.com");
  vcs(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "a\n");
  vcs(repo, "add", "a.txt");
  vcs(repo, "commit", "-q", "-m", "init");
  vcs(repo, "update-ref", "refs/remotes/origin/master", "HEAD");
  mkdirSync(join(repo, ".claude", "worktrees"), { recursive: true });
  return { dir, repo, state: join(dir, "state.json"), log: join(dir, "nightly.log") };
}

function addWorktree(f: Fixture, taskId: string): string {
  const wt = join(f.repo, ".claude", "worktrees", `agent-${taskId}`);
  vcs(f.repo, "worktree", "add", "-q", wt, "-b", `worktree-agent-${taskId}`);
  return wt;
}

function writeState(f: Fixture, taskId: string, cls: string, anchor?: string): void {
  const slot: Record<string, unknown> = { skill: "hydra-dev", started_epoch: Math.floor(Date.now() / 1000), task_id: taskId };
  if (anchor) slot.anchor = anchor;
  writeFileSync(
    f.state,
    JSON.stringify({
      started_epoch: Math.floor(Date.now() / 1000),
      limits: { token_budget: 2_000_000, subagent_max_tokens: SOFT_CAP, subagent_hard_max_tokens: 800_000 },
      cumulative_tokens: 0,
      dispatches: 0,
      idle_turns: 0,
      burned_classes: [],
      reaped_task_ids: [],
      slots: { dev_orch: null, qa_orch: null, research_orch: null, [cls]: slot },
      signal_last_fired: {},
      failure_log: [],
    }),
  );
}

/** Run a completion reap and return the status= token of the slot_complete line. */
function reapStatus(f: Fixture, cls: string, taskId: string, tokens = 1000, root?: string, anchor?: string): string {
  writeState(f, taskId, cls, anchor);
  const r = spawnSync("python3", [REAP, "completion", cls, taskId, String(tokens), "hydra-dev"], {
    env: {
      ...process.env,
      HYDRA_API_BASE: DEAD_API_BASE,
      HYDRA_BASE_URL: DEAD_API_BASE,
      HYDRA_API: DEAD_API_BASE,
      HYDRA_AUTOPILOT_STATE: f.state,
      HYDRA_AUTOPILOT_LOG: f.log,
      HYDRA_REAP_WORKTREE_GC: "0",
      HYDRA_AUTOPILOT_REPO_ROOT: root ?? f.repo,
      // Stop git walking above the fixture so "not a repo" is host-independent.
      GIT_CEILING_DIRECTORIES: f.dir,
    },
    encoding: "utf-8",
  });
  assert.equal(r.status, 0, `reap must exit 0; stderr=${r.stderr}`);
  const log = existsSync(f.log) ? readFileSync(f.log, "utf-8") : "";
  const m = /slot_complete [^\n]*status=(\S+)/.exec(log);
  assert.ok(m, `slot_complete line missing; log=${log}`);
  return m[1];
}

describe("reap.py completion — no-work dev_orch is recorded empty (issue #4985)", () => {
  test("auto-cleaned worktree (dir + branch + remote ref all absent) => empty", () => {
    const f = makeFixture();
    try {
      assert.equal(reapStatus(f, "dev_orch", "aaaa0001"), "empty");
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("worktree present with zero commits and a clean tree => empty", () => {
    const f = makeFixture();
    try {
      addWorktree(f, "aaaa0002");
      assert.equal(reapStatus(f, "dev_orch", "aaaa0002"), "empty");
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("worktree with one commit on HEAD (even on a renamed branch) => completed", () => {
    const f = makeFixture();
    try {
      const wt = addWorktree(f, "aaaa0003");
      vcs(wt, "checkout", "-q", "-b", "dev/some-slug");
      writeFileSync(join(wt, "b.txt"), "b\n");
      vcs(wt, "add", "b.txt");
      vcs(wt, "commit", "-q", "-m", "work");
      assert.equal(reapStatus(f, "dev_orch", "aaaa0003"), "completed");
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("worktree with an uncommitted change => completed", () => {
    const f = makeFixture();
    try {
      const wt = addWorktree(f, "aaaa0004");
      writeFileSync(join(wt, "wip.txt"), "wip\n");
      assert.equal(reapStatus(f, "dev_orch", "aaaa0004"), "completed");
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("worktree dir gone but the local branch survives => completed", () => {
    const f = makeFixture();
    try {
      vcs(f.repo, "branch", "worktree-agent-aaaa0005");
      assert.equal(reapStatus(f, "dev_orch", "aaaa0005"), "completed");
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("repo root not a repo => completed (fail-safe, never over-classify)", () => {
    const f = makeFixture();
    try {
      const notARepo = join(f.dir, "not-a-repo");
      mkdirSync(notARepo);
      assert.equal(reapStatus(f, "dev_orch", "aaaa0006", 1000, notARepo), "completed");
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("soft-cap failed wins over empty", () => {
    const f = makeFixture();
    try {
      assert.equal(reapStatus(f, "dev_orch", "aaaa0007", SOFT_CAP + 1), "failed");
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("non-dev_orch class keeps completed even with no worktree", () => {
    const f = makeFixture();
    try {
      assert.equal(reapStatus(f, "qa_orch", "aaaa0008"), "completed");
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});

describe("reap.py no-work probe — fail-safe / never over-classify (issue #4985 QA round 1)", () => {
  function withFixture(fn: (f: Fixture) => void): void {
    const f = makeFixture();
    try {
      fn(f);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  }

  function commitInWorktree(wt: string): void {
    writeFileSync(join(wt, "b.txt"), "b\n");
    vcs(wt, "add", "b.txt");
    vcs(wt, "commit", "-q", "-m", "work");
  }

  test("slot form worktree-agent-<hash> with real commits => completed", () => {
    withFixture((f) => {
      commitInWorktree(addWorktree(f, "bbbb0001"));
      assert.equal(reapStatus(f, "dev_orch", "worktree-agent-bbbb0001"), "completed");
    });
  });

  test("slot form agent-<hash> with real commits => completed", () => {
    withFixture((f) => {
      commitInWorktree(addWorktree(f, "bbbb0002"));
      assert.equal(reapStatus(f, "dev_orch", "agent-bbbb0002"), "completed");
    });
  });

  test("slot form worktree-agent-<hash> with an idle worktree => empty", () => {
    withFixture((f) => {
      addWorktree(f, "bbbb0003");
      assert.equal(reapStatus(f, "dev_orch", "worktree-agent-bbbb0003"), "empty");
    });
  });

  test("non-hash task_id => completed (ambiguous, never over-classify)", () => {
    withFixture((f) => {
      assert.equal(reapStatus(f, "dev_orch", "my-task-name"), "completed");
    });
  });

  test("all artefacts absent but a PR-sized token spend => completed", () => {
    withFixture((f) => {
      assert.equal(reapStatus(f, "dev_orch", "bbbb0004", 300_000), "completed");
    });
  });

  test("remote-tracking ref only (dir + local branch gone) => completed", () => {
    withFixture((f) => {
      vcs(f.repo, "update-ref", "refs/remotes/origin/worktree-agent-bbbb0005", "HEAD");
      assert.equal(reapStatus(f, "dev_orch", "bbbb0005"), "completed");
    });
  });

  test("worktree whose HEAD is an ancestor of origin/master after real commits => completed", () => {
    withFixture((f) => {
      const wt = addWorktree(f, "bbbb0006");
      commitInWorktree(wt);
      // The work later merged: origin/master now contains HEAD (count == 0, clean).
      vcs(f.repo, "update-ref", "refs/remotes/origin/master", vcsRevParse(wt));
      assert.equal(reapStatus(f, "dev_orch", "bbbb0006"), "completed");
    });
  });

  test("nonexistent repo root => completed", () => {
    withFixture((f) => {
      assert.equal(reapStatus(f, "dev_orch", "bbbb0007", 1000, join(f.dir, "nope")), "completed");
    });
  });
});

describe("reap.py no-work probe — QA round 2 (issue #4985)", () => {
  function withFixture(fn: (f: Fixture) => void): void {
    const f = makeFixture();
    try {
      fn(f);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  }

  test("all artefacts absent and token usage unknown (0) => completed", () => {
    withFixture((f) => {
      assert.equal(reapStatus(f, "dev_orch", "cccc0001", 0), "completed");
    });
  });

  test("registered worktree outside .claude/worktrees with a commit => completed", () => {
    withFixture((f) => {
      const wt = join(f.dir, "shm", "agent-cccc0002");
      mkdirSync(join(f.dir, "shm"), { recursive: true });
      vcs(f.repo, "worktree", "add", "-q", wt, "-b", "dev/renamed-slug");
      writeFileSync(join(wt, "c.txt"), "c\n");
      vcs(wt, "add", "c.txt");
      vcs(wt, "commit", "-q", "-m", "work");
      assert.equal(reapStatus(f, "dev_orch", "cccc0002"), "completed");
    });
  });

  test("registered worktree outside .claude/worktrees, idle => empty", () => {
    withFixture((f) => {
      const wt = join(f.dir, "shm", "agent-cccc0003");
      mkdirSync(join(f.dir, "shm"), { recursive: true });
      vcs(f.repo, "worktree", "add", "-q", wt, "-b", "worktree-agent-cccc0003");
      assert.equal(reapStatus(f, "dev_orch", "cccc0003"), "empty");
    });
  });

  test("anchored zero-commit dispatch is a needs-dev-resume handoff => completed", () => {
    withFixture((f) => {
      addWorktree(f, "cccc0004");
      assert.equal(reapStatus(f, "dev_orch", "cccc0004", 1000, undefined, "issue-4985"), "completed");
    });
  });

  test("reap passes status=empty through to the cycle-record write", () => {
    withFixture((f) => {
      addWorktree(f, "cccc0005");
      reapStatus(f, "dev_orch", "cccc0005");
      const log = readFileSync(f.log, "utf-8");
      assert.match(log, /cycle_record_fired [^\n]*status=empty/);
    });
  });
});

function vcsRevParse(cwd: string): string {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf-8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

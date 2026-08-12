/**
 * Regression tests for issue #3866 — reap.py: a `dev_orch` completion whose
 * anchor has NO open PR referencing it is a STALL, not a finished cycle.
 *
 * Motivating incident (autopilot run 2bcba309, 2026-08-05): dev_orch on #3726
 * did ~9.5 min of real implementation, backgrounded `npm test`, then ended
 * its session with "I'll stop here and wait for the monitor notification...
 * before proceeding with the PR." No PR existed at reap time. Before this
 * fix, reap.py's completion accounting had no concept of "did a PR actually
 * get opened?" — the source issue stayed usable by hydra-dev's own
 * `ready-for-agent` self-selection, so the NEXT autopilot turn re-dispatched
 * the SAME anchor from a brand-new worktree, silently re-paying the ~165k
 * tokens already spent.
 *
 * The fix (`_handle_dev_orch_stall` in `scripts/autopilot/reap.py`):
 *   - only applies to `dev_orch` completions carrying a resolved anchor
 *     (slot.anchor, or the planning-time deposit — the same recovery
 *     `_fire_reflection_for_completion` already uses);
 *   - checks GitHub for an open PR referencing the anchor, via the SAME
 *     shared predicate `pr-refs.py` exposes (issue #3852) — never a
 *     re-implemented regex;
 *   - on a confirmed miss (PR-existence === false), relabels the issue away
 *     from `ready-for-agent`/`in-progress` to `needs-dev-resume` (a label
 *     pre-created for this issue), posts an explanatory comment, and queues
 *     a resume record onto `state.dev_resume_pending` for decide.py to drain
 *     (see test/decide-dev-resume-pending.test.mts for that half);
 *   - fails OPEN (no mutation at all) on any `gh` hiccup or when a PR IS
 *     found — this suite pins both the positive (stall detected) and
 *     negative (PR found / gh unreachable / no anchor) cases so a future
 *     change can't quietly turn this into a false-positive relabel machine.
 *
 * A stub `gh` binary (HYDRA_AUTOPILOT_GH_CLI override, mirroring the existing
 * HYDRA_AUTOPILOT_REDIS_CLI test-injection pattern for `_redis_cli`) replaces
 * the real CLI so these tests run hermetically — no network, no real repo.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const REAP = join(REPO_ROOT, "scripts", "autopilot", "reap.py");

interface Paths {
  dir: string;
  state: string;
  log: string;
  ghStub: string;
  ghCallsLog: string;
}

/**
 * Writes an executable stub `gh` that:
 *   - records every invocation (space-joined argv) as one line in ghCallsLog
 *   - answers `pr list ...` with $STUB_PR_LIST_JSON on stdout, exit
 *     $STUB_PR_LIST_EXIT (default 0)
 *   - answers `issue edit ...` / `issue comment ...` with exit
 *     $STUB_ISSUE_EDIT_EXIT / $STUB_ISSUE_COMMENT_EXIT (default 0)
 */
function makeTmp(): Paths {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-reap-dev-resume-"));
  const ghStub = join(dir, "gh-stub.sh");
  const ghCallsLog = join(dir, "gh-calls.log");
  writeFileSync(
    ghStub,
    `#!/usr/bin/env bash
set -u
echo "$*" >> "${ghCallsLog}"
case "\${1:-} \${2:-}" in
  "pr list")
    exit_code="\${STUB_PR_LIST_EXIT:-0}"
    if [ "\$exit_code" != "0" ]; then
      exit "\$exit_code"
    fi
    printf '%s' "\${STUB_PR_LIST_JSON:-[]}"
    exit 0
    ;;
  "issue edit")
    exit "\${STUB_ISSUE_EDIT_EXIT:-0}"
    ;;
  "issue comment")
    exit "\${STUB_ISSUE_COMMENT_EXIT:-0}"
    ;;
  *)
    exit 0
    ;;
esac
`,
  );
  chmodSync(ghStub, 0o755);
  return { dir, state: join(dir, "state.json"), log: join(dir, "nightly.log"), ghStub, ghCallsLog };
}

function writeState(path: string, patch: Record<string, unknown>): void {
  const base: Record<string, unknown> = {
    started_epoch: Math.floor(Date.now() / 1000),
    limits: {
      token_budget: 2_000_000,
      subagent_max_tokens: 400_000,
      subagent_hard_max_tokens: 800_000,
    },
    cumulative_tokens: 0,
    dispatches: 0,
    idle_turns: 0,
    burned_classes: [],
    reaped_task_ids: [],
    slots: {
      dev_orch: null,
      qa_orch: null,
      research_orch: null,
      dev_target: null,
      qa_target: null,
      research_target: null,
    },
    signal_last_fired: {},
    failure_log: [],
  };
  writeFileSync(path, JSON.stringify({ ...base, ...patch }));
}

function runCompletion(
  args: string[],
  paths: Paths,
  ghEnv: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("python3", [REAP, "completion", ...args], {
    env: {
      ...process.env,
      HYDRA_API_BASE: "http://127.0.0.1:1", // dead port — no real orchestrator calls
      HYDRA_BASE_URL: "http://127.0.0.1:1",
      HYDRA_AUTOPILOT_STATE: paths.state,
      HYDRA_AUTOPILOT_LOG: paths.log,
      HYDRA_AUTOPILOT_REPO: "hydra-test/nonexistent-fixture",
      HYDRA_REAP_WORKTREE_GC: "0", // keep the worktree-GC side-effect out of the test
      HYDRA_AUTOPILOT_GH_CLI: paths.ghStub,
      ...ghEnv,
    },
    encoding: "utf-8",
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function runLog(paths: Paths): string {
  return existsSync(paths.log) ? readFileSync(paths.log, "utf-8") : "";
}

function ghCalls(paths: Paths): string[] {
  return existsSync(paths.ghCallsLog)
    ? readFileSync(paths.ghCallsLog, "utf-8").trim().split("\n").filter(Boolean)
    : [];
}

describe("reap.py completion → dev_orch no-PR stall detection (issue #3866)", () => {
  test("STALL: no open PR references the anchor → relabel + comment + queue a resume record", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          dev_orch: {
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000) - 600,
            task_id: "t1",
            anchor: "issue-3726",
            branch: "issue-3726-fix",
          },
        },
      });

      const r = runCompletion(["dev_orch", "t1", "50000", "hydra-dev"], tmp, {
        STUB_PR_LIST_JSON: "[]", // no open PRs at all
      });
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      assert.match(
        log,
        /dev_stall_no_pr anchor=issue-3726 task_id=t1 branch=issue-3726-fix relabelled=True/,
        "a confirmed no-PR stall must log dev_stall_no_pr with relabelled=True",
      );

      const calls = ghCalls(tmp);
      assert.ok(
        calls.some((c) => c.startsWith("pr list") && c.includes("--repo hydra-test/nonexistent-fixture")),
        `must query open PRs for the anchor's repo: ${JSON.stringify(calls)}`,
      );
      assert.ok(
        calls.some(
          (c) =>
            c.startsWith("issue edit 3726") &&
            c.includes("--remove-label ready-for-agent") &&
            c.includes("--remove-label in-progress") &&
            c.includes("--add-label needs-dev-resume"),
        ),
        `must relabel issue #3726 to needs-dev-resume: ${JSON.stringify(calls)}`,
      );
      assert.ok(
        calls.some((c) => c.startsWith("issue comment 3726")),
        `must post an explanatory comment on issue #3726: ${JSON.stringify(calls)}`,
      );

      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      assert.equal(s.dev_resume_pending.length, 1);
      assert.equal(s.dev_resume_pending[0].anchor, "issue-3726");
      assert.equal(s.dev_resume_pending[0].task_id, "t1");
      assert.equal(s.dev_resume_pending[0].branch, "issue-3726-fix");
      assert.equal(typeof s.dev_resume_pending[0].stalled_epoch, "number");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("CLEAN: an open PR references the anchor via branch name → no relabel, no queue entry", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          dev_orch: {
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000) - 600,
            task_id: "t2",
            anchor: "issue-3727",
            branch: "issue-3727-fix",
          },
        },
      });

      const prJson = JSON.stringify([{ headRefName: "issue-3727-fix", body: "" }]);
      const r = runCompletion(["dev_orch", "t2", "60000", "hydra-dev"], tmp, {
        STUB_PR_LIST_JSON: prJson,
      });
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      assert.ok(!log.includes("dev_stall_no_pr"), "a found PR must never log a stall");

      const calls = ghCalls(tmp);
      assert.ok(calls.some((c) => c.startsWith("pr list")), "must still check for an open PR");
      assert.ok(
        !calls.some((c) => c.startsWith("issue edit")),
        `must NOT relabel when a PR was found: ${JSON.stringify(calls)}`,
      );
      assert.ok(
        !calls.some((c) => c.startsWith("issue comment")),
        `must NOT comment when a PR was found: ${JSON.stringify(calls)}`,
      );

      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      assert.ok(
        !s.dev_resume_pending || s.dev_resume_pending.length === 0,
        "a found PR must never queue a resume record",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("CLEAN: an open PR references the anchor via a Closes-# body keyword → no relabel", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          dev_orch: {
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000) - 600,
            task_id: "t3",
            anchor: "issue-3728",
          },
        },
      });

      const prJson = JSON.stringify([
        { headRefName: "some-other-branch-name", body: "Implements the fix.\n\nCloses #3728" },
      ]);
      const r = runCompletion(["dev_orch", "t3", "40000", "hydra-dev"], tmp, {
        STUB_PR_LIST_JSON: prJson,
      });
      assert.equal(r.status, 0);
      const calls = ghCalls(tmp);
      assert.ok(!calls.some((c) => c.startsWith("issue edit")), "a Closes-# body reference must count as a found PR");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("UNKNOWN: gh pr list fails → fail OPEN, no relabel, no queue entry", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          dev_orch: {
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000) - 600,
            task_id: "t4",
            anchor: "issue-3729",
          },
        },
      });

      const r = runCompletion(["dev_orch", "t4", "30000", "hydra-dev"], tmp, {
        STUB_PR_LIST_EXIT: "1", // simulate gh auth/network failure
      });
      assert.equal(r.status, 0, "an unreachable gh must never fail the reap");

      const log = runLog(tmp);
      assert.ok(!log.includes("dev_stall_no_pr"), "an unknown PR-existence result must never be treated as a stall");

      const calls = ghCalls(tmp);
      assert.ok(!calls.some((c) => c.startsWith("issue edit")), "must NOT relabel when gh pr list failed");

      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      assert.ok(!s.dev_resume_pending || s.dev_resume_pending.length === 0);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("NO ANCHOR: a dev_orch completion with no resolvable anchor never calls gh at all", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          dev_orch: {
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000) - 600,
            task_id: "t5",
            // no anchor field, and no reflection-deposit file for t5 either
          },
        },
      });

      const r = runCompletion(["dev_orch", "t5", "10000", "hydra-dev"], tmp, {
        STUB_PR_LIST_JSON: "[]",
      });
      assert.equal(r.status, 0);
      assert.deepEqual(ghCalls(tmp), [], "no anchor means no PR-existence check at all");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("NON-dev_orch class: a qa_orch completion never triggers the stall check", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {});

      const r = runCompletion(["qa_orch", "t6", "20000", "hydra-qa"], tmp, {
        STUB_PR_LIST_JSON: "[]",
      });
      assert.equal(r.status, 0);
      assert.deepEqual(ghCalls(tmp), [], "only dev_orch completions run the no-PR stall check");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});

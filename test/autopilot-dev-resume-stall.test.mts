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
 * Issue #4057 narrows the stall predicate: "no open PR" is incomplete
 * evidence, because a dev_orch dispatch has a second legitimate terminal
 * outcome with no PR — the anchor turned out to be already resolved and the
 * agent CLOSED it with evidence instead of inventing a fix (observed: #4032,
 * closed via ae381b7d + #4054, no PR by design). Before mutating, the
 * handler now reads the anchor issue's own state (a dedicated `gh issue
 * view` scoped to that one issue, fired ONLY on the already-narrow
 * no-open-PR branch — never on the found-a-PR majority case, never folded
 * into the shared open-PR-list fetch): a CLOSED anchor short-circuits with
 * no relabel and no resume record, and an UNREADABLE state fails open as
 * no-mutation, matching every other `gh` gate in the handler.
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
 *   - answers `issue view ...` with $STUB_ISSUE_VIEW_JSON on stdout (default
 *     {"state":"OPEN"} — the pre-#4057 tests' anchors are open issues), exit
 *     $STUB_ISSUE_VIEW_EXIT (default 0)
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
  "issue view")
    exit_code="\${STUB_ISSUE_VIEW_EXIT:-0}"
    if [ "\$exit_code" != "0" ]; then
      exit "\$exit_code"
    fi
    out="\${STUB_ISSUE_VIEW_JSON:-}"
    if [ -z "\$out" ]; then
      out='{"state":"OPEN"}'
    fi
    printf '%s' "\$out"
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
        STUB_ISSUE_VIEW_JSON: '{"state":"OPEN"}', // #4057: anchor still open → #3866 behaviour unchanged
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
        !calls.some((c) => c.startsWith("issue view")),
        `the #4057 issue-state read must never fire when a PR was found (call-volume discipline + the read is gated to the no-PR branch): ${JSON.stringify(calls)}`,
      );
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

describe("reap.py completion → closed-anchor short-circuit (issue #4057)", () => {
  test("CLOSED ANCHOR: no open PR but the anchor issue is CLOSED → no relabel, no comment, no resume record", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          dev_orch: {
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000) - 600,
            task_id: "t7",
            anchor: "issue-4032",
            branch: "worktree-agent-6db9fed5-t10-dev_orch",
          },
        },
      });

      // The exact motivating shape: the agent verified the defect was
      // already resolved (ae381b7d + #4054), posted its evidence, and closed
      // #4032 as completed — no PR was the CORRECT outcome.
      const r = runCompletion(["dev_orch", "t7", "50000", "hydra-dev"], tmp, {
        STUB_PR_LIST_JSON: "[]",
        STUB_ISSUE_VIEW_JSON: '{"state":"CLOSED"}',
      });
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      assert.ok(
        !log.includes("dev_stall_no_pr anchor="),
        "a correctly-CLOSED anchor must never be recorded as a stall",
      );
      assert.match(
        log,
        /dev_stall_no_pr_skipped_closed anchor=issue-4032 task_id=t7/,
        "the closed-anchor skip must be logged so a no-op reap is distinguishable from a missed check",
      );

      const calls = ghCalls(tmp);
      assert.ok(
        calls.some((c) => c.startsWith("pr list")),
        "the shared open-PR-list check still runs first (the #3866 predicate is untouched)",
      );
      assert.ok(
        calls.some((c) => c.startsWith("issue view 4032") && c.includes("--repo hydra-test/nonexistent-fixture")),
        `must read the anchor issue's own state via a per-issue call: ${JSON.stringify(calls)}`,
      );
      assert.ok(
        !calls.some((c) => c.startsWith("issue edit")),
        `must NOT relabel a CLOSED anchor (it mislabels a terminal outcome as needs-dev-resume): ${JSON.stringify(calls)}`,
      );
      assert.ok(
        !calls.some((c) => c.startsWith("issue comment")),
        `must NOT comment on a CLOSED anchor: ${JSON.stringify(calls)}`,
      );

      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      assert.ok(
        !s.dev_resume_pending || s.dev_resume_pending.length === 0,
        "a CLOSED anchor must never queue a dev_resume_pending record (it pins a future dispatch to done work)",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("UNKNOWN STATE: gh issue view fails → fail OPEN, no mutation", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          dev_orch: {
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000) - 600,
            task_id: "t8",
            anchor: "issue-4033",
          },
        },
      });

      const r = runCompletion(["dev_orch", "t8", "30000", "hydra-dev"], tmp, {
        STUB_PR_LIST_JSON: "[]",
        STUB_ISSUE_VIEW_EXIT: "1", // simulate gh auth/network failure on the state read
      });
      assert.equal(r.status, 0, "an unreachable gh must never fail the reap");

      const log = runLog(tmp);
      assert.ok(!log.includes("dev_stall_no_pr"), "an unreadable issue state must never be treated as a stall");

      const calls = ghCalls(tmp);
      assert.ok(!calls.some((c) => c.startsWith("issue edit")), "must NOT relabel when the issue state is unreadable");
      assert.ok(!calls.some((c) => c.startsWith("issue comment")), "must NOT comment when the issue state is unreadable");

      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      assert.ok(
        !s.dev_resume_pending || s.dev_resume_pending.length === 0,
        "must NOT queue a resume record when the issue state is unreadable",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("UNKNOWN STATE: gh issue view returns unparseable output → fail OPEN, no mutation", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          dev_orch: {
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000) - 600,
            task_id: "t9",
            anchor: "issue-4034",
          },
        },
      });

      const r = runCompletion(["dev_orch", "t9", "30000", "hydra-dev"], tmp, {
        STUB_PR_LIST_JSON: "[]",
        STUB_ISSUE_VIEW_JSON: "not-json-at-all", // exit 0 but garbage stdout
      });
      assert.equal(r.status, 0);

      const log = runLog(tmp);
      assert.ok(!log.includes("dev_stall_no_pr"), "unparseable state must never be treated as a stall");

      const calls = ghCalls(tmp);
      assert.ok(
        !calls.some((c) => c.startsWith("issue edit")),
        `unparseable state output must fail open, not guess a stall: ${JSON.stringify(calls)}`,
      );

      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      assert.ok(
        !s.dev_resume_pending || s.dev_resume_pending.length === 0,
        "unparseable state output must not queue a resume record",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #4377 — reap.py's 8 byte-identical `gh` subprocess try/except sites
// (the ones exercised end-to-end by the two suites above) collapsed into one
// private helper, `_gh_run`. This suite pins the helper's own exception-
// branch contract directly, Redis-free and independent of the two suites
// above (its own lifecycle — no shared before/after), plus one end-to-end
// case proving the collapse didn't change `_handle_dev_orch_stall`'s
// fail-open behaviour when `gh` cannot be run at all.
// ---------------------------------------------------------------------------
describe("scripts/autopilot/reap.py _gh_run — exception-branch contract (issue #4377)", () => {
  // Imports reap.py as a module (its __main__ guard keeps import side-effect
  // free) so `_gh_run` can be probed directly, mirroring the
  // spec_from_file_location + sys.modules-registration-before-exec_module
  // pattern test/autopilot-dedup-reap.test.mts already established.
  function runPython(
    code: string,
    env: Record<string, string> = {},
  ): { status: number; stdout: string; stderr: string } {
    const r = spawnSync("python3", ["-c", code], {
      env: {
        ...process.env,
        REAP_PATH: REAP,
        ...env,
      },
      encoding: "utf-8",
    });
    return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  const IMPORT_PREAMBLE = (name: string) => `
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("${name}", os.environ["REAP_PATH"])
reap = importlib.util.module_from_spec(spec)
# Register BEFORE exec_module: reap.py uses PEP 563 future annotations, so a
# decorator resolving cls.__module__ needs the module already in sys.modules
# (test/autopilot-dedup-reap.test.mts hit this first).
sys.modules["${name}"] = reap
spec.loader.exec_module(reap)
`;

  test("gh binary missing (FileNotFoundError) → _gh_run returns None and logs one canonical WARN naming the context", () => {
    const r = runPython(
      `${IMPORT_PREAMBLE("reap_ghrun_a")}
proc = reap._gh_run("issue", "view", "1", "--repo", "x/y", "--json", "state", context="unit-test-context-a")
print("NONE" if proc is None else "NOT_NONE")
`,
      { HYDRA_AUTOPILOT_GH_CLI: "/nonexistent/hydra-test-4377-gh-binary" },
    );
    assert.equal(r.status, 0, `probe must exit 0, got ${r.status}; stderr=${r.stderr}`);
    assert.equal(r.stdout.trim(), "NONE", "a missing gh binary must make _gh_run return None");
    assert.match(
      r.stderr,
      /\[autopilot\] reap: WARN gh issue view failed for unit-test-context-a \(non-fatal\):/,
      `must log the canonical WARN line with the caller's context: ${r.stderr}`,
    );
  });

  test("subprocess.run raises TimeoutExpired → _gh_run returns None and logs the canonical WARN", () => {
    const r = runPython(`${IMPORT_PREAMBLE("reap_ghrun_b")}
import subprocess
def boom(*args, **kwargs):
    raise subprocess.TimeoutExpired(cmd="gh", timeout=15)
reap.subprocess.run = boom
proc = reap._gh_run("pr", "list", "--repo", "x/y", context="unit-test-context-b")
print("NONE" if proc is None else "NOT_NONE")
`);
    assert.equal(r.status, 0, `probe must exit 0, got ${r.status}; stderr=${r.stderr}`);
    assert.equal(r.stdout.trim(), "NONE", "a TimeoutExpired must make _gh_run return None");
    assert.match(
      r.stderr,
      /\[autopilot\] reap: WARN gh pr list failed for unit-test-context-b \(non-fatal\):/,
      `must log the canonical WARN line with the caller's context: ${r.stderr}`,
    );
  });

  test("gh exits non-zero → _gh_run returns the CompletedProcess as-is, never None (INV-3)", () => {
    const dir = mkdtempSync(join(tmpdir(), "autopilot-reap-ghrun-c-"));
    try {
      const ghStub = join(dir, "gh-stub-exit3.sh");
      writeFileSync(ghStub, `#!/usr/bin/env bash\nexit 3\n`);
      chmodSync(ghStub, 0o755);

      const r = runPython(
        `${IMPORT_PREAMBLE("reap_ghrun_c")}
proc = reap._gh_run("issue", "edit", "1", "--repo", "x/y", context="unit-test-context-c")
print("NONE" if proc is None else f"RETURNCODE={proc.returncode}")
`,
        { HYDRA_AUTOPILOT_GH_CLI: ghStub },
      );
      assert.equal(r.status, 0, `probe must exit 0, got ${r.status}; stderr=${r.stderr}`);
      assert.equal(
        r.stdout.trim(),
        "RETURNCODE=3",
        "a non-zero gh exit must be returned as a CompletedProcess, not swallowed into None",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("end-to-end: gh unreachable during a dev_orch stall check → reap still exits 0 and mutates nothing", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          dev_orch: {
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000) - 600,
            task_id: "t-ghrun-d",
            anchor: "issue-9999",
            branch: "issue-9999-fix",
          },
        },
      });

      // Route every gh call at a nonexistent binary — the collapsed helper's
      // FileNotFoundError branch must keep the whole completion path
      // fail-open, exactly as the pre-#4377 per-site try/except blocks did.
      const r = runCompletion(["dev_orch", "t-ghrun-d", "20000", "hydra-dev"], tmp, {
        HYDRA_AUTOPILOT_GH_CLI: "/nonexistent/hydra-test-4377-gh-binary-e2e",
      });
      assert.equal(r.status, 0, `reap must exit 0 even when gh cannot be run at all, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      assert.ok(!log.includes("dev_stall_no_pr"), "an unreachable gh must never be treated as a confirmed stall");

      // paths.ghStub was overridden away, so nothing ever wrote ghCallsLog —
      // proof the real (nonexistent) binary path was the one attempted.
      assert.deepEqual(ghCalls(tmp), [], "no gh call can have recorded a response when the binary does not exist");

      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      assert.ok(
        !s.dev_resume_pending || s.dev_resume_pending.length === 0,
        "an unreachable gh must never queue a resume record",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});
